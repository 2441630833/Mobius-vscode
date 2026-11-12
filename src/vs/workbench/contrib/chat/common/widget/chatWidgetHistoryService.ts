/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { equals as arraysEqual } from '../../../../../base/common/arrays.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { Memento } from '../../../../common/memento.js';
import { IChatModelInputState } from '../model/chatModel.js';
import { CHAT_PROVIDER_ID } from '../participants/chatParticipantContribTypes.js';
import { IChatRequestVariableEntry } from '../attachments/chatVariableEntries.js';
import { ChatAgentLocation, ChatModeKind } from '../constants.js';

interface IChatHistoryEntry {
	text: string;
	state?: IChatInputState;
}

/** The collected input state for chat history entries */
interface IChatInputState {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	[key: string]: any;
	chatContextAttachments?: ReadonlyArray<IChatRequestVariableEntry>;

	/**
	 * This should be a mode id (ChatMode | string).
	 * { id: string } is the old IChatMode. This is deprecated but may still be in persisted data.
	 */
	chatMode?: ChatModeKind | string | { id: string };
}

export const IChatWidgetHistoryService = createDecorator<IChatWidgetHistoryService>('IChatWidgetHistoryService');
export interface IChatWidgetHistoryService {
	_serviceBrand: undefined;

	readonly onDidChangeHistory: Event<ChatHistoryChange>;

	clearHistory(): void;
	getHistory(location: ChatAgentLocation, historyKey?: string): readonly IChatModelInputState[];
	append(location: ChatAgentLocation, history: IChatModelInputState, historyKey?: string): void;
	moveHistory(location: ChatAgentLocation, fromHistoryKey: string, toHistoryKey: string): void;
}

interface IChatHistory {
	history?: { [providerId: string]: IChatModelInputState[] };
}

export type ChatHistoryChange = { kind: 'append'; location: ChatAgentLocation; historyKey: string | undefined; entry: IChatModelInputState } | { kind: 'move'; location: ChatAgentLocation; fromHistoryKey: string; toHistoryKey: string } | { kind: 'clear' };

export const ChatInputHistoryMaxEntries = 40;

/**
 * Upper bound on how many distinct history buckets are persisted.
 *
 * A bucket key includes the chat session resource, so every chat that was ever
 * opened created its own bucket and nothing ever removed it. Users who keep the
 * Agents window open for weeks accumulated hundreds of buckets — with 40 full
 * prompt texts each — in the `interactive-session` memento, which is loaded and
 * parsed on every workspace start. Bounding the number of buckets (rather than
 * only the entries inside one bucket) keeps that memento small.
 */
export const ChatInputHistoryMaxBuckets = 8;

export class ChatWidgetHistoryService extends Disposable implements IChatWidgetHistoryService {
	_serviceBrand: undefined;

	private memento: Memento<IChatHistory>;
	private viewState: IChatHistory;

	private readonly _onDidChangeHistory = this._register(new Emitter<ChatHistoryChange>());
	private changed = false;
	readonly onDidChangeHistory = this._onDidChangeHistory.event;

	constructor(
		@IStorageService storageService: IStorageService
	) {
		super();

		this.memento = new Memento<IChatHistory>('interactive-session', storageService);
		const loadedState = this.memento.getMemento(StorageScope.WORKSPACE, StorageTarget.MACHINE);
		this.viewState = loadedState;

		this._register(storageService.onWillSaveState(() => {
			if (this.changed) {
				this.memento.saveMemento();
				this.changed = false;
			}
		}));
	}

