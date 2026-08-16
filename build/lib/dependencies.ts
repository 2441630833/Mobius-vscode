/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import fs from 'fs';
import path from 'path';
import cp from 'child_process';
const root = fs.realpathSync(path.dirname(path.dirname(import.meta.dirname)));

function getNpmProductionDependencies(folder: string): string[] {
	let raw: string;

	try {
		raw = cp.execSync('npm ls --all --omit=dev --parseable', { cwd: folder, encoding: 'utf8', env: { ...process.env, NODE_ENV: 'production' }, stdio: [null, null, null] });
	} catch (err: unknown) {
		const e = err as { message?: string; stdout?: string | Buffer; stderr?: string | Buffer };
		const combined = [e.message, e.stdout?.toString(), e.stderr?.toString()].filter(Boolean).join('\n');

		// npm exits non-zero for any dependency tree mismatch (ELSPROBLEMS); stdout is still usable.
		if (/npm (ERR!|error) code ELSPROBLEMS/.test(combined)) {
			raw = e.stdout?.toString() ?? '';
		} else {
			const regex = /^npm (ERR!|error) .*/gim;
			let match: RegExpExecArray | null;
			let hasDisallowedError = false;

			while ((match = regex.exec(combined)) !== null) {
				const line = match[0];
				if (/invalid: xterm/.test(line)) {
					continue;
				} else if (/invalid:.*@continuedev\//.test(line)) {
					continue;
				} else if (/invalid: core@npm:@continuedev\/core/.test(line)) {
					continue;
				} else if (/extraneous:.*@continuedev\/core/.test(line)) {
					continue;
				} else if (/A complete log of this run/.test(line)) {
					continue;
				} else {
					hasDisallowedError = true;
				}
			}

			if (hasDisallowedError) {
				throw err;
			}

			raw = e.stdout?.toString() ?? '';
		}
	}

	return raw.split(/\r?\n/).filter(line => {
		return !!line.trim() && path.relative(root, line) !== path.relative(root, folder);
	});
}

export function getProductionDependencies(folderPath: string): string[] {
	const result = getNpmProductionDependencies(folderPath);
	// Account for distro npm dependencies
	const realFolderPath = fs.realpathSync(folderPath);
	const relativeFolderPath = path.relative(root, realFolderPath);
	const distroFolderPath = `${root}/.build/distro/npm/${relativeFolderPath}`;

	if (fs.existsSync(distroFolderPath)) {
		result.push(...getNpmProductionDependencies(distroFolderPath));
	}

	return [...new Set(result)];
}

if (import.meta.main) {
	console.log(JSON.stringify(getProductionDependencies(root), null, '  '));
}
