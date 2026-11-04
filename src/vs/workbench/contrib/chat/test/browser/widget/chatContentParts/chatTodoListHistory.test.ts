/*---------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import { URI } from '../../../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../../base/test/common/utils.js';
import { StorageScope } from '../../../../../../../platform/storage/common/storage.js';
import { Memento } from '../../../../../../common/memento.js';
import { TestStorageService } from '../../../../../../test/common/workbenchTestServices.js';
import { workbenchInstantiationService } from '../../../../../../test/browser/workbenchTestServices.js';
import { IChatContentPartRenderContext } from '../../../../browser/widget/chatContentParts/chatContentParts.js';
import { ChatToolInvocationPart } from '../../../../browser/widget/chatContentParts/toolInvocationParts/chatToolInvocationPart.js';
import { IChatToolInvocationSerialized } from '../../../../common/chatService/chatService.js';
import { ChatTodoListService, IChatTodoListService } from '../../../../common/tools/chatTodoListService.js';

suite('Todo history rendering', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	setup(() => Memento.clear(StorageScope.WORKSPACE));
	teardown(() => Memento.clear(StorageScope.WORKSPACE));
	test('remounting old tool cards cannot overwrite current, other-session or cleared persisted todos', () => {
		const storage = store.add(new TestStorageService());
		const todos = store.add(new ChatTodoListService(storage));
		const session = URI.parse('test://session/current');
		const other = URI.parse('test://session/other');
		const current = [{ id: 1, title: 'Current request verified', status: 'completed' as const }];
		todos.setTodos(session, current);
		todos.setTodos(other, [{ id: 1, title: 'Other request', status: 'in-progress' }]);
		const instantiation = workbenchInstantiationService(undefined, store);
		instantiation.stub(IChatTodoListService, todos);
		const old: IChatToolInvocationSerialized = {
			kind: 'toolInvocationSerialized', toolId: 'manage_todo_list', toolCallId: 'old-call',
			presentation: undefined, invocationMessage: ' ', pastTenseMessage: ' ', originMessage: undefined,
			isConfirmed: true, isComplete: true, source: undefined,
			toolSpecificData: { kind: 'todoList', todoList: [{ id: '1', title: 'Old request', status: 'in-progress' }] }
		};
		const remount = () => store.add(instantiation.createInstance(ChatToolInvocationPart, old,
			{ element: { sessionResource: session } } as IChatContentPartRenderContext,
			undefined!, undefined!, undefined!, () => 500, undefined, 0));
		remount();
		assert.deepStrictEqual(todos.getTodos(session), current);
		assert.strictEqual(todos.getTodos(other)[0].title, 'Other request');
		Memento.clear(StorageScope.WORKSPACE); // Simulate reopening from local storage.
		const reopened = store.add(new ChatTodoListService(storage));
		assert.deepStrictEqual(reopened.getTodos(session), current);
		reopened.setTodos(session, []);
		remount();
		assert.deepStrictEqual(reopened.getTodos(session), []);
	});
});
