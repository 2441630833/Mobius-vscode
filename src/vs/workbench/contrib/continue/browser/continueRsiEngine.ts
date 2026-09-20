/*---------------------------------------------------------------------------------------------
 *  Mobius — Recursive Self-Improvement (RSI) engine (production).
 *
 *  This is the live counterpart to the `rsi-test/` reference loop. It lets the
 *  self-evolving agent propose changes to its OWN skills — but only promotes a
 *  candidate after it survives an INDEPENDENT evaluation on a hidden acceptance
 *  set, five deterministic quality gates, and (optionally) human approval.
 *
 *  Three iron rules, enforced structurally:
 *   1. The proposer never sees the acceptance set — only the visible (train)
 *      dataset and its misses. `runIteration` passes only `train` through.
 *   2. The agent cannot modify the evaluator or the gates. Both live in this
 *      module, imported read-only by the loop. The acceptance file is
 *      human-owned; the agent has no write path to it.
 *   3. One small step per iteration; every promotion writes the previous
 *      champion to `history/` first, so a single rollback undoes it.
 *
 *  On-disk layout (`.agents/skills/rsi/` by default — NOT auto-loaded):
 *    acceptance.json     human-owned hidden test set  (never written here)
 *    champion.json       the current promoted skill set
 *    candidates/<id>.json  audit trail of materialized candidates
 *    history/<stamp>.json  pre-promotion snapshots (rollback source)
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../../base/common/buffer.js';
import { URI } from '../../../../base/common/uri.js';
import { joinPath } from '../../../../base/common/resources.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import {
	IAgentSkill,
} from '../../chat/common/promptSyntax/service/promptsService.js';
import { rankSkillsForMessage } from './continueSkillsContext.js';

//#region Types

/** A skill definition as it participates in the RSI loop (router-relevant fields only). */
export interface RsiSkill {
	readonly name: string;
	readonly description: string;
	readonly body: string;
}

/** Materialized, immutable snapshot of a skill set (champion or candidate). */
export interface RsiSkillSet {
	readonly skills: readonly RsiSkill[];
}

export interface RsiCase {
	readonly prompt: string;
	readonly expectSkill: string;
}

export interface RsiDataset {
	readonly cases: readonly RsiCase[];
}

/** One proposed edit — pure data, applied off-champion (never mutating in place). */
export interface RsiEdit {
	/** Skill name being added or updated. */
	readonly target: string;
	/** New description (undefined = keep existing). */
	readonly description?: string;
	/** New body (undefined = keep existing). */
	readonly body?: string;
	/** The LLM's stated rationale for the edit. */
	readonly rationale: string;
}

export interface RsiProposal {
	readonly edit?: RsiEdit;
	readonly rationale: string;
}

export interface RsiGateResult {
	readonly id: string;
	readonly passed: boolean;
	readonly detail: string;
}

export interface RsiEvalResult {
	readonly accuracy: number;
	readonly topk: number;
	readonly correct: number;
	readonly total: number;
	readonly misses: readonly { prompt: string; expect: string; got: string }[];
}

export interface RsiGateReport {
	readonly passed: boolean;
	readonly gates: readonly RsiGateResult[];
	readonly champion: RsiEvalResult;
	readonly candidate: RsiEvalResult;
}

export type RsiStatus =
	| 'promoted'
	| 'rejected-by-gate'
	| 'awaiting-human-approval'
	| 'no-op'
	| 'skipped-no-acceptance';

export interface RsiIterationResult {
	readonly status: RsiStatus;
	readonly rationale: string;
	readonly edit?: RsiEdit;
	readonly champion?: RsiEvalResult;
	readonly candidate?: RsiEvalResult;
	readonly gates: readonly RsiGateResult[];
	readonly candidateSet?: RsiSkillSet;
}

/** Gate thresholds. Tightening these is a human decision, not the agent's. */
export const RSI_GATE_DEFAULTS = {
	/** Gate 1 — candidate accuracy must not drop below champion. */
	maxAccuracyDrop: 0.0,
	/** Gate 2 — absolute accuracy floor the candidate must clear. */
	minAccuracy: 0.6,
	/** Gate 3 — no non-zero champion class may collapse to zero. */
	noClassCollapse: true,
	/** Gate 4 — candidate must strictly beat the champion. */
	requireNetPositive: true,
	/** Gate 5 — top-3 recall must not drop. */
	maxTopkDrop: 0.0,
} as const;

export type RsiGateOverrides = Partial<typeof RSI_GATE_DEFAULTS>;

