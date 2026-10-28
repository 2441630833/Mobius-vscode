import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { createStreamContentParser, parseOpenAIStreamBuffer } from '../../browser/continueLanguageModelProvider.js';

suite('Continue compatible provider stream', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	function parse(events: unknown[]): string {
		const parser = createStreamContentParser();
		const state = { hasContentDelta: false, hasReasoningDelta: false };
		const tools = new Map<number, { id: string; name: string; arguments: string }>();
		const parts = events.flatMap(event => parseOpenAIStreamBuffer(`data: ${JSON.stringify(event)}\n`, tools, parser, state).parts);
		parts.push(...parser.flush());
		return parts.filter(p => p.type === 'text').map(p => p.value).join('');
	}

	test('reads a complete message without deltas', () => {
		assert.strictEqual(parse([{ choices: [{ message: { content: 'Final answer' } }] }]), 'Final answer');
	});

	test('does not repeat a final message after streamed deltas', () => {
		assert.strictEqual(parse([
			{ choices: [{ delta: { content: 'Final ' } }] },
			{ choices: [{ delta: { content: 'answer' } }] },
			{ choices: [{ message: { content: 'Final answer' } }] },
		]), 'Final answer');
	});
});
