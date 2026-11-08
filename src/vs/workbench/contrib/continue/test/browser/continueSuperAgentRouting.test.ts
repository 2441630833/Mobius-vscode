/*---------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { formatSuperAgentSelections, routeSuperAgentRequest } from '../../browser/continueSuperAgentRouting.js';

suite('Super Agent chat routing', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	for (const text of ['解释如何实现前后端功能', 'How does the architecture work?', 'Fix the button color', '把按钮改成蓝色', '不要实现整个项目', '实现整个项目可以吗？', '解释怎么取消任务']) {
		test(`foreground: ${text}`, () => assert.equal(routeSuperAgentRequest(text, false), 'local'));
	}
	for (const text of ['实现前后端完整功能，并补充测试', 'Build an end-to-end authentication feature', '/background Implement the feature']) {
		test(`background: ${text}`, () => assert.equal(routeSuperAgentRequest(text, false), 'submit'));
	}
	for (const [text, route] of [['暂停任务', 'pause'], ['cancel task', 'cancel'], ['查看进度', 'status'], ['恢复任务', 'resume'], ['另外加上测试', 'followup'], ['Also preserve compatibility', 'followup'], ['把按钮改成蓝色', 'followup'], ['Add regression tests', 'followup']] as const) {
		test(`existing task: ${text}`, () => assert.equal(routeSuperAgentRequest(text, true), route));
	}
	test('a followup cannot start a task without an existing owner', () => assert.equal(routeSuperAgentRequest('另外加上测试', false), 'local'));
	test('background selection reports only observed loading, including none', () => {
		assert.ok(formatSuperAgentSelections({ handled: true }).includes('Skill：无'));
		const summary = formatSuperAgentSelections({ handled: true, selections: [{ kind: 'skill', name: 'regression', reason: 'verify the bug' }, { kind: 'agent-profile', name: 'reviewer' }] });
		assert.ok(summary.includes('regression')); assert.ok(summary.includes('reviewer')); assert.ok(summary.includes('不代表启动了额外子代理'));
	});
});
