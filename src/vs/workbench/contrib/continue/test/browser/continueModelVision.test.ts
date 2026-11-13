/*---------------------------------------------------------------------------------------------
 *  Mobius — unit tests for Continue model image-input capability resolution
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { parseConfigYamlModels, resolveModelVision, declaresImageInput, declaresTextOnly, normalizeCapabilities } from '../../browser/continueModelConfig.js';

suite('Continue model vision capability', () => {

	const yaml = [
		'models:',
		'  - name: ali',
		'    provider: openai',
		'    model: deepseek-v4.1-flash-1017',
		'    apiBase: https://ali.example.com/v1',
		'    apiKey: sk-ali',
		'    capabilities:',
		'      - tool_use',
		'      - image_input',
		'  - name: volcano',
		'    provider: openai',
		'    model: ark-code-latest',
		'    apiBase: https://volcano.example.com/v1',
		'    capabilities:',
		'      - tool_use',
		'    apiKey: sk-volcano',
		'  - name: bare',
		'    provider: openai',
		'    model: some-proxy-model-7b',
		'    apiBase: https://bare.example.com/v1',
		'    apiKey: sk-bare',
	].join('\n');

	test('nested capabilities list must not truncate the entry being parsed', () => {
		const models = parseConfigYamlModels(yaml);
		const volcano = models.find(m => m.name === 'volcano');
		assert.ok(volcano, 'volcano entry was dropped by the yaml parser');
		assert.strictEqual(volcano!.apiKey, 'sk-volcano', 'keys after a nested list must be kept');
		assert.deepStrictEqual(volcano!.capabilities, ['tool_use']);
	});

	test('declared image_input enables vision regardless of the model name', () => {
		const models = parseConfigYamlModels(yaml);
		const ali = models.find(m => m.name === 'ali');
		assert.ok(ali);
		assert.ok(declaresImageInput(ali!.capabilities));
		assert.strictEqual(resolveModelVision(ali), true);
	});

	test('a non-image capability inventory does not veto images (server is the authority)', () => {
		const models = parseConfigYamlModels(yaml);
		// `capabilities: [tool_use]` says nothing about image support: ali/volcano-style gateways still
		// accept image_url parts. Dropping the attachment locally and detouring into OCR is the bug.
		assert.strictEqual(resolveModelVision(models.find(m => m.name === 'volcano')), true);
	});

	test('explicit text_only token or missing entry still blocks detection', () => {
		assert.strictEqual(resolveModelVision({ model: 'mystery-model', capabilities: ['text_only'] }), false);
	});

	test('undeclared custom gateway is not blocked client-side', () => {
		const models = parseConfigYamlModels(yaml);
		assert.strictEqual(resolveModelVision(models.find(m => m.name === 'bare')), true);
	});

	test('explicit per-model switch wins over everything', () => {
		assert.strictEqual(resolveModelVision({ model: 'gpt-4o', imageInput: false }), false);
		assert.strictEqual(resolveModelVision({ model: 'ark-code-latest', capabilities: ['tool_use'], imageInput: true }), true);
		assert.strictEqual(resolveModelVision({ model: 'gpt-4o', capabilities: ['text_only'] }), false);
	});

	test('flow-style capability arrays and inputModalities are understood', () => {
		assert.ok(declaresImageInput('[tool_use, image_input]'));
		assert.ok(declaresImageInput(['image_url']));
		assert.ok(!declaresTextOnly('[tool_use, image_input]'));
		assert.deepStrictEqual(normalizeCapabilities('tool_use, image_input'), ['tool_use', 'image_input']);
	});

	test('known vision families are still recognised', () => {
		assert.strictEqual(resolveModelVision({ model: 'gemma-3-27b-it' }), true);
		assert.strictEqual(resolveModelVision({ model: 'qwen2.5-vl-72b-instruct' }), true);
	});
});