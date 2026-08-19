/*---------------------------------------------------------------------------------------------
 *  Mobius — wire VS Code Skills into Continue Agent requests (auto-routing)
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { VSBuffer, encodeBase64 } from '../../../../base/common/buffer.js';
import { URI } from '../../../../base/common/uri.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import {
	isPromptFileVariableEntry,
} from '../../chat/common/attachments/chatVariableEntries.js';
import { IChatAgentRequest } from '../../chat/common/participants/chatAgents.js';
import { PromptsConfig } from '../../chat/common/promptSyntax/config/config.js';
import {
	IAgentSkill,
	IPromptsService,
	matchesSessionType,
} from '../../chat/common/promptSyntax/service/promptsService.js';
import { getChatSessionType } from '../../chat/common/model/chatUri.js';
import { ContinueSkillEmbeddingIndex } from './continueSkillEmbeddings.js';
import { ContinueSkillFeedbackStore } from './continueSkillFeedback.js';

/** Max full SKILL.md bodies injected per turn (compatible set, not conflicting). */
const MAX_FULL_SKILLS = 3;
/** Minimum relevance score to auto-load a skill body. */
const AUTO_ROUTE_SCORE_THRESHOLD = 4;
const SKILL_DESCRIPTION_CHAR_BUDGET = 15_000;
/** Max chars per preloaded skill body in agent mode (keeps turn-2 latency down). */
const AGENT_SKILL_BODY_CHAR_BUDGET = 6_000;

/** Interview-only skills — conflict with execution skills when loaded together. */
const INTERVIEW_SKILL_NAMES = new Set([
	'brainstorming',
	'office-hours',
	'doc-coauthoring',
	'using-superpowers',
]);

/** Build / ship skills — pair well with each other and with plan/debug skills. */
const EXECUTION_SKILL_HINTS = [
	'frontend-design',
	'executing-plans',
	'design-html',
	'canvas-design',
	'subagent-driven-development',
];

/** UI / web page design skills — should win over document or git skills for page-design briefs. */
const DESIGN_UI_SKILL_HINTS = [
	'frontend-design',
	'canvas-design',
	'design-html',
	'design-shotgun',
	'web-artifacts-builder',
];

/** Office-document skills — conflict with UI design when the user wants a web page, not Word/PPT. */
const DOCUMENT_SKILL_PREFIXES = ['wps-', 'docx', 'pptx', 'xlsx', 'pdf'] as const;

const PPT_DOCUMENT_SKILL_HINTS = ['wps-ppt', 'pptx'] as const;
const WORD_DOCUMENT_SKILL_HINTS = ['wps-word', 'docx', 'doc-coauthoring'] as const;
const EXCEL_DOCUMENT_SKILL_HINTS = ['wps-excel', 'xlsx'] as const;

/** Git / PR workflow skills — should not load for pure design requests. */
const GIT_PR_SKILL_NAMES = new Set([
	'update-pr',
	'code-review',
	'requesting-code-review',
	'receiving-code-review',
	'finishing-a-development-branch',
	'using-git-worktrees',
]);

/**
 * Intent hints: when the user message matches a pattern, boost skills whose
 * names contain any of the hint tokens. Covers EN + ZH so routing works without
 * requiring the user to type /skill-name.
 */
