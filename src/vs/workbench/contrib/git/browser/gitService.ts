/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { BugIndicatingError } from '../../../../base/common/errors.js';
import { Disposable, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { IGitService, IGitExtensionDelegate, GitRef, GitRefQuery, IGitRepository, GitRepositoryState, GitDiffChange } from '../common/gitService.js';
import { ISettableObservable, observableValueOpts } from '../../../../base/common/observable.js';
import { structuralEquals } from '../../../../base/common/equals.js';
import { DeferredPromise } from '../../../../base/common/async.js';
import { ILogService } from '../../../../platform/log/common/log.js';

export class GitService extends Disposable implements IGitService {
	declare readonly _serviceBrand: undefined;

	private _delegate: IGitExtensionDelegate | undefined;
	private _delegateReady = new DeferredPromise<IGitExtensionDelegate>();

	get repositories(): Iterable<IGitRepository> {
		return this._delegate?.repositories ?? [];
	}

		constructor(@ILogService private readonly logService: ILogService) {
		super();
		this._register(toDisposable(() => {
			if (!this._delegateReady.isSettled) {
				this._delegateReady.error(new Error('GitService disposed'));
			}
		}));
	}

	setDelegate(delegate: IGitExtensionDelegate): IDisposable {
		// The delegate can only be set once, since the vscode.git
		// extension can only run in one extension host process per
		// window.
		if (this._delegate) {
			this.logService.error('[GitService][setDelegate] GitExtension delegate is already set.');
			throw new BugIndicatingError('GitExtension delegate is already set.');
		}

				this._delegate = delegate;
		this._delegateReady.complete(delegate);

		return toDisposable(() => {
			this._delegate = undefined;
		});
	}

		async openRepository(uri: URI): Promise<IGitRepository | undefined> {
		// Wait indefinitely for the delegate — the extension host may be
		// blocked during startup (heavy extensions like Continue), and a
		// fixed timeout causes repository loading to fail silently.
		const delegate = await this._delegateReady.p;
		return delegate.openRepository(uri);
	}
}

export class GitRepository extends Disposable implements IGitRepository {
	readonly rootUri: URI;

	readonly state: ISettableObservable<GitRepositoryState>;
	updateState(state: GitRepositoryState): void {
		this.state.set(state, undefined);
	}

	constructor(
		rootUri: URI,
		initialState: GitRepositoryState,
		private readonly delegate: IGitExtensionDelegate
	) {
		super();

		this.rootUri = rootUri;
		this.state = observableValueOpts({ owner: this, equalsFn: structuralEquals }, initialState);
	}

	async getRefs(query: GitRefQuery, token?: CancellationToken): Promise<GitRef[]> {
		return this.delegate.getRefs(this.rootUri, query, token);
	}

	async diffBetweenWithStats(ref1: string, ref2: string, path?: string): Promise<GitDiffChange[]> {
		return this.delegate.diffBetweenWithStats(this.rootUri, ref1, ref2, path);
	}

		async diffBetweenWithStats2(ref: string, path?: string): Promise<GitDiffChange[]> {
		return this.delegate.diffBetweenWithStats2(this.rootUri, ref, path);
	}

	async status(): Promise<void> {
		return this.delegate.status(this.rootUri);
	}
}
