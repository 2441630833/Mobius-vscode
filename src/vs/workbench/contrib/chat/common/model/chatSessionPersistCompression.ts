/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Persistence-side compression for chat session logs.
 *
 * Chat sessions are persisted as an append-only mutation log. Without a bound,
 * every tool result (terminal output, file reads, diffs, thinking) is written
 * verbatim and kept forever, so long-running sessions grow to tens of MB and
 * opening one blocks the renderer while the whole log is parsed and replayed.
 *
 * This module ports the content-aware compressors of headroom
 * (https://github.com/headroomlabs-ai/headroom, Apache-2.0, vendored as the
 * `headroom` submodule of Mobius) to the persisted copy of a session:
 *
 * - `LogCompressor` defaults: keep head/tail, errors with +-3 lines of context
 *   (first/last 5 when there are more than 10), deduplicated warnings, summary
 *   lines and stack frames, with a 100-line budget.
 * - `DenseLineElider`: long lines with <6% spaces and <10% non-ASCII (minified
 *   bundles, base64, RSC payloads) keep 160 head / 80 tail chars.
 * - Error keywords mirror `KeywordRegistry::default_set()` of headroom-core.
 *
 * Only the value written to disk is compressed. The live chat model (what the
 * UI renders and the agent sends to the model during the session) is never
 * mutated, and markdown answers, text edits, URIs and image data are untouched.
 * The output is deterministic and idempotent, which keeps the mutation-log diff
 * stable across writes.
 */

/** Strings at or below this many characters are never touched. */
export const PERSIST_COMPRESS_MIN_CHARS = 4 * 1024;
/** Hard upper bound for one compressed string. */
export const PERSIST_COMPRESS_MAX_CHARS = 16 * 1024;
/** Marker appended to every compressed value. */
export const PERSIST_COMPRESS_MARKER = '[headroom: persisted copy compressed';

const HEAD_LINES = 20;
const TAIL_LINES = 20;
const MAX_TOTAL_LINES = 100;
const MAX_ERRORS = 10;
const ERROR_CONTEXT_LINES = 3;
const MAX_WARNINGS = 5;
const MAX_TRACE_LINES = 20;

const DENSE_MIN_LINE_CHARS = 300;
const DENSE_MAX_SPACE_RATIO = 0.06;
const DENSE_MAX_NON_ASCII_RATIO = 0.1;
const DENSE_MIN_TOTAL_CHARS = 2000;
const DENSE_HEAD_CHARS = 160;
const DENSE_TAIL_CHARS = 80;

const ERROR_RE = /\b(error|exception|fail|failed|failure|fatal|critical|crash|panic|abort|timeout|denied|rejected)\b|traceback|报错|失败|错误/i;
const WARNING_RE = /\bwarn(ing)?\b|警告/i;
const SUMMARY_RE = /(\b\d+ (passed|failed|errors?|warnings?|tests?|skipped)\b)|^\s*(total|summary|result|tests?:|done in|finished|exit code|build (succeeded|failed))|\bexit(ed)? (with )?code\b/i;
const TRACE_RE = /^\s+at |^\s*File "|^Traceback|^\s+\^|^\s*Caused by/;

/** Response part kinds whose payload is tool or reasoning output, not the user-visible answer. */
const COMPRESSIBLE_PART_KINDS: ReadonlySet<string> = new Set([
	'toolInvocationSerialized',
	'thinking',
	'progressTaskSerialized',
	'elicitationSerialized',
]);

/** Keys whose values must be kept byte-identical. */
const PRESERVED_KEYS: ReadonlySet<string> = new Set(['base64Data', 'uri', 'resource']);

function isDenseLine(line: string): boolean {
	const n = line.length;
	if (n < DENSE_MIN_LINE_CHARS || line.indexOf('\t') !== -1) {
		return false;
	}
	let spaces = 0;
	let nonAscii = 0;
	for (let i = 0; i < n; i++) {
		const c = line.charCodeAt(i);
		if (c === 32) {
			spaces++;
		} else if (c > 127) {
			nonAscii++;
		}
	}
	if (spaces / n >= DENSE_MAX_SPACE_RATIO || nonAscii > n * DENSE_MAX_NON_ASCII_RATIO) {
		return false;
	}
	// Compact JSON is left to the line compressor; never rewrite its values.
	const s = line.trim();
	const a = s[0], b = s[s.length - 1];
	return !((a === '{' || a === '[') && (b === '}' || b === ']'));
}

function marker(originalChars: number, compressedChars: number, lines?: number): string {
	return lines === undefined
		? `\n${PERSIST_COMPRESS_MARKER} ${originalChars} -> ${compressedChars} chars]`
		: `\n${PERSIST_COMPRESS_MARKER} ${originalChars} -> ${compressedChars} chars, ${lines} lines; the live output was not changed]`;
}

