/*---------------------------------------------------------------------------------------------
 *  Mobius — Ant Design Outlined SVG icons for Agent / Game mode pickers
 *  (does not depend on codicon.ttf having game/agent glyphs)
 *--------------------------------------------------------------------------------------------*/

import { ThemeIcon } from '../../../../base/common/themables.js';
import { ChatMode, IChatMode } from '../../chat/common/chatModes.js';
import { CONTINUE_GAME_AGENT_ID } from './continueProduct.js';

/** Registered in continue.contribution.ts — styled via continueMobiusModeIcons.css */
export const MOBIUS_MODE_AGENT_ICON = ThemeIcon.fromId('mobius-mode-agent');
export const MOBIUS_MODE_GAME_ICON = ThemeIcon.fromId('mobius-mode-game');

export function isMobiusGameMode(mode: IChatMode): boolean {
	const name = mode.name.get().toLowerCase();
	return mode.id === CONTINUE_GAME_AGENT_ID || name === 'game';
}

export function isMobiusAgentMode(mode: IChatMode): boolean {
	const name = mode.name.get().toLowerCase();
	return mode.id === ChatMode.Agent.id || name === 'agent';
}

/** Ant Design Outlined-style icon for Mobius Agent / Game pickers. */
export function getMobiusChatModeIcon(mode: IChatMode): ThemeIcon {
	if (isMobiusGameMode(mode)) {
		return MOBIUS_MODE_GAME_ICON;
	}
	if (isMobiusAgentMode(mode)) {
		return MOBIUS_MODE_AGENT_ICON;
	}
	return mode.icon.get() ?? MOBIUS_MODE_AGENT_ICON;
}