const INTENT_HINTS: readonly { readonly patterns: readonly RegExp[]; readonly skillHints: readonly string[] }[] = [
	{
		patterns: [
			/(设计).{0,12}(页面|界面|组件|布局|视觉|ui)/i,
			/(页面|界面|ui|组件).{0,12}设计/i,
			/(新页面|新界面|落地页)/,
			/\bdesign\b.+\b(page|ui|screen|layout|mockup|component)\b/i,
			/\b(ui|css|layout|frontend|landing|mockup|responsive|hand-?drawn|warm)\b/i,
			/(前端|页面|样式|布局|界面|视觉|落地页|手绘|温暖)/,
			/(高度|宽度|太高|太矮).{0,20}(视频|video|文本|文字|匹配|对齐|match)/i,
			/(视频|video).{0,20}(高度|height|太高)/i,
			/\b(fix|adjust|match|align).{0,40}\b(height|width|layout|css|video)\b/i,
		],
		skillHints: ['frontend-design', 'canvas-design', 'design-html'],
	},
	{
		patterns: [
			/\b(brainstorm|spec|requirements?|proposal)\b/i,
			/(方案|需求|头脑风暴|构思|想法|创意|功能规划)/,
		],
		skillHints: ['brainstorming', 'writing-plans'],
	},
	{
		patterns: [
			/\b(create|build|add|ship|implement)\b.+\b(feature|component|page|screen|module|product|app|agent)\b/i,
			/(做|实现|开发|加|搭建|设计).{0,12}(功能|页面|组件|模块|产品|应用|agent)/,
			/(产品|agent).{0,20}(风格|手绘|notion|mailchimp|落地)/i,
		],
		skillHints: ['frontend-design', 'executing-plans'],
	},
	{
		patterns: [
			/\b(test|testing|qa|bug|regress|e2e|unit.?test)\b/i,
			/(测试|修.?bug|缺陷|回归|单测|联调)/,
			/(能不能正常|能否正常|能否运行|跑通|跑起来|运行正常|是否正常|试运行|验证一下)/,
			/\b(run|verify|sanity|smoke.?test)\b.+\b(project|app|build|normally?)\b/i,
		],
		skillHints: ['qa', 'qa-only', 'systematic-debugging', 'webapp-testing', 'verification-before-completion'],
	},
	{
		patterns: [
			/\b(plan|implement(ation)?|roadmap|checklist)\b/i,
			/(计划|实施|落地|路线图|分步)/,
		],
		skillHints: ['writing-plans', 'executing-plans', 'subagent-driven-development'],
	},
	{
		patterns: [
			/\b(debug|investigate|root.?cause|stack.?trace)\b/i,
			/(排查|调试|根因|报错|崩溃|挂了)/,
		],
		skillHints: ['systematic-debugging', 'investigate', 'qa'],
	},
	{
		patterns: [
			/\b(commit|pull\s*request|rebase|merge)\b/i,
			/\b(open|update|create)\s+(a\s+)?pr\b/i,
			/\bpr\s*[#:]\s*\d+/i,
			/\bcode\s*review\b/i,
			/(提交|合并|代码审查|拉取请求|分支)/,
		],
		skillHints: ['requesting-code-review', 'receiving-code-review', 'finishing-a-development-branch', 'using-git-worktrees', 'update-pr'],
	},
	{
		patterns: [
			/(新建|搭建|创建|初始化).{0,20}(项目|仓库|工程|脚手架|骨架)/i,
			/(写|创建).{0,10}(可运行)?骨架/i,
			/立即\s*write_file|immediately write_file/i,
			/package\.json[\s\S]{0,400}(src\/|\.ts\b)/i,
		],
		skillHints: ['executing-plans', 'writing-plans', 'subagent-driven-development'],
	},
	{
		patterns: [
			/(生成|制作|导出|填写).{0,16}(表格|xlsx|excel)/i,
			/\bxlsx\b/i,
			/\.xlsx\b/i,
			/templates\/[^\s]+\.xlsx/i,
		],
		skillHints: ['xlsx', 'wps-excel'],
	},
	{
		patterns: [
			/(生成|制作|导出|填写).{0,16}(word|docx|文档|方案)/i,
			/\b(docx?)\b/i,
			/\.docx?\b/i,
			/templates\/[^\s]+\.docx/i,
		],
		skillHints: ['docx', 'wps-word', 'doc-coauthoring'],
	},
	{
		patterns: [
			/(生成|制作|导出|做).{0,16}(pptx?|幻灯片|演示|deck)/i,
			/\b(pptx)\b/i,
			/\.pptx?\b/i,
			/templates\/[^\s]+\.pptx/i,
		],
		skillHints: ['pptx', 'wps-ppt'],
	},
	{
		patterns: [
			/\b(pdf)\b/i,
			/(pdf)/i,
		],
		skillHints: ['pdf'],
	},
	{
		patterns: [
			/\b(mcp|server.?tool|tool.?server)\b/i,
			/(mcp)/i,
		],
		skillHints: ['mcp-builder'],
	},
	{
		patterns: [
			/\b(skill|skills)\b.+\b(creat|author|write|build)\b/i,
			/(写|创建|制作).{0,8}(skill|技能)/i,
		],
		skillHints: ['skill-creator', 'skillify', 'writing-skills'],
	},
];

export interface ContinueSkillsContext {
	/** Skills catalog for the system message. */
	readonly systemText: string;
	/** Full SKILL.md bodies already loaded for this turn. */
	readonly attachmentTexts: readonly string[];
	/** Skill names that were auto-routed / loaded (for logging / UI). */
	readonly routedSkillNames: readonly string[];
}

/**
 * Build Skills context for Continue Agent requests with automatic routing.
 *
 * Without a mid-turn tool loop, Continue cannot call a `skill` tool later.
 * So we score each skill against the user message and eagerly load the
 * top matches as `<skill-context>` blocks.
 *
 * Prefer {@link buildContinueSkillsContextFast} on the Agent first-token path
 * (warm RAM cache, no disk). This full loader is for warmup / cache miss.
 */
export async function loadSkillWarmSnapshot(
	promptsService: IPromptsService,
	fileService: IFileService,
	configurationService: IConfigurationService,
	logService: ILogService,
	token: CancellationToken,
): Promise<{
	readonly invocable: IAgentSkill[];
	readonly catalog: string;
	readonly bodies: Map<string, string>;
}> {
	if (configurationService.getValue<boolean>(PromptsConfig.USE_AGENT_SKILLS) === false) {
		return { invocable: [], catalog: '', bodies: new Map() };
	}
	const skills = (await promptsService.findAgentSkills(token)) ?? [];
	const invocable = skills.filter(skill => !!skill.description && !skill.disableModelInvocation);
	const catalog = buildSkillsCatalog(invocable);
	const bodies = new Map<string, string>();
	for (const skill of invocable) {
		if (token.isCancellationRequested) {
			break;
		}
		try {
			const content = (await fileService.readFile(skill.uri)).value.toString();
			let body = sanitizeSkillBodyForAgentExecution(stripYamlFrontmatter(content).trim(), skill.name);
			if (!body) {
				continue;
			}
			if (body.length > AGENT_SKILL_BODY_CHAR_BUDGET) {
				body = body.slice(0, AGENT_SKILL_BODY_CHAR_BUDGET) + '\n…[truncated for agent execution speed]';
			}
			bodies.set(skill.uri.toString(), body);
		} catch (err) {
			logService.warn('[Continue] Skill warmup failed to read', skill.uri.toString(), err);
		}
	}
	return { invocable, catalog, bodies };
}

/**
 * Sync skill routing from the warm cache. Returns undefined when the cache is cold
 * so the caller can start the LLM without waiting on disk.
 */
export function buildContinueSkillsContextFast(
	message: string,
	embeddingIndex: ContinueSkillEmbeddingIndex,
	feedbackStore: ContinueSkillFeedbackStore | undefined,
	logService: ILogService,
): ContinueSkillsContext | undefined {
	if (!embeddingIndex.hasWarmCache()) {
		return undefined;
	}
	if (hasWebSearchIntent(message)) {
		return { systemText: '', attachmentTexts: [], routedSkillNames: [] };
	}

	const invocable = embeddingIndex.getCachedInvocable();
	const systemText = embeddingIndex.getCachedCatalog();
	const lexicalRanked = rankSkillsForMessage(message, invocable)
		.map(hit => adjustScoreForAgentExecution(message, hit));
	let hybridDetails = applyFeedbackBoosts(
		embeddingIndex.fuseCached(message, lexicalRanked),
		feedbackStore,
	);
	hybridDetails = applyIntentDomainAdjustments(message, hybridDetails);
	hybridDetails = applyEmbeddingOnlyGating(message, hybridDetails);
	hybridDetails.sort((a, b) => b.fusedScore - a.fusedScore || a.skill.name.localeCompare(b.skill.name));

	const toLoad: SkillLoadCandidate[] = [];
	for (const hit of hybridDetails) {
		if (hit.fusedScore < AUTO_ROUTE_SCORE_THRESHOLD) {
			break;
		}
		toLoad.push({ uri: hit.skill.uri, name: hit.skill.name, score: hit.fusedScore });
	}
	const ordered = selectCompatibleSkills(
		toLoad.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)),
		MAX_FULL_SKILLS,
		message,
	);

	const attachmentTexts: string[] = [];
	const routedSkillNames: string[] = [];
	for (const item of ordered) {
		const body = embeddingIndex.getCachedBody(item.uri.toString());
		if (!body) {
			continue;
		}
		const baseDir = URI.joinPath(item.uri, '..').fsPath;
		attachmentTexts.push(
			`<skill-context name="${escapeXml(item.name)}" score="${item.score}" mode="agent-execute">\nBase directory: ${baseDir}\n\n${body}\n</skill-context>`,
		);
		routedSkillNames.push(item.name);
	}

	const top = hybridDetails.slice(0, 5).map(r =>
		`${r.skill.name}:f${r.fusedScore.toFixed(1)}(L${r.lexicalScore.toFixed(0)}+E${r.embedScore.toFixed(1)})`,
	);
	logService.info(
		`[Continue] Skills auto-route [warm-cache]: ${formatRoutingQueryForLog(message)} loaded=[${routedSkillNames.join(', ')}] catalog=${invocable.length} top=${top.join(', ')}`,
	);
	return { systemText, attachmentTexts, routedSkillNames };
}

