/*---------------------------------------------------------------------------------------------
 *  Mobius — Offline detection and search_web gating unit tests
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { isNetworkOnline, checkNetworkOnline, setNetworkOnlineForTesting, recordNetworkFailure } from '../../browser/continueNetworkStatus.js';
import { hasWebSearchIntent } from '../../browser/continueSkillsContext.js';
import { loadContinueAgentTools, invokeContinueBuiltInTool } from '../../browser/continueAgentToolsBridge.js';
import { loadAgentToolSuperset } from '../../browser/continueCopilotToolsBridge.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { ILanguageModelToolsService } from '../../../chat/common/tools/languageModelToolsService.js';

suite('Continue Network Status & Search Web Gating', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	teardown(() => {
		setNetworkOnlineForTesting(undefined);
	});

	test('isNetworkOnline reflects testing override', () => {
		setNetworkOnlineForTesting(true);
		assert.strictEqual(isNetworkOnline(), true);

		setNetworkOnlineForTesting(false);
		assert.strictEqual(isNetworkOnline(), false);
	});

	test('checkNetworkOnline reflects testing override', async () => {
		setNetworkOnlineForTesting(false);
		assert.strictEqual(await checkNetworkOnline(), false);

		setNetworkOnlineForTesting(true);
		assert.strictEqual(await checkNetworkOnline(), true);
	});

	test('recordNetworkFailure sets status to offline', () => {
		setNetworkOnlineForTesting(undefined);
		recordNetworkFailure();
		assert.strictEqual(isNetworkOnline(), false);
	});

	test('hasWebSearchIntent returns false when network is offline', () => {
		setNetworkOnlineForTesting(true);
		assert.strictEqual(hasWebSearchIntent('请搜索一下最新的英伟达模型信息'), true);
		assert.strictEqual(hasWebSearchIntent('What is the latest release of Python?'), true);

		// Switch to offline
		setNetworkOnlineForTesting(false);
		assert.strictEqual(hasWebSearchIntent('请搜索一下最新的英伟达模型信息'), false);
		assert.strictEqual(hasWebSearchIntent('What is the latest release of Python?'), false);
		assert.strictEqual(hasWebSearchIntent('search the web for current weather'), false);

		// Switch back to online
		setNetworkOnlineForTesting(true);
		assert.strictEqual(hasWebSearchIntent('请搜索一下最新的英伟达模型信息'), true);
	});

	test('loadContinueAgentTools excludes search_web when offline', async () => {
		const mockCommandService = {
			executeCommand: async () => [],
		} as unknown as ICommandService;

		setNetworkOnlineForTesting(true);
		const onlineTools = await loadContinueAgentTools(mockCommandService);
		assert.ok(onlineTools.some(t => t.function.name === 'search_web'), 'Expected search_web in online tools');

		setNetworkOnlineForTesting(false);
		const offlineTools = await loadContinueAgentTools(mockCommandService);
		assert.ok(!offlineTools.some(t => t.function.name === 'search_web'), 'Expected search_web excluded in offline tools');
	});

	test('loadAgentToolSuperset excludes search_web when offline', async () => {
		const mockCommandService = {
			executeCommand: async () => [],
		} as unknown as ICommandService;
		const mockToolsService = {
			getTool: () => undefined,
			hasToolImplementation: () => false,
			getAllToolsIncludingDisabled: () => [],
		} as unknown as ILanguageModelToolsService;

		setNetworkOnlineForTesting(true);
		const onlineTools = await loadAgentToolSuperset(mockToolsService, mockCommandService);
		assert.ok(onlineTools.some(t => t.function.name === 'search_web'), 'Expected search_web in superset when online');

		setNetworkOnlineForTesting(false);
		const offlineTools = await loadAgentToolSuperset(mockToolsService, mockCommandService);
		assert.ok(!offlineTools.some(t => t.function.name === 'search_web'), 'Expected search_web excluded from superset when offline');
	});

	test('invokeContinueBuiltInTool blocks search_web immediately when offline', async () => {
		let commandExecuted = false;
		const mockCommandService = {
			executeCommand: async () => {
				commandExecuted = true;
				return { ok: true, contextItems: [] };
			},
		} as unknown as ICommandService;

		setNetworkOnlineForTesting(false);
		const result = await invokeContinueBuiltInTool(
			mockCommandService,
			'search_web',
			{ query: 'test' },
			'call-1',
		);
		assert.strictEqual(commandExecuted, false, 'Command should not be called when offline');
		assert.strictEqual(result.ok, false);
		assert.ok(result.text.includes('disabled') || result.text.includes('offline'));
	});
});
