/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * In-process port of headroom's content compressors
 * (https://github.com/headroomlabs-ai/headroom, Apache-2.0, vendored as the
 * `headroom` submodule of Mobius).
 *
 * - `LogCompressor`: keep head/tail, errors with +-3 lines of context (first and
 *   last 5 when there are more than 10), deduplicated warnings, summary lines and
 *   stack frames, within a line budget.
 * - `DenseLineElider`: long lines with <6% spaces and <10% non-ASCII (minified
 *   bundles, base64, RSC payloads) keep 160 head / 80 tail characters.
 * - Error keywords mirror `KeywordRegistry::default_set()` of headroom-core.
 *
 * Unlike blind head truncation, the lines a reader needs (the error, the failing
 * test, the summary at the end) survive. Output is deterministic, and a value
 * that is already compressed for the same budget is returned unchanged.
 */

export const HEADROOM_MARKER = '[headroom:';

export interface IHeadroomCompressOptions {
	/** Text at or below this many characters is returned unchanged. */
	readonly minChars: number;
	/** Upper bound for the result, marker included. */
	readonly maxChars: number;
	/** Short label used in the marker, e.g. `persisted copy` or `tool output`. */
	readonly label: string;
	/** Optional sentence appended to the marker. */
	readonly note?: string;
}

const MAX_ERRORS = 10;
const ERROR_CONTEXT_LINES = 3;
const MAX_WARNINGS = 5;
const MAX_TRACE_LINES = 20;
const MARKER_RESERVE = 200;

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

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}

export function isDenseLine(line: string): boolean {
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
	// Compact JSON is never rewritten by the elider.
	const s = line.trim();
	const a = s[0], b = s[s.length - 1];
	return !((a === '{' || a === '[') && (b === '}' || b === ']'));
}

function marker(options: IHeadroomCompressOptions, originalChars: number, compressedChars: number, lines?: number): string {
	const linesPart = lines === undefined ? '' : `, ${lines} lines`;
	const note = options.note ? `; ${options.note}` : '';
	return `\n${HEADROOM_MARKER} ${options.label} compressed ${originalChars} -> ${compressedChars} chars${linesPart}${note}]`;
}

/**
 * Compresses `text` to at most `options.maxChars` characters (marker included),
 * keeping the lines that carry signal. Returns `text` unchanged when it is at or
 * below `options.minChars`, or when it is already a compressed value that fits.
 */
export function headroomCompressText(text: string, options: IHeadroomCompressOptions): string {
	if (text.length <= options.minChars) {
		return text;
	}
	if (text.length <= options.maxChars && text.indexOf(HEADROOM_MARKER) !== -1) {
		return text;
	}

	const budget = Math.max(256, options.maxChars - MARKER_RESERVE);
	const headLines = clamp(Math.floor(options.maxChars / 800), 3, 20);
	const tailLines = headLines;
	const maxTotalLines = clamp(Math.floor(options.maxChars / 160), 12, 100);

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
	if (text.length <= options.minChars || (n <= maxTotalLines && text.length <= budget)) {
		return text.length < original.length ? text + marker(options, original.length, text.length) : text;
	}

	// 2. Log compression.
	const keep = new Uint8Array(n);
	for (let i = 0; i < Math.min(headLines, n); i++) {
		keep[i] = 1;
	}
	for (let i = Math.max(0, n - tailLines); i < n; i++) {
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
		if (kept >= maxTotalLines && i < n - tailLines) {
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

	// 3. Hard cap: keep the head and the tail, where errors and summaries usually are.
	if (text.length > budget) {
		const head = Math.floor(budget * 0.625);
		const tail = Math.floor(budget * 0.25);
		text = `${text.slice(0, head)}\n... [${text.length - head - tail} chars omitted] ...\n${text.slice(-tail)}`;
	}
	return text + marker(options, original.length, text.length, n);
}