export async function buildContinueSkillsContext(
	request: IChatAgentRequest,
	promptsService: IPromptsService,
	fileService: IFileService,
	configurationService: IConfigurationService,
	logService: ILogService,
	token: CancellationToken,
	embeddingIndex?: ContinueSkillEmbeddingIndex,
	feedbackStore?: ContinueSkillFeedbackStore,
): Promise<ContinueSkillsContext> {
	if (configurationService.getValue<boolean>(PromptsConfig.USE_AGENT_SKILLS) === false) {
		return { systemText: '', attachmentTexts: [], routedSkillNames: [] };
	}

	const skills = (await promptsService.findAgentSkills(token)) ?? [];
	const sessionType = getChatSessionType(request.sessionResource);
	const invocable = skills.filter(skill => {
		if (!skill.description || skill.disableModelInvocation) {
			return false;
		}
		return matchesSessionType(skill.sessionTypes, sessionType);
	});

	const fromVariables = extractFromRequestVariables(request);
	const routingQuery = extractSkillRoutingQuery(request);

	if (hasWebSearchIntent(routingQuery)) {
		logService.trace('[Continue] Skipping skill auto-route (web-search / external-knowledge intent)');
		return { systemText: '', attachmentTexts: [], routedSkillNames: [] };
	}

	const systemText = buildSkillsCatalog(invocable);

	const toLoad = new Map<string, { uri: URI; name: string; score: number }>();

	// 1) Explicit prompt-file attachments (highest priority)
	for (const uri of fromVariables.promptFileUris) {
		const skill = skills.find(s => s.uri.toString() === uri.toString());
		toLoad.set(uri.toString(), {
			uri,
			name: skill?.name ?? uri.path.split('/').slice(-2, -1)[0] ?? 'skill',
			score: 100,
		});
	}

	// 2) Explicit /skill-name still works as an override
	for (const name of collectExplicitSlashSkills(request.message)) {
		const skill = invocable.find(s => s.name.toLowerCase() === name.toLowerCase())
			?? skills.find(s => s.name.toLowerCase() === name.toLowerCase());
		if (skill) {
			toLoad.set(skill.uri.toString(), { uri: skill.uri, name: skill.name, score: 90 });
		}
	}

	// 3) Hybrid auto-routing: lexical recall + embedding ANN → light-ranker fusion.
	// Query is ALWAYS the current user turn prompt — never chat history (history is separate in invoke()).
	const lexicalRanked = rankSkillsForMessage(routingQuery, invocable)
		.map(hit => adjustScoreForAgentExecution(routingQuery, hit));

	let hybridDetails: { skill: IAgentSkill; fusedScore: number; lexicalScore: number; embedScore: number; feedbackBoost: number }[] = [];
	if (embeddingIndex) {
		const fused = await embeddingIndex.fuseWithLexicalRank(
			routingQuery,
			invocable,
			lexicalRanked,
			token,
		);
		hybridDetails = applyFeedbackBoosts(fused, feedbackStore);
	} else {
		hybridDetails = applyFeedbackBoosts(
			lexicalRanked.map(hit => ({
				skill: hit.skill,
				lexicalScore: hit.score,
				embedScore: 0,
				feedbackBoost: 0,
				fusedScore: hit.score,
			})),
			feedbackStore,
		);
	}

	hybridDetails = applyIntentDomainAdjustments(routingQuery, hybridDetails);
	hybridDetails = applyEmbeddingOnlyGating(routingQuery, hybridDetails);
	hybridDetails.sort((a, b) => b.fusedScore - a.fusedScore || a.skill.name.localeCompare(b.skill.name));
	for (const hit of hybridDetails) {
		if (hit.fusedScore < AUTO_ROUTE_SCORE_THRESHOLD) {
			break;
		}
		if (!toLoad.has(hit.skill.uri.toString())) {
			toLoad.set(hit.skill.uri.toString(), {
				uri: hit.skill.uri,
				name: hit.skill.name,
				score: hit.fusedScore,
			});
		}
	}

	const ordered = selectCompatibleSkills(
		[...toLoad.values()].sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)),
		MAX_FULL_SKILLS,
		routingQuery,
	);

	const attachmentTexts: string[] = [];
	const routedSkillNames: string[] = [];
	for (const item of ordered) {
		if (token.isCancellationRequested) {
			break;
		}
		try {
			const content = (await fileService.readFile(item.uri)).value.toString();
			let body = sanitizeSkillBodyForAgentExecution(stripYamlFrontmatter(content).trim(), item.name);
			if (!body) {
				continue;
			}
			if (body.length > AGENT_SKILL_BODY_CHAR_BUDGET) {
				body = body.slice(0, AGENT_SKILL_BODY_CHAR_BUDGET) + '\n…[truncated for agent execution speed]';
			}
			const baseDir = URI.joinPath(item.uri, '..').fsPath;
			attachmentTexts.push(
				`<skill-context name="${escapeXml(item.name)}" score="${item.score}" mode="agent-execute">\nBase directory: ${baseDir}\n\n${body}\n</skill-context>`
			);
			routedSkillNames.push(item.name);
		} catch (err) {
			logService.warn('[Continue] Failed to load skill file', item.uri.toString(), err);
		}
	}

	if (systemText || attachmentTexts.length) {
		const top = hybridDetails.slice(0, 5).map(r => {
			const fb = r.feedbackBoost !== 0 ? `${r.feedbackBoost.toFixed(1)}` : '0';
			return `${r.skill.name}:f${r.fusedScore.toFixed(1)}(L${r.lexicalScore.toFixed(0)}+E${r.embedScore.toFixed(1)}+F${fb})`;
		});
		const embedMode = embeddingIndex?.isEmbedAvailable() ? 'hybrid' : (embeddingIndex ? 'lexical-fallback' : 'lexical');
		const feedbackMode = feedbackStore ? 'feedback-on' : 'feedback-off';
		const queryLog = formatRoutingQueryForLog(routingQuery);
		logService.info(
			`[Continue] Skills auto-route [${embedMode}/${feedbackMode}]: ${queryLog} loaded=[${routedSkillNames.join(', ')}] catalog=${invocable.length} top=${top.join(', ')}`,
		);
	}

	return { systemText, attachmentTexts, routedSkillNames };
}

export interface RankedSkill {
	readonly skill: IAgentSkill;
	readonly score: number;
}

/**
 * Score every skill against the user message and return highest first.
 */
