/*---------------------------------------------------------------------------------------------
 *  Mobius — load Continue/OpenAI model settings from .env and config.yaml
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IPathService } from '../../../services/path/common/pathService.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';

export interface ContinueModelEntry {
	readonly name: string;
	readonly model: string;
	readonly apiBase: string;
	readonly apiKey: string;
	readonly profileId?: string;
}

export interface EnvModelProfile {
	readonly id: string;
	readonly provider: string;
	readonly baseUrl: string;
	readonly apiKey: string;
	readonly model: string;
}

/** Sync with config/ollama.port — used by OCR + embeddings only (no local chat). */
export const BUNDLED_OLLAMA_PORT = 25137;

/** Bundled local OCR (image → text) before cloud/agent turns. Sync with scripts/ollama-common.ps1. */
export const BUNDLED_OLLAMA_OCR = {
	name: 'GLM-OCR (Local)',
	model: 'glm-ocr',
	apiBase: `http://127.0.0.1:${BUNDLED_OLLAMA_PORT}`,
} as const;

const OPENAI_COMPATIBLE = new Set([
	'openai', 'openrouter', 'groq', 'deepseek', 'mistral', 'together', 'lmstudio', 'siliconflow',
]);

/**
 * Best-effort vision/multimodal detection for OpenAI-compatible models.
 * Continue talks to arbitrary OpenAI-compatible endpoints that expose no capability
 * endpoint, so we match known vision model families by name. When the model matches,
 * Agents sends the attached image directly to the model instead of running local OCR.
 * ponytail: name heuristic only — add new families here; unknown models fall back to OCR.
 */
const VISION_MODEL_PATTERNS: RegExp[] = [
	/gpt-4o(?:-|\b)/i,            // gpt-4o, gpt-4o-mini
	/gpt-4-vision/i,
	/gpt-4-turbo/i,
	/o1(?:-|\b)/i,                // o1 family supports image input
	/o3(?:-|\b)/i,
	/gpt-5/i,
	/claude-?[345](?:[.\-]|\b)/i, // claude-3 / claude-3.5 / claude-4 / claude-sonnet-4
	/gemini/i,                    // gemini-1.5/2.0/2.5 pro/flash
	/qwen[\d.]*-?vl/i,            // qwen-vl, qwen2-vl, qwen2.5-vl
	/qvq/i,
	/glm-?4v/i,                   // glm-4v, glm-4.5v
	/glm-?4\.5v/i,
	/internvl/i,
	/llama-?3\.2-?\d*[bv]?.*vision/i,
	/pixtral/i,
	/molmo/i,
	/idefics/i,
	/cogvlm/i,
	/minicpm-?v/i,
	/deepseek-?vl/i,
	/vision/i,
	/(?:^|[-_])vl(?:[-_]|$)/i,    // explicit -vl- token
];

export function modelSupportsVision(model: string | undefined): boolean {
	if (!model) {
		return false;
	}
	return VISION_MODEL_PATTERNS.some(re => re.test(model));
}

/** True for retired/local-only chat entries that must not appear in the Agents picker. */
export function isLocalOllamaChatModel(entry: {
	readonly name?: string;
	readonly model?: string;
	readonly apiBase?: string;
}): boolean {
	if (entry.model === 'nomic-embed-text' || entry.model === 'glm-ocr') {
		return false;
	}
	if (entry.name && /\(Local\)$/i.test(entry.name) && /^Qwen/i.test(entry.name)) {
		return true;
	}
	if (entry.model && /^qwen3\.5:/i.test(entry.model)) {
		return true;
	}
	const base = entry.apiBase ?? '';
	return new RegExp(`(?:localhost|127\\.0\\.0\\.1):${BUNDLED_OLLAMA_PORT}`).test(base);
}

export function parseEnvContent(content: string): Record<string, string> {
	const vars: Record<string, string> = {};
	for (const line of content.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith('#')) {
			continue;
		}
		if (/^\[[^\]]+\]$/.test(trimmed)) {
			continue;
		}
		const eq = trimmed.indexOf('=');
		if (eq < 0) {
			continue;
		}
		const key = trimmed.substring(0, eq).trim();
		let value = trimmed.substring(eq + 1).trim();
		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith('\'') && value.endsWith('\''))) {
			value = value.slice(1, -1);
		}
		if (value) {
			vars[key] = value;
		}
	}
	return vars;
}

function unquoteEnvValue(raw: string): string {
	let value = raw.trim();
	if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith('\'') && value.endsWith('\''))) {
		value = value.slice(1, -1);
	}
	return value;
}

