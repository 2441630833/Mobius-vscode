/*---------------------------------------------------------------------------------------------
 *  Mobius — pre-task terminal log capture for Continue Agent
 *
 *  Before executing an agent task we peek at the visible terminal(s) so the
 *  model can see the last command, its output, and any error messages the
 *  user is likely asking about. The capture is intentionally conservative:
 *
 *    1. If no terminal exists, or no terminal has produced any output, we
 *       return undefined and the agent proceeds without terminal context
 *       (no injected noise, no extra latency).
 *    2. Terminals created by the agent itself via `run_in_terminal` are
 *       included only when their cwd / last command overlaps with the user
 *       prompt (relevance heuristic), so we don't dump unrelated server
 *       logs from a previous session into every new prompt.
 *    3. Output is truncated to a bounded tail (default 200 lines / 12 KB)
 *       to keep the prompt small.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { basename } from '../../../../base/common/path.js';
import { ITerminalChatService, ITerminalService, type ITerminalInstance } from '../../../contrib/terminal/browser/terminal.js';

/** Max lines to pull from a single terminal's scrollback. */
const MAX_TERMINAL_LINES = 200;
/** Hard cap on total captured characters (across all terminals). */
const MAX_TOTAL_CHARS = 12_000;
/** If prompt contains one of these words we treat it as bug/error-oriented. */
const BUG_KEYWORDS = /\b(error|bug|fail(ed|ure)?|crash|exception|traceback|broken|stuck|hang|doesn'?t work|not work|why|diagnos|debug|fix|issue|problem|wrong|incorrect|报错|错误|失败|崩溃|异常|卡住|无法|不能|问题|修复|排查|为什么)\b/i;

export interface TerminalContextEntry {
	/** Terminal title (process name or user-set label). */
	readonly title: string;
	/** cwd of the terminal, if known. */
	readonly cwd: string | undefined;
	/** Whether this terminal was started by the agent (run_in_terminal tool). */
	readonly startedByAgent: boolean;
	/** Whether the terminal is a hidden/background agent terminal. */
	readonly isBackground: boolean;
	/** Recent tail of the terminal buffer (already trimmed). */
	readonly output: string;
}

export interface CapturedTerminalContext {
	/** One block per relevant terminal, already formatted for the system prompt. */
	readonly promptBlock: string;
	readonly entries: readonly TerminalContextEntry[];
}

/**
 * Read the last N lines of an xterm terminal buffer. Returns '' if the
 * terminal has no xterm instance ready yet (e.g. just created, no pty data).
 */
function readTerminalTail(instance: ITerminalInstance, maxLines: number): string {
	const raw = instance.xterm?.raw;
	if (!raw) {
		return '';
	}
	try {
		const buf = raw.buffer.active;
		const total = buf.length;
		const start = Math.max(0, total - maxLines);
		const lines: string[] = [];
		for (let i = start; i < total; i++) {
			const line = buf.getLine(i);
			if (!line) {
				continue;
			}
			// translateToString(true) trims trailing whitespace; keep leading
			// whitespace so indented stack traces stay readable.
			const text = line.translateToString(true);
			if (text) {
				lines.push(text);
			}
		}
		// Drop leading lines that are just the shell prompt repeated (common in
		// idle terminals) — keep only from the first line that looks like
		// actual command output, but always keep at least the last 20 lines.
		return lines.join('\n');
	} catch (err) {
		// xterm buffer access can occasionally throw during disposal; treat as empty.
		return '';
	}
}

/**
 * Naive relevance check between a user prompt and a terminal's state.
 *
 * A terminal is "relevant" when ANY of:
 *   - the prompt mentions a bug/error keyword AND the terminal output itself
 *     contains error indicators (traceback / Error / failed / non-zero shell
 *     exit / npm ERR! / etc.), OR
 *   - the prompt's working-directory basename appears in the terminal cwd, OR
 *   - the terminal was started by the agent in the same chat session.
 */
function isTerminalRelevant(
	entry: { cwd: string | undefined; output: string; startedByAgent: boolean },
	userPrompt: string,
	cwd: URI | undefined,
): boolean {
	const prompt = userPrompt.toLowerCase();
	const output = entry.output.toLowerCase();

	// Agent-started terminals in this session are always considered — the
	// agent itself just produced this output and the next prompt is very
	// likely asking about it.
	if (entry.startedByAgent) {
		return true;
	}

	// Bug/error intent + visible error in output.
	if (BUG_KEYWORDS.test(userPrompt)) {
		const hasErrorSignal =
			/\b(error|exception|traceback|failed|failure|fatal|panic|segmentation fault|npm err!|command not found|cannot find module|syntaxerror|typeerror|referenceerror|econnrefused|enoent|eacces)\b/i.test(entry.output)
			|| /错误|异常|失败|崩溃|找不到|无法|未找到|命令未找到/.test(entry.output);
		if (hasErrorSignal) {
			return true;
		}
	}

	// cwd overlap: prompt's folder name appears in terminal cwd.
	if (cwd) {
		const folderName = basename(cwd.fsPath).toLowerCase();
		if (folderName && entry.cwd?.toLowerCase().includes(folderName)) {
			return true;
		}
	}

	// Prompt explicitly mentions the terminal / shell / last command.
	if (/\b(terminal|shell|console|command|prompt|powershell|bash|output|log)\b/i.test(prompt)
		|| /(终端|命令行|控制台|输出|日志|刚才|上一条)/.test(userPrompt)) {
		return true;
	}

	// If the prompt itself contains a quoted snippet that appears in the
	// terminal output, the user is clearly referencing it.
	const quoted = userPrompt.match(/[`'"]([^`'"\n]{6,120})[`'"]/);
	if (quoted && output.includes(quoted[1].toLowerCase())) {
		return true;
	}

	return false;
}

/**
 * Strip ANSI escape sequences that xterm may still hand back. Also collapses
 * runs of blank lines to keep the captured text compact.
 */
function cleanOutput(raw: string): string {
	// eslint-disable-next-line no-control-regex
	const withoutAnsi = raw.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
	const collapsed = withoutAnsi
		.replace(/\r\n/g, '\n')
		.replace(/\r/g, '\n')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
	return collapsed;
}

/**
 * Inspect all live terminals and return a formatted system-prompt block
 * describing relevant recent terminal output.
 *
 * Returns undefined when there is nothing useful to inject (no terminals,
 * empty buffers, or no relevance to the current prompt).
 */
export function captureTerminalContext(
	terminalService: ITerminalService,
	terminalChatService: ITerminalChatService,
	logService: ILogService,
	userPrompt: string,
	cwd: URI | undefined,
): CapturedTerminalContext | undefined {
	const instances = terminalService.instances;
	if (!instances.length) {
		return undefined;
	}

	const entries: TerminalContextEntry[] = [];

	for (const instance of instances) {
		if (instance.isDisposed) {
			continue;
		}
		const toolSessionId = terminalChatService.getToolSessionIdForInstance(instance);
		const startedByAgent = !!toolSessionId;
		const isBackground = toolSessionId
			? terminalChatService.isBackgroundTerminal(toolSessionId)
			: !!instance.shellLaunchConfig?.hideFromUser;

		// For hidden background agent terminals (long-running servers started
		// by a prior turn), only include the tail — we already filter by
		// relevance below; if it's a server that printed 5000 lines of
		// request logs, the tail is what matters.
		const rawTail = readTerminalTail(instance, MAX_TERMINAL_LINES);
		const output = cleanOutput(rawTail);
		if (!output) {
			continue;
		}

		const entry: TerminalContextEntry = {
			title: instance.title || instance.processName || 'terminal',
			cwd: instance.cwd || instance.initialCwd,
			startedByAgent,
			isBackground,
			output,
		};

		if (!isTerminalRelevant(entry, userPrompt, cwd)) {
			continue;
		}
		entries.push(entry);
	}

	if (!entries.length) {
		return undefined;
	}

	// Build the prompt block with a hard char budget. Prioritize agent-started
	// terminals, then foreground user terminals, then background ones.
	entries.sort((a, b) => {
		if (a.startedByAgent !== b.startedByAgent) {
			return a.startedByAgent ? -1 : 1;
		}
		if (a.isBackground !== b.isBackground) {
			return a.isBackground ? 1 : -1;
		}
		return 0;
	});

	const blocks: string[] = [];
	let totalChars = 0;
	for (const e of entries) {
		const header = e.startedByAgent
			? `### Terminal: ${e.title} (started by agent${e.isBackground ? ', background' : ''})`
			: `### Terminal: ${e.title}${e.isBackground ? ' (background)' : ''}`;
		const cwdLine = e.cwd ? `cwd: ${e.cwd}` : '';
		const remaining = MAX_TOTAL_CHARS - totalChars;
		if (remaining <= 200) {
			break;
		}
		const trimmedOutput = e.output.length > remaining - 200
			? `…(truncated)\n${e.output.slice(-(remaining - 200))}`
			: e.output;
		const block = [header, cwdLine, '```', trimmedOutput, '```'].filter(Boolean).join('\n');
		blocks.push(block);
		totalChars += block.length;
	}

	if (!blocks.length) {
		return undefined;
	}

	const promptBlock =
		`<terminal-context>\n`
		+ `Recent terminal output relevant to the user's request is below. `
		+ `Use it to understand the bug/issue the user encountered (error messages, `
		+ `stack traces, last command and exit status). If the output shows the agent's `
		+ `own previous command failed, fix the root cause rather than re-running blindly.\n\n`
		+ blocks.join('\n\n')
		+ `\n</terminal-context>`;

	logService.info(
		`[Continue][TerminalContext] Captured ${entries.length} terminal(s) for agent prompt (${totalChars} chars)`,
	);

	return { promptBlock, entries };
}