export function rankSkillsForMessage(message: string, skills: readonly IAgentSkill[]): RankedSkill[] {
	const msgLower = message.toLowerCase();
	const msgTokens = tokenize(message);
	const intentBoosts = collectIntentBoosts(message);

	const ranked: RankedSkill[] = skills.map(skill => {
		let score = 0;
		const nameLower = skill.name.toLowerCase();
		const nameTokens = tokenize(skill.name.replace(/[-_]/g, ' '));
		const descTokens = tokenize(skill.description ?? '');

		// Exact / near-exact name in message
		if (msgLower.includes(nameLower)) {
			score += 10;
		}
		for (const t of nameTokens) {
			if (t.length >= 3 && msgTokens.has(t)) {
				if (t === 'wps' && hasWpsIntegrationProjectIntent(message) && !hasExplicitOfficeFileOutput(message) && isWpsSkill(nameLower)) {
					continue;
				}
				score += 3;
			}
		}

		// Description lexical overlap
		let descHits = 0;
		for (const t of descTokens) {
			if (t.length < 4) {
				continue;
			}
			if (msgTokens.has(t) || msgLower.includes(t)) {
				descHits++;
				score += 1;
			}
		}
		if (descHits >= 3) {
			score += 2;
		}
		if (descHits >= 5) {
			score += 3;
		}

		// Intent hint boosts (EN/ZH patterns → skill name hints)
		for (const hint of intentBoosts) {
			if (skillMatchesIntentHint(nameLower, hint)) {
				score += 6;
			}
		}

		// Strong signal: user wants a UI page designed (e.g. 帮我设计个新页面)
		if (hasDesignUiIntent(message) && isDesignUiSkill(nameLower)) {
			score += 10;
		}
		if (hasDesignUiIntent(message) && !hasTestVerifyIntent(message)
			&& (isTestDebugSkill(nameLower) || isCiOrMetaSkill(nameLower))) {
			score = Math.max(0, score - 20);
		}

		if (hasScaffoldProjectIntent(message)) {
			if (isScaffoldExecutionSkill(nameLower)) {
				score += 12;
			}
			if ((isWpsSkill(nameLower) || isDocumentSkill(nameLower)) && !hasExplicitOfficeFileOutput(message)) {
				score = 0;
			}
		}

		if (hasWpsIntegrationProjectIntent(message) && !hasExplicitOfficeFileOutput(message)) {
			if (isScaffoldExecutionSkill(nameLower)) {
				score += 10;
			}
			if (isWpsSkill(nameLower) || isDocumentSkill(nameLower)) {
				score = 0;
			}
		}

		if (hasTestVerifyIntent(message) && !hasPptDocumentIntent(message) && !hasWordDocumentIntent(message)) {
			if (isTestDebugSkill(nameLower)) {
				score += 8;
			}
			if (isWpsSkill(nameLower) || isDocumentSkill(nameLower)) {
				score = Math.max(0, score - 18);
			}
		}

		return { skill, score };
	});

	return ranked.sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name));
}

/**
 * Agent mode: prefer execution when the user wants to build, but still allow
 * multiple skills when they do not conflict (see selectCompatibleSkills).
 */
function adjustScoreForAgentExecution(message: string, hit: RankedSkill): RankedSkill {
	const name = hit.skill.name.toLowerCase();
	let score = hit.score;

	if (hasBuildOrCreateIntent(message)) {
		if (name.includes('brainstorm') || name.includes('office-hours')) {
			score = Math.max(0, score - 6);
		}
		if (EXECUTION_SKILL_HINTS.some(hint => name.includes(hint))) {
			score += 5;
		}
	}

	if (isBuildReadyBrief(message)) {
		if (name.includes('brainstorm') || name.includes('office-hours')) {
			score = Math.max(0, score - 4);
		}
		if (name.includes('frontend') || name.includes('executing') || name.includes('design-html')) {
			score += 4;
		}
	}

	if (hasDesignUiIntent(message)) {
		if (isDesignUiSkill(name)) {
			score += 6;
		}
		if (isDocumentSkill(name) || isGitPrSkill(name)) {
			score = Math.max(0, score - 14);
		}
	}

	if (hasScaffoldProjectIntent(message)) {
		if (isScaffoldExecutionSkill(name)) {
			score += 8;
		}
		if (isWpsSkill(name) || isDocumentSkill(name)) {
			score = Math.max(0, score - 18);
		}
	}

	return { skill: hit.skill, score };
}

/**
 * Current-turn routing query only. VS Code sets `request.message` from getPromptText()
 * for this request — prior turns live in `history`, which routing intentionally ignores.
 */
export function extractSkillRoutingQuery(request: IChatAgentRequest): string {
	return request.message.trim();
}

/**
 * ASCII-safe log form for routing queries. Avoids mojibake in Windows DevTools / native
 * log sinks (UTF-8 CJK displayed as GBK) and prevents embedded newlines from breaking lines.
 *
 * Decode: node -e "console.log(Buffer.from('<b64>','base64').toString('utf8'))"
 */
export function formatRoutingQueryForLog(query: string): string {
	const oneLine = query.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
	const preview = oneLine.length > 120 ? `${oneLine.slice(0, 120)}…` : oneLine;
	const utf8b64 = encodeBase64(VSBuffer.fromString(preview));
	return `queryLen=${query.length} queryUtf8B64=${utf8b64}`;
}

/**
 * Post-fusion domain gate: embedding recall alone must not override a clear primary intent.
 */
function applyIntentDomainAdjustments<T extends { skill: IAgentSkill; fusedScore: number; lexicalScore: number }>(
	message: string,
	details: readonly T[],
): (T & { fusedScore: number })[] {
	const domains = detectIntentDomains(message);
	if (!domains.size) {
		return details.map(d => ({ ...d, fusedScore: d.fusedScore }));
	}

	return details
		.map(d => {
			const name = d.skill.name.toLowerCase();
			let delta = 0;

			if (domains.has('scaffold-code') && isScaffoldExecutionSkill(name)) {
				delta += 10;
			}
			if (domains.has('design-ui') && isDesignUiSkill(name)) {
				delta += 8;
			}
			if (domains.has('document-ppt') && isPptDocumentSkill(name)) {
				delta += 8;
			}
			if (domains.has('document-word') && isWordDocumentSkill(name)) {
				delta += 8;
			}
			if (domains.has('document-excel') && isExcelDocumentSkill(name)) {
				delta += 8;
			}
			if (domains.has('document-pdf') && (name === 'pdf' || name.startsWith('pdf'))) {
				delta += 8;
			}
			if (domains.has('git-pr') && isGitPrSkill(name)) {
				delta += 6;
			}
			if (domains.has('mcp') && name.includes('mcp')) {
				delta += 8;
			}
			if (domains.has('test-verify') && isTestDebugSkill(name)) {
				delta += 10;
			}

			if (domains.has('design-ui') && (isDocumentSkill(name) || isGitPrSkill(name))) {
				const embedOnly = d.lexicalScore < 2;
				delta -= embedOnly ? 18 : 12;
			}
			if (domains.has('design-ui') && !domains.has('test-verify')
				&& (isTestDebugSkill(name) || isCiOrMetaSkill(name))) {
				delta -= d.lexicalScore < 2 ? 22 : 16;
			}
			if (domains.has('scaffold-code') && (isWpsSkill(name) || isDocumentSkill(name))) {
				delta -= d.lexicalScore < 2 ? 22 : 16;
			}
			if (domains.has('document-ppt') && (isWordDocumentSkill(name) || isExcelDocumentSkill(name) || isDesignUiSkill(name) || isGitPrSkill(name))) {
				delta -= d.lexicalScore < 2 ? 16 : 10;
			}
			if (domains.has('document-word') && (isPptDocumentSkill(name) || isExcelDocumentSkill(name) || isDesignUiSkill(name) || isGitPrSkill(name))) {
				delta -= d.lexicalScore < 2 ? 16 : 10;
			}
			if (!domains.has('git-pr') && isGitPrSkill(name)) {
				delta -= d.lexicalScore < 2 ? 18 : 14;
			}
			if (domains.has('mcp') && !name.includes('mcp') && d.lexicalScore < 2) {
				delta -= 10;
			}
			if (domains.has('test-verify') && (isWpsSkill(name) || isDocumentSkill(name))) {
				delta -= d.lexicalScore < 2 ? 22 : 16;
			}

			return { ...d, fusedScore: Math.max(0, d.fusedScore + delta) };
		})
		.filter(d => shouldKeepSkillForDomains(message, d.skill.name.toLowerCase(), d.lexicalScore, domains));
}

