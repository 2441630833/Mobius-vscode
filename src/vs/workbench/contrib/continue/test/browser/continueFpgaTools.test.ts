/*---------------------------------------------------------------------------------------------
 *  Mobius — FPGA path resolution for installed IDE
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { collectFpgaMobiusRootCandidates } from '../../browser/continueFpgaTools.js';

suite('Continue FPGA tools', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('collectFpgaMobiusRootCandidates includes packaged mobius-chip from appRoot', () => {
		const host = {
			fileService: undefined as never,
			workspaceService: { getWorkspace: () => ({ folders: [] }) } as never,
			appRoot: 'C:/Programs/Mobius/resources/app',
		};
		const workspace = URI.file('D:/projects/my-chip-design');
		const candidates = collectFpgaMobiusRootCandidates(host, workspace);
		const normalized = candidates.map(c => c.fsPath.replace(/\\/g, '/'));
		assert.ok(
			normalized.some(p => p.endsWith('resources/mobius-chip')),
			`expected mobius-chip candidate, got: ${normalized.join(', ')}`,
		);
		assert.ok(
			normalized.some(p => p.endsWith('Programs/Mobius')),
			'expected install root from appRoot walk',
		);
	});

	test('packaged mobius-chip is probed before appRoot walk-up', () => {
		const host = {
			fileService: undefined as never,
			workspaceService: { getWorkspace: () => ({ folders: [] }) } as never,
			appRoot: 'C:/Programs/Mobius/resources/app',
		};
		const candidates = collectFpgaMobiusRootCandidates(host, undefined);
		const first = candidates[0].fsPath.replace(/\\/g, '/');
		assert.ok(
			first.endsWith('resources/mobius-chip'),
			`expected mobius-chip first, got: ${first}`,
		);
	});
});
