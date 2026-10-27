/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { URI } from '../../../../base/common/uri.js';
import type { IChatTodo, IChatTodoListService } from '../../chat/common/tools/chatTodoListService.js';

/** Publish a fallback before any asynchronous preflight or model work. Never reuse session todos. */
export function initializeRequestTodos(service: IChatTodoListService, session: URI, message: string): boolean {
	const title = message.trim();
	if (!title) {
		return false;
	}
	service.setTodos(session, [{ id: 1, title, status: 'in-progress' }]);
	return true;
}

/** A successful read does not count as planning; setTodos replaces the stored array on writes. */
export function didWriteRequestTodos(ok: boolean, before: IChatTodo[], after: IChatTodo[]): boolean {
	return ok && before !== after && after.length > 0;
}

export const REQUEST_TODO_INSTRUCTIONS = 'The IDE initialized a fallback todo from the current request. Your FIRST tool call MUST be manage_todo_list to replace it with 1-7 actionable items in the user\'s language, proportional to the task (one item is enough for a simple request). Base every item on the FULL latest user request and its constraints, not ECC recommendations, recalled memories, or unrelated older tasks. Use history only to resolve explicit follow-ups such as "continue"; retain unfinished work only when the current request continues it. Mark one item in-progress and then execute the work. Update progress after each step. This also applies to short requests, searches and documentation edits.';