/** Discount embedding-only recalls that lack lexical support for any detected intent domain. */
function applyEmbeddingOnlyGating<T extends { skill: IAgentSkill; fusedScore: number; lexicalScore: number; embedScore?: number }>(
	message: string,
	details: readonly T[],
): (T & { fusedScore: number })[] {
	const domains = detectIntentDomains(message);
	return details.map(d => {
		if (d.lexicalScore >= 2) {
			return { ...d, fusedScore: d.fusedScore };
		}
		if (!domains.size) {
			return { ...d, fusedScore: d.fusedScore };
		}
		if (skillMatchesIntentDomains(d.skill.name.toLowerCase(), domains)) {
			return { ...d, fusedScore: d.fusedScore };
		}
		// Pure vector hit with no rule support — cap contribution.
		return { ...d, fusedScore: d.fusedScore * 0.4 };
	});
}

function shouldKeepSkillForDomains(
	message: string,
	nameLower: string,
	lexicalScore: number,
	domains: ReadonlySet<IntentDomain>,
): boolean {
	if (message.toLowerCase().includes(nameLower)) {
		return true;
	}
	// Git/PR skills: require explicit PR/git intent. Plain "update the frontend"
	// must not load update-pr via embedding/"update" lexical bleed.
	if (isGitPrSkill(nameLower) && !domains.has('git-pr')) {
		return false;
	}
	if (lexicalScore >= 6) {
		return true;
	}
	if (domains.has('scaffold-code') && (isWpsSkill(nameLower) || isDocumentSkill(nameLower)) && !hasExplicitOfficeFileOutput(message)) {
		return false;
	}
	if (hasWpsIntegrationProjectIntent(message) && (isWpsSkill(nameLower) || isDocumentSkill(nameLower)) && !hasExplicitOfficeFileOutput(message)) {
		return false;
	}
	if (domains.has('design-ui') && (isDocumentSkill(nameLower) || isGitPrSkill(nameLower))) {
		return false;
	}
	// UI/layout fixes must not pull QA / CI / gstack skills via embedding/"fix" bleed.
	if (domains.has('design-ui') && !domains.has('test-verify')
		&& (isTestDebugSkill(nameLower) || isCiOrMetaSkill(nameLower))) {
		return false;
	}
	if (domains.has('document-ppt') && (isWordDocumentSkill(nameLower) || isDesignUiSkill(nameLower) || isGitPrSkill(nameLower))) {
		return false;
	}
	if (domains.has('document-word') && (isPptDocumentSkill(nameLower) || isDesignUiSkill(nameLower) || isGitPrSkill(nameLower))) {
		return false;
	}
	if (domains.has('test-verify') && !hasExplicitOfficeFileOutput(message)
		&& (isWpsSkill(nameLower) || isDocumentSkill(nameLower))) {
		return false;
	}
	return true;
}

function applyFeedbackBoosts<T extends { skill: IAgentSkill; fusedScore: number; feedbackBoost?: number }>(
	details: readonly T[],
	feedbackStore?: ContinueSkillFeedbackStore,
): (T & { feedbackBoost: number; fusedScore: number })[] {
	if (!feedbackStore) {
		return details.map(d => ({
			...d,
			feedbackBoost: 0,
			fusedScore: d.fusedScore,
		}));
	}
	return details.map(d => {
		const feedbackBoost = feedbackStore.getScoreBoost(d.skill.name);
		return {
			...d,
			feedbackBoost,
			fusedScore: d.fusedScore + feedbackBoost,
		};
	});
}

export interface SkillLoadCandidate {
	readonly uri: URI;
	readonly name: string;
	readonly score: number;
}

/**
 * Greedy top-N selection: highest scores first, skip any skill that conflicts
 * with an already-selected skill.
 */
export function selectCompatibleSkills(
	candidates: readonly SkillLoadCandidate[],
	max: number,
	message?: string,
): SkillLoadCandidate[] {
	const selected: SkillLoadCandidate[] = [];
	for (const candidate of candidates) {
		if (selected.length >= max) {
			break;
		}
		if (selected.every(s => !skillsConflict(s.name, candidate.name, message))) {
			selected.push(candidate);
		}
	}
	return selected;
}

/** Returns true when two skills should not be loaded in the same Agent turn. */
export function skillsConflict(a: string, b: string, message?: string): boolean {
	const aLower = a.toLowerCase();
	const bLower = b.toLowerCase();
	if (aLower === bLower) {
		return false;
	}

	const aInterview = isInterviewSkill(aLower);
	const bInterview = isInterviewSkill(bLower);
	const aExecute = isExecutionSkill(aLower);
	const bExecute = isExecutionSkill(bLower);

	// Interview workflows (HARD-GATE, questionnaires) conflict with ship-now execution skills.
	if ((aInterview && bExecute) || (bInterview && aExecute)) {
		return true;
	}

	// UI page design vs office-document or git/PR workflows — different deliverables.
	if ((isDesignUiSkill(aLower) && isDocumentSkill(bLower)) || (isDesignUiSkill(bLower) && isDocumentSkill(aLower))) {
		return true;
	}
	if ((isDesignUiSkill(aLower) && isGitPrSkill(bLower)) || (isDesignUiSkill(bLower) && isGitPrSkill(aLower))) {
		return true;
	}
	// UI/layout work vs QA/CI meta skills — "fix height" must not load qa/fix-ci/gstack.
	if (message && hasDesignUiIntent(message) && !hasTestVerifyIntent(message)) {
		const aUi = isDesignUiSkill(aLower);
		const bUi = isDesignUiSkill(bLower);
		const aQa = isTestDebugSkill(aLower) || isCiOrMetaSkill(aLower);
		const bQa = isTestDebugSkill(bLower) || isCiOrMetaSkill(bLower);
		if ((aUi && bQa) || (bUi && aQa)) {
			return true;
		}
	}

	// Only one WPS pipeline per turn (wps-ppt + wps-word + wps-office stalls execution).
	if (isWpsSkill(aLower) && isWpsSkill(bLower)) {
		return true;
	}

	// Single document type requested — don't load both PPT and Word pipelines.
	if (message) {
		const pptOnly = hasPptDocumentIntent(message) && !hasWordDocumentIntent(message);
		const wordOnly = hasWordDocumentIntent(message) && !hasPptDocumentIntent(message);
		if (pptOnly && ((isPptDocumentSkill(aLower) && isWordDocumentSkill(bLower)) || (isWordDocumentSkill(aLower) && isPptDocumentSkill(bLower)))) {
			return true;
		}
		if (wordOnly && ((isPptDocumentSkill(aLower) && isWordDocumentSkill(bLower)) || (isWordDocumentSkill(aLower) && isPptDocumentSkill(bLower)))) {
			return true;
		}
	}

	// Verify / run-check prompts should not load office pipelines alongside debug skills.
	if (message && hasTestVerifyIntent(message) && !hasPptDocumentIntent(message) && !hasWordDocumentIntent(message)) {
		const aDoc = isDocumentSkill(aLower) || isWpsSkill(aLower);
		const bDoc = isDocumentSkill(bLower) || isWpsSkill(bLower);
		const aDebug = isTestDebugSkill(aLower);
		const bDebug = isTestDebugSkill(bLower);
		if ((aDoc && bDebug) || (bDoc && aDebug)) {
			return true;
		}
	}

	return false;
}

