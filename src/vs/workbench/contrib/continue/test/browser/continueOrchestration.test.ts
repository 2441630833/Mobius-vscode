/*---------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import { CancellationTokenSource, CancellationToken } from '../../../../../base/common/cancellation.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { resolveParallelAgentSetting, runParallelResearch, shouldOrchestrateRequest } from '../../browser/continueOrchestration.js';

suite('Continue parallel research routing', () => {
	test('accepts 5-10 as ceilings and defaults invalid settings to 10', () => {
		for (const value of [5, 6, 10]) { assert.strictEqual(resolveParallelAgentSetting(value), value); }
		for (const value of [undefined, 4, 11, 5.5, '10']) { assert.strictEqual(resolveParallelAgentSetting(value), 10); }
	});

	test('shows the deterministic per-specialist report without claiming the main task is complete', async () => {
		const displayed: string[] = [];
		const commands = { executeCommand: async () => ({ text: 'findings', contributionReport: 'Specialist A: analysis completed; Specialist B: failed' }) } as unknown as ICommandService;
		await runParallelResearch(commands, { request: 'research', modelTitle: 'selected', allowWeb: true }, parts => {
			for (const part of parts) { if (part.kind === 'markdownContent') { displayed.push(part.content.value); } }
		}, CancellationToken.None);
		assert.ok(displayed.some(text => text.includes('Specialist A: analysis completed; Specialist B: failed')));
		assert.ok(displayed.at(-1)?.includes('继续实施并验证'));
	});
	test('only complex Agent requests receive preflight research', () => {
		const complex = { enabled: true, agentMode: true, lightweight: false, codeChange: true, investigate: false };
		assert.strictEqual(shouldOrchestrateRequest(complex), true);
		for (const options of [{ ...complex, enabled: false }, { ...complex, agentMode: false }, { ...complex, lightweight: true }, { ...complex, codeChange: false }]) {
			assert.strictEqual(shouldOrchestrateRequest(options), false);
		}
	});

	test('passes selected model, request context and cwd to the real command bridge', async () => {
		let params: Record<string, unknown> | undefined;
		const commands = { executeCommand: async (name: string, args: Record<string, unknown>) => {
			assert.strictEqual(name, 'continue.orchestrateAgents'); params = args; return { text: 'findings' };
		} } as unknown as ICommandService;
		assert.strictEqual(await runParallelResearch(commands, { request: 'research', modelTitle: 'selected', workingDirectory: 'file:///project', allowWeb: false, maxAgents: 5 }, () => {}, CancellationToken.None), 'findings');
		assert.strictEqual(params?.['modelTitle'], 'selected');
		assert.strictEqual(params?.['workingDirectory'], 'file:///project');
		assert.strictEqual(params?.['maxAgents'], 5);
		assert.ok(String(params?.['sharedContext']).includes('research'));
	});

	test('forwards user cancellation to the same run and discards late results', async () => {
		const source = new CancellationTokenSource();
		let runId: string | undefined; let cancelId: string | undefined;
		const commands = { executeCommand: async (name: string, args: { id: string } | string) => {
			if (name === 'continue.cancelAgentOrchestration') { cancelId = args as string; return; }
			runId = (args as { id: string }).id;
			source.cancel();
			return { text: 'late findings' };
		} } as unknown as ICommandService;
		try {
			const result = await runParallelResearch(commands, { request: 'research', modelTitle: 'selected', allowWeb: true }, () => {}, source.token);
			assert.strictEqual(result, undefined);
			assert.strictEqual(cancelId, runId);
		} finally { source.dispose(); }
	});
});
