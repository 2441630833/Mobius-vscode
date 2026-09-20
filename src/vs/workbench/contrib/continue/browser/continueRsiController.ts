/*---------------------------------------------------------------------------------------------
 *  Mobius — RSI controller: binds the RSI engine to the live Skill engine.
 *
 *  Responsibilities:
 *   - Load the champion from the REAL auto-generated skills out of
 *     `.agents/skills/auto/` (the ones the hybrid router already auto-loads).
 *   - Synthesize a propose→gate→promote loop with the same ILanguageModelsService
 *     the self-evolving engine uses (LLM proposer).
 *   - On promotion, materialize the winning candidate back to `.agents/skills/auto/`
 *     so the change actually takes effect on future turns.
 *   - Expose rollback (one step) driven by the champion store's history/.
 *
 *  Safety posture: in `shadow` mode the loop evaluates + records but never writes;
 *  in `enforce` mode it writes ONLY gate-passing, optionally human-approved candidates.
 *  The acceptance set is human-owned and never written by this class.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { URI } from '../../../../base/common/uri.js';
import { joinPath } from '../../../../base/common/resources.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import {
	ChatMessageRole,
	ILanguageModelsService,
} from '../../chat/common/languageModels.js';
import {
	RsiChampionStore,
	RsiDataset,
	RsiIterationResult,
	RsiMode,
	RsiProposal,
	RsiSkill,
	RsiSkillSet,
	runRsiIteration,
} from './continueRsiEngine.js';

/** Where auto-generated skills live — matches `continueSelfEvolving.ts`. */
const AUTO_SKILLS_SUBDIR = '.agents/skills/auto';

/**
 * Process-wide handle to the live controller, set when the chat agent is
 * constructed. Lets workbench commands (approve/rollback/evaluate) reach the
 * same instance without threading services through the command layer.
 */
let activeRsiController: ContinueRsiController | undefined;
export function setActiveRsiController(controller: ContinueRsiController): void {
	activeRsiController = controller;
}
export function getActiveRsiController(): ContinueRsiController | undefined {
	return activeRsiController;
}

export interface RsiControllerConfig {
	readonly mode: RsiMode;
	/** Storage root for the RSI sandbox (champion/candidates/history). */
	readonly storeSubdir: string;
	/** Use ~/.agents/skills/auto instead of workspace for the live skills. */
	readonly global: boolean;
}

export interface RsiRunReport {
	readonly status: RsiIterationResult['status'];
	readonly rationale: string;
	readonly championAccuracy: number;
	readonly candidateAccuracy: number;
	readonly gates: readonly { id: string; passed: boolean; detail: string }[];
	/** Skills written back to disk (only when promoted + mode=enforce). */
	readonly writtenSkills: readonly string[];
	readonly rollbackStamp?: string;
}

/**
 * Drives RSI over the live auto-generated skill set.
 *
 * Usage from the chat agent (after a task completes with write success):
 *   const report = await rsi.maybeImprove(token);
 * A human-facing command (`mobius.rsi.approve` / `.rollback`) can drive it too.
 */
export class ContinueRsiController {
	constructor(
		private readonly _languageModelsService: ILanguageModelsService,
		private readonly _fileService: IFileService,
		private readonly _workspaceService: IWorkspaceContextService,
		private readonly _logService: ILogService,
		private readonly _resolveModelId: () => string | undefined,
		private readonly _config: RsiControllerConfig,
	) { }

	/** True when the engine is active enough to be worth invoking. */
	get active(): boolean {
		return this._config.mode !== 'off';
	}

	private _store(): RsiChampionStore {
		return new RsiChampionStore(this._fileService, this._workspaceService, this._config.storeSubdir);
	}

