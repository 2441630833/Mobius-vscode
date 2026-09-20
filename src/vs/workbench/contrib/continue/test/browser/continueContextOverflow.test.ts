/*---------------------------------------------------------------------------------------------
 *  Mobius — context-window overflow detection & history pruning for Continue agents
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ChatMessageRole, IChatMessage } from '../../../chat/common/languageModels.js';
import { isContextOverflowError, pruneHistoryForContext } from '../../browser/continueChatAgent.js';

suite('Continue context overflow handling', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('isContextOverflowError matches provider 400 phrasings, not unrelated errors', () => {
		assert.ok(isContextOverflowError(
			"litellm.ContextWindowExceededError: This model's maximum context length is 200000 tokens. However, your messages resulted in 210000 tokens.",
		));
		assert.ok(isContextOverflowError('context_length_exceeded: 131072'));
		assert.ok(isContextOverflowError('prompt is too long: 210000 tokens > 200000 maximum'));
		assert.ok(!isContextOverflowError('HTTP 429 TPM rate limit exceeded'));
		assert.ok(!isContextOverflowError('Canceled'));
	});

	test('pruneHistoryForContext keeps system + newest turns and drops the oldest', () => {
		const big = 'x'.repeat(8_000);
		const messages: IChatMessage[] = [
			{ role: ChatMessageRole.System, content: [{ type: 'text', value: 'system prompt' }] },
			{ role: ChatMessageRole.User, content: [{ type: 'text', value: `old question ${big}` }] },
			{ role: ChatMessageRole.Assistant, content: [{ type: 'text', value: `old answer ${big}` }] },
			{ role: ChatMessageRole.User, content: [{ type: 'text', value: `recent question ${big}` }] },
			{ role: ChatMessageRole.Assistant, content: [{ type: 'text', value: `recent answer ${big}` }] },
		];
		// ~16k char budget (each turn is 8k) => must drop the oldest non-system turns.
		const pruned = pruneHistoryForContext(messages, 6_000, 2_000);
		assert.strictEqual(pruned[0].role, ChatMessageRole.System);
		const joined = JSON.stringify(pruned);
		assert.ok(joined.includes('recent answer'), 'newest turn must survive');
		assert.ok(!joined.includes('old question'), 'oldest turn must be dropped');
	});

	test('pruneHistoryForContext never starts the history with an orphaned tool_result', () => {
		const big = 'y'.repeat(6_000);
		const messages: IChatMessage[] = [
			{ role: ChatMessageRole.System, content: [{ type: 'text', value: 'system' }] },
			{ role: ChatMessageRole.Assistant, content: [{ type: 'text', value: big }] },
			{ role: ChatMessageRole.User, content: [{ type: 'tool_result', toolCallId: 'a', value: [{ type: 'text', value: big }] }] },
			{ role: ChatMessageRole.User, content: [{ type: 'text', value: `please continue ${big}` }] },
		];
		// ~13k char budget: keeps the newest text + tool_result, drops the leading assistant
		// message, which would otherwise orphan the tool_result at the head of history.
		const pruned = pruneHistoryForContext(messages, 4_250, 1_000);
		assert.strictEqual(pruned[0].role, ChatMessageRole.System);
		const firstNonSystem = pruned[1];
		const parts = Array.isArray(firstNonSystem?.content) ? firstNonSystem.content : [];
		assert.ok(
			!parts.some(p => p && p.type === 'tool_result'),
			'history must not start with an orphaned tool_result',
		);
	});

	test('pruneHistoryForContext truncates oversized single tool results', () => {
		const huge = 'z'.repeat(50_000);
		const messages: IChatMessage[] = [
			{ role: ChatMessageRole.System, content: [{ type: 'text', value: 'system' }] },
			{ role: ChatMessageRole.Assistant, content: [{ type: 'tool_use', name: 'read_file', toolCallId: 'a', parameters: {} }] },
			{ role: ChatMessageRole.User, content: [{ type: 'tool_result', toolCallId: 'a', value: [{ type: 'text', value: huge }] }] },
		];
		const pruned = pruneHistoryForContext(messages, 1_000_000, 4_096);
		const text = JSON.stringify(pruned);
		assert.ok(text.includes('[truncated]'), 'oversized tool result must be truncated');
		assert.ok(!text.includes(huge), 'the 50k tool result must not survive intact');
	});
});