/** How the engine treats a gate result for the self-evolving write path. */
export type RsiMode =
	/** Never gate — behave exactly as before RSI (write candidate directly). */
	| 'off'
	/** Evaluate + log + keep audit trail, but still write (safe rollout). */
	| 'shadow'
	/** Only write when the candidate passes every gate; else hold champion. */
	| 'enforce';

//#endregion

//#region Independent evaluator (iron rule #2 — agent cannot modify this)

/**
 * Score a skill set against a dataset using the REAL hybrid router's lexical ranker.
 *
 * accuracy = fraction of cases where the expected skill routes Top-1.
 * topk     = fraction where the expected skill is in the top-3.
 *
 * Deterministic; no LLM. Safe to run on the hidden acceptance set.
 */
export function evaluateSkillSet(skillSet: RsiSkillSet, dataset: RsiDataset): RsiEvalResult {
	const agentSkills = toAgentSkills(skillSet);
	let correct = 0;
	let topk = 0;
	const misses: { prompt: string; expect: string; got: string }[] = [];

	for (const c of dataset.cases) {
		const ranked = rankSkillsForMessage(c.prompt, agentSkills);
		const top1 = ranked[0]?.skill.name ?? '(none)';
		const top3 = ranked.slice(0, 3).map(h => h.skill.name);
		if (top1 === c.expectSkill) {
			correct++;
		} else {
			misses.push({ prompt: c.prompt, expect: c.expectSkill, got: top1 });
		}
		if (top3.includes(c.expectSkill)) {
			topk++;
		}
	}

	const total = dataset.cases.length || 1;
	return {
		accuracy: correct / total,
		topk: topk / total,
		correct,
		total: dataset.cases.length,
		misses,
	};
}

/** Per-class Top-1 accuracy, used by the "no class collapse" gate. */
export function perClassAccuracy(skillSet: RsiSkillSet, dataset: RsiDataset): Record<string, number> {
	const agentSkills = toAgentSkills(skillSet);
	const buckets = new Map<string, { correct: number; total: number }>();
	for (const c of dataset.cases) {
		const b = buckets.get(c.expectSkill) ?? { correct: 0, total: 0 };
		b.total++;
		if ((rankSkillsForMessage(c.prompt, agentSkills)[0]?.skill.name ?? '') === c.expectSkill) {
			b.correct++;
		}
		buckets.set(c.expectSkill, b);
	}
	const out: Record<string, number> = {};
	for (const [cls, b] of buckets) {
		out[cls] = b.correct / (b.total || 1);
	}
	return out;
}

/** Skills whose shape would fail the router's parse (bad name / empty fields). */
export function parseErrors(skillSet: RsiSkillSet, dataset: RsiDataset): string[] {
	const errors: string[] = [];
	const known = new Set(dataset.cases.map(c => c.expectSkill));
	for (const s of skillSet.skills) {
		if (!/^[a-z0-9-]{2,40}$/.test(s.name)) {
			errors.push(`${s.name}: bad name`);
		}
		if (!s.description) {
			errors.push(`${s.name}: empty description`);
		}
		if (!s.body) {
			errors.push(`${s.name}: empty body`);
		}
		if (!known.has(s.name)) {
			// A skill that no acceptance case exercises is inert but not invalid.
			continue;
		}
	}
	return errors;
}

/** Run all five gates for `candidate` vs `champion` on the hidden acceptance set. */
export function runRsiGates(
	championSet: RsiSkillSet,
	candidateSet: RsiSkillSet,
	dataset: RsiDataset,
	overrides: RsiGateOverrides = {},
): RsiGateReport {
	const t = { ...RSI_GATE_DEFAULTS, ...overrides };
	const champion = evaluateSkillSet(championSet, dataset);
	const candidate = evaluateSkillSet(candidateSet, dataset);
	const championClasses = perClassAccuracy(championSet, dataset);
	const candidateClasses = perClassAccuracy(candidateSet, dataset);
	const parseErrs = parseErrors(candidateSet, dataset);

	const gates: RsiGateResult[] = [];

	// Gate 1 — no regression vs champion.
	const accDrop = champion.accuracy - candidate.accuracy;
	gates.push({
		id: 'no-regression',
		passed: accDrop <= t.maxAccuracyDrop + 1e-9,
		detail: `accuracy champion=${fmt(champion.accuracy)} candidate=${fmt(candidate.accuracy)} drop=${fmt(accDrop)} (max ${t.maxAccuracyDrop})`,
	});

	// Gate 2 — accuracy floor.
	gates.push({
		id: 'accuracy-not-down',
		passed: candidate.accuracy >= t.minAccuracy - 1e-9,
		detail: `candidate accuracy=${fmt(candidate.accuracy)} (min ${t.minAccuracy})`,
	});

	// Gate 3 — no parse errors.
	gates.push({
		id: 'no-parse-errors',
		passed: parseErrs.length === 0,
		detail: parseErrs.length ? `parse errors: ${parseErrs.join('; ')}` : 'all skills parse',
	});

	// Gate 4 — net positive gain (strictly better) when required.
	gates.push({
		id: 'net-positive-gain',
		passed: !t.requireNetPositive || candidate.accuracy > champion.accuracy + 1e-9,
		detail: `candidate ${fmt(candidate.accuracy)} vs champion ${fmt(champion.accuracy)}`,
	});

	// Gate 5 — no class collapse + top-k floor.
	const collapsed: string[] = [];
	if (t.noClassCollapse) {
		for (const [cls, acc] of Object.entries(championClasses)) {
			if (acc > 0 && (candidateClasses[cls] ?? 0) === 0) {
				collapsed.push(cls);
			}
		}
	}
	const topkDrop = champion.topk - candidate.topk;
	const topkOk = topkDrop <= t.maxTopkDrop + 1e-9;
	gates.push({
		id: 'no-class-collapse',
		passed: collapsed.length === 0 && topkOk,
		detail: collapsed.length
			? `collapsed classes: ${collapsed.join(', ')}`
			: `no collapse; topk champion=${fmt(champion.topk)} candidate=${fmt(candidate.topk)}`,
	});

	return {
		passed: gates.every(g => g.passed),
		gates,
		champion,
		candidate,
	};
}