	getHistory(location: ChatAgentLocation, historyKey?: string): IChatModelInputState[] {
		const key = this.getKey(location, historyKey);
		const history = this.viewState.history?.[key] ?? [];
		return history.map(entry => this.migrateHistoryEntry(entry));
	}

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	private migrateHistoryEntry(entry: any): IChatModelInputState {
		// If it's already in the new format (has 'inputText' property), return as-is
		if (entry.inputText !== undefined) {
			return entry as IChatModelInputState;
		}

		// Otherwise, it's an old IChatHistoryEntry with 'text' and 'state' properties
		const oldEntry = entry as IChatHistoryEntry;
		const oldState = oldEntry.state ?? {};

		// Migrate chatMode to the new mode structure
		let modeId: string;
		let modeKind: ChatModeKind | undefined;
		if (oldState.chatMode) {
			if (typeof oldState.chatMode === 'string') {
				modeId = oldState.chatMode;
				modeKind = Object.values(ChatModeKind).includes(oldState.chatMode as ChatModeKind)
					? oldState.chatMode as ChatModeKind
					: undefined;
			} else if (typeof oldState.chatMode === 'object' && oldState.chatMode !== null) {
				// Old format: { id: string }
				const oldMode = oldState.chatMode as { id?: string };
				modeId = oldMode.id ?? ChatModeKind.Ask;
				modeKind = oldMode.id && Object.values(ChatModeKind).includes(oldMode.id as ChatModeKind)
					? oldMode.id as ChatModeKind
					: undefined;
			} else {
				modeId = ChatModeKind.Ask;
				modeKind = ChatModeKind.Ask;
			}
		} else {
			modeId = ChatModeKind.Ask;
			modeKind = ChatModeKind.Ask;
		}

		return {
			inputText: oldEntry.text ?? '',
			attachments: oldState.chatContextAttachments ?? [],
			mode: {
				id: modeId,
				kind: modeKind
			},
			contrib: oldEntry.state || {},
			selectedModel: undefined,
			selections: []
		};
	}

	private getKey(location: ChatAgentLocation, historyKey?: string): string {
		// Preserve history for panel by continuing to use the same old provider id. Use the location as a key for other chat locations.
		const locationKey = location === ChatAgentLocation.Chat ? CHAT_PROVIDER_ID : location;
		return historyKey === undefined ? locationKey : `${locationKey}:${historyKey}`;
	}

	append(location: ChatAgentLocation, history: IChatModelInputState, historyKey?: string): void {
		this.viewState.history ??= {};

		const key = this.getKey(location, historyKey);
		const entries = this.getHistory(location, historyKey).concat(history).slice(-ChatInputHistoryMaxEntries);
		// Delete before writing so the key moves to the end of the object: key order is
		// insertion order, and {@link pruneHistoryBuckets} drops from the front.
		delete this.viewState.history[key];
		this.viewState.history[key] = entries;
		this.pruneHistoryBuckets(key);
		this.changed = true;
		this._onDidChangeHistory.fire({ kind: 'append', location, historyKey, entry: history });
	}

	/**
	 * Drops the least recently written history buckets, keeping at most
	 * {@link ChatInputHistoryMaxBuckets}. The bucket that was just written is never
	 * dropped.
	 */
	private pruneHistoryBuckets(mostRecentKey: string): void {
		const history = this.viewState.history;
		if (!history) {
			return;
		}
		const keys = Object.keys(history);
		const excess = keys.length - ChatInputHistoryMaxBuckets;
		if (excess <= 0) {
			return;
		}
		let removed = 0;
		for (const key of keys) {
			if (removed >= excess) {
				break;
			}
			if (key === mostRecentKey) {
				continue;
			}
			delete history[key];
			removed++;
		}
	}

	moveHistory(location: ChatAgentLocation, fromHistoryKey: string, toHistoryKey: string): void {
		if (fromHistoryKey === toHistoryKey) {
			return;
		}

		const fromHistory = this.getHistory(location, fromHistoryKey);
		if (fromHistory.length === 0) {
			return;
		}

		this.viewState.history ??= {};

		const fromKey = this.getKey(location, fromHistoryKey);
		const toKey = this.getKey(location, toHistoryKey);
		const entries = this.getHistory(location, toHistoryKey).concat(fromHistory).slice(-ChatInputHistoryMaxEntries);
		delete this.viewState.history[toKey];
		this.viewState.history[toKey] = entries;
		delete this.viewState.history[fromKey];
		this.pruneHistoryBuckets(toKey);
		this.changed = true;
		this._onDidChangeHistory.fire({ kind: 'move', location, fromHistoryKey, toHistoryKey });
	}

