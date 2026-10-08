/*---------------------------------------------------------------------------------------------
 *  Mobius — mode picker subtitle and routing for Agent / Game / Chip / PPT
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { observableValue } from '../../../../../base/common/observable.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ChatMode, IChatMode } from '../../../chat/common/chatModes.js';
import { ChatModeKind } from '../../../chat/common/constants.js';
import { getMobiusModePickerDetailLine, inferMobiusModeFromPrompt } from '../../browser/continueMobiusModeRouting.js';
import { isMobiusAgentMode, isMobiusPptMode } from '../../browser/continueMobiusModeIcons.js';

suite('MobiusModeRouting', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('builtin Agent is recognized and has a subtitle', () => {
		assert.strictEqual(isMobiusAgentMode(ChatMode.Agent), true);
		const detail = getMobiusModePickerDetailLine(ChatMode.Agent);
		assert.strictEqual(detail, 'General coding · no auto Godot');
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

	test('inferMobiusModeFromPrompt routes PPT keywords', () => {
		const resultZh = inferMobiusModeFromPrompt('帮我做一份关于量子计算的PPT幻灯片');
		assert.deepStrictEqual(resultZh, { mode: 'ppt', reason: 'ppt-keywords' });

		const resultEn = inferMobiusModeFromPrompt('Create a 10-page presentation slide deck for investors');
		assert.deepStrictEqual(resultEn, { mode: 'ppt', reason: 'ppt-keywords' });
	});
});
