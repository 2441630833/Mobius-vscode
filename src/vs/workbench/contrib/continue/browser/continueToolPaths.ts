/*---------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { URI } from '../../../../base/common/uri.js';

export function normalizeToolArguments(input: unknown): Record<string, unknown> {
	let value = input;
	for (let depth = 0; depth < 4; depth++) {
		if (typeof value === 'string') {
			try { value = JSON.parse(value); continue; } catch { return { raw: value }; }
		}
		if (!value || typeof value !== 'object' || Array.isArray(value)) { return {}; }
		const record = value as Record<string, unknown>;
		const keys = Object.keys(record);
		if (keys.length === 1 && (keys[0] === 'arguments' || keys[0] === 'parameters')) {
			value = record[keys[0]];
			continue;
		}
		return record;
	}
	return {};
}

/** Accept common provider dialects without inventing a missing file path. */
export function toolPathArgument(args: Record<string, unknown>): string | undefined {
	for (const key of ['filepath', 'filePath', 'file_path', 'path', 'uri', 'fileUri', 'filename', 'file']) {
		const value = args[key];
		if (typeof value === 'string' && value.trim()) { return value.trim(); }
	}
	return undefined;
}

export function resolveToolPath(cwd: URI | undefined, input: string): URI {
	const value = input.trim();
	if (!value) { throw new Error('A non-empty file path is required'); }
	if (/^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('\\\\')) {
		return URI.file(value);
	}
	if (/^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(value) || value.startsWith('file:')) {
		return URI.parse(value);
	}
	if (value.startsWith('/')) {
		return cwd && cwd.scheme !== 'file' ? cwd.with({ path: value, query: '', fragment: '' }) : URI.file(value);
	}
	if (!cwd) {
		throw new Error(`Cannot resolve relative path "${value}" without a workspace. Supply an absolute path.`);
	}
	return URI.joinPath(cwd, value.replace(/\\/g, '/'));
}
