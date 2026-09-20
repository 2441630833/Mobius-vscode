/*---------------------------------------------------------------------------------------------
 *  Mobius — RSI engine: gates, immutability, iron rule #1 (proposer isolation).
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	applyRsiEdit,
	evaluateSkillSet,
	perClassAccuracy,
	runRsiGates,
	runRsiIteration,
	RsiDataset,
	RsiProposal,
	RsiSkillSet,
} from '../../browser/continueRsiEngine.js';

function skills(...defs: [string, string, string][]): RsiSkillSet {
	return {
		skills: defs.map(([name, description, body]) => ({ name, description, body })),
	};
}

/**
 * A narrow-trigger champion that misses the generalization case.
 *
 * NOTE: it must be imperfect on ACCEPTANCE — gate 4 requires a candidate to
 * *strictly* beat the champion, so a fixture champion that already scores 1.0
 * leaves no headroom and every candidate is (correctly) rejected by gate 4.
 * Here `release-notes`' terse description misses the changelog case.
 */
const NARROW_CHAMPION = skills(
	['k8s-rollout', 'Use when running a kubernetes rollout.', '## Steps\nkubectl rollout'],
	['systematic-debugging', 'Use when debugging an exception.', '## Steps\nread stack'],
	['release-notes', 'Use when drafting docs.', '## Notes\nlist changes'],
);

/** Same skills, broadened triggers — the "winning" candidate shape. */
const BROAD_CHAMPION = skills(
	['k8s-rollout', 'Use when deploying or rolling out to a kubernetes cluster with pods and nodes.', '## Steps\nkubectl rollout'],
	['systematic-debugging', 'Use when debugging or diagnosing a crash, exception, or trace in code.', '## Steps\nread stack'],
	['release-notes', 'Use when writing or drafting a changelog for a tagged release.', '## Notes\nlist changes'],
);

const ACCEPTANCE: RsiDataset = {
	cases: [
		{ prompt: 'kubernetes cluster pods rollout deploy', expectSkill: 'k8s-rollout' },
		{ prompt: 'deploy to the kubernetes cluster', expectSkill: 'k8s-rollout' },
		{ prompt: 'debug this crash trace exception', expectSkill: 'systematic-debugging' },
		{ prompt: 'diagnose a stack trace crash', expectSkill: 'systematic-debugging' },
		{ prompt: 'summarise the changelog entries for this version', expectSkill: 'release-notes' },
	],
};

const TRAIN: RsiDataset = {
	cases: [
		{ prompt: 'kubernetes cluster pods rollout', expectSkill: 'k8s-rollout' },
		{ prompt: 'debug a crash trace', expectSkill: 'systematic-debugging' },
	],
};

suite('Mobius RSI engine', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('evaluateSkillSet scores Top-1 accuracy against the acceptance set', () => {
		const narrow = evaluateSkillSet(NARROW_CHAMPION, ACCEPTANCE);
		const broad = evaluateSkillSet(BROAD_CHAMPION, ACCEPTANCE);
		assert.ok(broad.accuracy >= narrow.accuracy, `broad=${broad.accuracy} narrow=${narrow.accuracy}`);
		assert.strictEqual(broad.correct + broad.misses.length, broad.total);
	});

	test('perClassAccuracy reports per-skill Top-1 fractions', () => {
		const perClass = perClassAccuracy(BROAD_CHAMPION, ACCEPTANCE);
		assert.ok('k8s-rollout' in perClass);
		assert.ok('systematic-debugging' in perClass);
	});

	test('applyRsiEdit returns a NEW set and never mutates the champion', () => {
		const before = JSON.stringify(NARROW_CHAMPION);
		const candidate = applyRsiEdit(NARROW_CHAMPION, {
			target: 'k8s-rollout',
			description: 'Use when deploying to a kubernetes cluster.',
			rationale: 'broaden trigger',
		});
		assert.notStrictEqual(candidate, NARROW_CHAMPION);
		assert.strictEqual(JSON.stringify(NARROW_CHAMPION), before, 'champion must be untouched');
		const edited = candidate.skills.find(s => s.name === 'k8s-rollout');
		assert.strictEqual(edited?.description, 'Use when deploying to a kubernetes cluster.');
	});

	test('gate 4 (net-positive-gain) rejects an edit that does not raise accuracy', () => {
		const report = runRsiGates(NARROW_CHAMPION, NARROW_CHAMPION, ACCEPTANCE);
		const netPositive = report.gates.find(g => g.id === 'net-positive-gain');
		assert.strictEqual(netPositive?.passed, false);
		assert.strictEqual(report.passed, false);
	});

	test('a genuinely broadened candidate passes all five gates', () => {
		const report = runRsiGates(NARROW_CHAMPION, BROAD_CHAMPION, ACCEPTANCE);
		const failing = report.gates.filter(g => !g.passed).map(g => g.id);
		assert.deepStrictEqual(failing, [], `unexpected failing gates: ${failing.join(', ')}`);
	});

	test('gate 3 (no-parse-errors) rejects a malformed skill', () => {
		const bad = skills(['Bad Name', 'Use when x.', 'body']);
		const report = runRsiGates(NARROW_CHAMPION, bad, ACCEPTANCE);
		const parse = report.gates.find(g => g.id === 'no-parse-errors');
		assert.strictEqual(parse?.passed, false);
	});

	test('IRON RULE #1: the proposer never sees the acceptance set', async () => {
		let proposerSawAcceptance = false;
		const acceptancePrompts = new Set(ACCEPTANCE.cases.map(c => c.prompt));

		const result = await runRsiIteration({
			championSet: NARROW_CHAMPION,
			acceptance: ACCEPTANCE,
			train: TRAIN,
			proposer: async (champion, context) => {
				const serialized = JSON.stringify(champion) + JSON.stringify(context);
				for (const prompt of acceptancePrompts) {
					if (serialized.includes(prompt) && !TRAIN.cases.some(t => t.prompt === prompt)) {
						proposerSawAcceptance = true;
					}
				}
				return { rationale: 'broaden trigger', edit: { target: 'k8s-rollout', description: 'Use when deploying to a kubernetes cluster with pods.', rationale: 'broaden' } } satisfies RsiProposal;
			},
			approve: () => Promise.resolve(true),
		});

		assert.strictEqual(proposerSawAcceptance, false, 'acceptance prompts leaked into proposer context');
		assert.ok(result.status === 'promoted' || result.status === 'rejected-by-gate');
	});

	test('no proposal → no-op (loop does not churn against zero signal)', async () => {
		const result = await runRsiIteration({
			championSet: NARROW_CHAMPION,
			acceptance: ACCEPTANCE,
			train: TRAIN,
			proposer: async () => ({ rationale: 'nothing safe' }),
			approve: () => Promise.resolve(true),
		});
		assert.strictEqual(result.status, 'no-op');
	});

	test('gate-passing candidate without approval is held (human gate)', async () => {
		const result = await runRsiIteration({
			championSet: NARROW_CHAMPION,
			acceptance: ACCEPTANCE,
			train: TRAIN,
			proposer: async () => ({
				rationale: 'broaden trigger',
				// Broaden the skill that actually fixes the acceptance miss, so the
				// candidate clears gate 4 (strict gain) and reaches the human gate.
				edit: { target: 'release-notes', description: 'Use when writing or drafting a changelog for a tagged release.', body: '## Notes\nlist changes', rationale: 'broaden' },
			}),
			approve: () => Promise.resolve(false),
		});
		assert.strictEqual(result.status, 'awaiting-human-approval');
	});
});