	clearHistory(): void {
		this.viewState.history = {};
		this.changed = true;
		this._onDidChangeHistory.fire({ kind: 'clear' });
	}
}

export class ChatHistoryNavigator extends Disposable {
	/**
	 * Index of our point in history. Goes 1 past the length of `_history`
	 */
	private _currentIndex: number;
	private _history: readonly IChatModelInputState[];
	private _overlay: (IChatModelInputState | undefined)[] = [];
	private _historyKey: string | undefined;

	public get values() {
		return this.chatWidgetHistoryService.getHistory(this.location, this._historyKey);
	}

	constructor(
		private readonly location: ChatAgentLocation,
		@IChatWidgetHistoryService private readonly chatWidgetHistoryService: IChatWidgetHistoryService
	) {
		super();
		this._history = this.chatWidgetHistoryService.getHistory(this.location, this._historyKey);
		this._currentIndex = this._history.length;

		this._register(this.chatWidgetHistoryService.onDidChangeHistory(e => {
			if (e.kind === 'append') {
				if (e.location !== this.location || e.historyKey !== this._historyKey) {
					return;
				}
				const prevLength = this._history.length;
				this._history = this.chatWidgetHistoryService.getHistory(this.location, this._historyKey);
				const newLength = this._history.length;

				// If this append operation adjusted all history entries back, move our index back too
				// if we weren't pointing to the end of the history.
				if (prevLength === newLength) {
					this._overlay.shift();
					if (this._currentIndex < this._history.length) {
						this._currentIndex = Math.max(this._currentIndex - 1, 0);
					}
				} else if (this._currentIndex === prevLength) {
					this._currentIndex = newLength;
				}
			} else if (e.kind === 'clear') {
				this._history = [];
				this._currentIndex = 0;
				this._overlay = [];
			} else if (e.kind === 'move') {
				if (e.location !== this.location || (e.fromHistoryKey !== this._historyKey && e.toHistoryKey !== this._historyKey)) {
					return;
				}
				this._history = this.chatWidgetHistoryService.getHistory(this.location, this._historyKey);
				this._currentIndex = this._history.length;
				this._overlay = [];
			}
		}));
	}

	public setHistoryKey(historyKey: string | undefined) {
		if (this._historyKey === historyKey) {
			return;
		}

		this._historyKey = historyKey;
		this._history = this.chatWidgetHistoryService.getHistory(this.location, this._historyKey);
		this._currentIndex = this._history.length;
		this._overlay = [];
	}

	public isAtEnd() {
		return this._currentIndex === Math.max(this._history.length, this._overlay.length);
	}

	public isAtStart() {
		return this._currentIndex === 0;
	}

	/**
	 * Replaces a history entry at the current index in this view of the history.
	 * Allows editing of old history entries while preventing accidental navigation
	 * from losing the edits.
	 */
	public overlay(entry: IChatModelInputState) {
		this._overlay[this._currentIndex] = entry;
	}

	public resetCursor() {
		this._currentIndex = this._history.length;
	}

	public previous() {
		this._currentIndex = Math.max(this._currentIndex - 1, 0);
		return this.current();
	}

	public next() {
		this._currentIndex = Math.min(this._currentIndex + 1, this._history.length);
		return this.current();
	}

	public current() {
		return this._overlay[this._currentIndex] ?? this._history[this._currentIndex];
	}

	/**
	 * Appends a new entry to the navigator. Resets the state back to the end
	 * and clears any overlayed entries.
	 */
	public append(entry: IChatModelInputState) {
		this._overlay = [];
		this._currentIndex = this._history.length;

		if (!entriesEqual(this._history.at(-1), entry)) {
			this.chatWidgetHistoryService.append(this.location, entry, this._historyKey);
		}
	}
}

function entriesEqual(a: IChatModelInputState | undefined, b: IChatModelInputState | undefined): boolean {
	if (!a || !b) {
		return false;
	}

	if (a.inputText !== b.inputText) {
		return false;
	}

	if (!arraysEqual(a.attachments, b.attachments, (x, y) => x.id === y.id)) {
		return false;
	}

	return true;
}
