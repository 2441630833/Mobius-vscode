/*---------------------------------------------------------------------------------------------
 *  Mobius — Semantic Intent Router for Agent Modes
 *
 *  Inspired by aurelio-labs/semantic-router & vllm-project/semantic-router:
 *  Matches user prompts against curated bilingual route utterances in vector space
 *  using in-process n-gram embeddings and cosine similarity, with negative guardrails
 *  and calibrated confidence scoring. Zero LLM calls, zero network latency (<2ms).
 *--------------------------------------------------------------------------------------------*/

import { cosineSimilarity, embedTextLocal } from './continueSkillEmbeddings.js';

export type MobiusSemanticMode = 'agent' | 'game' | 'chip' | 'ppt';

export interface ISemanticRouteMatch {
	readonly mode: MobiusSemanticMode;
	readonly score: number;
	readonly reason: string;
	readonly matchedUtterance?: string;
}

interface IRouteDefinition {
	readonly mode: MobiusSemanticMode;
	readonly reason: string;
	readonly utterances: readonly string[];
	readonly lexicalPatterns: readonly RegExp[];
	readonly antiPatterns?: readonly RegExp[];
	readonly threshold: number;
	readonly requiresLexical?: boolean;
}

const PPT_ROUTE: IRouteDefinition = {
	mode: 'ppt',
	reason: 'semantic-ppt-route',
	threshold: 0.50,
	requiresLexical: false,
	lexicalPatterns: [
		/^\/ppt\b/i,
		/\b(ppt|pptx|powerpoint|slide\s*deck|pitch\s*deck|keynote)\b/i,
		/(生成|制作|做|设计|写|输出).{0,25}(演示文稿|幻灯片|ppt|课件|讲稿|胶片|deck)/i,
		/(演示文稿|幻灯片|汇报幻灯片|演讲幻灯片|路演幻灯片|汇报材料|述职报告|课件制作)/i,
	],
	antiPatterns: [
		/(解析|读取|导出库|转换器|脚本解析|代码解析).{0,10}(pptx?|ppt文件)/i,
		/(pptx?|ppt文件).{0,10}(解析|读取|导出库|转换器|脚本解析|代码解析)/i,
		/(css|html|react|vue|web|网页|轮播|组件).{0,10}(slide|幻灯片|卡片轮播)/i,
		/(slide|幻灯片|卡片轮播).{0,10}(css|html|react|vue|web|网页|轮播|组件|动效)/i,
		/\bpython-pptx\b/i,
		/\b(git\s+pull|git\s+push|git\s+commit|npm\s+run|启动服务)\b/i,
	],
	utterances: [
		'制作一份关于人工智能发展历程的PPT',
		'帮我准备明天向高管汇报的项目进展材料和演示文稿',
		'做一个产品发布会的演示文稿和精美幻灯片',
		'总结这个季度的业务指标，做成演讲胶片和大纲',
		'帮我做一份商业计划书融资路演的pitch deck',
		'生成5页关于新能源汽车行业分析的演讲大纲和课件',
		'把这段方案文字转成汇报幻灯片，设计清晰的结构和页面内容',
		'帮我写个学术答辩汇报，包含背景、方法、实验结果和总结',
		'做一份团队季度述职报告的演示幻灯片',
		'梳理系统架构设计要点，输出成技术分享PPT',
		'帮我做个课件，向初学者讲解量子计算的基本原理',
		'制作公司介绍和核心优势展示的幻灯片大纲',
		'make a slide deck for our quarterly business review',
		'generate presentation slides for the upcoming investor pitch',
		'create a pitch deck with problem, solution, market size, and financials',
		'design a keynote presentation on autonomous driving breakthroughs',
		'outline presentation slides explaining transformer neural networks',
		'format these meeting notes into presentation slides with visual layouts',
		'prepare a presentation deck for tomorrow client showcase',
		'build a 10-slide presentation about cloud native architecture',
		'generate an executive slide presentation summarizing this proposal',
		'draft speech notes and presentation slides for the keynote',
		'Create a 10-page presentation slide deck for investors',
	],
};