/** Detect flat AI_*, AI_ACTIVE_PROFILE, or [profile] sections. */
export function envFileHasAiConfig(content: string): boolean {
	return (
		/^AI_MODEL=/m.test(content)
		|| /^AI_ACTIVE_PROFILE=/m.test(content)
		|| /^\[[\w.-]+\]\s*$/m.test(content)
	);
}

export function profileModelTitle(profileId: string, _model?: string): string {
	return profileId;
}

/**
 * Parse named `[profile]` sections + `AI_ACTIVE_PROFILE`.
 * Flat `AI_*` with no sections → one implicit profile `default`.
 */
export function parseEnvProfiles(content: string): {
	activeProfileId: string;
	profiles: EnvModelProfile[];
} {
	const lines = content.replace(/\r\n/g, '\n').split('\n');
	let activeFromFile: string | undefined;
	const sectionOrder: string[] = [];
	const sectionVars = new Map<string, Record<string, string>>();
	const topLevelAi: Record<string, string> = {};
	let currentSection: string | null = null;
	const aiKeys = new Set([
		'AI_PROVIDER', 'AI_BASE_URL', 'AI_API_KEY', 'AI_MODEL', 'AI_ACTIVE_PROFILE',
		'OPENAI_PROVIDER', 'OPENAI_BASE_URL', 'OPENAI_API_KEY', 'OPENAI_MODEL',
	]);

	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith('#')) {
			continue;
		}
		const sectionMatch = /^\[([^\]]+)\]$/.exec(trimmed);
		if (sectionMatch) {
			currentSection = sectionMatch[1].trim();
			if (currentSection && !sectionVars.has(currentSection)) {
				sectionVars.set(currentSection, {});
				sectionOrder.push(currentSection);
			}
			continue;
		}
		const eq = trimmed.indexOf('=');
		if (eq < 0) {
			continue;
		}
		const key = trimmed.substring(0, eq).trim();
		const value = unquoteEnvValue(trimmed.substring(eq + 1));
		if (!value && key !== 'AI_API_KEY' && key !== 'OPENAI_API_KEY') {
			continue;
		}
		if (currentSection === null) {
			if (key === 'AI_ACTIVE_PROFILE') {
				activeFromFile = value;
				continue;
			}
			if (aiKeys.has(key)) {
				topLevelAi[key] = value;
			}
			continue;
		}
		const bucket = sectionVars.get(currentSection);
		if (bucket) {
			bucket[key] = value;
		}
	}

	const toProfile = (id: string, vars: Record<string, string>): EnvModelProfile => {
		const provider = vars.AI_PROVIDER || vars.OPENAI_PROVIDER || 'openai';
		return {
			id,
			provider,
			baseUrl: vars.AI_BASE_URL || vars.OPENAI_BASE_URL || 'https://api.openai.com/v1',
			apiKey: vars.AI_API_KEY || vars.OPENAI_API_KEY || '',
			model: vars.AI_MODEL || vars.OPENAI_MODEL || 'gpt-4o',
		};
	};

	const profiles: EnvModelProfile[] = [];
	if (sectionOrder.length > 0) {
		for (const id of sectionOrder) {
			const vars = sectionVars.get(id) ?? {};
			if (
				vars.AI_MODEL || vars.OPENAI_MODEL
				|| vars.AI_API_KEY || vars.OPENAI_API_KEY
				|| vars.AI_PROVIDER || vars.OPENAI_PROVIDER
			) {
				profiles.push(toProfile(id, vars));
			}
		}
	}

	if (profiles.length === 0) {
		const hasFlat =
			topLevelAi.AI_MODEL || topLevelAi.OPENAI_MODEL
			|| topLevelAi.AI_API_KEY || topLevelAi.OPENAI_API_KEY
			|| topLevelAi.AI_PROVIDER || topLevelAi.OPENAI_PROVIDER;
		if (hasFlat) {
			profiles.push(toProfile('default', topLevelAi));
		}
	}

	const activeProfileId =
		activeFromFile && profiles.some(p => p.id === activeFromFile)
			? activeFromFile
			: (profiles[0]?.id ?? 'default');

	profiles.sort((a, b) => {
		if (a.id === activeProfileId) {
			return -1;
		}
		if (b.id === activeProfileId) {
			return 1;
		}
		return 0;
	});

	return { activeProfileId, profiles };
}

/** Cloud chat models only (no local Qwen / Ollama chat). */
export function pickCloudModels(models: readonly ContinueModelEntry[]): ContinueModelEntry[] {
	return models.filter(m => !isLocalOllamaChatModel(m) && m.model !== 'nomic-embed-text');
}

