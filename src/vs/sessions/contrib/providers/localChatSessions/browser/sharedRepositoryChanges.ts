/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, IReference } from '../../../../../base/common/lifecycle.js';
import { autorun, IObservable, observableValue } from '../../../../../base/common/observable.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IChatSessionFileChange2 } from '../../../../../workbench/contrib/chat/common/chatSessionsService.js';
import { GitChange, IGitRepository } from '../../../../../workbench/contrib/git/common/gitService.js';

/** Untracked files beyond this count are reported without a line count. */
export const MAX_UNTRACKED_FILES_TO_COUNT = 200;
/** Untracked files larger than this are reported without a line count (never read into memory). */
export const MAX_UNTRACKED_FILE_BYTES_TO_COUNT = 1024 * 1024;

/**
 * Uncommitted changes of one repository, computed once and shared by every
 * session whose workspace is that repository.
 *
 * Previously each `LocalSession` (up to the 100-session cache cap) subscribed
 * to the repository state on its own. Every save then ran one
 * `diffBetweenWithStats2('HEAD')` per cached session and read the full content
 * of every untracked file once per session to count its lines, so CPU and heap
 * grew linearly with the number of sessions that had ever been opened, even
 * idle ones. Sessions now hold a reference to one tracker per repository.
 */
export class SharedRepositoryChanges extends Disposable {

	private static readonly _instances = new Map<string, { tracker: SharedRepositoryChanges; refCount: number }>();

	/** Acquire the shared tracker of `repo`. Dispose the returned reference to release it. */
	static acquire(repo: IGitRepository, fileService: IFileService): IReference<SharedRepositoryChanges> {
		const key = repo.rootUri.toString();
		let entry = SharedRepositoryChanges._instances.get(key);
		if (!entry) {
			entry = { tracker: new SharedRepositoryChanges(repo, fileService), refCount: 0 };
			SharedRepositoryChanges._instances.set(key, entry);
		}
		entry.refCount++;
		const acquired = entry;
		let released = false;
		return {
			object: acquired.tracker,
			dispose: () => {
				if (released) {
					return;
				}
				released = true;
				if (--acquired.refCount === 0) {
					if (SharedRepositoryChanges._instances.get(key) === acquired) {
						SharedRepositoryChanges._instances.delete(key);
					}
					acquired.tracker.dispose();
				}
			},
		};
	}

	/** Number of live trackers (for tests and diagnostics). */
	static get instanceCount(): number {
		return SharedRepositoryChanges._instances.size;
	}

	private readonly _changes = observableValue<readonly IChatSessionFileChange2[]>(this, []);
	readonly changes: IObservable<readonly IChatSessionFileChange2[]> = this._changes;

	/** Number of diff passes started (for tests and diagnostics). */
	diffPasses = 0;

	private _diffVersion = 0;
	private _diffInFlight = false;
	private _diffPending = false;
	private _latestStateChanges: readonly GitChange[] = [];

	private constructor(
		private readonly _repo: IGitRepository,
		private readonly _fileService: IFileService,
	) {
		super();
		this._register(autorun(reader => {
			const state = this._repo.state.read(reader);
			this._latestStateChanges = [...state.workingTreeChanges, ...state.untrackedChanges, ...state.indexChanges];
			if (this._latestStateChanges.length === 0) {
				this._diffPending = false;
				this._diffVersion++;
				this._changes.set([], undefined);
				return;
			}
			this._scheduleDiff();
		}));
	}

	/** At most one HEAD diff at a time, with one trailing pass if state changed while it ran. */
	private _scheduleDiff(): void {
		if (this._diffInFlight) {
			this._diffPending = true;
			return;
		}
		this._diffInFlight = true;
		this._diffPending = false;
		this.diffPasses++;
		const version = ++this._diffVersion;
		const snapshot = this._latestStateChanges;
		const stale = () => this._store.isDisposed || version !== this._diffVersion;

		this._repo.diffBetweenWithStats2('HEAD').finally(() => {
			this._diffInFlight = false;
			if (this._diffPending && !this._store.isDisposed) {
				this._scheduleDiff();
			}
		}).then(async diffChanges => {
			if (stale()) {
				return;
			}
			const tracked = new Set(diffChanges.map(el => el.uri.toString()));
			const changes: IChatSessionFileChange2[] = diffChanges.map(el => ({
				uri: el.uri,
				originalUri: el.originalUri,
				modifiedUri: el.modifiedUri ?? el.uri,
				insertions: el.insertions,
				deletions: el.deletions,
			}));
			const untracked = snapshot.filter(el => !tracked.has(el.uri.toString()));
			const counted = await Promise.all(untracked.map((el, index) => this._countUntracked(el, index)));
			if (stale()) {
				return;
			}
			changes.push(...counted);
			this._changes.set(changes, undefined);
		}, () => {
			if (stale()) {
				return;
			}
			this._changes.set(snapshot.map<IChatSessionFileChange2>(el => ({
				uri: el.uri,
				originalUri: el.originalUri,
				modifiedUri: el.modifiedUri ?? el.uri,
				insertions: 0,
				deletions: 0,
			})), undefined);
		});
	}

	private async _countUntracked(el: GitChange, index: number): Promise<IChatSessionFileChange2> {
		let insertions = 0;
		if (index < MAX_UNTRACKED_FILES_TO_COUNT) {
			try {
				const stat = await this._fileService.stat(el.uri);
				if (!stat.isDirectory && stat.size <= MAX_UNTRACKED_FILE_BYTES_TO_COUNT) {
					const content = await this._fileService.readFile(el.uri);
					const text = content.value.toString();
					insertions = text.length > 0 ? text.split('\n').length : 0;
				}
			} catch {
				// File may have been deleted between state snapshot and read
			}
		}
		return {
			uri: el.uri,
			originalUri: undefined,
			modifiedUri: el.modifiedUri ?? el.uri,
			insertions,
			deletions: 0,
		};
	}
}
