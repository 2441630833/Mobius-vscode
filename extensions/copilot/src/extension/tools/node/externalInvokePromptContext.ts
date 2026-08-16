/*---------------------------------------------------------------------------------------------
 *  Mobius — synthesize IBuildPromptContext when tools are invoked outside Copilot's agent loop
 *  (e.g. Continue Agent via vscode.lm / ILanguageModelToolsService.invokeTool).
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ChatResponseStreamImpl } from '../../../util/common/chatResponseStreamImpl';
import { URI } from '../../../util/vs/base/common/uri';
import { ChatResponseTextEditPart, ChatResponseWorkspaceEditPart, TextEdit } from '../../../vscodeTypes';
import { ChatVariablesCollection } from '../../prompt/common/chatVariablesCollection';
import { IBuildPromptContext } from '../../prompt/common/intents';

function asTextEditArray(edits: TextEdit | readonly TextEdit[] | undefined): TextEdit[] {
	if (!edits) {
		return [];
	}
	return Array.isArray(edits) ? [...edits] : [edits as TextEdit];
}

/** Streams we created for external invoke — only these should be finalize()'d by edit tools. */
const externalInvokeStreams = new WeakSet<object>();

function toVscodeUri(uri: URI | vscode.Uri): vscode.Uri {
	if (uri instanceof vscode.Uri) {
		return uri;
	}
	return vscode.Uri.parse(uri.toString());
}

async function ensureParentDirectory(uri: vscode.Uri): Promise<void> {
	const parent = vscode.Uri.joinPath(uri, '..');
	if (parent.toString() === uri.toString()) {
		return;
	}
	try {
		await vscode.workspace.fs.stat(parent);
	} catch {
		await vscode.workspace.fs.createDirectory(parent);
	}
}

/**
 * When creating a brand-new file, WorkspaceEdit createFile + TextEdit.insert(0,0) is flaky
 * outside Copilot's chat edit session. Prefer a direct writeFile with the insert/replace text.
 */
function fullContentFromNewFileEdits(edits: TextEdit[]): string | undefined {
	if (edits.length !== 1) {
		return undefined;
	}
	const edit = edits[0];
	const range = edit?.range;
	const newText = typeof edit?.newText === 'string' ? edit.newText : undefined;
	if (newText === undefined || !range) {
		return undefined;
	}
	// insert at start, or replace from start (empty / stale in-memory doc)
	if (range.start.line === 0 && range.start.character === 0) {
		return newText;
	}
	return undefined;
}

async function flushApplyJobs(jobs: Promise<void>[]): Promise<void> {
	const settled = await Promise.allSettled(jobs);
	jobs.length = 0;
	const firstError = settled.find((r): r is PromiseRejectedResult => r.status === 'rejected');
	if (firstError) {
		throw firstError.reason;
	}
}

function isTextEditPart(part: unknown): part is ChatResponseTextEditPart {
	if (part instanceof ChatResponseTextEditPart) {
		return true;
	}
	// Duck-type: some bundling paths break instanceof across vscodeTypes re-exports.
	const p = part as { uri?: { toString?: () => string }; edits?: unknown; isDone?: boolean };
	return !!p && typeof p.uri?.toString === 'function' && ('edits' in p || 'isDone' in p);
}

/**
 * Build a minimal prompt context whose ChatResponseStream applies text edits via
 * WorkspaceEdit — so replace/create/applyPatch tools work when `resolveInput` was
 * never called (Continue Agent / direct lm.invokeTool).
 */
