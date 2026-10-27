/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import type { IChatTodo, IChatTodoListService } from '../../../chat/common/tools/chatTodoListService.js';
import { didWriteRequestTodos, initializeRequestTodos } from '../../browser/continueRequestTodos.js';

suite('Continue request todos', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	const session = URI.parse('test://request-todos');
	function fixture() {
		const lists = new Map<string, IChatTodo[]>();
		return {
			getTodos: (uri: URI) => lists.get(uri.toString()) ?? [],
			setTodos: (uri: URI, todos: IChatTodo[]) => { lists.set(uri.toString(), todos); },
		} as IChatTodoListService;
	}

	for (const status of ['completed', 'in-progress', 'not-started'] as const) {
		test(`new request replaces ${status} todos from previous request`, () => {
			const service = fixture();
			service.setTodos(session, [{ id: 1, title: 'Old unrelated task', status }]);
			assert.strictEqual(initializeRequestTodos(service, session, 'Fix login'), true);
			assert.deepStrictEqual(service.getTodos(session), [{ id: 1, title: 'Fix login', status: 'in-progress' }]);
		});
	}

	for (const prompt of ['改 README', 'Search weather', 'hi', '继续修复上面的登录问题', 'x'.repeat(500) + '\nDo not change the API']) {
		test(`creates fallback preserving full prompt: ${prompt.slice(0, 30)}`, () => {
			const service = fixture();
			assert.ok(initializeRequestTodos(service, session, prompt));
			assert.strictEqual(service.getTodos(session)[0].title, prompt);
		});
	}

	test('does not touch other sessions or initialize empty requests', () => {
		const service = fixture();
		initializeRequestTodos(service, session, 'Existing task');
		assert.strictEqual(initializeRequestTodos(service, session, '  '), false);
		initializeRequestTodos(service, URI.parse('test://other'), 'Other task');
		assert.strictEqual(service.getTodos(session)[0].title, 'Existing task');
	});

	test('only successful nonempty writes satisfy initialization, including identical replacement', () => {
		const service = fixture();
		initializeRequestTodos(service, session, 'Fix login');
		const before = service.getTodos(session);
		assert.strictEqual(didWriteRequestTodos(true, before, service.getTodos(session)), false);
		assert.strictEqual(didWriteRequestTodos(false, before, [...before]), false);
		assert.strictEqual(didWriteRequestTodos(true, before, []), false);
		service.setTodos(session, [...before]);
		assert.strictEqual(didWriteRequestTodos(true, before, service.getTodos(session)), true);
	});
});