type IntentDomain = 'design-ui' | 'scaffold-code' | 'document-ppt' | 'document-word' | 'document-excel' | 'document-pdf' | 'git-pr' | 'mcp' | 'test-verify';

/** QA / debug / run-check skills — should not pair with office-document skills on verify-only prompts. */
const TEST_DEBUG_SKILL_HINTS = ['systematic-debugging', 'qa', 'webapp-testing', 'verification'] as const;

function detectIntentDomains(message: string): Set<IntentDomain> {
	const domains = new Set<IntentDomain>();
	const scaffold = hasScaffoldProjectIntent(message);
	if (scaffold) {
		domains.add('scaffold-code');
	}
	if (hasDesignUiIntent(message)) {
		domains.add('design-ui');
	}
	if (!scaffold) {
		if (hasPptDocumentIntent(message)) {
			domains.add('document-ppt');
		}
		if (hasWordDocumentIntent(message)) {
			domains.add('document-word');
		}
		if (hasExcelDocumentIntent(message)) {
			domains.add('document-excel');
		}
	}
	if (hasPdfDocumentIntent(message)) {
		domains.add('document-pdf');
	}
	if (hasGitPrIntent(message)) {
		domains.add('git-pr');
	}
	if (hasMcpIntent(message)) {
		domains.add('mcp');
	}
	if (hasTestVerifyIntent(message) && !hasPptDocumentIntent(message) && !hasWordDocumentIntent(message) && !hasExcelDocumentIntent(message)) {
		domains.add('test-verify');
	}
	return domains;
}

function skillMatchesIntentDomains(nameLower: string, domains: ReadonlySet<IntentDomain>): boolean {
	for (const domain of domains) {
		switch (domain) {
			case 'scaffold-code':
				if (isScaffoldExecutionSkill(nameLower)) {
					return true;
				}
				break;
			case 'design-ui':
				if (isDesignUiSkill(nameLower)) {
					return true;
				}
				break;
			case 'document-ppt':
				if (isPptDocumentSkill(nameLower)) {
					return true;
				}
				break;
			case 'document-word':
				if (isWordDocumentSkill(nameLower)) {
					return true;
				}
				break;
			case 'document-excel':
				if (isExcelDocumentSkill(nameLower)) {
					return true;
				}
				break;
			case 'document-pdf':
				if (nameLower === 'pdf' || nameLower.startsWith('pdf')) {
					return true;
				}
				break;
			case 'git-pr':
				if (isGitPrSkill(nameLower)) {
					return true;
				}
				break;
			case 'mcp':
				if (nameLower.includes('mcp')) {
					return true;
				}
				break;
			case 'test-verify':
				if (isTestDebugSkill(nameLower)) {
					return true;
				}
				break;
		}
	}
	return false;
}

function isInterviewSkill(nameLower: string): boolean {
	if (INTERVIEW_SKILL_NAMES.has(nameLower)) {
		return true;
	}
	return nameLower.includes('brainstorm') || nameLower.includes('office-hours');
}

function isExecutionSkill(nameLower: string): boolean {
	return EXECUTION_SKILL_HINTS.some(hint => nameLower.includes(hint));
}

function hasBuildOrCreateIntent(message: string): boolean {
	return /\b(create|build|add|ship|implement|make|develop|scaffold|design)\b/i.test(message)
		|| /(做|实现|开发|加|搭建|创建|生成|落地|构建|设计)/.test(message);
}

/** User wants a .docx/.pptx/.xlsx file produced this turn — not a WPS-related code repo name. */
export function hasExplicitOfficeFileOutput(message: string): boolean {
	return /\.(docx|pptx|xlsx)\b/i.test(message)
		|| /templates\/[^\s]+\.(docx|pptx|xlsx)/i.test(message)
		|| /(生成|导出|制作|填写|输出).{0,16}(word|docx|pptx|xlsx|幻灯片|表格文件)/i.test(message);
}

/**
 * WPS appears as a product/integration name (Hermes + WPS agent repo), not "run WPS to export a file".
 */
export function hasWpsIntegrationProjectIntent(message: string): boolean {
	return /(?:hermes|wps).{0,40}(?:agent|项目|工程|仓库|脚手架|代码库)/i.test(message)
		|| /\bwps\b.{0,32}(?:agent|集成|sdk|api|项目|工程)/i.test(message)
		|| /(?:文档生成).{0,16}(?:项目|工程|agent|仓库|脚手架)/i.test(message)
		|| /hermes[-_]?wps/i.test(message);
}

