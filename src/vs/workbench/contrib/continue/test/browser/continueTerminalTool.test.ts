/*---------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import { CancellationToken, CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { URI } from '../../../../../base/common/uri.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { ILanguageModelToolsService } from '../../../chat/common/tools/languageModelToolsService.js';
import { executeRunTerminalCommand } from '../../browser/continueTerminalTool.js';

suite('Continue terminal command waiting', () => {
	const context = { sessionResource: URI.parse('test:session') };

	for (const wait of [true, false]) {
		test(`bounds ${wait ? 'sync' : 'async'} waiting and preserves native background output`, async () => {
			let fallbackCalls = 0;
			const tools = {
				getTool: () => ({}),
				invokeTool: async (invocation: { parameters: { mode: string; timeout: number } }) => {
					assert.strictEqual(invocation.parameters.mode, wait ? 'sync' : 'async');
					assert.strictEqual(invocation.parameters.timeout, wait ? 60_000 : 10_000);
					return { content: [{ kind: 'text', value: 'Still running. Terminal ID: abc. Partial output.' }] };
				},
			} as unknown as ILanguageModelToolsService;
			const commands = { executeCommand: async () => { fallbackCalls++; } } as unknown as ICommandService;
			const result = await executeRunTerminalCommand(tools, new NullLogService(), context, 'sleep 120', wait, CancellationToken.None, commands);
			assert.strictEqual(result.ok, true);
			assert.ok(result.text.includes('Terminal ID: abc'));
			assert.strictEqual(fallbackCalls, 0);
		});
	}

	test('does not invoke a command already cancelled', async () => {
		const tools = { getTool: () => { throw new Error('must not look up tools'); } } as unknown as ILanguageModelToolsService;
		const result = await executeRunTerminalCommand(tools, new NullLogService(), context, 'echo test', true, CancellationToken.Cancelled);
		assert.strictEqual(result.ok, false);
		assert.match(result.text, /cancelled/);
	});

	test('does not rerun through fallback after native cancellation', async () => {
		const source = new CancellationTokenSource();
		let fallbackCalls = 0;
		const tools = {
			getTool: () => ({}),
			invokeTool: async () => { source.cancel(); throw new Error('cancelled'); },
		} as unknown as ILanguageModelToolsService;
		const commands = { executeCommand: async () => { fallbackCalls++; } } as unknown as ICommandService;
		try {
			const result = await executeRunTerminalCommand(tools, new NullLogService(), context, 'echo test', true, source.token, commands);
			assert.strictEqual(result.ok, false);
			assert.strictEqual(fallbackCalls, 0);
		} finally { source.dispose(); }
	});

	test('retains fallback when native invocation fails without cancellation', async () => {
		const tools = { getTool: () => ({}), invokeTool: async () => { throw new Error('unavailable'); } } as unknown as ILanguageModelToolsService;
		const commands = { executeCommand: async (name: string, request: { arguments: { waitForCompletion: boolean } }) => {
			assert.strictEqual(name, 'continue.callBuiltInTool');
			assert.strictEqual(request.arguments.waitForCompletion, false);
			return { ok: true, text: 'fallback output' };
		} } as unknown as ICommandService;
		const result = await executeRunTerminalCommand(tools, new NullLogService(), context, 'echo test', false, CancellationToken.None, commands);
		assert.deepStrictEqual(result, { ok: true, text: 'fallback output' });
	});
});
