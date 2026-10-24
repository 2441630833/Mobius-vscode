/*---------------------------------------------------------------------------------------------
 *  Mobius — Continue Agent Harness Adapter
 *  Wraps the default Continue agent loop into the pluggable harness interface.
 *--------------------------------------------------------------------------------------------*/

import { IChatAgentResult } from '../../chat/common/participants/chatAgents.js';
import { IMobiusAgentHarness, IMobiusHarnessTurnContext } from './continueAgentHarness.js';

export class ContinueAgentHarness implements IMobiusAgentHarness {
	readonly id = 'continue';
	readonly name = 'Continue Agent Harness';
	readonly description = 'Built-in Continue agent harness for chat, inline editing, and multi-mode workflows.';
	readonly version = '1.0.0';

	readonly capabilities = {
		supportsLoopGuards: false,
		supportsEventLifecycle: false,
		supportsModularPrompts: true,
		supportsWorkingMemory: false,
	};

	constructor(
		private readonly _fallbackExecutor?: (context: IMobiusHarnessTurnContext) => Promise<IChatAgentResult>,
	) { }

	async executeTurn(context: IMobiusHarnessTurnContext): Promise<IChatAgentResult> {
		if (this._fallbackExecutor) {
			return this._fallbackExecutor(context);
		}
		return {};
	}
}
