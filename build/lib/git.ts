/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import path from 'path';
import fs from 'fs';

function resolveGitDir(repo: string): string | undefined {
	const gitPath = path.join(repo, '.git');

	try {
		const stat = fs.statSync(gitPath);
		if (stat.isDirectory()) {
			return gitPath;
		}

		if (stat.isFile()) {
			const gitfile = fs.readFileSync(gitPath, 'utf8').trim();
			const gitdirMatch = /^gitdir:\s*(.+)$/i.exec(gitfile);
			if (!gitdirMatch) {
				return undefined;
			}

			const gitdir = gitdirMatch[1];
			return path.isAbsolute(gitdir) ? gitdir : path.resolve(repo, gitdir);
		}
	} catch (e) {
		// noop
	}

	return undefined;
}

/**
 * Returns the sha1 commit version of a repository or undefined in case of failure.
 */
export function getVersion(repo: string): string | undefined {
	const git = resolveGitDir(repo);
	if (!git) {
		return undefined;
	}

	const headPath = path.join(git, 'HEAD');
	let head: string;

	try {
		head = fs.readFileSync(headPath, 'utf8').trim();
	} catch (e) {
		return undefined;
	}

	if (/^[0-9a-f]{40}$/i.test(head)) {
		return head;
	}

	const refMatch = /^ref: (.*)$/.exec(head);

	if (!refMatch) {
		return undefined;
	}

	const ref = refMatch[1];
	const refPath = path.join(git, ref);

	try {
		return fs.readFileSync(refPath, 'utf8').trim();
	} catch (e) {
		// noop
	}

	const packedRefsPath = path.join(git, 'packed-refs');
	let refsRaw: string;

	try {
		refsRaw = fs.readFileSync(packedRefsPath, 'utf8').trim();
	} catch (e) {
		return undefined;
	}

	const refsRegex = /^([0-9a-f]{40})\s+(.+)$/gm;
	let refsMatch: RegExpExecArray | null;
	const refs: { [ref: string]: string } = {};

	while (refsMatch = refsRegex.exec(refsRaw)) {
		refs[refsMatch[2]] = refsMatch[1];
	}

	return refs[ref];
}
