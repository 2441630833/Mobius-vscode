/*---------------------------------------------------------------------------------------------
 *  Mobius — Node 22.15 compatibility (import.meta.main needs Node 22.18+)
 *--------------------------------------------------------------------------------------------*/

import path from 'path';
import { fileURLToPath } from 'url';

/** True when this module is the process entry point. Pass the caller's import.meta.url. */
export function isMainModule(metaUrl: string): boolean {
	// Compare argv[1] to the caller's import.meta.url — do not use import.meta.main here,
	// because inside this imported module it always refers to isMainModule.ts, not the caller.
	const entry = process.argv[1];
	if (!entry) {
		return false;
	}
	const match = path.resolve(entry) === path.resolve(fileURLToPath(metaUrl));
	if (!match && process.env.VSCODE_DEBUG_MAIN) {
		console.log('[isMainModule] entry:', path.resolve(entry), 'meta:', path.resolve(fileURLToPath(metaUrl)));
	}
	return match;
}