const GAME_ROUTE: IRouteDefinition = {
	mode: 'game',
	reason: 'semantic-game-route',
	threshold: 0.50,
	requiresLexical: true,
	lexicalPatterns: [
		/^\/game\b/i,
		/\bgodot\b/i,
		/\bgame[\s-]?dev\b/i,
		/game[\s-]?dev(?:\/|\b|里|中)/i,
		/(做个小游戏|开发游戏|制作游戏|游戏开发|游戏场景|刚体碰撞|跳跃控制|金币收集|血条UI|游戏关卡)/i,
	],
	antiPatterns: [
		/(架构解析|源码分析|引擎原理|对比|区别).{0,10}(godot|unity|unreal)/i,
		/(godot|unity|unreal).{0,10}(架构解析|源码分析|引擎原理|对比|区别)/i,
		/\b(git\s+pull|git\s+push|git\s+commit|git\s+checkout|npm\s+run|启动服务|运行服务|部署)\b/i,
	],
	utterances: [
		'在game-dev里用Godot给游戏加个跳跃和下蹲动作控制',
		'给Star Catcher加一颗会发光的奖励星星和实时计分板',
		'制作一个2D横版跳跃小游戏，包含玩家控制和金币收集',
		'修改角色物理刚体碰撞体积，增加弹性跳跃和重力效果',
		'添加敌人巡逻AI、近战攻击判定和生命值血条UI',
		'跑一下godot_test和godot_play验证游戏场景和导入状态',
		'调整游戏背景音乐音量以及角色跳跃、击中怪物的音效系统',
		'给游戏添加关卡胜利条件和死亡重新开始的菜单弹窗',
		'in game-dev/, implement player movement and jump mechanics in Godot',
		'add a collectible bonus star and score display to Star Catcher',
		'create a 2D platformer level with collision shapes and tilemap in Godot',
		'test game physics and run godot_play to preview live gameplay',
		'add enemy patrolling behavior, hurtbox detection, and health bar UI',
		'build a small space shooter game prototype in game-dev',
	],
};

const CHIP_ROUTE: IRouteDefinition = {
	mode: 'chip',
	reason: 'semantic-chip-route',
	threshold: 0.50,
	requiresLexical: true,
	lexicalPatterns: [
		/^\/chip\b/i,
		/\bchip[\s-]?design\b/i,
		/chip[\s-]?design(?:\/|\b|里|中)/i,
		/\b(fpga|verilog|rtl|arty\s*a7|openfpgaloader|yosys|openxc7|verilator)\b/i,
		/(物理采样器|真随机数|热噪声|环形振荡器|综合比特流|烧录fpga)/i,
	],
	antiPatterns: [
		/(解释|介绍|什么是|科普|对比|区别|论文|理论).{0,20}(fpga|asic|gpu|chip|芯片)/i,
		/(fpga|asic|gpu|chip|芯片).{0,20}(解释|介绍|什么是|科普|对比|区别|差异|原理|架构对比|论文|理论)/i,
		/\b(explain|difference|what is|overview of)\b.{0,20}\b(fpga|asic|gpu)\b/i,
		/\b(git\s+pull|git\s+push|git\s+commit|git\s+checkout|npm\s+run|启动服务|运行服务|部署)\b/i,
	],
	utterances: [
		'在chip-design里检查FPGA物理采样器工具链并执行fpga_detect',
		'编写Verilog硬件描述语言并用verilator进行RTL前仿和波形验证',
		'使用yosys和openXC7综合bitstream比特流并烧录到Arty A7开发板',
		'测试环形振荡器和热噪声TRNG的随机熵物理采样',
		'读取UART串口输出的真随机数采样token',
		'检查FPGA引脚约束xdc文件和时序约束配置',
		'in chip-design/, run fpga_detect and verify the FPGA sampler toolchain',
		'lint and simulate Verilog RTL with verilator and inspect waveforms',
		'synthesize bitstream with Yosys and openXC7, then flash Arty A7 over openFPGALoader',
		'sample physical random tokens from the thermal-noise TRNG over UART',
		'verify ring oscillator entropy source and TRNG stochastic sampling on hardware',
	],
};

const AGENT_ROUTE: IRouteDefinition = {
	mode: 'agent',
	reason: 'semantic-agent-route',
	threshold: 0.40,
	lexicalPatterns: [
		/^\/agent\b/i,
		/\b(implement|fix|add|create|refactor|patch|commit|update|change|modify|write|build|scaffold|migrate|rename|delete|remove|run tests|apply)\b/i,
		/(实现|修复|添加|修改|重构|直接改|帮我改|创建文件|写代码|重写|写个脚本)/i,
	],
	utterances: [
		'修复前端组件的样式对齐问题，修改CSS文件并测试',
		'写一个Python脚本读取文件并提取表格数据',
		'编写一个Node.js后端接口处理用户认证和权限校验',
		'重构这段代码，提取公共工具函数并补充完整的单元测试',
		'在README.md末尾添加项目架构与使用说明并提交git commit',
		'排查程序运行中的空指针异常并提供修复方案',
		'优化数据库查询语句，增加索引提高检索性能',
		'fix bug in user login authentication flow and update unit tests',
		'refactor this TypeScript service and extract reusable helper functions',
		'write a bash script to automate deployment and health check',
		'update README documentation with getting started guide',
		'inspect git status and clean up temporary test files',
	],
};