//#endregion

//#region Immutable skill-set edits (never mutate champion in place)

/** Apply a single edit off a champion set, returning a NEW set. */
export function applyRsiEdit(champion: RsiSkillSet, edit: RsiEdit): RsiSkillSet {
	let found = false;
	const skills = champion.skills.map(s => {
		if (s.name !== edit.target) {
			return s;
		}
		found = true;
		return {
			name: s.name,
			description: edit.description ?? s.description,
			body: edit.body ?? s.body,
		};
	});
	if (!found) {
		skills.push({
			name: edit.target,
			description: edit.description ?? '',
			body: edit.body ?? '',
		});
	}
	return { skills };
}

//#endregion

//#region Champion store (disk-backed, rollbackable)

interface RsiHistoryEntry {
	readonly stamp: string;
	readonly champion: RsiSkillSet;
	readonly meta?: Record<string, unknown>;
}

/**
 * Persists the champion, materialized candidates, and pre-promotion snapshots
 * under a dedicated `rsi/` directory. Every `promote()` writes the outgoing
 * champion to `history/` FIRST — so `rollback()` is a single-pointer swap.
 */
export class RsiChampionStore {
	private readonly _root: URI;

	constructor(
		private readonly _fileService: IFileService,
		workspaceService: IWorkspaceContextService,
		private readonly _subdir: string = '.agents/skills/rsi',
	) {
		const workspaceFolder = workspaceService.getWorkspace().folders[0];
		const home = typeof process !== 'undefined' && process.env
			? (process.env.HOME || process.env.USERPROFILE || '')
			: '';
		const base = workspaceFolder?.uri ?? URI.file(home);
		this._root = joinPath(base, ...this._subdir.split('/'));
	}

	get rootUri(): URI {
		return this._root;
	}

	/** Hidden acceptance set — human-owned; this class only ever READS it. */
	async loadAcceptance(): Promise<RsiDataset | undefined> {
		return this._readJson<RsiDataset>(joinPath(this._root, 'acceptance.json'));
	}

	async loadChampion(): Promise<RsiSkillSet> {
		const champion = await this._readJson<RsiSkillSet>(joinPath(this._root, 'champion.json'));
		return champion ?? { skills: [] };
	}

	async hasChampion(): Promise<boolean> {
		return !!(await this.loadChampion()).skills.length;
	}

	/** Write the candidate to `candidates/<id>.json` for the audit trail. */
	async stageCandidate(id: string, candidate: RsiSkillSet): Promise<void> {
		await this._writeJson(joinPath(this._root, 'candidates', `${safeId(id)}.json`), candidate);
	}

	/**
	 * Promote a candidate to champion. The outgoing champion is snapshotted to
	 * `history/<stamp>.json` first. Returns the rollback stamp.
	 */
	async promote(candidate: RsiSkillSet, meta?: Record<string, unknown>): Promise<string> {
		const previous = await this.loadChampion();
		const stamp = `rsi_${Date.now()}`;
		if (previous.skills.length) {
			const entry: RsiHistoryEntry = { stamp, champion: previous, meta };
			await this._writeJson(joinPath(this._root, 'history', `${stamp}.json`), entry);
		}
		await this._writeJson(joinPath(this._root, 'champion.json'), candidate);
		return stamp;
	}

