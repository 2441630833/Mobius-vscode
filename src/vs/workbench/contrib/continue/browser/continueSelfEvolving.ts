/*---------------------------------------------------------------------------------------------
 *  Mobius — self-evolving agent: auto-generates reusable SKILL.md files from
 *  completed tasks, mirroring Hermes Agent's built-in learning loop.
 *
 *  Generated skills land in `.agents/skills/auto/<name>/SKILL.md` (workspace)
 *  or `~/.agents/skills/auto/<name>/SKILL.md` (global). The existing prompts
 *  service + hybrid router (`continueSkillsContext.ts`) discovers them on the
 *  next session and auto-loads them based on intent-match score — no extra
 *  wiring required.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { URI } from '../../../../base/common/uri.js';
import { joinPath } from '../../../../base/common/resources.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import {
	ChatMessageRole,
	ILanguageModelsService,
} from '../../chat/common/languageModels.js';

/** Minimum number of tool calls before a task is "complex enough" to distill. */
const MIN_TOOL_CALLS_FOR_SKILL = 5;

/** Max chars of tool transcript fed to the skill-synthesis prompt. */
const TRANSCRIPT_CHAR_BUDGET = 12_000;

const AUTO_SKILLS_SUBDIR = '.agents/skills/auto';

export interface SelfEvolvingConfig {
	/** Master switch. Default true. */
	readonly enabled: boolean;
	/** Write to global `~/.agents/skills/auto` instead of workspace. Default false. */
	readonly global: boolean;
	/** Min tool calls to trigger auto-generation. */
	readonly minToolCalls: number;
}

export interface TaskExecutionRecord {
	/** The original user request for this task. */
	readonly userRequest: string;
	/** Tool calls made during the task (name + brief input summary). */
	readonly toolCalls: readonly { name: string; inputSummary: string; ok: boolean }[];
	/** Files that were edited or created. */
	readonly editedFiles: readonly string[];
	/** Error/diagnostic messages recovered from (e.g. compile errors that were fixed). */
	readonly recoveredErrors: readonly string[];
	/** Any user corrections or explicit preferences stated mid-task. */
	readonly userCorrections: readonly string[];
	/** Final user-facing summary produced by the agent. */
	readonly finalSummary: string;
	/** Whether the task completed successfully. */
	readonly success: boolean;
}

export interface GeneratedSkill {
	readonly name: string;
	readonly description: string;
	readonly path: string;
	readonly created: boolean;
	readonly updated: boolean;
}

interface SynthesisResult {
	shouldCreate: boolean;
	name: string;
	description: string;
	body: string;
}

/**
 * Listens for task completion, decides whether a reusable skill emerged, and
 * writes a SKILL.md. Also exposes an explicit `learn()` entrypoint for the
 * `learn!` / "记住这个流程" command.
 */
export class ContinueSelfEvolving {
	private readonly _onDidGenerateSkill = new Emitter<GeneratedSkill>();
	readonly onDidGenerateSkill: Event<GeneratedSkill> = this._onDidGenerateSkill.event;

	private readonly _globalSkillsRoot: URI;

	constructor(
		private readonly _languageModelsService: ILanguageModelsService,
		private readonly _fileService: IFileService,
		private readonly _workspaceService: IWorkspaceContextService,
		private readonly _logService: ILogService,
		private readonly _resolveModelId: () => string | undefined,
		private readonly _config: SelfEvolvingConfig = {
			enabled: true,
			global: false,
			minToolCalls: MIN_TOOL_CALLS_FOR_SKILL,
		},
	) {
		this._globalSkillsRoot = joinPath(URI.file(this._userHome()), AUTO_SKILLS_SUBDIR);
	}

