/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs/promises';
import * as path from 'path';
import { x } from 'tar';

/** Ship the pinned, complete skill without depending on an ignored developer checkout. */
export async function stageMobiusPptMaster(outDir: string): Promise<void> {
	const root = path.resolve(import.meta.dirname, '../..');
	const destination = path.resolve(root, outDir, 'vs/workbench/contrib/continue/mobius/skills');
	await fs.mkdir(destination, { recursive: true });
	await x({
		file: path.join(root, 'resources/ppt-master/ppt-master-6.7.0.tar.gz'),
		cwd: destination,
		strict: true,
	});
	await fs.access(path.join(destination, 'ppt-master/SKILL.md'));
}
