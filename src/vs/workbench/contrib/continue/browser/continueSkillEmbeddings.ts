/*---------------------------------------------------------------------------------------------
 *  Mobius — hybrid skill recall: embedding ANN + lexical fusion (Phase 1)
 *--------------------------------------------------------------------------------------------*/

import { streamToBuffer } from '../../../../base/common/buffer.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IRequestService } from '../../../../platform/request/common/request.js';
import { IAgentSkill } from '../../chat/common/promptSyntax/service/promptsService.js';
import { BUNDLED_OLLAMA_PORT } from './continueModelConfig.js';
import type { RankedSkill } from './continueSkillsContext.js';
import { formatRoutingQueryForLog } from './continueSkillsContext.js';

/** Bundled Ollama embed model — sync with config/continue-config.yaml local-embed */
export const BUNDLED_EMBED_MODEL = 'nomic-embed-text';

const EMBED_API_BASE = `http://127.0.0.1:${BUNDLED_OLLAMA_PORT}`;
const SKILL_BODY_PREVIEW_CHARS = 500;
const EMBED_BATCH_CONCURRENCY = 4;
const EMBED_REQUEST_TIMEOUT_MS = 8_000;

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
 * Falls back gracefully when Ollama embed is unavailable.
 */
export class ContinueSkillEmbeddingIndex {
	private readonly _vectors = new Map<string, CachedSkillVector>();
	private _embedAvailable: boolean | undefined;

	constructor(
		private readonly _requestService: IRequestService,
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
			const queryVector = await this._embedText(message, token);
			if (queryVector) {
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

	isEmbedAvailable(): boolean | undefined {
		return this._embedAvailable;
	}

	private async _ensureSkillVectors(skills: readonly IAgentSkill[], token: CancellationToken): Promise<void> {
		const pending: { skill: IAgentSkill; text: string; textHash: string }[] = [];
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
			pending.push({ skill, text, textHash });
		}

		await runPool(pending, EMBED_BATCH_CONCURRENCY, async item => {
			if (token.isCancellationRequested) {
				return;
			}
			const vector = await this._embedText(item.text, token);
			if (!vector) {
				return;
			}
			this._vectors.set(item.skill.uri.toString(), { textHash: item.textHash, vector });
		});
	}

	private async _embedText(text: string, token: CancellationToken): Promise<number[] | undefined> {
		const trimmed = text.trim();
		if (!trimmed) {
			return undefined;
		}

		// OpenAI-compatible (Ollama /v1/embeddings) — supports batch via array later.
		const openAi = await this._requestEmbed(
			`${EMBED_API_BASE}/v1/embeddings`,
			JSON.stringify({ model: BUNDLED_EMBED_MODEL, input: trimmed }),
			token,
		);
		if (openAi) {
			return openAi;
		}

		// Native Ollama /api/embeddings fallback.
		return this._requestEmbed(
			`${EMBED_API_BASE}/api/embeddings`,
			JSON.stringify({ model: BUNDLED_EMBED_MODEL, prompt: trimmed }),
			token,
		);
	}

	private async _requestEmbed(url: string, body: string, token: CancellationToken): Promise<number[] | undefined> {
		const context = await this._requestService.request({
			type: 'POST',
			url,
			callSite: 'ContinueSkillEmbeddingIndex.embed',
			headers: {
				'Content-Type': 'application/json',
			},
			data: body,
			timeout: EMBED_REQUEST_TIMEOUT_MS,
		}, token);

		if (context.res.statusCode && context.res.statusCode >= 400) {
			return undefined;
		}

		const raw = (await streamToBuffer(context.stream)).toString();
		try {
			const json = JSON.parse(raw);
			if (Array.isArray(json?.data?.[0]?.embedding)) {
				return json.data[0].embedding as number[];
			}
			if (Array.isArray(json?.embedding)) {
				return json.embedding as number[];
			}
		} catch {
			// malformed
		}
		return undefined;
	}
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

async function runPool<T>(
	items: readonly T[],
	concurrency: number,
	fn: (item: T) => Promise<void>,
): Promise<void> {
	let index = 0;
	const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
		while (index < items.length) {
			const i = index++;
			await fn(items[i]);
		}
	});
	await Promise.all(workers);
}