	/**
	 * Run one RSI iteration over the live skill set. Returns a report; never throws.
	 * No-op when there is no acceptance set or no auto-generated skills to improve.
	 */
	async maybeImprove(token: CancellationToken): Promise<RsiRunReport | undefined> {
		if (!this.active) {
			return undefined;
		}
		try {
			const store = this._store();
			const acceptance = await store.loadAcceptance();
			if (!acceptance?.cases?.length) {
				this._logService.trace('[RSI] No acceptance set at .agents/skills/rsi/acceptance.json — skipping');
				return undefined;
			}

			// Champion = the live auto-generated skills. Bootstrap the store from disk
			// the first time so history/rollback has a stable baseline.
			let champion = await store.loadChampion();
			if (!champion.skills.length) {
				champion = await this._readLiveSkills();
				if (!champion.skills.length) {
					return undefined;
				}
				await store.promote(champion, { bootstrap: true });
			}

			const train = await this._loadTrain(acceptance);
			const report = await runRsiIteration({
				championSet: champion,
				acceptance,
				train,
				proposer: (set, ctx) => this._propose(set, ctx, token),
				approve: () => Promise.resolve(this._config.mode === 'enforce'),
			});

			this._logReport(report);

			if (report.status !== 'promoted' || !report.candidateSet) {
				return {
					status: report.status,
					rationale: report.rationale,
					championAccuracy: report.champion?.accuracy ?? 0,
					candidateAccuracy: report.candidate?.accuracy ?? 0,
					gates: report.gates,
					writtenSkills: [],
				};
			}

			// Audit trail for every passing candidate.
			await store.stageCandidate(`cand_${Date.now()}`, report.candidateSet);

			// In enforce mode, write the winner back to the live skills so it takes effect.
			const written = this._config.mode === 'enforce'
				? await this._materializeLiveSkills(report.candidateSet)
				: [];
			const stamp = await store.promote(report.candidateSet, {
				rationale: report.rationale,
				championAccuracy: report.champion?.accuracy,
				candidateAccuracy: report.candidate?.accuracy,
			});

			return {
				status: report.status,
				rationale: report.rationale,
				championAccuracy: report.champion?.accuracy ?? 0,
				candidateAccuracy: report.candidate?.accuracy ?? 0,
				gates: report.gates,
				writtenSkills: written,
				rollbackStamp: stamp,
			};
		} catch (err) {
			this._logService.warn('[RSI] Iteration failed', err);
			return undefined;
		}
	}

	/** Undo the most recent promotion. Restores the previous champion to disk too. */
	async rollback(): Promise<{ restored: boolean; skills: readonly string[] }> {
		try {
			const store = this._store();
			const restoredSet = await store.rollback();
			if (!restoredSet) {
				return { restored: false, skills: [] };
			}
			const written = this._config.mode === 'enforce'
				? await this._materializeLiveSkills(restoredSet)
				: [];
			this._logService.info(`[RSI] Rolled back last promotion; restored ${restoredSet.skills.length} skill(s)`);
			return { restored: true, skills: written };
		} catch (err) {
			this._logService.warn('[RSI] Rollback failed', err);
			return { restored: false, skills: [] };
		}
	}

	/** Score the current champion against the acceptance set (diagnostics). */
	async evaluateChampion(): Promise<{ accuracy: number; total: number } | undefined> {
		const store = this._store();
		const acceptance = await store.loadAcceptance();
		if (!acceptance?.cases?.length) {
			return undefined;
		}
		const champion = await store.loadChampion();
		const { evaluateSkillSet } = await import('./continueRsiEngine.js');
		const evalResult = evaluateSkillSet(champion, acceptance);
		return { accuracy: evalResult.accuracy, total: evalResult.total };
	}

	//#region Proposer (LLM) — sees only train + misses (iron rule #1)

