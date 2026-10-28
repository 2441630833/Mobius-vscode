/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { normalizeToolArguments, resolveToolPath, toolPathArgument } from './continueToolPaths.js';

export interface SelectionEvidence {
	readonly kind: 'skill' | 'agent' | 'agent-profile';
	readonly outcome: 'success' | 'failure';
	readonly name: string;
	readonly path?: string;
	readonly tool: string;
}

/** Successful preflight is background work; only failures need a chat notice. */
export function shouldShowEccPreflight(ok: boolean): boolean {
	return !ok;
}

/** User-facing facts, not an assertion that a model followed the instructions. */
export function formatSelectionEvidence(event: SelectionEvidence): string {
	const subject = event.path ? `${event.name} (${event.path})` : event.name;
	if (event.kind === 'skill') {
		if (event.outcome === 'failure') {
			return localize('continue.selection.skillFailed', 'Skill read failed: {0}', subject);
		}
		return event.tool === 'explicit-context' || event.tool === 'ppt-mode-context'
			? localize('continue.selection.skillIncluded', 'Skill in context: {0}', subject)
			: localize('continue.selection.skillRead', 'Skill read: {0}', subject);
	}
	if (event.kind === 'agent-profile') {
		return event.outcome === 'success'
			? localize('continue.selection.profileRead', 'Agent profile read: {0}', subject)
			: localize('continue.selection.profileFailed', 'Agent profile read failed: {0}', subject);
	}
	const agent = event.name || localize('continue.selection.agentUnspecified', 'not specified');
	return event.outcome === 'success'
		? localize('continue.selection.agentCompleted', 'Agent tool completed: {0} ({1})', agent, event.tool)
		: localize('continue.selection.agentFailed', 'Agent tool failed: {0} ({1})', agent, event.tool);
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
