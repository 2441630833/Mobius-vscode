/*---------------------------------------------------------------------------------------------
 *  Mobius — hybrid skill recall: embedding ANN + lexical fusion (Phase 1)
 *
 *  Embeddings are computed in-process (hashed n-gram vectors). They must not
 *  call bundled Ollama: concurrent agents previously flooded nomic-embed-text
 *  and stalled chat streaming / the workbench.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IAgentSkill } from '../../chat/common/promptSyntax/service/promptsService.js';
import type { RankedSkill } from './continueSkillsContext.js';
import { formatRoutingQueryForLog } from './continueSkillsContext.js';

/** In-process embedder id — not an Ollama model. Kept for log / debug stability. */
export const BUNDLED_EMBED_MODEL = 'all-MiniLM-L6-v2-hash';

const SKILL_BODY_PREVIEW_CHARS = 500;
const EMBED_DIMS = 384;

/** Stage-1 recall width per channel (X-style multi-source funnel). */
export const EMBEDDING_RECALL_TOP_K = 8;
export const LEXICAL_RECALL_TOP_K = 8;

/** Light-ranker fusion weights (sum = 1.0). */
export const FUSION_EMBED_WEIGHT = 0.45;
export const FUSION_LEXICAL_WEIGHT = 0.55;

/** Scale cosine similarity (0–1) into lexical score range (~0–20). */
const EMBED_SCORE_SCALE = 20;

interface CachedSkillVector {
	readonly textHash: string;
	readonly vector: readonly number[];
}

export interface HybridSkillScoreDetail {
	readonly skill: IAgentSkill;
	readonly lexicalScore: number;
	readonly embedScore: number;
	readonly feedbackBoost: number;
	readonly fusedScore: number;
}

/**
 * Precomputes / caches skill embeddings and fuses vector recall with lexical scores.
 * Uses an in-process hashing embedder so multi-agent turns never contend on Ollama.
 */
export class ContinueSkillEmbeddingIndex {
	private readonly _vectors = new Map<string, CachedSkillVector>();
	private _embedAvailable: boolean | undefined = true;
	private _warm = false;
	private _invocable: IAgentSkill[] = [];
	private _catalog = '';
	private readonly _bodies = new Map<string, string>();
	private _warmupInFlight: Promise<void> | undefined;

	constructor(
		private readonly _fileService: IFileService,
		private readonly _logService: ILogService,
	) { }

	async fuseWithLexicalRank(
		/** Current user turn prompt only — not chat history. */
		message: string,
		skills: readonly IAgentSkill[],
		lexicalRanked: readonly RankedSkill[],
		token: CancellationToken,
	): Promise<HybridSkillScoreDetail[]> {
		if (!skills.length || !lexicalRanked.length) {
			return lexicalRanked.map(hit => ({
				skill: hit.skill,
				lexicalScore: hit.score,
				embedScore: 0,
				feedbackBoost: 0,
				fusedScore: hit.score,
			}));
		}

		const lexicalByUri = new Map(lexicalRanked.map(hit => [hit.skill.uri.toString(), hit.score]));
		const lexicalTop = [...lexicalRanked]
			.sort((a, b) => b.score - a.score)
			.slice(0, LEXICAL_RECALL_TOP_K);

		let embedByUri = new Map<string, number>();
		try {
			const queryVector = embedTextLocal(message);
			if (queryVector) {
				this._logService.info(
					`[MobiusEmbed] skill-in-process hash queryChars=${message.length} (not Ollama)`,
				);
				this._logService.trace(
					`[Continue] Skill embed query (current turn only): ${formatRoutingQueryForLog(message)}`,
				);
				await this._ensureSkillVectors(skills, token);
				const sims: { uri: string; sim: number }[] = [];
				for (const skill of skills) {
					const cached = this._vectors.get(skill.uri.toString());
					if (!cached) {
						continue;
					}
					sims.push({ uri: skill.uri.toString(), sim: cosineSimilarity(queryVector, cached.vector) });
				}
				sims.sort((a, b) => b.sim - a.sim);
				embedByUri = new Map(sims.slice(0, EMBEDDING_RECALL_TOP_K).map(s => [s.uri, s.sim]));
				this._embedAvailable = true;
			}
		} catch (err) {
			this._embedAvailable = false;
			this._logService.warn('[Continue] Skill embedding recall unavailable, lexical-only routing', err);
		}

		if (!embedByUri.size) {
			return lexicalRanked.map(hit => ({
				skill: hit.skill,
				lexicalScore: hit.score,
				embedScore: 0,
				feedbackBoost: 0,
				fusedScore: hit.score,
			}));
		}

		const recallUris = new Set<string>([
			...lexicalTop.map(h => h.skill.uri.toString()),
			...embedByUri.keys(),
		]);

		const details: HybridSkillScoreDetail[] = [];
		for (const uri of recallUris) {
			const skill = skills.find(s => s.uri.toString() === uri);
			if (!skill) {
				continue;
			}
			const lexicalScore = lexicalByUri.get(uri) ?? 0;
			const embedScore = (embedByUri.get(uri) ?? 0) * EMBED_SCORE_SCALE;
			const fusedScore = FUSION_EMBED_WEIGHT * embedScore + FUSION_LEXICAL_WEIGHT * lexicalScore;
			details.push({ skill, lexicalScore, embedScore, feedbackBoost: 0, fusedScore });
		}

		for (const hit of lexicalRanked) {
			const uri = hit.skill.uri.toString();
			if (recallUris.has(uri)) {
				continue;
			}
			details.push({
				skill: hit.skill,
				lexicalScore: hit.score,
				embedScore: 0,
				feedbackBoost: 0,
				fusedScore: FUSION_LEXICAL_WEIGHT * hit.score,
			});
		}

		return details.sort((a, b) =>
			b.fusedScore - a.fusedScore || a.skill.name.localeCompare(b.skill.name));
	}

