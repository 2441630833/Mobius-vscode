import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { buildChatMessages, CURRENT_REQUEST_PRIORITY } from '../../browser/continueChatAgent.js';

suite('Continue current request priority', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	test('keeps current request intact and applies priority after contextual guidance', () => {
		const prompt = 'Update the existing approval tab. Preserve our theme; do not create a mockup.';
		const messages = buildChatMessages([], prompt, 'Agent system', 'Optional catalog', ['<skill-reference>design</skill-reference>']);
		const text = (message: typeof messages[number]) => message.content.map(p => p.type === 'text' ? p.value : '').join('');
		assert.ok(text(messages[0]).endsWith(CURRENT_REQUEST_PRIORITY));
		assert.ok(text(messages[messages.length - 1]).endsWith(prompt));
		assert.ok(!text(messages[messages.length - 1]).includes('<execution-override>'));
	});
	test('CURRENT_REQUEST_PRIORITY explicitly instructs response based primarily on user request', () => {
		assert.ok(CURRENT_REQUEST_PRIORITY.includes('Base your response primarily on the user request'));
		assert.ok(CURRENT_REQUEST_PRIORITY.includes('never on automatically routed skills'));
	});
	test('buildChatMessages includes eccAdvisory in user message before user prompt', () => {
		const prompt = 'Fix button color';
		const advisory = '<ecc-advisory source="preflight">\nDetected stack: React\n</ecc-advisory>';
		const messages = buildChatMessages([], prompt, 'Agent system', undefined, [], undefined, undefined, undefined, false, false, true, true, advisory);
		const userMsg = messages[messages.length - 1];
		const userText = userMsg.content.map(p => p.type === 'text' ? p.value : '').join('');
		assert.ok(userText.includes(advisory));
		assert.ok(userText.endsWith(prompt));
	});
});
