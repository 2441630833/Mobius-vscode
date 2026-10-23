/*---------------------------------------------------------------------------------------------
 *  Mobius — Offline detection and search_web gating unit tests
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { isWebSearchEnabled } from '../../browser/continueWebSearch.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { isNetworkOnline, checkNetworkOnline, setNetworkOnlineForTesting, recordNetworkFailure } from '../../browser/continueNetworkStatus.js';
import { hasWebSearchIntent } from '../../browser/continueSkillsContext.js';
import { loadContinueAgentTools, invokeContinueBuiltInTool, invokeContinueClientEditTool } from '../../browser/continueAgentToolsBridge.js';
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
	test('Web Search defaults on and follows configuration changes', async () => {
		const configuration = new TestConfigurationService();
		assert.strictEqual(isWebSearchEnabled(configuration), true);
		await configuration.setUserConfiguration('continue.webSearch.enabled', false);
		assert.strictEqual(isWebSearchEnabled(configuration), false);
		await configuration.setUserConfiguration('continue.webSearch.enabled', true);
		assert.strictEqual(isWebSearchEnabled(configuration), true);
	});

	test('disabled Web Search removes extension tools and superset search but keeps URL fetching', async () => {
		setNetworkOnlineForTesting(true);
		const configuration = new TestConfigurationService({ continue: { webSearch: { enabled: false } } });
		const commands = {
			executeCommand: async () => [{ type: 'function', function: { name: 'search_web' } }],
		} as unknown as ICommandService;
		const tools = {
			getTool: () => undefined, hasToolImplementation: () => false,
			getAllToolsIncludingDisabled: () => [],
		} as unknown as ILanguageModelToolsService;
		for (const schemas of [
			await loadContinueAgentTools(commands, undefined, configuration),
			await loadAgentToolSuperset(tools, commands, undefined, configuration),
		]) {
			assert.ok(!schemas.some(t => t.function.name === 'search_web'));
			assert.ok(schemas.some(t => t.function.name === 'fetch_webpage'));
		}
		await configuration.setUserConfiguration('continue.webSearch.enabled', true);
		assert.ok((await loadAgentToolSuperset(tools, commands, undefined, configuration))
			.some(t => t.function.name === 'search_web'));
	});

	test('pending search is blocked after toggling off and resumes after toggling on', async () => {
		setNetworkOnlineForTesting(true);
		const configuration = new TestConfigurationService();
		let executions = 0;
		const commands = {
			executeCommand: async () => { executions++; return { ok: true, contextItems: [] }; },
		} as unknown as ICommandService;
		const search = () => invokeContinueBuiltInTool(commands, 'search_web', { query: 'latest release' }, 'pending', undefined, configuration);
		assert.strictEqual((await search()).ok, true);
		await configuration.setUserConfiguration('continue.webSearch.enabled', false);
		assert.strictEqual((await search()).ok, false);
		assert.strictEqual(executions, 1);
		assert.strictEqual((await invokeContinueBuiltInTool(commands, 'fetch_webpage', { url: 'https://example.com' }, 'url', undefined, configuration)).ok, true);
		await configuration.setUserConfiguration('continue.webSearch.enabled', true);
		assert.strictEqual((await search()).ok, true);
		assert.strictEqual(executions, 3);
	});

	test('retired parallel research and restored aliases never execute through either bridge', async () => {
		let executions = 0;
		const commands = { executeCommand: async () => { executions++; return { ok: true, contextItems: [] }; } } as unknown as ICommandService;
		for (const name of ['orchestrate_agents', 'orchestrateAgents', 'continue.orchestrateAgents', 'continue_orchestrate_agents', 'list_a2a_agents', 'call_a2a_agent']) {
			for (const invoke of [invokeContinueBuiltInTool, invokeContinueClientEditTool]) {
				const result = await invoke(commands, name, { request: 'Research' }, 'restored');
				assert.strictEqual(result.ok, false);
				assert.ok(result.text.includes('Continue the original task directly'));
			}
		}
		assert.strictEqual(executions, 0);
		assert.strictEqual((await invokeContinueBuiltInTool(commands, 'read_file', { filepath: 'src/app.ts' }, 'read')).ok, true);
		assert.strictEqual(executions, 1);
	});

	test('parallel research is absent from extension and native tool catalogs, even with old settings enabled', async () => {
		setNetworkOnlineForTesting(true);
		const configuration = new TestConfigurationService({ continue: { multiAgent: { enabled: true } } });
		const commands = { executeCommand: async () => [
			{ type: 'function', function: { name: 'orchestrate_agents' } },
			{ type: 'function', function: { name: 'read_file' } },
		] } as unknown as ICommandService;
		const tools = {
			getTool: () => undefined, hasToolImplementation: () => false,
			getAllToolsIncludingDisabled: () => [{ id: 'continue.orchestrateAgents', modelDescription: 'Old orchestration tool', inputSchema: { type: 'object' } }],
		} as unknown as ILanguageModelToolsService;
		for (const schemas of [await loadContinueAgentTools(commands, undefined, configuration), await loadAgentToolSuperset(tools, commands, undefined, configuration)]) {
			assert.ok(!schemas.some(t => /orchestrat/i.test(t.function.name)));
			assert.ok(schemas.some(t => ['read_file', 'readFile'].includes(t.function.name)));
		}
	});

});