	hasWarmCache(): boolean {
		return this._warm && this._invocable.length > 0;
	}

	getCachedInvocable(): readonly IAgentSkill[] {
		return this._invocable;
	}

	getCachedCatalog(): string {
		return this._catalog;
	}

	getCachedBody(uri: string): string | undefined {
		return this._bodies.get(uri);
	}

	/**
	 * Sync fusion using vectors already in RAM. Does not read the disk.
	 */
	fuseCached(
		message: string,
		lexicalRanked: readonly RankedSkill[],
	): HybridSkillScoreDetail[] {
		if (!this._invocable.length || !lexicalRanked.length) {
			return lexicalRanked.map(hit => ({
				skill: hit.skill,
				lexicalScore: hit.score,
				embedScore: 0,
				feedbackBoost: 0,
				fusedScore: hit.score,
			}));
		}

		const lexicalByUri = new Map(lexicalRanked.map(hit => [hit.skill.uri.toString(), hit.score]));
		const lexicalTop = [...lexicalRanked]
			.sort((a, b) => b.score - a.score)
			.slice(0, LEXICAL_RECALL_TOP_K);

		const queryVector = embedTextLocal(message);
		const embedByUri = new Map<string, number>();
		if (queryVector) {
			const sims: { uri: string; sim: number }[] = [];
			for (const skill of this._invocable) {
				const cached = this._vectors.get(skill.uri.toString());
				if (!cached) {
					continue;
				}
				sims.push({ uri: skill.uri.toString(), sim: cosineSimilarity(queryVector, cached.vector) });
			}
			sims.sort((a, b) => b.sim - a.sim);
			for (const s of sims.slice(0, EMBEDDING_RECALL_TOP_K)) {
				embedByUri.set(s.uri, s.sim);
			}
		}

		if (!embedByUri.size) {
			return lexicalRanked.map(hit => ({
				skill: hit.skill,
				lexicalScore: hit.score,
				embedScore: 0,
				feedbackBoost: 0,
				fusedScore: hit.score,
			}));
		}

		const recallUris = new Set<string>([
			...lexicalTop.map(h => h.skill.uri.toString()),
			...embedByUri.keys(),
		]);

		const details: HybridSkillScoreDetail[] = [];
		for (const uri of recallUris) {
			const skill = this._invocable.find(s => s.uri.toString() === uri);
			if (!skill) {
				continue;
			}
			const lexicalScore = lexicalByUri.get(uri) ?? 0;
			const embedScore = (embedByUri.get(uri) ?? 0) * EMBED_SCORE_SCALE;
			const fusedScore = FUSION_EMBED_WEIGHT * embedScore + FUSION_LEXICAL_WEIGHT * lexicalScore;
			details.push({ skill, lexicalScore, embedScore, feedbackBoost: 0, fusedScore });
		}

		for (const hit of lexicalRanked) {
			const uri = hit.skill.uri.toString();
			if (recallUris.has(uri)) {
				continue;
			}
			details.push({
				skill: hit.skill,
				lexicalScore: hit.score,
				embedScore: 0,
				feedbackBoost: 0,
				fusedScore: FUSION_LEXICAL_WEIGHT * hit.score,
			});
		}

		return details.sort((a, b) =>
			b.fusedScore - a.fusedScore || a.skill.name.localeCompare(b.skill.name));
	}

