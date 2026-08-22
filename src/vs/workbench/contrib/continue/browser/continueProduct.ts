/*---------------------------------------------------------------------------------------------
 *  Mobius — product detection helpers
 *--------------------------------------------------------------------------------------------*/

import product from '../../../../platform/product/common/product.js';
import { ExtensionIdentifier } from '../../../../platform/extensions/common/extensions.js';

export const CONTINUE_EXTENSION_ID = 'Continue.continue';
export const CONTINUE_EXTENSION_IDENTIFIER = new ExtensionIdentifier(CONTINUE_EXTENSION_ID);
export const CONTINUE_GAME_AGENT_ID = `${CONTINUE_EXTENSION_ID}.game`;

export function isContinuePhysicalAiIde(): boolean {
	return product.defaultChatAgent?.extensionId === CONTINUE_EXTENSION_ID;
}
