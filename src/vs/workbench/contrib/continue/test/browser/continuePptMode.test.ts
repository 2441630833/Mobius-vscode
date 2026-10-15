/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { FileAccess } from '../../../../../base/common/network.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { loadPptMasterSkill, pptModeSystemHint } from '../../browser/continuePptMode.js';

function skillFiles(files: Map<string, string>, reads: URI[] = []): Pick<IFileService, 'readFile'> {
	return {
		readFile: async resource => {
			reads.push(resource);
			const content = files.get(resource.toString());
			if (content === undefined) {
				throw new Error('File not found');
			}
			return { resource, value: VSBuffer.fromString(content) } as Awaited<ReturnType<IFileService['readFile']>>;
		},
	};
}

suite('Continue PPT mode', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('loads the installed skill without any presentation workspace files', async () => {
		const directory = FileAccess.asFileUri('vs/workbench/contrib/continue/mobius/skills/ppt-master');
		const skill = await loadPptMasterSkill(skillFiles(new Map([
			[URI.joinPath(directory, 'SKILL.md').toString(), '# PPT Master\nFollow the workflow.'],
		])), undefined);
		assert.deepStrictEqual(skill, { directory, instructions: '# PPT Master\nFollow the workflow.' });
	});

	test('falls back to appRoot for installations whose resource base differs', async () => {
		const appRoot = URI.file('/Programs/Mobius with spaces/resources/app');
		const directory = URI.joinPath(appRoot, 'out/vs/workbench/contrib/continue/mobius/skills/ppt-master');
		const skill = await loadPptMasterSkill(skillFiles(new Map([
			[URI.joinPath(directory, 'SKILL.md').toString(), 'Skill body'],
		])), appRoot.fsPath);
		assert.deepStrictEqual(skill, { directory, instructions: 'Skill body' });
	});

	test('missing resources never cause workspace-relative probes', async () => {
		const reads: URI[] = [];
		const skill = await loadPptMasterSkill(skillFiles(new Map(), reads), '/Programs/Mobius/resources/app');
		assert.strictEqual(skill, undefined);
		assert.ok(reads.length > 0 && reads.every(uri => uri.path.endsWith('/mobius/skills/ppt-master/SKILL.md') && !uri.path.includes('/.agents/')));
	});

	test('rejects empty skill files', async () => {
		const entry = FileAccess.asFileUri('vs/workbench/contrib/continue/mobius/skills/ppt-master/SKILL.md');
		assert.strictEqual(await loadPptMasterSkill(skillFiles(new Map([[entry.toString(), '  \n']])), undefined), undefined);
	});

	test('prompt provides absolute paths and the actual skill instructions', () => {
		const directory = URI.file('/Programs/Mobius with spaces/skills/ppt-master');
		const hint = pptModeSystemHint({ directory, instructions: '# Actual workflow\nRun the integrity gate first.' });
		assert.ok(hint.includes(JSON.stringify(directory.fsPath.replace(/\\/g, '/'))));
		assert.ok(hint.includes('/SKILL.md') && hint.includes('# Actual workflow\nRun the integrity gate first.'));
		assert.ok(!hint.includes('.agents/skills/ppt-master'));
	});
});