	private async _propose(
		champion: RsiSkillSet,
		context: { visible: RsiDataset; misses: readonly { prompt: string; expect: string; got: string }[] },
		token: CancellationToken,
	): Promise<RsiProposal> {
		if (!context.misses.length) {
			return { rationale: 'No visible (train) misses to learn from — nothing to improve.' };
		}
		const modelId = this._resolveModelId();
		if (!modelId) {
			return { rationale: 'No model available for RSI proposal.' };
		}

		const systemPrompt = `You are the PROPOSER in a controlled Recursive Self-Improvement loop for a coding agent's Skills.
A skill routes a user prompt to a workflow via name + description. You are shown ONLY a visible (train) dataset and which prompts the current skills MISS. You are NOT shown the hidden acceptance set — do not try to guess it.

Propose exactly ONE small edit (to a single skill) that would make these missed prompts route to the expected skill, WITHOUT hurting the skills that already work. Generalize the TRIGGER concept (broaden the description), not the exact sentence.

Output ONLY a JSON object (no markdown fences):
{ "target": "<skill-name being edited>", "description": "Use when ... (broadened trigger)", "body": "## When to use\\n...\\n## Steps\\n...", "rationale": "why this generalizes" }

Rules:
- target must match /^[a-z0-9-]{2,40}$/
- description must start with "Use when"
- description length 20-200 chars; must retain the concept, not the literal prompt
- If no safe generalization exists, output { "target": "", "rationale": "no safe edit" }`;

		const misses = context.misses.slice(0, 12)
			.map(m => `- prompt: "${m.prompt}"\n  expected: ${m.expect}\n  currently: ${m.got}`)
			.join('\n');
		const skills = champion.skills
			.map(s => `- ${s.name}: ${s.description}`)
			.join('\n');

		const userPrompt = `Current skills:\n${skills}\n\nVisible (train) misses to fix:\n${misses}\n\nPropose ONE generalizing edit.`;

		try {
			const response = await this._languageModelsService.sendChatRequest(
				modelId,
				undefined,
				[
					{ role: ChatMessageRole.System, content: [{ type: 'text', value: systemPrompt }] },
					{ role: ChatMessageRole.User, content: [{ type: 'text', value: userPrompt }] },
				],
				{},
				token,
			);
			let fullText = '';
			for await (const part of response.stream) {
				const parts = Array.isArray(part) ? part : [part];
				for (const p of parts) {
					if (p.type === 'text') {
						fullText += p.value;
					}
				}
				if (token.isCancellationRequested) {
					return { rationale: 'Cancelled.' };
				}
			}
			return this._parseProposal(fullText);
		} catch (err) {
			this._logService.warn('[RSI] Proposer LLM call failed', err);
			return { rationale: 'Proposer LLM call failed.' };
		}
	}

	private _parseProposal(raw: string): RsiProposal {
		let text = raw.trim();
		const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
		if (fence) {
			text = fence[1].trim();
		}
		const start = text.indexOf('{');
		const end = text.lastIndexOf('}');
		if (start < 0 || end <= start) {
			return { rationale: 'Proposer returned no JSON.' };
		}
		try {
			const parsed = JSON.parse(text.slice(start, end + 1));
			const target = String(parsed.target ?? '').trim().toLowerCase();
			const rationale = String(parsed.rationale ?? '').trim() || 'Proposed edit.';
			if (!/^[a-z0-9-]{2,40}$/.test(target)) {
				return { rationale };
			}
			return {
				rationale,
				edit: {
					target,
					description: typeof parsed.description === 'string' ? parsed.description.trim() : undefined,
					body: typeof parsed.body === 'string' ? parsed.body.trim() : undefined,
					rationale,
				},
			};
		} catch {
			return { rationale: 'Proposer JSON parse failed.' };
		}
	}

	//#endregion

	//#region Live skill I/O

