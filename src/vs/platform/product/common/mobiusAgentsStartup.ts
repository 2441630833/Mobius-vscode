/*---------------------------------------------------------------------------------------------
 *  Mobius — default Agents window on startup when no workspace paths are provided.
 *--------------------------------------------------------------------------------------------*/

import { NativeParsedArgs } from '../../environment/common/argv.js';

const MOBIUS_CHAT_AGENT_EXTENSION_ID = 'Continue.continue';

export function isMobiusProduct(defaultChatAgentExtensionId: string | undefined): boolean {
	return defaultChatAgentExtensionId === MOBIUS_CHAT_AGENT_EXTENSION_ID;
}

/**
 * Mobius opens the Agents window (not the IDE window) when launched without
 * file/folder paths — matching Cursor-like agent-first startup.
 */
export function shouldDefaultToAgentsWindow(args: NativeParsedArgs, defaultChatAgentExtensionId: string | undefined): boolean {
	if (!isMobiusProduct(defaultChatAgentExtensionId)) {
		return false;
	}
	if (args['agents'] || args.extensionDevelopmentPath || args['new-window']) {
		return false;
	}
	if (args._.length || args['folder-uri'] || args['file-uri']) {
		return false;
	}
	return true;
}
