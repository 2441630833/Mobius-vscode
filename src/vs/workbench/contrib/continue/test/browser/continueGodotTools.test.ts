/*---------------------------------------------------------------------------------------------
 *  Mobius — Godot path resolution for installed IDE
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { collectGodotMobiusRootCandidates } from '../../browser/continueGodotTools.js';

suite('Continue Godot tools', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('collectGodotMobiusRootCandidates includes packaged mobius-godot from appRoot', () => {
		const host = {
			fileService: undefined as never,
			workspaceService: { getWorkspace: () => ({ folders: [] }) } as never,
			appRoot: 'C:/Programs/Mobius/resources/app',
		};
		const workspace = URI.file('D:/projects/my-game');
		const candidates = collectGodotMobiusRootCandidates(host, workspace);
		const normalized = candidates.map(c => c.fsPath.replace(/\\/g, '/'));
		assert.ok(
			normalized.some(p => p.endsWith('resources/mobius-godot')),
			`expected mobius-godot candidate, got: ${normalized.join(', ')}`,
		);
		assert.ok(
			normalized.some(p => p.endsWith('Programs/Mobius')),
			'expected install root from appRoot walk',
		);
	});
});