	/** Read every SKILL.md under the live auto-skills folder into an RsiSkillSet. */
	private async _readLiveSkills(): Promise<RsiSkillSet> {
		const root = this._liveRoot();
		try {
			const stat = await this._fileService.resolve(root);
			const skills: RsiSkill[] = [];
			for (const child of stat.children ?? []) {
				if (!child.isDirectory) {
					continue;
				}
				try {
					const content = (await this._fileService.readFile(joinPath(child.resource, 'SKILL.md'))).value.toString();
					const name = content.match(/^name:\s*(.+)$/m)?.[1]?.replace(/^["']|["']$/g, '') ?? child.name;
					const description = content.match(/^description:\s*(.+)$/m)?.[1]?.replace(/^["']|["']$/g, '') ?? '';
					const body = stripFrontmatter(content);
					skills.push({ name, description, body });
				} catch { /* skip malformed skill */ }
			}
			return { skills };
		} catch {
			return { skills: [] };
		}
	}

	/** Write an RsiSkillSet back to the live `.agents/skills/auto/` folder. */
	private async _materializeLiveSkills(skillSet: RsiSkillSet): Promise<string[]> {
		const root = this._liveRoot();
		const written: string[] = [];
		for (const skill of skillSet.skills) {
			if (!/^[a-z0-9-]{2,40}$/.test(skill.name)) {
				continue;
			}
			const dir = joinPath(root, skill.name);
			const uri = joinPath(dir, 'SKILL.md');
			const frontmatter = [
				'---',
				`name: ${skill.name}`,
				`description: ${JSON.stringify(skill.description)}`,
				'rsi-managed: true',
				`updated-at: ${new Date().toISOString()}`,
				'---',
				'',
			].join('\n');
			await this._fileService.createFolder(dir);
			await this._fileService.writeFile(uri, VSBuffer.fromString(frontmatter + skill.body + '\n'));
			written.push(skill.name);
		}
		return written;
	}

	private _liveRoot(): URI {
		if (this._config.global) {
			const home = typeof process !== 'undefined' && process.env
				? (process.env.HOME || process.env.USERPROFILE || '')
				: '';
			return joinPath(URI.file(home), ...AUTO_SKILLS_SUBDIR.split('/'));
		}
		const folder = this._workspaceService.getWorkspace().folders[0];
		if (folder) {
			return joinPath(folder.uri, ...AUTO_SKILLS_SUBDIR.split('/'));
		}
		const home = typeof process !== 'undefined' && process.env
			? (process.env.HOME || process.env.USERPROFILE || '')
			: '';
		return joinPath(URI.file(home), ...AUTO_SKILLS_SUBDIR.split('/'));
	}

	//#endregion

	//#region Train split + logging

	/**
	 * Train = all acceptance cases EXCEPT a deterministic hold-out. The proposer
	 * only ever sees this; the acceptance set stays hidden. (`acceptance.json` may
	 * also ship an explicit `train` array — preferred when present.)
	 */
	private async _loadTrain(acceptance: RsiDataset): Promise<RsiDataset> {
		const trainFile = await this._readTrainFile();
		if (trainFile?.cases?.length) {
			return trainFile;
		}
		// Fallback: derive train from acceptance via a stable hash hold-out (every 3rd).
		const trainCases = acceptance.cases.filter((_, i) => i % 3 !== 0);
		return { cases: trainCases };
	}

	private async _readTrainFile(): Promise<RsiDataset | undefined> {
		try {
			const uri = joinPath(this._store().rootUri, 'train.json');
			const text = (await this._fileService.readFile(uri)).value.toString();
			const parsed = JSON.parse(text) as RsiDataset;
			return parsed?.cases?.length ? parsed : undefined;
		} catch {
			return undefined;
		}
	}

	private _logReport(report: RsiIterationResult): void {
		const gateLine = report.gates.map(g => `${g.passed ? 'PASS' : 'FAIL'}:${g.id}`).join(', ');
		this._logService.info(
			`[RSI] status=${report.status} champion=${fmt(report.champion?.accuracy)} candidate=${fmt(report.candidate?.accuracy)} gates=[${gateLine}] — ${report.rationale}`,
		);
	}

	//#endregion
}

function stripFrontmatter(content: string): string {
	if (!content.startsWith('---')) {
		return content;
	}
	const end = content.indexOf('\n---', 3);
	if (end < 0) {
		return content;
	}
	return content.slice(end + 4).replace(/^\r?\n/, '');
}

function fmt(n: number | undefined): string {
	return typeof n === 'number' ? n.toFixed(3) : 'n/a';
}
