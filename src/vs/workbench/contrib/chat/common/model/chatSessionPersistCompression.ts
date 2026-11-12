/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Persistence-side compression for chat session logs (see ../headroom/headroomCompressor.ts).
 *
 * Chat sessions are persisted as an append-only mutation log. Without a bound,
 * every tool result (terminal output, file reads, diffs, thinking) is written
 * verbatim and kept forever, so long-running sessions grow to tens of MB and
 * opening one blocks the renderer while the whole log is parsed and replayed.
 *
 * The headroom compressors (vendored as the `headroom` submodule of Mobius)
 * are applied to the persisted copy of tool, thinking, progress and elicitation
 * parts.
 *
 * Only the value written to disk is compressed. The live chat model (what the
 * UI renders and the agent sends to the model during the session) is never
 * mutated, and markdown answers, text edits, URIs and image data are untouched.
 * The output is deterministic and idempotent, which keeps the mutation-log diff
 * stable across writes.
 */

import { HEADROOM_MARKER, headroomCompressText } from '../headroom/headroomCompressor.js';

/** Strings at or below this many characters are never touched. */
export const PERSIST_COMPRESS_MIN_CHARS = 4 * 1024;
/** Hard upper bound for one compressed string, marker included. */
export const PERSIST_COMPRESS_MAX_CHARS = 16 * 1024;
/** Marker carried by every compressed value. */
export const PERSIST_COMPRESS_MARKER = HEADROOM_MARKER;

/** Response part kinds whose payload is tool or reasoning output, not the user-visible answer. */
const COMPRESSIBLE_PART_KINDS: ReadonlySet<string> = new Set([
	'toolInvocationSerialized',
	'thinking',
	'progressTaskSerialized',
	'elicitationSerialized',
]);

/** Keys whose values must be kept byte-identical. */
const PRESERVED_KEYS: ReadonlySet<string> = new Set(['base64Data', 'uri', 'resource']);

/**
 * Compresses one string for persistence. Returns the input unchanged when it is
 * short or already compressed.
 */
export function compressStringForPersistence(text: string): string {
	return headroomCompressText(text, {
		minChars: PERSIST_COMPRESS_MIN_CHARS,
		maxChars: PERSIST_COMPRESS_MAX_CHARS,
		label: 'persisted copy',
		note: 'the live output was not changed',
	});
}

/** Copy-on-write walk: returns the same reference when nothing changed and never mutates the input. */
function compressValue(value: unknown, depth: number): unknown {
	if (typeof value === 'string') {
		return compressStringForPersistence(value);
	}
	if (!value || typeof value !== 'object' || depth > 12) {
		return value;
	}
	if (Array.isArray(value)) {
		let copy: unknown[] | undefined;
		for (let i = 0; i < value.length; i++) {
			const next = compressValue(value[i], depth + 1);
			if (next !== value[i]) {
				copy ??= value.slice();
				copy[i] = next;
			}
		}
		return copy ?? value;
	}
	const proto = Object.getPrototypeOf(value);
	if (proto !== Object.prototype && proto !== null) {
		return value; // URIs, buffers and other class instances are serialized by their own toJSON
	}
	const record = value as Record<string, unknown>;
	let copy: Record<string, unknown> | undefined;
	for (const key of Object.keys(record)) {
		if (PRESERVED_KEYS.has(key)) {
			continue;
		}
		const next = compressValue(record[key], depth + 1);
		if (next !== record[key]) {
			copy ??= { ...record };
			copy[key] = next;
		}
	}
	return copy ?? value;
}

/**
 * Compresses a serialized response part for persistence. Only tool, thinking,
 * progress-task and elicitation parts are compressed; anything else is returned
 * as-is (same reference).
 */
export function compressResponsePartForPersistence<T>(part: T): T {
	if (part && typeof part === 'object' && COMPRESSIBLE_PART_KINDS.has((part as { kind?: unknown }).kind as string)) {
		try {
			return compressValue(part, 0) as T;
		} catch {
			return part;
		}
	}
	return part;
}
