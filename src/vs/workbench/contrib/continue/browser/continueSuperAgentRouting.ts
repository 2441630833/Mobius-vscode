/*---------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export type SuperAgentRoute = 'local' | 'submit' | 'followup' | 'pause' | 'resume' | 'cancel' | 'status';

/** Conservative intake: quoted code, explanations and uncertain intent stay in the foreground. */
export function routeSuperAgentRequest(message: string, hasTask: boolean): SuperAgentRoute {
	const text = message.trim();
	if (/^(?:请|帮我)?(?:解释|说明|为什么|如何|怎么|能否|是否)|^(?:explain|why|how|what|can you explain)\b/i.test(text) || /```/.test(text)) { return 'local'; }
	if (/^(?:请|帮我)?(?:取消|停止)(?:当前|这个|后台|原)?(?:任务|执行)?[。！!\s]*$|^(?:cancel|stop)(?: the)?(?: current| background)?(?: task)?[.!\s]*$/i.test(text)) { return 'cancel'; }
	if (/^(?:请)?暂停(?:当前|这个|后台)?(?:任务|执行)?[。！!\s]*$|^pause(?: the)?(?: current| background)?(?: task)?[.!\s]*$/i.test(text)) { return 'pause'; }
	if (/^(?:请)?(?:查询|查看)?(?:当前|这个|后台)?(?:任务)?进度[？?。\s]*$|^(?:status|progress|show progress|task status)[?!.\s]*$/i.test(text)) { return 'status'; }
	if (hasTask && /^(?:请)?(?:继续|恢复)(?:当前|这个|后台|原)?(?:任务|执行)?[。！!\s]*$|^resume(?: the)?(?: task)?[.!\s]*$/i.test(text)) { return 'resume'; }
	if (hasTask && /^(?:请)?(?:补充|另外|还要|再加|加上|改成|继续|同时)|^(?:also|additionally|instead|follow up|change it|make it)\b/i.test(text)) { return 'followup'; }
	if (hasTask && /^(?:请|帮我)?(?:修改|修复|增加|添加|把.+改成|调整)|^(?:please\s+)?(?:add|fix|change|update|adjust)\b/i.test(text)) { return 'followup'; }
	if (/^(?:\/background\s+|交给\s*super\s*agent|让\s*super\s*agent)/i.test(text)) { return 'submit'; }
	if (/[?？]$|(?:不要|不用|先别|仅讨论|只解释|don't|do not)\s*(?:实现|修改|编码|implement|change|code)/i.test(text)) { return 'local'; }
	const coding = /(?:实现|开发|重构|改造|修复|集成|构建)|\b(?:implement|build|refactor|integrate|fix)\b/i.test(text);
	const complex = /(?:跨模块|多个模块|前后端|端到端|完整功能|整个项目|架构|数据库.*接口|接口.*数据库)|\b(?:end.to.end|full.stack|multi.module|architecture|entire (?:app|project))\b/i.test(text)
		|| (text.length > 100 && /(?:测试|验证|tests?|verify)/i.test(text) && /(?:以及|并且|同时|另外|\band\b)/i.test(text));
	return coding && complex ? 'submit' : 'local';
}

export interface SuperAgentChatResult {
	handled: boolean;
	id?: string;
	stage?: string;
	chatState?: string;
	reason?: string;
	error?: string;
	report?: { state: string; summary: string; at?: string };
	execution?: { branch?: string; worktree?: string; commit?: string };
	selections?: { kind: string; name: string; reason?: string }[];
}

export function formatSuperAgentSelections(result: SuperAgentChatResult): string {
	const names = (kind: string) => result.selections?.filter(s => s.kind === kind).map(s => `${s.name}${s.reason ? `（${s.reason}）` : ''}`).join('、') || '无';
	return `Super Agent 实际选择 — 已加载 Skill：${names('skill')}；已加载 Agent 配置：${names('agent-profile')}。配置加载不代表启动了额外子代理。`;
}

export function formatSuperAgentResult(result: SuperAgentChatResult): string {
	const stage = result.chatState ?? result.stage;
	const states: Record<string, string> = { running: '执行中', pending: '排队中', paused: '已暂停', ready: '待审阅', completed: '已完成', stopped: '已取消', blocked: '需要处理', failed: '失败' };
	return ['Super Agent', result.id ? `任务 ${result.id}：${states[stage ?? ''] ?? stage ?? '已接管'}` : '', result.reason ?? '', result.error ? `通信失败：${result.error}。请查询后台任务状态，避免重复执行。` : '', result.report?.summary ?? '', result.report ? formatSuperAgentSelections(result) : '', result.execution?.branch ? `结果分支：${result.execution.branch}` : '', result.execution?.worktree ? `工作目录：${result.execution.worktree}` : ''].filter(Boolean).join('\n\n');
}