	/**
	 * Called after an agent turn finishes. Decides whether to distill a skill
	 * and writes it asynchronously. Never throws — failures are logged.
	 */
	async maybeGenerateFromTask(
		record: TaskExecutionRecord,
		token: CancellationToken,
	): Promise<GeneratedSkill | undefined> {
		if (!this._config.enabled) {
			return undefined;
		}
		if (!record.success) {
			this._logService.trace('[SelfEvolving] Skipping skill generation (task did not succeed)');
			return undefined;
		}
		if (record.toolCalls.length < this._config.minToolCalls && record.userCorrections.length === 0) {
			this._logService.trace(
				`[SelfEvolving] Skipping skill generation (only ${record.toolCalls.length} tool calls, no corrections)`,
			);
			return undefined;
		}

		const modelId = this._resolveModelId();
		if (!modelId) {
			this._logService.trace('[SelfEvolving] No model available for skill synthesis');
			return undefined;
		}

		try {
			const synthesis = await this._synthesizeSkill(record, modelId, token);
			if (!synthesis?.shouldCreate || !synthesis.name || !synthesis.body) {
				this._logService.info('[SelfEvolving] LLM decided no reusable skill emerged');
				return undefined;
			}

			return await this._writeSkill(synthesis, record, token);
		} catch (err) {
			this._logService.warn('[SelfEvolving] Skill generation failed', err);
			return undefined;
		}
	}

	/**
	 * Explicit "learn this" — force-synthesizes a skill from a task record
	 * regardless of tool-call threshold.
	 */
	async learn(
		record: TaskExecutionRecord,
		token: CancellationToken,
	): Promise<GeneratedSkill | undefined> {
		return this.maybeGenerateFromTask(
			{ ...record, success: true /* explicit learn assumes value */ },
			token,
		);
	}

