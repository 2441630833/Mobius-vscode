/*---------------------------------------------------------------------------------------------
 *  Mobius — infer Agent / Ask / Plan / Game from the user's prompt
 *--------------------------------------------------------------------------------------------*/

import { coalesce } from '../../../../base/common/arrays.js';
import { MarkdownString } from '../../../../base/common/htmlContent.js';
import { localize } from '../../../../nls.js';
import { URI } from '../../../../base/common/uri.js';
import { ChatMode, IChatMode, IChatModeService, IChatModes } from '../../chat/common/chatModes.js';
import { hasGameDevIntent } from './continueGodotTools.js';

export const MOBIUS_AUTO_MODE_ROUTING_KEY = 'mobius.autoModeRouting.enabled';

/** Fixed Agent / Ask / Plan / Game list for Mobius mode pickers. */
export function getMobiusChatModes(modes: IChatModes): IChatMode[] {
	return coalesce([
		ChatMode.Agent,
		ChatMode.Ask,
		modes.findModeByName('Plan'),
		modes.findModeByName('Game'),
	]);
}

export type MobiusRoutableMode = 'agent' | 'ask' | 'plan' | 'game';

export interface IMobiusModeInference {
	readonly mode: MobiusRoutableMode;
	readonly reason: string;
}

export interface IMobiusModeAutoSwitch {
	readonly fromMode: IChatMode;
	readonly toMode: IChatMode;
	readonly reason: string;
}

const MOBIUS_MODE_SWITCH_REASON_LABELS: Record<string, string> = {
	'question-shape': localize('mobius.modeSwitchReason.question', "read-only question"),
	'plan-keywords': localize('mobius.modeSwitchReason.plan', "planning request"),
	'game-dev-keywords': localize('mobius.modeSwitchReason.game', "game development task"),
	'implementation-keywords': localize('mobius.modeSwitchReason.agent', "implementation task"),
	'slash-override': localize('mobius.modeSwitchReason.slash', "slash command"),
};

export function formatMobiusModeAutoSwitchMessage(switchInfo: IMobiusModeAutoSwitch): MarkdownString {
	const reasonLabel = MOBIUS_MODE_SWITCH_REASON_LABELS[switchInfo.reason] ?? switchInfo.reason;
	return new MarkdownString(
		localize(
			'mobius.modeAutoSwitch',
			"Mode auto switch: **{0}** → **{1}** ({2})",
			switchInfo.fromMode.label.get(),
			switchInfo.toMode.label.get(),
			reasonLabel,
		),
	);
}

/** Copy-paste prompts to manually verify each mode (picker label + behavior). */
export const MOBIUS_MODE_TEST_PROMPTS: Readonly<Record<MobiusRoutableMode, { zh: string; en: string; expect: string }>> = {
	agent: {
		zh: '在 README.md 末尾加一行说明 Mobius 支持 Agent/Ask/Plan/Game 四种模式，直接改文件并保存。',
		en: 'Add one sentence to README.md documenting the four Mobius modes, then save the file.',
		expect: 'Uses write/edit tools; may change the workspace.',
	},
	ask: {
		zh: '解释一下这个仓库里 continue 和 vscode 子模块各自负责什么？不要修改任何文件。',
		en: 'Explain what the continue vs vscode submodules do in this repo. Do not edit any files.',
		expect: 'Read-only answer; no file writes or shell that mutates the repo.',
	},
	plan: {
		zh: '为「Agents 窗口发送失败时自动恢复 draft session」写一份实现方案：涉及哪些文件、步骤和验收标准。先别改代码。',
		en: 'Draft an implementation plan for auto-recovering the draft session when Agents send fails. List files, steps, and acceptance criteria — no edits yet.',
		expect: 'Plan-only guidance; no file writes.',
	},
	game: {
		zh: '用 Godot 在 game-dev/ 里给 Star Catcher 加一颗会旋转的奖励星星，然后 godot_test 和 godot_play 跑通。',
		en: 'In game-dev/, add a spinning bonus star to Star Catcher, then run godot_test and godot_play.',
		expect: 'Godot loop: write under game-dev/, import, test, play.',
	},
};

const SLASH_OVERRIDE = /^\/(agent|ask|plan|game)\b(?:\s|$)/i;

const PLAN_SIGNAL = /\b(plan|roadmap|outline|approach|implementation plan|step[- ]by[- ]step|don't edit|do not edit|without editing|read[- ]only analysis)\b|方案|计划|规划|先别改|不要改|别改代码|先写方案|怎么实现|实现思路/i;
const PLAN_BLOCK = /\b(implement now|just do it|直接改|马上改|立即实现|fix it now|apply the plan now)\b|直接实现/i;

const ASK_SIGNAL = /^(?:\s*(?:explain|what|why|how|when|where|who|is|are|can|does|could|would|describe|compare|difference between)\b|是什么|为什么|怎么理解|解释一下|有什么区别|请问)/i;
const ASK_BLOCK = /\b(implement|fix|add|create|refactor|patch|commit|update|change|modify|write|run|deploy|实现|修复|添加|修改|重构|直接改|帮我改)\b/i;

const AGENT_SIGNAL = /\b(implement|fix|add|create|refactor|patch|commit|update|change|modify|write|build|scaffold|migrate|rename|delete|remove|run tests|apply)\b|实现|修复|添加|修改|重构|直接改|帮我改|创建文件|写代码/i;

export function inferMobiusModeFromPrompt(message: string): IMobiusModeInference | undefined {
	const text = message.trim();
	if (!text) {
		return undefined;
	}

	const slash = text.match(SLASH_OVERRIDE);
	if (slash) {
		return { mode: slash[1]!.toLowerCase() as MobiusRoutableMode, reason: 'slash-override' };
	}

	if (hasGameDevIntent(text)) {
		return { mode: 'game', reason: 'game-dev-keywords' };
	}

	if (PLAN_SIGNAL.test(text) && !PLAN_BLOCK.test(text)) {
		return { mode: 'plan', reason: 'plan-keywords' };
	}

	const looksLikeQuestion = ASK_SIGNAL.test(text) || /\?\s*$/.test(text) || /？\s*$/.test(text);
	if (looksLikeQuestion && !ASK_BLOCK.test(text) && !PLAN_SIGNAL.test(text)) {
		return { mode: 'ask', reason: 'question-shape' };
	}

	if (AGENT_SIGNAL.test(text)) {
		return { mode: 'agent', reason: 'implementation-keywords' };
	}

	return undefined;
}

export async function resolveMobiusChatMode(
	mode: MobiusRoutableMode,
	sessionResource: URI,
	chatModeService: IChatModeService,
): Promise<IChatMode | undefined> {
	if (mode === 'agent') {
		return ChatMode.Agent;
	}
	if (mode === 'ask') {
		return ChatMode.Ask;
	}

	const modes = chatModeService.createModes(sessionResource);
	try {
		await modes.waitForPendingUpdates();
		return mode === 'plan'
			? modes.findModeByName('Plan')
			: modes.findModeByName('Game');
	} finally {
		modes.dispose();
	}
}
