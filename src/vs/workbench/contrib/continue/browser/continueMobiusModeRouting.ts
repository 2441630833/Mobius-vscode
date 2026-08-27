/*---------------------------------------------------------------------------------------------
 *  Mobius — infer Agent / Game / Chip from the user's prompt
 *--------------------------------------------------------------------------------------------*/

import { coalesce } from '../../../../base/common/arrays.js';
import { MarkdownString } from '../../../../base/common/htmlContent.js';
import { localize } from '../../../../nls.js';
import { URI } from '../../../../base/common/uri.js';
import { ChatMode, IChatMode, IChatModeService, IChatModes } from '../../chat/common/chatModes.js';
import { hasChipDesignIntent } from './continueChipDesign.js';
import { hasGameDevIntent } from './continueGodotTools.js';
import { isMobiusAgentMode, isMobiusChipMode, isMobiusGameMode } from './continueMobiusModeIcons.js';

export { getMobiusChatModeIcon } from './continueMobiusModeIcons.js';

export const MOBIUS_AUTO_MODE_ROUTING_KEY = 'mobius.autoModeRouting.enabled';

/** Fixed Agent / Game / Chip list for Mobius mode pickers. */
export function getMobiusChatModes(modes: IChatModes): IChatMode[] {
	return coalesce([
		ChatMode.Agent,
		modes.findModeByName('Game'),
		modes.findModeByName('Chip'),
	]);
}

/** Flyout when hovering a mode in the Mobius mode picker. */
export function getMobiusModePickerHoverContent(mode: IChatMode): MarkdownString | undefined {
	const name = mode.name.get();
	if (name === 'Game') {
		return new MarkdownString(
			localize(
				'mobius.modeHover.game',
				"**Game** — build and play games with live preview.\n\n- Describe features in plain language (\"add a shield power-up\", \"make enemies faster\")\n- Agent asks simple design choices when needed, then implements and opens the game\n- Design help and quality checks run automatically — you don't name any of it\n\n_Use **Agent** for non-game coding (README, scripts, refactors)._",
			),
			{ isTrusted: true },
		);
	}
	if (name === 'Chip') {
		return new MarkdownString(
			localize(
				'mobius.modeHover.chip',
				"**Chip** — FPGA physical token sampler under `chip-design/`.\n\n- Edit RTL, lint/simulate, synthesize with Yosys + openXC7 (no Docker), flash Arty A7, sample tokens over UART\n- Thermal-noise TRNG + stochastic softmax — not a software PRNG\n- Does **not** auto-open Godot. Missing board is normal: stay on lint/sim\n\n_Use **Agent** for general coding; **Game** for Godot._",
			),
			{ isTrusted: true },
		);
	}
	if (isMobiusAgentMode(mode)) {
		return new MarkdownString(
			localize(
				'mobius.modeHover.agent',
				"**Agent** — general software development.\n\n- Edit files, terminal, search, todos, multi-step tasks\n- Does **not** auto-open Godot\n\n_Use **Game** for `game-dev/` with live Godot preview. Use **Chip** for FPGA sampling._",
			),
			{ isTrusted: true },
		);
	}
	const desc = mode.description.get();
	return desc ? new MarkdownString(desc, { isTrusted: true }) : undefined;
}

/** Short second line under the mode name in the picker list. */
export function getMobiusModePickerDetailLine(mode: IChatMode): string | undefined {
	if (isMobiusGameMode(mode)) {
		return localize('mobius.modeDetail.game', "Make games · live preview");
	}
	if (isMobiusChipMode(mode)) {
		return localize('mobius.modeDetail.chip', "FPGA sampler · no auto Godot");
	}
	if (isMobiusAgentMode(mode)) {
		return localize('mobius.modeDetail.agent', "General coding · no auto Godot");
	}
	const description = mode.description.get()?.trim();
	return description || undefined;
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

export type MobiusRoutableMode = 'agent' | 'game' | 'chip';

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
	'chip-design-keywords': localize('mobius.modeSwitchReason.chip', "chip design task"),
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
		zh: '在 README.md 末尾加一行说明 Mobius 支持 Agent、Game 和 Chip 三种模式，直接改文件并保存。',
		en: 'Add one sentence to README.md documenting Mobius Agent, Game, and Chip modes, then save the file.',
		expect: 'Uses write/edit tools; may change the workspace.',
	},
	game: {
		zh: '用 Godot 在 game-dev/ 里给 Star Catcher 加一颗会旋转的奖励星星，然后 godot_test 和 godot_play 跑通。',
		en: 'In game-dev/, add a spinning bonus star to Star Catcher, then run godot_test and godot_play.',
		expect: 'Godot loop: write under game-dev/, import, test, play.',
	},
	chip: {
		zh: '在 chip-design/ 里检查 FPGA 采样器工具链，先 fpga_detect，再 lint/simulate RTL。不要打开 Godot。',
		en: 'In chip-design/, detect the FPGA sampler toolchain, then lint and simulate the RTL. Do not open Godot.',
		expect: 'FPGA loop: detect, lint, simulate; no Godot.',
	},
};

const SLASH_OVERRIDE = /^\/(agent|game|chip|ask|plan)\b(?:\s|$)/i;

const AGENT_SIGNAL = /\b(implement|fix|add|create|refactor|patch|commit|update|change|modify|write|build|scaffold|migrate|rename|delete|remove|run tests|apply)\b|实现|修复|添加|修改|重构|直接改|帮我改|创建文件|写代码/i;

export function inferMobiusModeFromPrompt(message: string): IMobiusModeInference | undefined {
	const text = message.trim();
	if (!text) {
		return undefined;
	}

	const slash = text.match(SLASH_OVERRIDE);
	if (slash) {
		const raw = slash[1]!.toLowerCase();
		if (raw === 'game') {
			return { mode: 'game', reason: 'slash-override' };
		}
		if (raw === 'chip') {
			return { mode: 'chip', reason: 'slash-override' };
		}
		return { mode: 'agent', reason: 'slash-override' };
	}

	if (hasChipDesignIntent(text)) {
		return { mode: 'chip', reason: 'chip-design-keywords' };
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
		return mode === 'chip' ? modes.findModeByName('Chip') : modes.findModeByName('Game');
	} finally {
		modes.dispose();
	}
}