	/** List all auto-generated skills (for UI / commands). */
	async listGeneratedSkills(): Promise<{ name: string; uri: URI; description: string }[]> {
		const root = this._skillsRoot();
		try {
			const stat = await this._fileService.resolve(root);
			if (!stat.children?.length) {
				return [];
			}
			const skills: { name: string; uri: URI; description: string }[] = [];
			for (const child of stat.children) {
				if (!child.isDirectory) {
					continue;
				}
				const skillMd = joinPath(child.resource, 'SKILL.md');
				try {
					const content = (await this._fileService.readFile(skillMd)).value.toString();
					const desc = content.match(/^description:\s*(.+)$/m)?.[1]?.replace(/^["']|["']$/g, '') ?? '';
					const name = content.match(/^name:\s*(.+)$/m)?.[1]?.replace(/^["']|["']$/g, '') ?? child.name;
					skills.push({ name, uri: skillMd, description: desc });
				} catch {
					// missing SKILL.md — skip
				}
			}
			return skills;
		} catch {
			return [];
		}
	}

	private async _synthesizeSkill(
		record: TaskExecutionRecord,
		modelId: string,
		token: CancellationToken,
	): Promise<SynthesisResult | undefined> {
		const transcript = this._formatTranscript(record);
		const systemPrompt = `You are a skill-distillation engine for an autonomous coding agent.
Given a completed task transcript, decide whether a REUSABLE skill emerged.
A reusable skill is a workflow, fix pattern, or domain procedure that would help
future sessions on similar tasks. Do NOT create a skill for one-off trivia or
trivial edits.

If the task is worth distilling, output ONLY a JSON object (no markdown fences):
{
  "shouldCreate": true,
  "name": "kebab-case-skill-name",
  "description": "Use when ... (one sentence, starts with 'Use when')",
  "body": "Full SKILL.md body in Markdown. Include: ## When to use, ## Steps, ## Pitfalls, ## Example. Be concrete."
}

Rules:
- name must match /^[a-z0-9-]+$/ and be 2-40 chars
- description starts with "Use when" and describes the TRIGGER, not the one task
- body should generalize the approach, not mention the specific user or filenames
- If no reusable pattern emerged, output {"shouldCreate":false}
- Prefer UPDATING an existing skill if one covers this territory (note in body).
Output JSON only.`;

		const userPrompt = `Task request:
${record.userRequest}

Tool transcript (abbreviated):
${transcript}

${record.recoveredErrors.length ? `Recovered errors:\n${record.recoveredErrors.slice(0, 5).join('\n')}\n` : ''}${record.userCorrections.length ? `User corrections/preferences:\n${record.userCorrections.join('\n')}\n` : ''}Final summary:
${record.finalSummary.slice(0, 1500)}`;

		const response = await this._languageModelsService.sendChatRequest(
			modelId,
			undefined,
			[
				{ role: ChatMessageRole.System, content: [{ type: 'text', value: systemPrompt }] },
				{ role: ChatMessageRole.User, content: [{ type: 'text', value: userPrompt }] },
			],
			{ },
			token,
		);

		let fullText = '';
		for await (const part of response.stream) {
			const parts = Array.isArray(part) ? part : [part];
			for (const p of parts) {
				if (p.type === 'text') {
					fullText += p.value;
				}
			}
			if (token.isCancellationRequested) {
				return undefined;
			}
		}

		return this._parseSynthesis(fullText);
	}

	private _parseSynthesis(raw: string): SynthesisResult | undefined {
		// Strip code fences if present
		let text = raw.trim();
		const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
		if (fenceMatch) {
			text = fenceMatch[1].trim();
		}
		// Find first {...} block
		const start = text.indexOf('{');
		const end = text.lastIndexOf('}');
		if (start < 0 || end <= start) {
			return undefined;
		}
		try {
			const parsed = JSON.parse(text.slice(start, end + 1));
			if (!parsed || typeof parsed !== 'object') {
				return undefined;
			}
			const name = String(parsed.name ?? '').trim().toLowerCase();
			if (!/^[a-z0-9-]{2,40}$/.test(name)) {
				this._logService.warn(`[SelfEvolving] Rejected skill name: ${name}`);
				return { shouldCreate: false, name: '', description: '', body: '' };
			}
			return {
				shouldCreate: !!parsed.shouldCreate,
				name,
				description: String(parsed.description ?? '').trim(),
				body: String(parsed.body ?? '').trim(),
			};
		} catch {
			this._logService.warn('[SelfEvolving] Failed to parse synthesis JSON');
			return undefined;
		}
	}

	private async _writeSkill(
		synthesis: SynthesisResult,
		record: TaskExecutionRecord,
		token: CancellationToken,
	): Promise<GeneratedSkill> {
		const root = this._skillsRoot();
		const skillDir = joinPath(root, synthesis.name);
		const skillUri = joinPath(skillDir, 'SKILL.md');

		let updated = false;
		let existingBody = '';
		try {
			existingBody = (await this._fileService.readFile(skillUri)).value.toString();
			updated = true;
		} catch {
			// new skill
		}

		const frontmatter = [
			'---',
			`name: ${synthesis.name}`,
			`description: ${JSON.stringify(synthesis.description || `Use when working on ${synthesis.name.replace(/-/g, ' ')} tasks`)}`,
			'auto-generated: true',
			`generated-at: ${new Date().toISOString()}`,
			`source-task: ${JSON.stringify(this._truncate(record.userRequest, 200))}`,
			'---',
			'',
		].join('\n');

		const content = updated
			? this._mergeWithExisting(existingBody, synthesis)
			: frontmatter + synthesis.body + '\n';

		await this._fileService.createFolder(skillDir);
		await this._fileService.writeFile(skillUri, VSBuffer.fromString(content));

		this._logService.info(
			`[SelfEvolving] ${updated ? 'Updated' : 'Created'} skill "${synthesis.name}" at ${skillUri.fsPath}`,
		);

		const result: GeneratedSkill = {
			name: synthesis.name,
			description: synthesis.description,
			path: skillUri.fsPath,
			created: !updated,
			updated,
		};
		this._onDidGenerateSkill.fire(result);
		return result;
	}

	/**
	 * When a skill already exists, append new learnings rather than overwriting.
	 * ponytail: simple section-append; full diff/merge is overkill for v1.
	 */
	private _mergeWithExisting(existing: string, synthesis: SynthesisResult): string {
		// If the existing body already has a "## Learnings" section, append there
		const learningsHeader = '## Learnings';
		const newEntry = `\n### ${new Date().toISOString().slice(0, 10)} — from task\n${this._truncate(synthesis.body, 2000)}\n`;

		if (existing.includes(learningsHeader)) {
			return existing.replace(
				learningsHeader,
				`${learningsHeader}${newEntry}`,
			);
		}
		return `${existing.trimEnd()}\n\n${learningsHeader}\n${newEntry}`;
	}

	private _skillsRoot(): URI {
		if (this._config.global) {
			return this._globalSkillsRoot;
		}
		const workspaceFolder = this._workspaceService.getWorkspace().folders[0];
		if (workspaceFolder) {
			return joinPath(workspaceFolder.uri, AUTO_SKILLS_SUBDIR);
		}
		return this._globalSkillsRoot;
	}

	private _userHome(): string {
		// renderer-safe: process.env is available in node/shared layer
		if (typeof process !== 'undefined' && process.env) {
			return process.env.HOME || process.env.USERPROFILE || '';
		}
		return '';
	}

	private _formatTranscript(record: TaskExecutionRecord): string {
		const lines: string[] = [];
		let budget = TRANSCRIPT_CHAR_BUDGET;
		for (const call of record.toolCalls) {
			const line = `- ${call.ok ? '✓' : '✗'} ${call.name}: ${this._truncate(call.inputSummary, 160)}`;
			if (budget - line.length < 0) {
				lines.push(`... (${record.toolCalls.length - lines.length} more tool calls truncated)`);
				break;
			}
			lines.push(line);
			budget -= line.length;
		}
		if (record.editedFiles.length) {
			lines.push('', 'Files edited:');
			for (const f of record.editedFiles.slice(0, 20)) {
				lines.push(`  - ${f}`);
			}
		}
		return lines.join('\n');
	}

	private _truncate(s: string, n: number): string {
		if (s.length <= n) { return s; }
		return s.slice(0, n - 1) + '…';
	}
}

/**
 * Accumulates a TaskExecutionRecord during an agent turn.
 * Call start() at turn beginning, recordToolCall/recordEdit/recordError as the
 * turn progresses, and finish() to produce the immutable record.
 */
export class TaskExecutionRecorder {
	private _userRequest = '';
	private readonly _toolCalls: { name: string; inputSummary: string; ok: boolean }[] = [];
	private readonly _editedFiles = new Set<string>();
	private readonly _recoveredErrors: string[] = [];
	private readonly _userCorrections: string[] = [];
	private _finalSummary = '';
	private _success = false;

	start(userRequest: string): void {
		this._userRequest = userRequest;
		this._toolCalls.length = 0;
		this._editedFiles.clear();
		this._recoveredErrors.length = 0;
		this._userCorrections.length = 0;
		this._finalSummary = '';
		this._success = false;
	}

	recordToolCall(name: string, input: unknown, ok: boolean): void {
		let summary = '';
		if (typeof input === 'string') {
			summary = input.slice(0, 200);
		} else if (input && typeof input === 'object') {
			try {
				// Pick the most informative field for the summary
				const obj = input as Record<string, unknown>;
				summary = String(obj.command ?? obj.filepath ?? obj.query ?? obj.pattern ?? obj.path ?? '')
					.slice(0, 200);
				if (!summary) {
					summary = JSON.stringify(obj).slice(0, 200);
				}
			} catch {
				summary = '(complex input)';
			}
		}
		this._toolCalls.push({ name, inputSummary: summary, ok });
	}

	recordEdit(uri: string): void {
		this._editedFiles.add(uri);
	}

	recordRecoveredError(message: string): void {
		if (message && message.trim()) {
			this._recoveredErrors.push(message.slice(0, 300));
		}
	}

	recordUserCorrection(text: string): void {
		if (text && text.trim()) {
			this._userCorrections.push(text.slice(0, 300));
		}
	}

	finish(success: boolean, finalSummary: string): TaskExecutionRecord {
		this._success = success;
		this._finalSummary = finalSummary ?? '';
		return {
			userRequest: this._userRequest,
			toolCalls: [...this._toolCalls],
			editedFiles: [...this._editedFiles],
			recoveredErrors: [...this._recoveredErrors],
			userCorrections: [...this._userCorrections],
			finalSummary: this._finalSummary,
			success: this._success,
		};
	}

	get toolCallCount(): number {
		return this._toolCalls.length;
	}
}

/**
 * Cross-session memory: stores small durable facts (user preferences, project
 * conventions, environment quirks) that should always be in context. Mirrors
 * Hermes Agent's memory plugin — separate from skills (which are procedures).
 *
 * Persisted as a simple JSONL file under `.agents/memory/` (workspace) or
 * `~/.agents/memory/` (global). Each line is one memory fact.
 */
export class AgentMemoryStore {
	private readonly _memories: { id: string; text: string; tags: string[]; createdAt: string }[] = [];
	private readonly _memoryFile: URI;
	private _loaded = false;

	constructor(
		private readonly _fileService: IFileService,
		private readonly _workspaceService: IWorkspaceContextService,
		global = false,
	) {
		const home = typeof process !== 'undefined' && process.env
			? (process.env.HOME || process.env.USERPROFILE || '')
			: '';
		const root = global
			? URI.file(home)
			: (this._workspaceService.getWorkspace().folders[0]?.uri ?? URI.file(home));
		this._memoryFile = joinPath(root, '.agents', 'memory', 'facts.jsonl');
	}

	private async _load(): Promise<void> {
		if (this._loaded) { return; }
		this._loaded = true;
		try {
			const content = (await this._fileService.readFile(this._memoryFile)).value.toString();
			for (const line of content.split('\n')) {
				const trimmed = line.trim();
				if (!trimmed) { continue; }
				try {
					const fact = JSON.parse(trimmed);
					if (fact?.text) {
						this._memories.push(fact);
					}
				} catch { /* skip malformed line */ }
			}
		} catch {
			// file doesn't exist yet — empty memory
		}
	}

	/** Recall memories relevant to a query. Simple keyword overlap + tag match. */
	async recall(query: string, limit = 10): Promise<{ text: string; tags: string[] }[]> {
		await this._load();
		const queryLower = query.toLowerCase();
		const queryTokens = new Set(queryLower.match(/[a-z0-9]+|[\u4e00-\u9fff]{2,}/g) ?? []);

		const scored = this._memories.map(m => {
			const textLower = m.text.toLowerCase();
			let score = 0;
			for (const t of queryTokens) {
				if (textLower.includes(t)) { score += 1; }
				if (m.tags.some(tag => tag.toLowerCase().includes(t))) { score += 2; }
			}
			return { m, score };
		});

		return scored
			.filter(s => s.score > 0)
			.sort((a, b) => b.score - a.score)
			.slice(0, limit)
			.map(s => ({ text: s.m.text, tags: s.m.tags }));
	}

	/** Store a new memory fact. */
	async remember(text: string, tags: string[] = []): Promise<void> {
		await this._load();
		const fact = {
			id: `mem_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
			text: text.slice(0, 1000),
			tags,
			createdAt: new Date().toISOString(),
		};
		this._memories.push(fact);
		await this._persist();
	}

	/** Get all memories (for system-prompt injection). */
	async all(): Promise<{ text: string; tags: string[] }[]> {
		await this._load();
		return this._memories.map(m => ({ text: m.text, tags: m.tags }));
	}

	private async _persist(): Promise<void> {
		const dir = joinPath(this._memoryFile, '..');
		try {
			await this._fileService.createFolder(dir);
		} catch { /* already exists */ }
		const lines = this._memories.map(m => JSON.stringify(m)).join('\n');
		await this._fileService.writeFile(this._memoryFile, VSBuffer.fromString(lines + '\n'));
	}
}