const ROUTES: readonly IRouteDefinition[] = [PPT_ROUTE, GAME_ROUTE, CHIP_ROUTE, AGENT_ROUTE];

interface ICachedRouteVector {
	readonly utterance: string;
	readonly vector: readonly number[];
}

class SemanticRouteIndex {
	private _initialized = false;
	private readonly _cache = new Map<MobiusSemanticMode, ICachedRouteVector[]>();

	private _ensureVectors(): void {
		if (this._initialized) {
			return;
		}
		for (const route of ROUTES) {
			const list: ICachedRouteVector[] = [];
			for (const utterance of route.utterances) {
				const vec = embedTextLocal(utterance);
				if (vec) {
					list.push({ utterance, vector: vec });
				}
			}
			this._cache.set(route.mode, list);
		}
		this._initialized = true;
	}

	route(message: string): ISemanticRouteMatch {
		const text = message.trim();
		if (!text) {
			return { mode: 'agent', score: 1.0, reason: 'empty-prompt' };
		}

		// 1. Slash command override
		const slashMatch = text.match(/^\/(agent|game|chip|ppt|ask|plan)\b/i);
		if (slashMatch) {
			const raw = slashMatch[1].toLowerCase();
			if (raw === 'game') {
				return { mode: 'game', score: 1.0, reason: 'slash-override' };
			}
			if (raw === 'chip') {
				return { mode: 'chip', score: 1.0, reason: 'slash-override' };
			}
			if (raw === 'ppt') {
				return { mode: 'ppt', score: 1.0, reason: 'slash-override' };
			}
			return { mode: 'agent', score: 1.0, reason: 'slash-override' };
		}

		this._ensureVectors();
		const queryVec = embedTextLocal(text);

		// Candidate scores
		let bestMode: MobiusSemanticMode = 'agent';
		let bestScore = -1;
		let bestReason = 'default-agent';
		let bestUtterance: string | undefined;

		// Evaluate specialized routes first: ppt, game, chip
		const specializedRoutes = [PPT_ROUTE, GAME_ROUTE, CHIP_ROUTE];

		for (const route of specializedRoutes) {
			// Check anti-patterns (guardrails against false positive tool triggers)
			if (route.antiPatterns?.some(pattern => pattern.test(text))) {
				continue;
			}

			let lexicalScore = 0;
			for (const pat of route.lexicalPatterns) {
				if (pat.test(text)) {
					lexicalScore = Math.max(lexicalScore, 0.70);
				}
			}

			let semanticScore = 0;
			let topUtterance: string | undefined;
			if (queryVec) {
				const vectors = this._cache.get(route.mode) ?? [];
				for (const item of vectors) {
					const sim = cosineSimilarity(queryVec, item.vector);
					if (sim > semanticScore) {
						semanticScore = sim;
						topUtterance = item.utterance;
					}
				}
			}

			// Hybrid scoring:
			// 1. If route requires explicit lexical keywords (e.g. Chip, Game hardware/engine modes),
			//    and none matched, never route via pure semantic similarity.
			if (route.requiresLexical && lexicalScore === 0) {
				continue;
			}

			// 2. Compute composite score:
			//    - If lexical keyword matched without anti-pattern, baseline 0.70 + semantic alignment up to 1.0.
			//    - If no lexical keyword matched (allowed only for unconstrained routes like PPT),
			//      require real semantic similarity without artificial doubling.
			let compositeScore = 0;
			if (lexicalScore > 0) {
				compositeScore = Math.max(lexicalScore, 0.70 + 0.30 * Math.min(1.0, Math.max(0, semanticScore) / 0.5));
			} else if (semanticScore >= route.threshold) {
				compositeScore = semanticScore;
			} else {
				compositeScore = 0;
			}

			if (compositeScore >= route.threshold && compositeScore > bestScore) {
				bestScore = compositeScore;
				bestMode = route.mode;
				bestReason = lexicalScore > 0 && semanticScore >= 0.25
					? `hybrid-${route.mode}-intent`
					: (lexicalScore > 0 ? `lexical-${route.mode}-intent` : `semantic-${route.mode}-similarity`);
				bestUtterance = topUtterance;
			}
		}

		if (bestScore >= 0.45 && bestMode !== 'agent') {
			return {
				mode: bestMode,
				score: bestScore,
				reason: bestReason,
				matchedUtterance: bestUtterance,
			};
		}

		return {
			mode: 'agent',
			score: 1.0,
			reason: 'default-agent',
		};
	}
}

export const semanticRouter = new SemanticRouteIndex();
