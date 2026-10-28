/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { normalizeToolArguments, resolveToolPath, toolPathArgument } from './continueToolPaths.js';

export interface SelectionEvidence {
	readonly kind: 'skill' | 'agent' | 'agent-profile';
	readonly outcome: 'success' | 'failure';
	readonly name: string;
	readonly path?: string;
	readonly tool: string;
}

/** Classify only observed tool invocations; recommendations are deliberately not evidence. */
export function selectionEvidenceForTool(name: string, parameters: unknown, ok: boolean, cwd?: URI, eccRoot?: URI): SelectionEvidence | undefined {
	const args = normalizeToolArguments(parameters);
	const normalized = name.toLowerCase().replace(/[_-]/g, '');
	const outcome = ok ? 'success' : 'failure';
	if (normalized === 'eccskill') {
		const skillName = typeof args.skill_name === 'string' ? args.skill_name.trim() : '';
		if (!skillName) { return undefined; }
		return { kind: 'skill', outcome, name: skillName, path: eccRoot ? URI.joinPath(eccRoot, 'skills', skillName, 'SKILL.md').fsPath : undefined, tool: name };
	}
	if (normalized === 'readfile' || normalized === 'readfilerange') {
		const rawPath = toolPathArgument(args);
		if (!rawPath) { return undefined; }
		let path = rawPath;
		try { path = resolveToolPath(cwd, rawPath).fsPath; } catch { /* Preserve the attempted path. */ }
		const parts = path.replace(/\\/g, '/').split('/');
		if (/(?:^|[\\/])SKILL\.md$/i.test(path)) {
			return { kind: 'skill', outcome, name: parts.at(-2) || 'SKILL.md', path, tool: name };
		}
		if (eccRoot && /\.md$/i.test(path)) {
			const parent = parts.slice(0, -1).join('/').toLowerCase();
			const agentsDir = URI.joinPath(eccRoot, 'agents').fsPath.replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
			if (parent === agentsDir) {
				return { kind: 'agent-profile', outcome, name: (parts.at(-1) || '').replace(/\.md$/i, ''), path, tool: name };
			}
		}
		return undefined;
	}
	if (['runsubagent', 'executionsubagent', 'searchsubagent', 'exploresubagent'].includes(normalized)) {
		const agentName = typeof args.agentName === 'string' && args.agentName.trim() ? args.agentName.trim() : '';
		return { kind: 'agent', outcome, name: agentName, tool: name };
	}
	return undefined;
}

/** Deduplicate repeated outcomes while still reporting a failure followed by success. */
export class SelectionEvidenceTracker {
	private readonly seen = new Set<string>();
	private readonly kinds = new Set<SelectionEvidence['kind']>();

	add(event: SelectionEvidence): boolean {
		this.kinds.add(event.kind);
		const key = JSON.stringify([event.kind, event.outcome, event.name, event.path, event.tool]);
		if (this.seen.has(key)) { return false; }
		this.seen.add(key);
		return true;
	}

	has(kind: SelectionEvidence['kind']): boolean { return this.kinds.has(kind); }
}
