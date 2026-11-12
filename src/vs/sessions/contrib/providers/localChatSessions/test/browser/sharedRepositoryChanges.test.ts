/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { VSBuffer } from '../../../../../../base/common/buffer.js';
import { observableValue } from '../../../../../../base/common/observable.js';
import { URI } from '../../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { IFileService } from '../../../../../../platform/files/common/files.js';
import { GitChange, GitDiffChange, GitRepositoryState, IGitRepository } from '../../../../../../workbench/contrib/git/common/gitService.js';
import { MAX_UNTRACKED_FILE_BYTES_TO_COUNT, SharedRepositoryChanges } from '../../browser/sharedRepositoryChanges.js';

suite('SharedRepositoryChanges', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const root = URI.file('/repo');
	const small = URI.file('/repo/small.txt');
	const huge = URI.file('/repo/huge.bin');

	function change(uri: URI): GitChange {
		return { uri, originalUri: undefined, modifiedUri: uri } as GitChange;
	}

	function state(untracked: GitChange[]): GitRepositoryState {
		return { HEAD: undefined, workingTreeChanges: [], indexChanges: [], untrackedChanges: untracked } as unknown as GitRepositoryState;
	}

	function setup() {
		const repoState = observableValue<GitRepositoryState>('state', state([]));
		let diffCalls = 0;
		const repo = {
			rootUri: root,
			state: repoState,
			diffBetweenWithStats2: async (): Promise<GitDiffChange[]> => { diffCalls++; return []; },
		} as unknown as IGitRepository;
		const reads: string[] = [];
		const fileService = {
			stat: async (uri: URI) => ({ isDirectory: false, size: uri.toString() === huge.toString() ? MAX_UNTRACKED_FILE_BYTES_TO_COUNT + 1 : 10 }),
			readFile: async (uri: URI) => { reads.push(uri.toString()); return { value: VSBuffer.fromString('a\nb\nc') }; },
		} as unknown as IFileService;
		return { repoState, repo, fileService, reads, diffCalls: () => diffCalls };
	}

	const flush = () => new Promise(resolve => setTimeout(resolve, 0));

	test('sessions on the same repository share one tracker and one diff pass', async () => {
		const { repoState, repo, fileService, diffCalls } = setup();
		const refs = [0, 1, 2, 3, 4].map(() => SharedRepositoryChanges.acquire(repo, fileService));
		assert.strictEqual(SharedRepositoryChanges.instanceCount, 1);
		assert.ok(refs.every(r => r.object === refs[0].object));

		repoState.set(state([change(small)]), undefined);
		await flush(); await flush();
		assert.strictEqual(diffCalls(), 1);
		assert.strictEqual(refs[0].object.changes.get().length, 1);
		assert.strictEqual(refs[0].object.changes.get()[0].insertions, 3);

		refs.forEach(r => r.dispose());
		assert.strictEqual(SharedRepositoryChanges.instanceCount, 0);
	});

	test('releasing a reference twice does not release the tracker for others', () => {
		const { repo, fileService } = setup();
		const a = SharedRepositoryChanges.acquire(repo, fileService);
		const b = SharedRepositoryChanges.acquire(repo, fileService);
		a.dispose();
		a.dispose();
		assert.strictEqual(SharedRepositoryChanges.instanceCount, 1);
		b.dispose();
		assert.strictEqual(SharedRepositoryChanges.instanceCount, 0);
	});

	test('never reads untracked files above the size budget', async () => {
		const { repoState, repo, fileService, reads } = setup();
		const ref = SharedRepositoryChanges.acquire(repo, fileService);
		repoState.set(state([change(small), change(huge)]), undefined);
		await flush(); await flush();
		assert.deepStrictEqual(reads, [small.toString()]);
		const hugeChange = ref.object.changes.get().find(c => c.uri.toString() === huge.toString());
		assert.strictEqual(hugeChange?.insertions, 0);
		ref.dispose();
	});

	test('clears changes when the working tree becomes clean', async () => {
		const { repoState, repo, fileService } = setup();
		const ref = SharedRepositoryChanges.acquire(repo, fileService);
		repoState.set(state([change(small)]), undefined);
		await flush(); await flush();
		assert.strictEqual(ref.object.changes.get().length, 1);
		repoState.set(state([]), undefined);
		assert.strictEqual(ref.object.changes.get().length, 0);
		ref.dispose();
	});
});
