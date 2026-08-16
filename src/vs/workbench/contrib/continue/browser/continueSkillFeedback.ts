/*---------------------------------------------------------------------------------------------
 *  Mobius — Phase 2 skill routing feedback (penalty-only demotion)
 *--------------------------------------------------------------------------------------------*/

import { ILogService } from '../../../../platform/log/common/log.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';

const STORAGE_KEY = 'continue.skillRoutingFeedback.v1';

/** Minimum failure samples before feedback affects ranking. */
export const MIN_FEEDBACK_SAMPLES = 2;

/** Max penalty on fused score (never boosts — write_success is not a routing signal). */
export const MAX_FEEDBACK_PENALTY = 3;

export type SkillRoutingOutcome =
	| 'write_success'
	| 'write_failed'
	| 'explore_only'
	| 'no_execution';

interface SkillFeedbackEntry {
	readonly successes: number;
	readonly failures: number;
}

type SkillFeedbackMap = Record<string, SkillFeedbackEntry>;

/**
 * Persists per-skill **failure** outcomes only and exposes a penalty for the ranker.
 *
 * write_success is intentionally NOT recorded: a successful write_file only means the
 * agent executed — it does not prove the routed skill matched the user's prompt intent.
 */
export class ContinueSkillFeedbackStore {
	private _data: SkillFeedbackMap = {};

	constructor(
		private readonly _storageService: IStorageService,
		private readonly _logService: ILogService,
	) {
		this._load();
	}

	/** Penalty-only boost in [-MAX_FEEDBACK_PENALTY, 0]. Never positive. */
	getScoreBoost(skillName: string): number {
		const entry = this._data[skillName.toLowerCase()];
		if (!entry || entry.failures < MIN_FEEDBACK_SAMPLES) {
			return 0;
		}
		// More repeated failures → stronger demotion. Successes are ignored.
		const normalized = Math.min(1, (entry.failures - MIN_FEEDBACK_SAMPLES + 1) / 4);
		return -normalized * MAX_FEEDBACK_PENALTY;
	}

	getStats(skillName: string): SkillFeedbackEntry | undefined {
		return this._data[skillName.toLowerCase()];
	}

	recordOutcome(skillNames: readonly string[], outcome: SkillRoutingOutcome): void {
		if (!skillNames.length) {
			return;
		}
		// write_success is not a routing-quality signal — do not reinforce skills.
		if (outcome === 'write_success') {
			this._logService.trace(
				`[Continue] Skill feedback skipped (write_success is not a routing signal): skills=[${skillNames.join(', ')}]`,
			);
			return;
		}

		for (const name of skillNames) {
			const key = name.toLowerCase();
			const prev = this._data[key] ?? { successes: 0, failures: 0 };
			this._data[key] = { successes: prev.successes, failures: prev.failures + 1 };
		}
		this._persist();
		this._logService.info(
			`[Continue] Skill feedback recorded: outcome=${outcome} penalty-only skills=[${skillNames.join(', ')}]`,
		);
	}

	private _load(): void {
		try {
			const raw = this._storageService.get(STORAGE_KEY, StorageScope.APPLICATION, '');
			if (!raw) {
				return;
			}
			const parsed = JSON.parse(raw) as SkillFeedbackMap;
			if (parsed && typeof parsed === 'object') {
				this._data = parsed;
			}
		} catch (err) {
			this._logService.warn('[Continue] Failed to load skill routing feedback', err);
			this._data = {};
		}
	}

	private _persist(): void {
		try {
			this._storageService.store(
				STORAGE_KEY,
				JSON.stringify(this._data),
				StorageScope.APPLICATION,
				StorageTarget.USER,
			);
		} catch (err) {
			this._logService.warn('[Continue] Failed to persist skill routing feedback', err);
		}
	}
}

/** Classify an agent session from tool-call telemetry. */
export function classifySkillRoutingOutcome(stats: {
	readonly writeSuccess: number;
	readonly writeFailed: number;
	readonly exploreOnly: boolean;
}): SkillRoutingOutcome {
	if (stats.writeSuccess > 0) {
		return 'write_success';
	}
	if (stats.writeFailed > 0) {
		return 'write_failed';
	}
	if (stats.exploreOnly) {
		return 'explore_only';
	}
	return 'no_execution';
}