/** @deprecated Prefer {@link modelsFromEnvProfiles}. Flat-vars helper for tests. */
export function modelsFromEnv(vars: Record<string, string>): ContinueModelEntry[] {
	const apiKey = vars.AI_API_KEY || vars.OPENAI_API_KEY;
	const provider = vars.AI_PROVIDER || vars.OPENAI_PROVIDER || 'openai';
	if (apiKey && OPENAI_COMPATIBLE.has(provider) && provider !== 'ollama') {
		const model = vars.AI_MODEL || vars.OPENAI_MODEL || 'gpt-4o';
		const apiBase = (vars.AI_BASE_URL || vars.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
		const profileId = vars.AI_ACTIVE_PROFILE || 'default';
		return [{
			name: profileModelTitle(profileId, model),
			model,
			apiBase,
			apiKey,
			profileId,
		}];
	}
	return [];
}

export function modelsFromEnvProfiles(content: string): ContinueModelEntry[] {
	const { activeProfileId, profiles } = parseEnvProfiles(content);
	const models: ContinueModelEntry[] = [];
	for (const profile of profiles) {
		if (!profile.apiKey || !OPENAI_COMPATIBLE.has(profile.provider) || profile.provider === 'ollama') {
			continue;
		}
		models.push({
			name: profileModelTitle(profile.id, profile.model),
			model: profile.model,
			apiBase: profile.baseUrl.replace(/\/+$/, ''),
			apiKey: profile.apiKey,
			profileId: profile.id,
		});
	}
	// Active first (parseEnvProfiles already sorts; keep stable).
	models.sort((a, b) => {
		if (a.profileId === activeProfileId) {
			return -1;
		}
		if (b.profileId === activeProfileId) {
			return 1;
		}
		return 0;
	});
	return models;
}

async function readEnvFile(
	fileService: IFileService,
	uri: URI,
): Promise<{ content: string; mtime: number } | undefined> {
	try {
		if (await fileService.exists(uri)) {
			const [file, stat] = await Promise.all([
				fileService.readFile(uri),
				fileService.stat(uri),
			]);
			return {
				content: file.value.toString(),
				mtime: stat.mtime,
			};
		}
	} catch {
		// ignore
	}
	return undefined;
}

/** Installer ships `config/.env` next to `resources/app` (appRoot). */
export function getPackagedModelEnvUri(appRoot: string | undefined): URI | undefined {
	if (!appRoot) {
		return undefined;
	}
	return URI.joinPath(URI.file(appRoot), '..', '..', 'config', '.env');
}

/** Higher = richer multi-profile schema. Flat last-wins parse is less preferred. */
export function envFileProfileRichness(content: string): number {
	const sectionCount = (content.match(/^\[[\w.-]+\]\s*$/gm) ?? []).length;
	if (sectionCount > 0 && /^AI_ACTIVE_PROFILE=/m.test(content)) {
		return 2 + sectionCount;
	}
	if (sectionCount > 0) {
		return 1 + sectionCount;
	}
	return 0;
}

/**
 * Same authority rules as IDE `resolveModelEnvContent`:
 * AI-config presence first, then multi-profile richness, then newer mtime.
 */
async function readBestEnvContent(
	fileService: IFileService,
	pathService: IPathService,
	workspaceService: IWorkspaceContextService,
	packagedEnvUri?: URI,
): Promise<string | undefined> {
	let workspaceFile: { content: string; mtime: number } | undefined;
	for (const folder of workspaceService.getWorkspace().folders) {
		const envUri = URI.joinPath(folder.uri, '.env');
		workspaceFile = await readEnvFile(fileService, envUri);
		if (workspaceFile) {
			break;
		}
	}

	let continueFile: { content: string; mtime: number } | undefined;
	try {
		const home = await pathService.userHome();
		continueFile = await readEnvFile(fileService, URI.joinPath(home, '.continue', '.env'));
	} catch {
		// no ~/.continue/.env
	}

	const packagedFile = packagedEnvUri
		? await readEnvFile(fileService, packagedEnvUri)
		: undefined;

	if (workspaceFile && !continueFile && !packagedFile) {
		return workspaceFile.content;
	}
	if (!workspaceFile && continueFile && !packagedFile) {
		return continueFile.content;
	}
	if (!workspaceFile && !continueFile) {
		return packagedFile?.content;
	}

	const workspaceHasAi = workspaceFile ? envFileHasAiConfig(workspaceFile.content) : false;
	const continueHasAi = continueFile ? envFileHasAiConfig(continueFile.content) : false;

	if (workspaceHasAi && !continueHasAi) {
		return workspaceFile!.content;
	}
	if (continueHasAi && !workspaceHasAi) {
		return continueFile!.content;
	}

	// Prefer named [profile] catalogs over a flat single quartet written by an
	// older Continue extension sync that ignored INI sections.
	if (workspaceFile && continueFile) {
		const workspaceRichness = envFileProfileRichness(workspaceFile.content);
		const continueRichness = envFileProfileRichness(continueFile.content);
		if (workspaceRichness !== continueRichness) {
			return workspaceRichness > continueRichness
				? workspaceFile.content
				: continueFile.content;
		}
		if (workspaceFile.mtime >= continueFile.mtime) {
			return workspaceFile.content;
		}
		return continueFile.content;
	}

	return workspaceFile?.content ?? continueFile?.content ?? packagedFile?.content;
}

export function parseConfigYamlModels(content: string): ContinueModelEntry[] {
	const models: ContinueModelEntry[] = [];
	const lines = content.split(/\r?\n/);
	let inModels = false;
	let current: { name?: string; model?: string; apiBase?: string; apiKey?: string } | undefined;

	const flush = () => {
		if (current?.name && current.model && current.apiBase && current.apiKey) {
			// Name is the profile id (or legacy profileId/model / bare model).
			const slash = current.name.indexOf('/');
			const profileId =
				slash > 0 && !current.name.includes(' ')
					? current.name.slice(0, slash)
					: current.name;
			models.push({
				name: current.name,
				model: current.model,
				apiBase: current.apiBase.replace(/\/+$/, ''),
				apiKey: current.apiKey,
				profileId,
			});
		}
		current = undefined;
	};

	for (const rawLine of lines) {
		const trimmed = rawLine.trim();
		if (!inModels) {
			if (trimmed === 'models:' || trimmed.startsWith('models:')) {
				inModels = true;
			}
			continue;
		}

		if (trimmed && !rawLine.startsWith(' ') && !rawLine.startsWith('\t') && !trimmed.startsWith('-')) {
			break;
		}

		if (trimmed.startsWith('- ')) {
			flush();
			current = {};
			const inline = trimmed.slice(2).trim();
			if (inline.includes(':')) {
				assignYamlField(current, inline);
			}
			continue;
		}

		if (current && trimmed.includes(':')) {
			assignYamlField(current, trimmed);
		}
	}

	flush();
	return pickCloudModels(models);
}

function assignYamlField(target: { name?: string; model?: string; apiBase?: string; apiKey?: string }, line: string): void {
	const colon = line.indexOf(':');
	if (colon < 0) {
		return;
	}
	const key = line.slice(0, colon).trim();
	let value = line.slice(colon + 1).trim();
	if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith('\'') && value.endsWith('\''))) {
		value = value.slice(1, -1);
	}
	switch (key) {
		case 'name':
			target.name = value;
			break;
		case 'model':
			target.model = value;
			break;
		case 'apiBase':
			target.apiBase = value;
			break;
		case 'apiKey':
			target.apiKey = value;
			break;
	}
}