/**
 * Compresses one string for persistence. Returns the input unchanged when it is
 * short or already compressed.
 */
export function compressStringForPersistence(text: string): string {
	if (text.length <= PERSIST_COMPRESS_MIN_CHARS) {
		return text;
	}
	if (text.length <= PERSIST_COMPRESS_MAX_CHARS && text.indexOf(PERSIST_COMPRESS_MARKER) !== -1) {
		return text;
	}

	const original = text;
	const lines = text.split('\n');
	const n = lines.length;

	// 1. Dense machine-generated lines.
	let denseTotal = 0;
	for (const line of lines) {
		if (isDenseLine(line)) {
			denseTotal += line.length;
		}
	}
	if (denseTotal >= DENSE_MIN_TOTAL_CHARS) {
		for (let i = 0; i < n; i++) {
			const line = lines[i];
			if (isDenseLine(line)) {
				lines[i] = `${line.slice(0, DENSE_HEAD_CHARS)} ...[${line.length - DENSE_HEAD_CHARS - DENSE_TAIL_CHARS} chars of dense machine-generated content elided]... ${line.slice(-DENSE_TAIL_CHARS)}`;
			}
		}
	}
	text = lines.join('\n');
	if (text.length <= PERSIST_COMPRESS_MIN_CHARS || (n <= MAX_TOTAL_LINES && text.length <= PERSIST_COMPRESS_MAX_CHARS)) {
		return text.length < original.length ? text + marker(original.length, text.length) : text;
	}

	// 2. Log compression.
	const keep = new Uint8Array(n);
	for (let i = 0; i < Math.min(HEAD_LINES, n); i++) {
		keep[i] = 1;
	}
	for (let i = Math.max(0, n - TAIL_LINES); i < n; i++) {
		keep[i] = 1;
	}
	const errors: number[] = [];
	const seenWarnings = new Set<string>();
	for (let i = 0; i < n; i++) {
		const line = lines[i];
		if (ERROR_RE.test(line)) {
			errors.push(i);
		} else if (WARNING_RE.test(line)) {
			if (seenWarnings.size < MAX_WARNINGS) {
				const key = line.replace(/[0-9]+/g, '#').replace(/[A-Za-z]:?[\\\/][^\s:]*/g, '<p>');
				if (!seenWarnings.has(key)) {
					seenWarnings.add(key);
					keep[i] = 1;
				}
			}
		} else if (SUMMARY_RE.test(line)) {
			keep[i] = 1;
		}
	}
	const picked = errors.length <= MAX_ERRORS ? errors : errors.slice(0, MAX_ERRORS / 2).concat(errors.slice(-MAX_ERRORS / 2));
	for (const e of picked) {
		for (let i = Math.max(0, e - ERROR_CONTEXT_LINES); i <= Math.min(n - 1, e + ERROR_CONTEXT_LINES); i++) {
			keep[i] = 1;
		}
		for (let i = e + 1, f = 0; i < n && f < MAX_TRACE_LINES && TRACE_RE.test(lines[i]); i++, f++) {
			keep[i] = 1;
		}
	}

	const out: string[] = [];
	let gap = 0, kept = 0, repeats = 0;
	let prev: string | undefined;
	for (let i = 0; i < n; i++) {
		if (!keep[i]) {
			gap++;
			continue;
		}
		if (gap) {
			out.push(`... [${gap} lines omitted]`);
			gap = 0;
		}
		if (lines[i] === prev) {
			repeats++;
			continue;
		}
		if (repeats) {
			out.push(`... [previous line repeated ${repeats} more times]`);
			repeats = 0;
		}
		out.push(lines[i]);
		prev = lines[i];
		kept++;
		if (kept >= MAX_TOTAL_LINES && i < n - TAIL_LINES) {
			let flagged = 0;
			for (let j = i + 1; j < n; j++) {
				flagged += keep[j];
			}
			out.push(`... [${n - i - 1} lines omitted, ${flagged} flagged]`);
			break;
		}
	}
	if (repeats) {
		out.push(`... [previous line repeated ${repeats} more times]`);
	}
	if (gap) {
		out.push(`... [${gap} lines omitted]`);
	}
	text = out.join('\n');

	// 3. Hard cap.
	if (text.length > PERSIST_COMPRESS_MAX_CHARS) {
		text = `${text.slice(0, 10240)}\n... [${text.length - 14336} chars omitted] ...\n${text.slice(-4096)}`;
	}
	return text + marker(original.length, text.length, n);
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
