/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { formatSelectionEvidence, SelectionEvidenceTracker, selectionEvidenceForTool, shouldShowEccPreflight } from '../../browser/continueSelectionEvidence.js';

suite('Continue selection evidence', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	const cwd = URI.file('C:/workspace');
	const ecc = URI.file('C:/ecc');

	test('records a successful skill read with its resolved path', () => {
		const event = selectionEvidenceForTool('read_file', JSON.stringify({ filepath: 'skills/verification-loop/SKILL.md' }), true, cwd);
		assert.strictEqual(event?.kind, 'skill');
		assert.strictEqual(event?.name, 'verification-loop');
		assert.strictEqual(event?.outcome, 'success');
		assert.strictEqual(event?.path?.replace(/\\/g, '/'), URI.joinPath(cwd, 'skills/verification-loop/SKILL.md').fsPath.replace(/\\/g, '/'));
	});

	test('records failure and ignores unrelated files and missing paths', () => {
		assert.strictEqual(selectionEvidenceForTool('read_file_range', { filePath: 'skills/demo/SKILL.md' }, false, cwd)?.outcome, 'failure');
		assert.strictEqual(selectionEvidenceForTool('read_file', { path: 'README.md' }, true, cwd), undefined);
		assert.strictEqual(selectionEvidenceForTool('read_file', {}, true, cwd), undefined);
	});

	test('tracks ECC skill and its real root, without inventing a root', () => {
		const event = selectionEvidenceForTool('ecc_skill', { skill_name: 'verification-loop' }, true, cwd, ecc);
		assert.strictEqual(event?.path, URI.joinPath(ecc, 'skills', 'verification-loop', 'SKILL.md').fsPath);
		assert.strictEqual(selectionEvidenceForTool('ecc_skill', { skill_name: 'x' }, false)?.path, undefined);
		assert.strictEqual(selectionEvidenceForTool('ecc_skill', {}, true, cwd, ecc), undefined);
	});

	test('reports the requested agent only for an actual tool call', () => {
		const event = selectionEvidenceForTool('runSubagent', { agentName: 'code-reviewer', description: 'Review changes' }, true);
		assert.strictEqual(event?.kind, 'agent');
		assert.strictEqual(event?.name, 'code-reviewer');
		assert.strictEqual(event?.outcome, 'success');
		assert.strictEqual(selectionEvidenceForTool('runSubagent', {}, false)?.name, '');
		assert.strictEqual(selectionEvidenceForTool('ecc_consult', { query: 'code-reviewer' }, true), undefined);
	});

	test('distinguishes reading an ECC agent profile from invoking an agent', () => {
		const path = URI.joinPath(ecc, 'agents', 'code-reviewer.md').fsPath;
		const event = selectionEvidenceForTool('read_file', { path }, true, cwd, ecc);
		assert.strictEqual(event?.kind, 'agent-profile');
		assert.strictEqual(event?.name, 'code-reviewer');
		assert.strictEqual(event?.path, path);
		assert.strictEqual(selectionEvidenceForTool('read_file', { path: '/elsewhere/agents/code-reviewer.md' }, true, cwd, ecc), undefined);
		const tracker = new SelectionEvidenceTracker();
		assert.ok(tracker.add(event!));
		assert.ok(!tracker.has('agent'));
	});

	test('deduplicates within a request, but reports failure then success independently', () => {
		const tracker = new SelectionEvidenceTracker();
		const failed = selectionEvidenceForTool('ecc_skill', { skill_name: 'demo' }, false)!;
		const success = selectionEvidenceForTool('ecc_skill', { skill_name: 'demo' }, true)!;
		assert.ok(tracker.add(failed));
		assert.ok(!tracker.add(failed));
		assert.ok(tracker.add(success));
		assert.ok(tracker.has('skill'));
		assert.ok(!tracker.has('agent'));
		assert.ok(new SelectionEvidenceTracker().add(failed));
	});

	test('keeps successful preflight quiet and displays failures', () => {
		assert.strictEqual(shouldShowEccPreflight(true), false);
		assert.strictEqual(shouldShowEccPreflight(false), true);
	});

	test('formats concise, distinct selection outcomes and preserves paths', () => {
		const path = URI.joinPath(cwd, 'skills', 'demo', 'SKILL.md').fsPath;
		assert.strictEqual(formatSelectionEvidence({ kind: 'skill', outcome: 'success', name: 'demo', path, tool: 'explicit-context' }), `Skill in context: demo (${path})`);
		assert.strictEqual(formatSelectionEvidence({ kind: 'skill', outcome: 'success', name: 'demo', path, tool: 'read_file' }), `Skill read: demo (${path})`);
		assert.strictEqual(formatSelectionEvidence({ kind: 'skill', outcome: 'failure', name: 'demo', path, tool: 'read_file' }), `Skill read failed: demo (${path})`);
		assert.strictEqual(formatSelectionEvidence({ kind: 'agent-profile', outcome: 'success', name: 'reviewer', path, tool: 'read_file' }), `Agent profile read: reviewer (${path})`);
		assert.strictEqual(formatSelectionEvidence({ kind: 'agent', outcome: 'success', name: 'reviewer', tool: 'runSubagent' }), 'Agent tool completed: reviewer (runSubagent)');
		assert.strictEqual(formatSelectionEvidence({ kind: 'agent', outcome: 'failure', name: '', tool: 'runSubagent' }), 'Agent tool failed: not specified (runSubagent)');
	});
});