export function createExternalInvokePromptContext(requestId?: string): IBuildPromptContext {
	const pendingByUri = new Map<string, { uri: URI | vscode.Uri; edits: TextEdit[] }>();
	const applyJobs: Promise<void>[] = [];

	const applyUri = (uri: URI | vscode.Uri, edits: TextEdit[]): void => {
		if (!edits.length) {
			return;
		}
		applyJobs.push((async () => {
			const vscodeUri = toVscodeUri(uri);
			await ensureParentDirectory(vscodeUri);

			let exists = true;
			try {
				await vscode.workspace.fs.stat(vscodeUri);
			} catch {
				exists = false;
			}

			if (!exists) {
				const fullContent = fullContentFromNewFileEdits(edits);
				if (fullContent !== undefined) {
					await vscode.workspace.fs.writeFile(vscodeUri, new TextEncoder().encode(fullContent));
					return;
				}
			}

			const we = new vscode.WorkspaceEdit();
			if (!exists) {
				we.createFile(vscodeUri, { ignoreIfExists: true });
			}
			we.set(vscodeUri, edits);
			const ok = await vscode.workspace.applyEdit(we);
			if (!ok) {
				// Last resort for create: flatten inserts into a writeFile.
				if (!exists) {
					const joined = edits.map(e => e.newText ?? '').join('');
					await vscode.workspace.fs.writeFile(vscodeUri, new TextEncoder().encode(joined));
					return;
				}
				throw new Error(`Failed to apply workspace edit to ${vscodeUri.fsPath}`);
			}
		})());
	};

	const stream = new ChatResponseStreamImpl(
		(part) => {
			if (isTextEditPart(part)) {
				const key = part.uri.toString();
				let bucket = pendingByUri.get(key);
				if (!bucket) {
					bucket = { uri: part.uri, edits: [] };
					pendingByUri.set(key, bucket);
				}
				if (part.isDone) {
					pendingByUri.delete(key);
					applyUri(bucket.uri, bucket.edits);
				} else {
					bucket.edits.push(...asTextEditArray(part.edits));
				}
				return;
			}

			if (part instanceof ChatResponseWorkspaceEditPart) {
				for (const edit of part.edits) {
					const oldResource = (edit as { oldResource?: vscode.Uri }).oldResource;
					const newResource = (edit as { newResource?: vscode.Uri }).newResource;
					if (oldResource && !newResource) {
						applyJobs.push(
							vscode.workspace.fs.delete(oldResource, { recursive: true, useTrash: true }).then(() => undefined),
						);
					} else if (!oldResource && newResource) {
						applyJobs.push((async () => {
							const target = toVscodeUri(newResource);
							await ensureParentDirectory(target);
							const we = new vscode.WorkspaceEdit();
							we.createFile(target, { ignoreIfExists: true });
							const ok = await vscode.workspace.applyEdit(we);
							if (!ok) {
								throw new Error(`Failed to create ${target.fsPath}`);
							}
						})());
					} else if (oldResource && newResource) {
						const we = new vscode.WorkspaceEdit();
						we.renameFile(oldResource, newResource, { overwrite: true });
						applyJobs.push(vscode.workspace.applyEdit(we).then(ok => {
							if (!ok) {
								throw new Error(`Failed to rename ${oldResource.fsPath}`);
							}
						}));
					}
				}
			}
		},
		() => { /* clearToPreviousToolInvocation — no-op for external invoke */ },
		async () => {
			for (const bucket of pendingByUri.values()) {
				applyUri(bucket.uri, bucket.edits);
			}
			pendingByUri.clear();
			await flushApplyJobs(applyJobs);
		},
	);
	externalInvokeStreams.add(stream);

	return {
		query: '',
		history: [],
		chatVariables: new ChatVariablesCollection([]),
		stream,
		requestId,
	};
}

/** Ensure edit tools have a promptContext.stream even when Copilot's agent loop did not call resolveInput. */
export function ensureExternalInvokePromptContext(
	existing: IBuildPromptContext | undefined,
	requestId?: string,
): IBuildPromptContext {
	if (existing?.stream) {
		return existing;
	}
	const synthesized = createExternalInvokePromptContext(requestId ?? existing?.requestId);
	if (existing) {
		return {
			...existing,
			stream: synthesized.stream,
			chatVariables: existing.chatVariables ?? synthesized.chatVariables,
			history: existing.history ?? synthesized.history,
			query: existing.query ?? '',
		};
	}
	return synthesized;
}

export function isExternalInvokePromptContext(promptContext: IBuildPromptContext | undefined): boolean {
	const stream = promptContext?.stream as object | undefined;
	return !!stream && externalInvokeStreams.has(stream);
}

/**
 * Await pending WorkspaceEdit applications from a synthesized external stream.
 * No-op for real Copilot agent streams (must not finalize the chat response).
 */
export async function finalizeExternalInvokeStream(promptContext: IBuildPromptContext | undefined): Promise<void> {
	const stream = promptContext?.stream as ChatResponseStreamImpl | undefined;
	if (!stream || !externalInvokeStreams.has(stream) || typeof stream.finalize !== 'function') {
		return;
	}
	await stream.finalize();
}
