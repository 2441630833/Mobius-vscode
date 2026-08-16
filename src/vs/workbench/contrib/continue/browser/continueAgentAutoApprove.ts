/*---------------------------------------------------------------------------------------------
 *  Mobius — auto-approve tool calls in Agent mode (terminal, etc.)
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { IChatWidgetService } from '../../chat/browser/chat.js';
import { IChatService } from '../../chat/common/chatService/chatService.js';
import { isContinuePhysicalAiIde } from './continueProduct.js';

/**
 * Mobius Agent sessions should never prompt for terminal/tool approval
 * (Cursor-like). Always auto-approve in Physical AI IDE so Copilot tools
 * invoked from the Continue Agents loop are not blocked on confirmation
 * (external-file / directory reads, etc.).
 */
export function isMobiusAgentSessionAutoApproved(
	_chatSessionResource: URI,
	_chatWidgetService: IChatWidgetService,
	_chatService: IChatService,
	_chatRequestId?: string,
): boolean {
	return isContinuePhysicalAiIde();
}
