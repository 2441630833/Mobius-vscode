/*---------------------------------------------------------------------------------------------
 *  Mobius — mode picker subtitle and routing for Agent / Game / Chip / PPT
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { observableValue } from '../../../../../base/common/observable.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ChatMode, IChatMode } from '../../../chat/common/chatModes.js';
import { ChatModeKind } from '../../../chat/common/constants.js';
import { getMobiusChatModes, getMobiusModePickerDetailLine, inferMobiusModeFromPrompt, normalizeMobiusChatMode } from '../../browser/continueMobiusModeRouting.js';
import { isMobiusAgentMode, isMobiusPptMode } from '../../browser/continueMobiusModeIcons.js';

suite('MobiusModeRouting', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('getMobiusChatModes returns only default Agent mode', () => {
		const modes = getMobiusChatModes();
		assert.strictEqual(modes.length, 1);
		assert.strictEqual(modes[0], ChatMode.Agent);
	});

	test('normalizeMobiusChatMode maps specialized modes to Agent', () => {
		const dummyPptMode = {
			id: 'Continue.continue.ppt',
			name: observableValue('name', 'PPT'),
		} as unknown as IChatMode;
		assert.strictEqual(normalizeMobiusChatMode(dummyPptMode), ChatMode.Agent);

		const dummyGameMode = {
			id: 'Continue.continue.game',
			name: observableValue('name', 'Game'),
		} as unknown as IChatMode;
		assert.strictEqual(normalizeMobiusChatMode(dummyGameMode), ChatMode.Agent);
	});

	test('builtin Agent is recognized and has a unified smart routing subtitle', () => {
		assert.strictEqual(isMobiusAgentMode(ChatMode.Agent), true);
		const detail = getMobiusModePickerDetailLine(ChatMode.Agent);
		assert.strictEqual(detail, 'Unified agent · smart routing');
	});

	test('PPT mode is recognized and has a subtitle', () => {
		const dummyPptMode = {
			id: 'Continue.continue.ppt',
			name: observableValue('name', 'PPT'),
			label: observableValue('label', 'PPT'),
			description: observableValue('description', 'Presentation design'),
			kind: ChatModeKind.Agent,
			icon: observableValue('icon', undefined),
			isDefault: observableValue('isDefault', false),
			instructions: observableValue('instructions', undefined),
			modeInstructions: observableValue('modeInstructions', undefined),
		} as unknown as IChatMode;
		assert.strictEqual(isMobiusPptMode(dummyPptMode), true);
		const detail = getMobiusModePickerDetailLine(dummyPptMode);
		assert.strictEqual(detail, 'Make presentations · slide design');
	});

	test('inferMobiusModeFromPrompt routes slash /ppt', () => {
		const result = inferMobiusModeFromPrompt('/ppt 制作5页汇报大纲');
		assert.deepStrictEqual(result, { mode: 'ppt', reason: 'slash-override' });
	});

	test('inferMobiusModeFromPrompt routes PPT keywords and semantic intent', () => {
		const resultZh = inferMobiusModeFromPrompt('帮我做一份关于量子计算的PPT幻灯片');
		assert.strictEqual(resultZh?.mode, 'ppt');

		const resultEn = inferMobiusModeFromPrompt('Create a 10-page presentation slide deck for investors');
		assert.strictEqual(resultEn?.mode, 'ppt');

		const resultParaphrased = inferMobiusModeFromPrompt('帮我准备明天向高管汇报的项目进展材料和演示文稿');
		assert.strictEqual(resultParaphrased?.mode, 'ppt');

		const resultJiaopian = inferMobiusModeFromPrompt('总结这个季度的核心指标，做成演讲胶片和大纲');
		assert.strictEqual(resultJiaopian?.mode, 'ppt');
	});

	test('inferMobiusModeFromPrompt semantically routes game requests', () => {
		const result = inferMobiusModeFromPrompt('在game-dev里给Star Catcher加一颗会发光的奖励星星');
		assert.strictEqual(result?.mode, 'game');

		const resultPhysics = inferMobiusModeFromPrompt('修改角色物理刚体碰撞体积，增加弹性跳跃效果');
		assert.strictEqual(resultPhysics?.mode, 'game');
	});

	test('inferMobiusModeFromPrompt semantically routes chip requests', () => {
		const result = inferMobiusModeFromPrompt('在chip-design里检查FPGA物理采样器工具链并执行fpga_detect');
		assert.strictEqual(result?.mode, 'chip');

		const resultVerilog = inferMobiusModeFromPrompt('编写Verilog硬件描述语言并用verilator进行RTL前仿和波形验证');
		assert.strictEqual(resultVerilog?.mode, 'chip');
	});

	test('inferMobiusModeFromPrompt negative guardrails keep coding tasks in agent mode', () => {
		// Parsing pptx file with python is general coding, not presentation generation
		const resultPythonPptx = inferMobiusModeFromPrompt('写一个Python脚本解析和读取pptx文件中的表格数据');
		assert.strictEqual(resultPythonPptx?.mode ?? 'agent', 'agent');

		// Web slide component is frontend coding
		const resultCssSlide = inferMobiusModeFromPrompt('用CSS3实现网页幻灯片卡片翻转的动效组件');
		assert.strictEqual(resultCssSlide?.mode ?? 'agent', 'agent');

		// Technical theory question about FPGA vs GPU
		const resultTheory = inferMobiusModeFromPrompt('解释一下FPGA和GPU在算力架构上的核心差异与原理');
		assert.strictEqual(resultTheory?.mode ?? 'agent', 'agent');
	});
});
