/*---------------------------------------------------------------------------------------------
 *  Mobius — ECC workflow & agent integration tests
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { ILanguageModelToolsService } from '../../../chat/common/tools/languageModelToolsService.js';
import {
	collectEccCandidates,
	ECC_ROOT_FOLDER,
	ECC_BRIDGE_TOOL_DEFINITIONS,
	executeEccPreflight,
	executeEccTool,
	findEccRootUri,
	isEccTool,
	PACKAGED_ECC_FOLDER,
	quotePs,
	resolveEccRootUri,
} from '../../browser/continueEccWorkflow.js';

suite('ContinueEccWorkflow', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('ECC_ROOT_FOLDER is ECC', () => {
		assert.strictEqual(ECC_ROOT_FOLDER, 'ECC');
	});

	test('resolveEccRootUri checks workspace folders', () => {
		const mockWorkspace = {
			getWorkspace: () => ({
				folders: [{ uri: URI.file('E:/MobiusCode/Mobius') }],
			}),
		} as unknown as IWorkspaceContextService;

		const uri = resolveEccRootUri(undefined, mockWorkspace);
		assert.ok(uri);
		assert.strictEqual(uri.fsPath.replace(/\\/g, '/').endsWith('/ECC'), true);
	});

	test('quotePs escapes PowerShell arguments properly', () => {
		assert.strictEqual(quotePs('status'), 'status');
		assert.strictEqual(quotePs('hello world'), "'hello world'");
		assert.strictEqual(quotePs("can't stop"), "'can''t stop'");
	});

	test('isEccTool identifies all ECC agent tools', () => {
		assert.strictEqual(isEccTool('ecc_run'), true);
		assert.strictEqual(isEccTool('ecc_consult'), true);
		assert.strictEqual(isEccTool('ecc_skill'), true);
		assert.strictEqual(isEccTool('ecc'), true);
		assert.strictEqual(isEccTool('read_file'), false);
		assert.strictEqual(isEccTool('fpga_detect'), false);
	});

	test('ECC_BRIDGE_TOOL_DEFINITIONS registers required tools', () => {
		const names = ECC_BRIDGE_TOOL_DEFINITIONS.map(s => s.function.name);
		assert.ok(names.includes('ecc_run'));
		assert.ok(names.includes('ecc_consult'));
		assert.ok(names.includes('ecc_skill'));
	});

	test('executeEccTool handles ecc_skill reading SKILL.md via fileService', async () => {
		const mockFileService = {
			exists: async (uri: URI) => uri.path.endsWith('SKILL.md'),
			readFile: async (uri: URI) => ({
				value: { toString: () => '# Test Skill\nInstructions here' },
			}),
		};
		const mockWorkspace = {
			getWorkspace: () => ({
				folders: [{ uri: URI.file('E:/MobiusCode/Mobius') }],
			}),
		} as unknown as IWorkspaceContextService;

		const tools = {} as ILanguageModelToolsService;
		const logService = new NullLogService();
		const context = {
			sessionResource: URI.parse('test:session'),
			workingDirectory: URI.file('E:/MobiusCode/Mobius'),
		};

		const result = await executeEccTool(
			{ fileService: mockFileService as any, workspaceService: mockWorkspace },
			tools,
			logService,
			context,
			'ecc_skill',
			{ skill_name: 'security' },
			CancellationToken.None,
		);

		assert.strictEqual(result.ok, true);
		assert.ok(result.text.includes('# Test Skill'));
	});

	test('executeEccPreflight parses JSON output from preflight runner', async () => {
		const eccRoot = URI.file('E:/MobiusCode/Mobius/ECC');
		const mockRequest = {
			message: 'refactor code and run tests',
			requestId: 'req-1',
			sessionResource: URI.parse('test:session'),
		} as any;

		const jsonPayload = JSON.stringify({
			ok: true,
			summary: 'ECC Preflight: Active (Stack: javascript | Skills: `security`)',
			systemPrompt: '<ecc-context><ecc-status readiness="active" /></ecc-context>',
			matchedSkills: ['security'],
			matchedAgents: ['refactor-cleaner'],
		});

		const mockToolsService = {
			getTool: () => ({}),
			invokeTool: async () => ({
				content: [{ kind: 'text', value: jsonPayload }],
			}),
		} as unknown as ILanguageModelToolsService;

		const result = await executeEccPreflight(
			eccRoot,
			mockRequest,
			URI.file('E:/MobiusCode/Mobius'),
			mockToolsService,
			new NullLogService(),
			CancellationToken.None,
		);

		assert.strictEqual(result.ok, true);
		assert.ok(result.summary.includes('ECC Preflight: Active'));
		assert.ok(result.systemPrompt.includes('<ecc-context>'));
		assert.deepStrictEqual(result.matchedSkills, ['security']);
		assert.deepStrictEqual(result.matchedAgents, ['refactor-cleaner']);
	});
	test('failed preflight does not invent an engineering workflow', async () => {
		const result = await executeEccPreflight(
			URI.file('/project/ECC'),
			{ message: 'Fix the existing approval tab', requestId: 'failure', sessionResource: URI.parse('test:session') } as any,
			URI.file('/project'),
			{ getTool: () => undefined } as any,
			new NullLogService(), CancellationToken.None,
		);
		assert.strictEqual(result.ok, false);
		assert.strictEqual(result.systemPrompt, '');
		assert.deepStrictEqual(result.matchedSkills, []);
	});

	test('collectEccCandidates includes packaged mobius-ecc from appRoot', () => {
		const mockWorkspace = {
			getWorkspace: () => ({ folders: [] }),
		} as unknown as IWorkspaceContextService;
		const candidates = collectEccCandidates(undefined, mockWorkspace, 'C:/Users/user/AppData/Local/Programs/Mobius/resources/app');
		const hasPackaged = candidates.some(c => c.path.includes(PACKAGED_ECC_FOLDER));
		assert.strictEqual(hasPackaged, true);
	});

	test('findEccRootUri finds staged package.json', async () => {
		const mockFileService = {
			exists: async (uri: URI) => uri.path.includes('mobius-ecc') && uri.path.endsWith('package.json'),
		} as any;
		const mockWorkspace = {
			getWorkspace: () => ({ folders: [] }),
		} as unknown as IWorkspaceContextService;
		const root = await findEccRootUri(mockFileService, undefined, mockWorkspace, 'C:/Programs/Mobius/resources/app');
		assert.ok(root);
		assert.strictEqual(root.path.includes('mobius-ecc'), true);
	});
});