/** User wants a web/UI page designed — not Word/PPT or a PR update. */
export function hasScaffoldProjectIntent(message: string): boolean {
	return /(新建|搭建|创建|初始化).{0,24}(项目|仓库|工程|脚手架|骨架)/i.test(message)
		|| /(写|创建).{0,10}(可运行)?骨架/i.test(message)
		|| /立即\s*write_file|immediately write_file/i.test(message)
		|| (
			/package\.json/i.test(message)
			&& (/src\//i.test(message) || /\.ts\b/m.test(message))
			&& /(新建|搭建|目录|结构|hermes|agent)/i.test(message)
		)
		|| hasWpsIntegrationProjectIntent(message);
}

/**
 * External / up-to-date knowledge questions — must use search_web, not skills or memory.
 * Excludes repo edit/scaffold tasks.
 */
export function hasWebSearchIntent(message: string): boolean {
	if (hasScaffoldProjectIntent(message) || hasDesignUiIntent(message)) {
		return false;
	}
	if (hasExcelDocumentIntent(message) || hasWordDocumentIntent(message) || hasPptDocumentIntent(message)) {
		return false;
	}
	if (/\b(implement|refactor|write_file|fix bug|debug|grep_search|run_terminal)\b/i.test(message)) {
		return false;
	}
	if (/(实现|修复|重构|编写代码|改代码|跑命令)/.test(message)) {
		return false;
	}

	const infoPatterns = [
		/\b(search\s+(the\s+)?web|web\s+search|look\s+up online)\b/i,
		/(网上|在线).{0,8}(搜|查|找)/,
		/(搜索|查询).{0,10}(一下|最新|网上|在线|资料|信息)/,
		/\b(latest|current|recent|up[- ]to[- ]date|released?|announced?|downloadable?)\b/i,
		/(最新|近期|发布|上架|下载|能否下载|可不可以下载|哪里下载|怎么下载|如何获取|开源吗|许可证|概况)/,
		/\b(what is|who is|when did|where can i download|is .+ available|overview of|tell me about)\b/i,
		/(是什么|什么是|介绍一下|能否公开|公开下载)/,
		/\b(nvidia|cosmos|hugging\s*face|openai|gemini|claude|llama)\b/i,
		/(模型).{0,8}(下载|发布|开源|概况|介绍|是什么)/,
		/(下载|发布|开源).{0,8}(模型|权重|model)/i,
	];
	return infoPatterns.some(p => p.test(message));
}

export function hasDesignUiIntent(message: string): boolean {
	return /(设计).{0,12}(页面|界面|组件|布局|视觉|ui)/i.test(message)
		|| /(页面|界面|ui|组件).{0,12}设计/i.test(message)
		|| /(新页面|新界面|落地页)/.test(message)
		|| /\bdesign\b.+\b(page|ui|screen|layout|mockup|component)\b/i.test(message)
		|| (/(前端|页面|界面|视觉|布局)/.test(message) && /(设计|样式|ui|css|手绘|温暖)/i.test(message))
		// Layout / CSS tweak on an existing page (height/width alignment, video sizing, …)
		|| /(高度|宽度|太高|太矮|样式|布局|对齐).{0,24}(视频|video|文本|文字|图片|图|组件|区块)/i.test(message)
		|| /(视频|video|图片|图|组件|区块).{0,24}(高度|宽度|太高|太矮|样式|布局|对齐|match)/i.test(message)
		|| /\b(page|layout|css|style|ui|video)\b/i.test(message)
			&& /(高度|宽度|太高|太矮|样式|布局|对齐|match.{0,12}(高|高矮|height|text))/i.test(message)
		|| /\b(fix|adjust|match|align).{0,40}\b(height|width|layout|css|style|video)\b/i.test(message);
}

export function hasPptDocumentIntent(message: string): boolean {
	if (hasScaffoldProjectIntent(message)) {
		return false;
	}
	return /(生成|制作|导出|做).{0,16}(pptx?|幻灯片|演示|deck)/i.test(message)
		|| /\bpptx\b/i.test(message)
		|| /\.pptx\b/i.test(message)
		|| /templates\/[^\s]+\.pptx/i.test(message);
}

export function hasWordDocumentIntent(message: string): boolean {
	if (hasScaffoldProjectIntent(message)) {
		return false;
	}
	if (hasWpsIntegrationProjectIntent(message) && !hasExplicitOfficeFileOutput(message)) {
		return false;
	}
	return /(生成|制作|导出|写).{0,16}(word|docx|文档|方案)/i.test(message)
		|| /\bdocx\b/i.test(message)
		|| /\.docx\b/i.test(message)
		|| /templates\/[^\s]+\.docx/i.test(message);
}

export function hasExcelDocumentIntent(message: string): boolean {
	if (hasScaffoldProjectIntent(message)) {
		return false;
	}
	return /(生成|制作|导出|填写).{0,16}(表格|xlsx|excel)/i.test(message)
		|| /\bxlsx\b/i.test(message)
		|| /\.xlsx\b/i.test(message);
}

export function hasPdfDocumentIntent(message: string): boolean {
	return /\bpdf\b/i.test(message);
}

export function hasGitPrIntent(message: string): boolean {
	return /\b(commit|pull\s*request|rebase|merge)\b/i.test(message)
		|| /\b(open|update|create)\s+(a\s+)?pr\b/i.test(message)
		|| /\bpr\s*[#:]\s*\d+/i.test(message)
		|| /\bcode\s*review\b/i.test(message)
		|| /(提交|合并|代码审查|拉取请求|分支)/.test(message);
}

export function hasMcpIntent(message: string): boolean {
	return /\b(mcp|server.?tool|tool.?server)\b/i.test(message)
		|| /(mcp)/i.test(message);
}

/** User wants to verify the project runs — not generate Office documents. */
export function hasTestVerifyIntent(message: string): boolean {
	return /\b(test|testing|verify|sanity|smoke.?test)\b/i.test(message)
		|| /\b(run|start)\b.+\b(project|app|build|server)\b/i.test(message)
		|| /(测试|试运行|能不能正常|能否正常|能否运行|跑起来|跑通|是否正常|运行正常|验证一下|能不能运行)/.test(message);
}

/**
 * Deterministic lexical routing for tests / diagnostics (no embedding or feedback).
 */
export function simulateLexicalSkillRouting(
	message: string,
	skills: readonly IAgentSkill[],
	max = MAX_FULL_SKILLS,
): { readonly routed: string[]; readonly top: { name: string; score: number }[] } {
	const ranked = rankSkillsForMessage(message, skills)
		.map(hit => adjustScoreForAgentExecution(message, hit));
	let details = ranked.map(hit => ({
		skill: hit.skill,
		lexicalScore: hit.score,
		fusedScore: hit.score,
	}));
	details = applyIntentDomainAdjustments(message, details);
	details = applyEmbeddingOnlyGating(message, details);
	details.sort((a, b) => b.fusedScore - a.fusedScore || a.skill.name.localeCompare(b.skill.name));

	const candidates = details
		.filter(d => d.fusedScore >= AUTO_ROUTE_SCORE_THRESHOLD)
		.map(d => ({ uri: d.skill.uri, name: d.skill.name, score: d.fusedScore }));
	const routed = selectCompatibleSkills(candidates, max, message).map(c => c.name);
	return {
		routed,
		top: details.slice(0, 8).map(d => ({ name: d.skill.name, score: d.fusedScore })),
	};
}

function skillMatchesIntentHint(nameLower: string, hint: string): boolean {
	if (nameLower === hint) {
		return true;
	}
	// Match hyphenated skill names by segment (e.g. wps-ppt ↔ hint pptx), not substring (code-review ↔ requesting-code-review).
	const segments = nameLower.split(/[-_]/);
	if (segments.includes(hint)) {
		return true;
	}
	return segments.some(seg => hint.includes(seg) && seg.length >= 4);
}

function isDesignUiSkill(nameLower: string): boolean {
	return DESIGN_UI_SKILL_HINTS.some(hint => nameLower === hint || nameLower.includes(hint));
}

function isDocumentSkill(nameLower: string): boolean {
	return DOCUMENT_SKILL_PREFIXES.some(prefix => nameLower === prefix || nameLower.startsWith(prefix));
}

function isPptDocumentSkill(nameLower: string): boolean {
	return PPT_DOCUMENT_SKILL_HINTS.some(hint => nameLower === hint || nameLower.includes(hint));
}

function isWordDocumentSkill(nameLower: string): boolean {
	return WORD_DOCUMENT_SKILL_HINTS.some(hint => nameLower === hint || nameLower.includes(hint));
}

function isExcelDocumentSkill(nameLower: string): boolean {
	return EXCEL_DOCUMENT_SKILL_HINTS.some(hint => nameLower === hint || nameLower.includes(hint));
}

function isGitPrSkill(nameLower: string): boolean {
	return GIT_PR_SKILL_NAMES.has(nameLower)
		|| nameLower.includes('code-review')
		|| nameLower.includes('git-worktree')
		|| nameLower.includes('development-branch');
}

const SCAFFOLD_EXECUTION_SKILL_HINTS = ['executing-plans', 'writing-plans', 'subagent-driven-development'] as const;

function isScaffoldExecutionSkill(nameLower: string): boolean {
	return SCAFFOLD_EXECUTION_SKILL_HINTS.some(hint => nameLower === hint || nameLower.includes(hint));
}

function isWpsSkill(nameLower: string): boolean {
	return nameLower.startsWith('wps-');
}

function isTestDebugSkill(nameLower: string): boolean {
	return TEST_DEBUG_SKILL_HINTS.some(hint => nameLower === hint || nameLower.includes(hint));
}

/** CI / meta workflow skills that steal the turn from UI layout fixes via "fix" embeddings. */
function isCiOrMetaSkill(nameLower: string): boolean {
	return nameLower === 'gstack'
		|| nameLower.includes('fix-ci')
		|| nameLower.includes('gstack')
		|| nameLower.includes('canary')
		|| nameLower === 'ship'
		|| nameLower.includes('land-and-deploy');
}

function isBuildReadyBrief(message: string): boolean {
	const hasProduct = /(产品|product|agent|应用|app)/i.test(message);
	const hasAudience = /(开发者|用户|audience|developer|customer|使用)/i.test(message);
	const hasStyle = /(风格|手绘|notion|mailchimp|温暖|landing|ui|页面)/i.test(message);
	const signals = [hasProduct, hasAudience, hasStyle].filter(Boolean).length;
	return signals >= 2 || (hasProduct && hasStyle);
}

/**
 * Neutralize HARD-GATE / interview-only / WPS-office instructions that block agent execution.
 */
function sanitizeSkillBodyForAgentExecution(body: string, skillName?: string): string {
	let sanitized = body;
	sanitized = sanitized.replace(/<HARD-GATE>[\s\S]*?<\/HARD-GATE>/gi, '');
	sanitized = sanitized.replace(
		/Do NOT invoke any implementation skill[\s\S]*?until you have presented a design and the user has approved it\./gi,
		'In Agent mode: skip the design interview — infer sensible defaults and implement with write_file immediately.',
	);
	sanitized = sanitized.replace(
		/Start by understanding the current project context, then ask questions one at a time[\s\S]*?get user approval\./gi,
		'In Agent mode: a quick ls/read_file is enough context — then write_file without further questions.',
	);
	sanitized = sanitized.replace(
		/Only one question per message[\s\S]*?success criteria/gi,
		'In Agent mode: do not ask clarifying questions — infer constraints and ship a first version',
	);
	sanitized = sanitized.replace(
		/(present(ed)? (the )?(design|plan|proposal)[\s\S]{0,80}?(get|wait for|seek) (user )?approval)/gi,
		'In Agent mode: skip approval — implement immediately',
	);
	sanitized = sanitized.replace(
		/(请确认|please confirm|get user approval|ask (the )?user (to )?confirm|wait for (the )?user (to )?(confirm|approve))/gi,
		'do not ask — edit files now',
	);
	if (skillName && isWpsSkill(skillName.toLowerCase())) {
		sanitized = [
			'AGENT MODE OVERRIDE: If the user lists TypeScript/project files or asks to scaffold a repo, use write_file for code — do NOT run WPS/MCP office document pipelines this turn.',
			'Skip template/MCP prerequisites unless the user explicitly asked to generate a .docx/.pptx/.xlsx file in this message.',
			sanitized,
		].join('\n\n');
	}
	return sanitized.trim();
}

function collectIntentBoosts(message: string): Set<string> {
	const boosts = new Set<string>();
	const scaffold = hasScaffoldProjectIntent(message);
	const wpsCodeProject = hasWpsIntegrationProjectIntent(message);
	for (const group of INTENT_HINTS) {
		if ((scaffold || wpsCodeProject) && group.skillHints.some(h =>
			h.startsWith('wps-') || h === 'docx' || h === 'pptx' || h === 'xlsx' || h === 'pdf')) {
			continue;
		}
		if (group.patterns.some(p => p.test(message))) {
			for (const hint of group.skillHints) {
				boosts.add(hint.toLowerCase());
			}
		}
	}
	return boosts;
}

function tokenize(text: string): Set<string> {
	const tokens = new Set<string>();
	const lower = text.toLowerCase();

	// Latin / digit words
	for (const m of lower.matchAll(/[a-z0-9][a-z0-9+.#-]{1,}/g)) {
		tokens.add(m[0]);
	}

	// Chinese: add 2-grams and 3-grams for better short-phrase matching
	const cjk = lower.match(/[\u4e00-\u9fff]+/g) ?? [];
	for (const run of cjk) {
		tokens.add(run);
		for (let i = 0; i < run.length - 1; i++) {
			tokens.add(run.slice(i, i + 2));
			if (i + 3 <= run.length) {
				tokens.add(run.slice(i, i + 3));
			}
		}
	}
	return tokens;
}

function extractFromRequestVariables(request: IChatAgentRequest): {
	promptFileUris: URI[];
} {
	const variables = request.variables?.variables ?? [];
	const promptFileUris: URI[] = [];
	for (const entry of variables) {
		if (isPromptFileVariableEntry(entry) && URI.isUri(entry.value)) {
			promptFileUris.push(entry.value);
		}
	}
	return { promptFileUris };
}

function buildSkillsCatalog(skills: readonly IAgentSkill[]): string {
	if (!skills.length) {
		return '';
	}

	const entries: string[] = [
		'<skills>',
		'Skills are specialized workflows. The runtime hybrid-recalls (embedding + lexical) and preloads up to several compatible skill(s) as <skill-context> blocks.',
		'Multiple skills may load together when they complement each other (e.g. frontend-design + executing-plans). Conflicting pairs (e.g. brainstorming + frontend-design) are not loaded in the same turn.',
		'When a <skill-context> is present, use it as implementation guidance and EXECUTE with write_file — do not stall in clarifying questions if the user brief is already enough for a first version.',
		'Available skills (catalog):',
	];

	let charCount = 0;
	let truncatedAt = skills.length;
	for (let i = 0; i < skills.length; i++) {
		const skill = skills[i];
		const skillEntry = [
			'<skill>',
			`<name>${escapeXml(skill.name)}</name>`,
			skill.description ? `<description>${escapeXml(skill.description)}</description>` : undefined,
			'</skill>',
		].filter((line): line is string => Boolean(line));
		const entryLength = skillEntry.join('\n').length + 1;
		if (charCount + entryLength > SKILL_DESCRIPTION_CHAR_BUDGET) {
			truncatedAt = i;
			break;
		}
		charCount += entryLength;
		entries.push(...skillEntry);
	}

	if (truncatedAt < skills.length) {
		const names = skills.slice(truncatedAt).map(s => s.name);
		entries.push(`Additional skills available: ${names.slice(0, 40).join(', ')}${names.length > 40 ? '...' : ''}`);
	}

	entries.push('</skills>');
	return entries.join('\n');
}

function collectExplicitSlashSkills(message: string): string[] {
	const names = new Set<string>();
	for (const match of message.matchAll(/(?:^|\s)\/([\w.-]+)\b/g)) {
		if (match[1]) {
			names.add(match[1]);
		}
	}
	return [...names];
}

function stripYamlFrontmatter(content: string): string {
	if (!content.startsWith('---')) {
		return content;
	}
	const end = content.indexOf('\n---', 3);
	if (end < 0) {
		return content;
	}
	const after = content.slice(end + 4);
	return after.replace(/^\r?\n/, '');
}

function escapeXml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}