export async function loadContinueModels(
	fileService: IFileService,
	pathService: IPathService,
	workspaceService: IWorkspaceContextService,
	appRoot?: string,
): Promise<ContinueModelEntry[]> {
	const packagedEnvUri = getPackagedModelEnvUri(appRoot);

	const envContent = await readBestEnvContent(
		fileService,
		pathService,
		workspaceService,
		packagedEnvUri,
	);
	if (envContent) {
		const fromEnv = pickCloudModels(modelsFromEnvProfiles(envContent));
		if (fromEnv.length) {
			return fromEnv;
		}
	}

	try {
		const home = await pathService.userHome();
		const configUri = URI.joinPath(home, '.continue', 'config.yaml');
		if (await fileService.exists(configUri)) {
			const content = (await fileService.readFile(configUri)).value.toString();
			const models = parseConfigYamlModels(content);
			if (models.length) {
				return models;
			}
		}
	} catch {
		// no models configured
	}

	return [];
}

export async function getContinueConfigWatchUris(
	pathService: IPathService,
	workspaceService: IWorkspaceContextService,
): Promise<URI[]> {
	const uris: URI[] = [];
	for (const folder of workspaceService.getWorkspace().folders) {
		uris.push(URI.joinPath(folder.uri, '.env'));
	}
	const home = await pathService.userHome();
	uris.push(URI.joinPath(home, '.continue', '.env'));
	uris.push(URI.joinPath(home, '.continue', 'config.yaml'));
	return uris;
}