	async warmup(
		load: () => Promise<{
			invocable: readonly IAgentSkill[];
			catalog: string;
			bodies: ReadonlyMap<string, string>;
		}>,
	): Promise<void> {
		if (this._warmupInFlight) {
			return this._warmupInFlight;
		}
		this._warmupInFlight = (async () => {
			try {
				const loaded = await load();
				this._invocable = [...loaded.invocable];
				this._catalog = loaded.catalog;
				this._bodies.clear();
				for (const [uri, body] of loaded.bodies) {
					this._bodies.set(uri, body);
				}
				for (const skill of this._invocable) {
					const body = this._bodies.get(skill.uri.toString()) ?? '';
					const text = [skill.name, skill.description ?? '', body.slice(0, SKILL_BODY_PREVIEW_CHARS)]
						.filter(Boolean).join('\n');
					const vector = embedTextLocal(text);
					if (vector) {
						this._vectors.set(skill.uri.toString(), { textHash: hashText(text), vector });
					}
				}
				this._warm = this._invocable.length > 0;
				this._logService.info(
					`[Continue] Skill warm-cache ready catalog=${this._invocable.length} bodies=${this._bodies.size} (no disk on next Agent turn)`,
				);
			} catch (err) {
				this._logService.warn('[Continue] Skill warm-cache failed', err);
			} finally {
				this._warmupInFlight = undefined;
			}
		})();
		return this._warmupInFlight;
	}

	isEmbedAvailable(): boolean | undefined {
		return this._embedAvailable;
	}

	private async _ensureSkillVectors(skills: readonly IAgentSkill[], token: CancellationToken): Promise<void> {
		for (const skill of skills) {
			if (token.isCancellationRequested) {
				return;
			}
			const text = await buildSkillEmbedText(skill, this._fileService);
			const textHash = hashText(text);
			const key = skill.uri.toString();
			const cached = this._vectors.get(key);
			if (cached?.textHash === textHash) {
				continue;
			}
			const vector = embedTextLocal(text);
			if (!vector) {
				continue;
			}
			this._vectors.set(key, { textHash, vector });
		}
	}
}

/**
 * Signed-hashing n-gram embedding (HashingVectorizer-style).
 * Fast, deterministic, CJK-safe via character 3-grams. No GPU / HTTP.
 */
export function embedTextLocal(text: string): number[] | undefined {
	const trimmed = text.trim();
	if (!trimmed) {
		return undefined;
	}

	const vec = new Float64Array(EMBED_DIMS);
	let nonempty = false;
	for (const token of tokenizeForEmbed(trimmed)) {
		const h1 = fnv1a(token);
		const h2 = fnv1a(token + '\u0001');
		vec[h1 % EMBED_DIMS] += (h1 & 0x80000000) ? -1 : 1;
		vec[h2 % EMBED_DIMS] += (h2 & 0x80000000) ? -1 : 1;
		nonempty = true;
	}
	if (!nonempty) {
		return undefined;
	}

	let norm = 0;
	for (let i = 0; i < EMBED_DIMS; i++) {
		norm += vec[i] * vec[i];
	}
	norm = Math.sqrt(norm);
	if (norm === 0) {
		return undefined;
	}

	const out = new Array<number>(EMBED_DIMS);
	for (let i = 0; i < EMBED_DIMS; i++) {
		out[i] = vec[i] / norm;
	}
	return out;
}

export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
	if (!a.length || a.length !== b.length) {
		return 0;
	}
	let dot = 0;
	let normA = 0;
	let normB = 0;
	for (let i = 0; i < a.length; i++) {
		dot += a[i] * b[i];
		normA += a[i] * a[i];
		normB += b[i] * b[i];
	}
	if (normA === 0 || normB === 0) {
		return 0;
	}
	return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function tokenizeForEmbed(text: string): string[] {
	const lower = text.toLowerCase();
	const tokens: string[] = [];
	const words = lower.split(/[^\p{L}\p{N}_]+/u).filter(t => t.length > 1);
	tokens.push(...words);
	const compact = lower.replace(/\s+/g, '');
	for (let i = 0; i < compact.length - 2; i++) {
		tokens.push(compact.slice(i, i + 3));
	}
	return tokens;
}

function fnv1a(text: string): number {
	let hash = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		hash ^= text.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return hash >>> 0;
}

async function buildSkillEmbedText(skill: IAgentSkill, fileService: IFileService): Promise<string> {
	const parts = [skill.name, skill.description ?? ''];
	try {
		const content = (await fileService.readFile(skill.uri)).value.toString();
		const body = stripYamlFrontmatter(content).trim();
		if (body) {
			parts.push(body.slice(0, SKILL_BODY_PREVIEW_CHARS));
		}
	} catch {
		// description-only fallback
	}
	return parts.filter(Boolean).join('\n');
}

function stripYamlFrontmatter(content: string): string {
	if (!content.startsWith('---')) {
		return content;
	}
	const end = content.indexOf('\n---', 3);
	if (end < 0) {
		return content;
	}
	return content.slice(end + 4).replace(/^\r?\n/, '');
}

function hashText(text: string): string {
	let hash = 5381;
	for (let i = 0; i < text.length; i++) {
		hash = ((hash << 5) + hash) ^ text.charCodeAt(i);
	}
	return (hash >>> 0).toString(16);
}
