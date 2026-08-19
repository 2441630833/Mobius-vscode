/*---------------------------------------------------------------------------------------------
 *  Mobius — infer Agent / Game from the user's prompt
 *--------------------------------------------------------------------------------------------*/

import { coalesce } from '../../../../base/common/arrays.js';
import { MarkdownString } from '../../../../base/common/htmlContent.js';
import { localize } from '../../../../nls.js';
import { URI } from '../../../../base/common/uri.js';
import { ChatMode, IChatMode, IChatModeService, IChatModes } from '../../chat/common/chatModes.js';
import { hasGameDevIntent } from './continueGodotTools.js';

export const MOBIUS_AUTO_MODE_ROUTING_KEY = 'mobius.autoModeRouting.enabled';

/** Fixed Agent / Game list for Mobius mode pickers. */
export function getMobiusChatModes(modes: IChatModes): IChatMode[] {
	return coalesce([
		ChatMode.Agent,
		modes.findModeByName('Game'),
	]);
}

/** Flyout when hovering a mode in the Mobius mode picker. */
export function getMobiusModePickerHoverContent(mode: IChatMode): MarkdownString | undefined {
	const name = mode.name.get();
	if (name === 'Game') {
		return new MarkdownString(
			localize(
				'mobius.modeHover.game',
				"**Game** — Godot game development with **live preview**.\n\n- Auto-opens Godot **editor** + **game window** while the agent edits `game-dev/`\n- Watch hot-reload; play with **arrow keys** (no autopilot)\n- Runs `godot_import` → `godot_test` → `godot_play`\n- Press **Stop** anytime to change direction\n\n_Use **Agent** for general coding (no auto Godot)._",
			),
			{ isTrusted: true },
		);
	}
	if (mode.id === ChatMode.Agent.id || name.toLowerCase() === 'agent') {
		return new MarkdownString(
			localize(
				'mobius.modeHover.agent',
				"**Agent** — general software development.\n\n- Edit files, terminal, search, todos, multi-step tasks\n- Does **not** auto-open Godot\n\n_Use **Game** for `game-dev/` with live Godot preview._",
			),
			{ isTrusted: true },
		);
	}
	const desc = mode.description.get();
	return desc ? new MarkdownString(desc, { isTrusted: true }) : undefined;
}

/** Short second line under the mode name in the picker list. */
export function getMobiusModePickerDetailLine(mode: IChatMode): string | undefined {
	if (mode.name.get() === 'Game') {
		return localize('mobius.modeDetail.game', "Godot live preview · game-dev/");
	}
	if (mode.id === ChatMode.Agent.id) {
		return localize('mobius.modeDetail.agent', "General coding · no auto Godot");
	}
	return undefined;
}

const MOBIUS_LEGACY_MODE_NAMES = new Set(['ask', 'plan', 'edit']);

/** Map retired Ask/Plan/Edit picker entries to Agent for old sessions. */
export function normalizeMobiusChatMode(mode: IChatMode | undefined): IChatMode {
	if (!mode) {
		return ChatMode.Agent;
	}
	if (mode.id === ChatMode.Ask.id || MOBIUS_LEGACY_MODE_NAMES.has(mode.name.get().toLowerCase())) {
		return ChatMode.Agent;
	}
	return mode;
}

export type MobiusRoutableMode = 'agent' | 'game';

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
		zh: '在 README.md 末尾加一行说明 Mobius 支持 Agent 和 Game 两种模式，直接改文件并保存。',
		en: 'Add one sentence to README.md documenting Mobius Agent and Game modes, then save the file.',
		expect: 'Uses write/edit tools; may change the workspace.',
	},
	game: {
		zh: '用 Godot 在 game-dev/ 里给 Star Catcher 加一颗会旋转的奖励星星，然后 godot_test 和 godot_play 跑通。',
		en: 'In game-dev/, add a spinning bonus star to Star Catcher, then run godot_test and godot_play.',
		expect: 'Godot loop: write under game-dev/, import, test, play.',
	},
};

const SLASH_OVERRIDE = /^\/(agent|game|ask|plan)\b(?:\s|$)/i;

const AGENT_SIGNAL = /\b(implement|fix|add|create|refactor|patch|commit|update|change|modify|write|build|scaffold|migrate|rename|delete|remove|run tests|apply)\b|实现|修复|添加|修改|重构|直接改|帮我改|创建文件|写代码/i;

export function inferMobiusModeFromPrompt(message: string): IMobiusModeInference | undefined {
	const text = message.trim();
	if (!text) {
		return undefined;
	}

	const slash = text.match(SLASH_OVERRIDE);
	if (slash) {
		const raw = slash[1]!.toLowerCase();
		return {
			mode: raw === 'game' ? 'game' : 'agent',
			reason: 'slash-override',
		};
	}

	if (hasGameDevIntent(text)) {
		return { mode: 'game', reason: 'game-dev-keywords' };
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

	const modes = chatModeService.createModes(sessionResource);
	try {
		await modes.waitForPendingUpdates();
		return modes.findModeByName('Game');
	} finally {
		modes.dispose();
	}
}