	/** Undo the most recent promotion. Returns the restored set, or undefined. */
	async rollback(): Promise<RsiSkillSet | undefined> {
		const stamps = await this._listHistoryStamps();
		if (!stamps.length) {
			return undefined;
		}
		const last = stamps[stamps.length - 1];
		const entry = await this._readJson<RsiHistoryEntry>(joinPath(this._root, 'history', `${last}.json`));
		if (!entry) {
			return undefined;
		}
		await this._writeJson(joinPath(this._root, 'champion.json'), entry.champion);
		try {
			await this._fileService.del(joinPath(this._root, 'history', `${last}.json`));
		} catch { /* best-effort cleanup */ }
		return entry.champion;
	}

	private async _listHistoryStamps(): Promise<string[]> {
		try {
			const stat = await this._fileService.resolve(joinPath(this._root, 'history'));
			return (stat.children ?? [])
				.filter(c => c.name.endsWith('.json'))
				.map(c => c.name.slice(0, -'.json'.length))
				.sort();
		} catch {
			return [];
		}
	}

	private async _readJson<T>(uri: URI): Promise<T | undefined> {
		try {
			const text = (await this._fileService.readFile(uri)).value.toString();
			return JSON.parse(text) as T;
		} catch {
			return undefined;
		}
	}

	private async _writeJson(uri: URI, value: unknown): Promise<void> {
		await this._fileService.createFolder(URI.joinPath(uri, '..'));
		await this._fileService.writeFile(uri, VSBuffer.fromString(JSON.stringify(value, null, 2)));
	}
}

//#endregion

//#region The loop (iron rule #1 — proposer sees train only)

export interface RsiIterationOptions {
	readonly championSet: RsiSkillSet;
	readonly acceptance: RsiDataset;
	readonly train: RsiDataset;
	readonly proposer: (champion: RsiSkillSet, context: { visible: RsiDataset; misses: readonly { prompt: string; expect: string; got: string }[] }) => Promise<RsiProposal>;
	readonly approve?: (proposal: RsiProposal, report: RsiGateReport) => Promise<boolean>;
	readonly gateOverrides?: RsiGateOverrides;
}

/**
 * Run one RSI iteration.
 *
 * The proposer receives ONLY the train dataset and its misses (iron rule #1).
 * If it proposes no edit → no-op. Otherwise the candidate is materialized
 * off-champion, gated on the hidden acceptance set (rule #2), then optionally
 * human-approved (rule #3).
 */
export async function runRsiIteration(opts: RsiIterationOptions): Promise<RsiIterationResult> {
	const championEval = evaluateSkillSet(opts.championSet, opts.acceptance);

	const trainMisses = evaluateSkillSet(opts.championSet, opts.train).misses;
	const proposal = await opts.proposer(opts.championSet, { visible: opts.train, misses: trainMisses });

	if (!proposal?.edit) {
		return { status: 'no-op', rationale: proposal?.rationale ?? 'Proposer produced no edit', champion: championEval, gates: [] };
	}

	const candidateSet = applyRsiEdit(opts.championSet, proposal.edit);
	const report = runRsiGates(opts.championSet, candidateSet, opts.acceptance, opts.gateOverrides);

	if (!report.passed) {
		return {
			status: 'rejected-by-gate',
			rationale: proposal.rationale,
			edit: proposal.edit,
			champion: report.champion,
			candidate: report.candidate,
			gates: report.gates,
			candidateSet,
		};
	}

	const approved = opts.approve ? await opts.approve(proposal, report) : false;
	if (!approved) {
		return {
			status: 'awaiting-human-approval',
			rationale: proposal.rationale,
			edit: proposal.edit,
			champion: report.champion,
			candidate: report.candidate,
			gates: report.gates,
			candidateSet,
		};
	}

	return {
		status: 'promoted',
		rationale: proposal.rationale,
		edit: proposal.edit,
		champion: report.champion,
		candidate: report.candidate,
		gates: report.gates,
		candidateSet,
	};
}

//#endregion

//#region Helpers

/** Adapt RSI skills to the router's `IAgentSkill` shape (uri decides the routing prior). */
function toAgentSkills(skillSet: RsiSkillSet): IAgentSkill[] {
	return skillSet.skills.map(s => ({
		uri: URI.file(`/.agents/skills/auto/${s.name}/SKILL.md`),
		storage: 'local' as IAgentSkill['storage'],
		name: s.name,
		description: s.description,
		disableModelInvocation: false,
		userInvocable: true,
	}));
}

function safeId(id: string): string {
	return id.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
}

function fmt(n: number): string {
	return Number(n).toFixed(3);
}

//#endregion
