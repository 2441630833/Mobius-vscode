/*---------------------------------------------------------------------------------------------
 *  Mobius — Continue language model provider for Agents / local chat sessions
 *--------------------------------------------------------------------------------------------*/

import { AsyncIterableObject } from '../../../../base/common/async.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { listenStream } from '../../../../base/common/stream.js';
import { ExtensionIdentifier } from '../../../../platform/extensions/common/extensions.js';
import { IRequestService, retryAfterFromHeaders } from '../../../../platform/request/common/request.js';
import {
	ChatMessageRole,
	IChatMessage,
	IChatResponsePart,
	IChatResponseTextPart,
	IChatResponseThinkingPart,
	IChatResponseToolUsePart,
	ILanguageModelChatMetadataAndIdentifier,
	ILanguageModelChatProvider,
	ILanguageModelChatRequestOptions,
	ILanguageModelChatResponse,
} from '../../chat/common/languageModels.js';
import { ChatAgentLocation } from '../../chat/common/constants.js';
import { ContinueModelEntry, modelSupportsVision, pickCloudModels } from './continueModelConfig.js';

export const CONTINUE_LM_VENDOR = 'continue';
export const CONTINUE_LM_VENDOR_DISPLAY = 'Continue';

const CLOUD_CHAT_TIMEOUT_MS = 120_000;

export class ContinueLanguageModelProvider extends Disposable implements ILanguageModelChatProvider {
	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	private _models: ContinueModelEntry[] = [];

	constructor(
		private readonly _extensionId: ExtensionIdentifier,
		private readonly _requestService: IRequestService,
	) {
		super();
	}

	updateModels(models: readonly ContinueModelEntry[]): void {
		this._models = pickCloudModels(models);
		this._onDidChange.fire();
	}

	async provideLanguageModelChatInfo(_options: unknown, _token: CancellationToken): Promise<ILanguageModelChatMetadataAndIdentifier[]> {
		return this._models.map((entry, index) => {
			const id = entry.name;
			const isDefault = index === 0;
			return {
				identifier: `${CONTINUE_LM_VENDOR}:${id}`,
				metadata: {
					extension: this._extensionId,
					name: entry.profileId ? `${entry.profileId} (${entry.model})` : entry.name,
					id,
					vendor: CONTINUE_LM_VENDOR,
					version: '1.0.0',
					family: entry.model,
					detail: entry.profileId ? `Profile: ${entry.profileId}` : 'Cloud',
					maxInputTokens: 200_000,
					maxOutputTokens: 8192,
					isDefaultForLocation: { [ChatAgentLocation.Chat]: isDefault },
					isUserSelectable: true,
					capabilities: {
						toolCalling: true,
						agentMode: true,
						vision: modelSupportsVision(entry.model),
					},
				},
			};
		});
	}

	async sendChatRequest(
		modelId: string,
		messages: IChatMessage[],
		_from: ExtensionIdentifier | undefined,
		options: ILanguageModelChatRequestOptions,
		token: CancellationToken,
	): Promise<ILanguageModelChatResponse> {
		const entry = this._models.find(m =>
			modelId === m.name
			|| modelId === m.model
			|| modelId === `${CONTINUE_LM_VENDOR}:${m.name}`
			|| modelId === `${CONTINUE_LM_VENDOR}:${m.model}`
			|| (m.profileId !== undefined && modelId === `${CONTINUE_LM_VENDOR}:${m.profileId}/${m.model}`)
			|| (m.profileId !== undefined && modelId === `${m.profileId}/${m.model}`)
		);
		if (!entry) {
			throw new Error(`Continue model '${modelId}' is not configured`);
		}

		const tools = Array.isArray(options['tools']) ? options['tools'] : undefined;
		let bodyObj = buildOpenAiRequestBody(entry, messages, tools, options);
		const url = `${entry.apiBase}/chat/completions`;

		const doRequest = async (body: Record<string, unknown>) => this._requestService.request({
			type: 'POST',
			url,
			callSite: 'ContinueLanguageModelProvider.sendChatRequest',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${entry.apiKey}`,
			},
			data: JSON.stringify(body),
			timeout: CLOUD_CHAT_TIMEOUT_MS,
			disableCache: true,
		}, token);

		let context;
		try {
			context = await doRequest(bodyObj);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			if (/^Offline$/i.test(msg)) {
				throw new Error(
					`Cloud model request failed (Offline). Check your network connection and API key in Settings → Model Provider.`,
				);
			}
			throw err;
		}

		// Some OpenAI-compatible providers reject tool_choice=required — fall back to auto.
		if (
			context.res.statusCode
			&& context.res.statusCode >= 400
			&& bodyObj['tool_choice'] === 'required'
		) {
			const detail = await readErrorBody(context.stream);
			if (/tool_choice|required|invalid/i.test(detail ?? '')) {
				bodyObj = { ...bodyObj, tool_choice: 'auto' };
				try {
					context = await doRequest(bodyObj);
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					throw new Error(msg);
				}
			} else {
				throw new Error(
					detail
						? `Continue model request failed (${context.res.statusCode}): ${detail}`
						: `Continue model request failed (${context.res.statusCode})`,
				);
			}
		}

		if (context.res.statusCode && context.res.statusCode >= 400) {
			const detail = await readErrorBody(context.stream);
			const retryAfter = retryAfterHintFromHeaders(context.res.headers);
			const suffix = retryAfter ? ` retry-after: ${retryAfter}` : '';
			throw new Error(
				detail
					? `Continue model request failed (${context.res.statusCode}): ${detail}${suffix}`
					: `Continue model request failed (${context.res.statusCode})${suffix}`,
			);
		}

		const requestContext = context;
		const stream = new AsyncIterableObject<IChatResponsePart | IChatResponsePart[]>(async emitter => {
			let buffer = '';
			const toolAcc = new Map<number, { id: string; name: string; arguments: string }>();
			const contentParser = createStreamContentParser();
			await new Promise<void>((resolve, reject) => {
				listenStream(requestContext.stream, {
					onData: (chunk: VSBuffer) => {
						buffer += chunk.toString();
						const parsed = parseOpenAIStreamBuffer(buffer, toolAcc, contentParser);
						buffer = parsed.rest;
						for (const part of parsed.parts) {
							emitter.emitOne(part);
						}
					},
					onError: reject,
					onEnd: () => {
						const parsed = parseOpenAIStreamBuffer(buffer + '\n', toolAcc, contentParser);
						for (const part of parsed.parts) {
							emitter.emitOne(part);
						}
						for (const part of contentParser.flush()) {
							emitter.emitOne(part);
						}
						emitAccumulatedToolUses(toolAcc, emitter);
						resolve();
					},
				}, token);
			});
		});

		return {
			stream,
			result: Promise.resolve(undefined),
		};
	}

	async provideTokenCount(_modelId: string, message: string | IChatMessage, _token: CancellationToken): Promise<number> {
		const text = typeof message === 'string'
			? message
			: message.content.filter(p => p.type === 'text').map(p => p.value).join('\n');
		return Math.ceil(text.length / 4);
	}
}

type OpenAIContentPart =
	| { type: 'text'; text: string }
	| { type: 'image_url'; image_url: { url: string } };

type OpenAIMessage =
	| {
		role: 'system' | 'user' | 'assistant';
		content: string | OpenAIContentPart[] | null;
		tool_calls?: OpenAIToolCall[];
		/** Required on DeepSeek V4 / reasoner assistant turns that include tool_calls. */
		reasoning_content?: string;
	}
	| { role: 'tool'; tool_call_id: string; content: string };

type OpenAIToolCall = {
	id: string;
	type: 'function';
	function: { name: string; arguments: string };
};

function encodeDataUrl(mimeType: string, data: Uint8Array): string {
	let binary = '';
	const chunk = 0x8000;
	for (let i = 0; i < data.length; i += chunk) {
		binary += String.fromCharCode(...data.subarray(i, i + chunk));
	}
	return `data:${mimeType};base64,${btoa(binary)}`;
}

/** DeepSeek V4+ requires reasoning_content echoed on assistant turns that used tools. */
function deepSeekNeedsReasoningRoundTrip(entry: ContinueModelEntry): boolean {
	const base = entry.apiBase.toLowerCase();
	const model = entry.model.toLowerCase();
	if (base.includes('deepseek.com')) {
		return true;
	}
	return /deepseek[-/]?(v4|r1|reasoner)/i.test(model);
}

function isDeepSeekApi(entry: ContinueModelEntry): boolean {
	return entry.apiBase.toLowerCase().includes('deepseek.com')
		|| deepSeekNeedsReasoningRoundTrip(entry);
}

function messagesToOpenAI(messages: IChatMessage[], entry: ContinueModelEntry): OpenAIMessage[] {
	const needsReasoningRoundTrip = deepSeekNeedsReasoningRoundTrip(entry);
	const out: OpenAIMessage[] = [];
	for (const message of messages) {
		const textParts: string[] = [];
		const toolCalls: OpenAIToolCall[] = [];
		const toolResults: { toolCallId: string; content: string }[] = [];
		const imageParts: OpenAIContentPart[] = [];
		let reasoningContent = '';

		for (const part of message.content) {
			if (part.type === 'text') {
				textParts.push(part.value);
			} else if (part.type === 'thinking') {
				const value = typeof part.value === 'string' ? part.value : part.value.join('');
				if (value) {
					reasoningContent += value;
				}
			} else if (part.type === 'image_url') {
				const mime = part.value.mimeType;
				const data = part.value.data.buffer;
				if (data?.byteLength) {
					imageParts.push({
						type: 'image_url',
						image_url: { url: encodeDataUrl(mime, data) },
					});
				}
			} else if (part.type === 'tool_use') {
				toolCalls.push({
					id: part.toolCallId,
					type: 'function',
					function: {
						name: part.name,
						arguments: JSON.stringify(part.parameters ?? {}),
					},
				});
			} else if (part.type === 'tool_result') {
				const value = part.value
					.filter(v => v.type === 'text')
					.map(v => (v as { type: 'text'; value: string }).value)
					.join('\n');
				toolResults.push({ toolCallId: part.toolCallId, content: value || (part.isError ? 'Error' : '') });
			}
		}

		if (toolResults.length) {
			for (const result of toolResults) {
				out.push({ role: 'tool', tool_call_id: result.toolCallId, content: result.content });
			}
			continue;
		}

		// Multimodal content: emit OpenAI-style content array with text + image_url parts.
		const hasImages = imageParts.length > 0;
		const contentValue: string | OpenAIContentPart[] = hasImages
			? [
				...(textParts.join('\n') ? [{ type: 'text' as const, text: textParts.join('\n') }] : []),
				...imageParts,
			]
			: textParts.join('\n');

		if (toolCalls.length) {
			const assistantMsg: OpenAIMessage = {
				role: 'assistant',
				content: typeof contentValue === 'string'
					? (contentValue || null)
					: (Array.isArray(contentValue) && contentValue.length === 0 ? null : contentValue),
				tool_calls: toolCalls,
			};
			if (needsReasoningRoundTrip) {
				assistantMsg.reasoning_content = reasoningContent;
			}
			out.push(assistantMsg);
			continue;
		}

		if (typeof contentValue === 'string' && !contentValue && !reasoningContent) {
			continue;
		}
		if (Array.isArray(contentValue) && contentValue.length === 0 && !reasoningContent) {
			continue;
		}
		const plainMsg: OpenAIMessage = {
			role: roleToOpenAI(message.role) as 'system' | 'user' | 'assistant',
			content: contentValue,
		};
		if (needsReasoningRoundTrip && message.role === ChatMessageRole.Assistant && reasoningContent) {
			plainMsg.reasoning_content = reasoningContent;
		}
		out.push(plainMsg);
	}
	return out;
}

function roleToOpenAI(role: ChatMessageRole): string {
	switch (role) {
		case ChatMessageRole.System: return 'system';
		case ChatMessageRole.User: return 'user';
		case ChatMessageRole.Assistant: return 'assistant';
		default: return 'user';
	}
}

function buildOpenAiRequestBody(
	entry: ContinueModelEntry,
	messages: IChatMessage[],
	tools: unknown[] | undefined,
	options: ILanguageModelChatRequestOptions,
): Record<string, unknown> {
	const bodyObj: Record<string, unknown> = {
		model: entry.model,
		messages: messagesToOpenAI(messages, entry),
		stream: true,
	};
	const normalizedTools = normalizeOpenAiTools(tools);
	if (normalizedTools?.length) {
		bodyObj['tools'] = normalizedTools;
		bodyObj['tool_choice'] = options['tool_choice'] ?? 'auto';
		if (isDeepSeekApi(entry)) {
			// DeepSeek interleaves parallel tool-call deltas; disable parallel calls.
			bodyObj['parallel_tool_calls'] = false;
		}
	} else if (options['tool_choice'] === 'none') {
		bodyObj['tool_choice'] = 'none';
	}
	return bodyObj;
}

/** Keep only OpenAI-compatible function tool schemas (drop broken / empty entries). */
function normalizeOpenAiTools(tools: unknown[] | undefined): Array<{
	type: 'function';
	function: { name: string; description?: string; parameters?: Record<string, unknown> };
}> | undefined {
	if (!tools?.length) {
		return undefined;
	}
	const out: Array<{
		type: 'function';
		function: { name: string; description?: string; parameters?: Record<string, unknown> };
	}> = [];
	for (const raw of tools) {
		if (!raw || typeof raw !== 'object') {
			continue;
		}
		const tool = raw as {
			type?: string;
			function?: { name?: string; description?: string; parameters?: Record<string, unknown> };
			name?: string;
			description?: string;
			parameters?: Record<string, unknown>;
		};
		const name = tool.function?.name || tool.name;
		if (!name || typeof name !== 'string') {
			continue;
		}
		out.push({
			type: 'function',
			function: {
				name,
				description: tool.function?.description || tool.description || name,
				parameters: tool.function?.parameters || tool.parameters || {
					type: 'object',
					properties: {},
				},
			},
		});
	}
	return out.length ? out : undefined;
}

async function readErrorBody(stream: Parameters<typeof listenStream>[0]): Promise<string | undefined> {
	try {
		let raw = '';
		await new Promise<void>((resolve, reject) => {
			listenStream(stream, {
				onData: (chunk: VSBuffer) => {
					raw += chunk.toString();
					if (raw.length > 2_000) {
						resolve();
					}
				},
				onError: reject,
				onEnd: () => resolve(),
			}, CancellationToken.None);
		});
		const trimmed = raw.trim();
		if (!trimmed) {
			return undefined;
		}
		try {
			const json = JSON.parse(trimmed) as { error?: string | { message?: string } };
			if (typeof json.error === 'string') {
				return json.error.slice(0, 500);
			}
			if (json.error && typeof json.error === 'object' && typeof json.error.message === 'string') {
				return json.error.message.slice(0, 500);
			}
		} catch {
			// not JSON
		}
		return trimmed.slice(0, 500);
	} catch {
		return undefined;
	}
}

function retryAfterHintFromHeaders(headers: { [key: string]: string | string[] | undefined } | undefined): string | undefined {
	const seconds = retryAfterFromHeaders(headers);
	return typeof seconds === 'number' ? String(seconds) : undefined;
}

function emitAccumulatedToolUses(
	toolAcc: Map<number, { id: string; name: string; arguments: string }>,
	emitter: { emitOne: (part: IChatResponsePart | IChatResponsePart[]) => void },
): void {
	for (const tool of toolAcc.values()) {
		if (!tool.name) {
			continue;
		}
		const parameters = parseStreamedToolArguments(tool.arguments);
		emitter.emitOne({
			type: 'tool_use',
			name: tool.name,
			toolCallId: tool.id || `call_${tool.name}_${Date.now()}`,
			parameters,
		} satisfies IChatResponseToolUsePart);
	}
}

/**
 * Parse streamed tool-call argument JSON. Models often emit unescaped newlines inside
 * string values (esp. write_file contents) which breaks JSON.parse — recover path/contents.
 */
function parseStreamedToolArguments(raw: string): Record<string, unknown> {
	const trimmed = (raw ?? '').trim();
	if (!trimmed) {
		return {};
	}
	try {
		const parsed = JSON.parse(trimmed);
		if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>;
		}
		if (typeof parsed === 'string') {
			return parseStreamedToolArguments(parsed);
		}
	} catch {
		// fall through to repair
	}
	try {
		const repaired = trimmed.replace(/,\s*([}\]])/g, '$1');
		const parsed = JSON.parse(repaired);
		if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>;
		}
	} catch {
		// fall through
	}

	const recovered: Record<string, unknown> = { raw: trimmed };
	const pathMatch = /"(?:path|filepath|filePath|file_path|filename|file)"\s*:\s*"((?:\\.|[^"\\])*)"/i.exec(trimmed);
	if (pathMatch?.[1]) {
		try {
			recovered.path = JSON.parse(`"${pathMatch[1]}"`);
			recovered.filePath = recovered.path;
			recovered.filepath = recovered.path;
		} catch {
			recovered.path = pathMatch[1];
			recovered.filePath = pathMatch[1];
			recovered.filepath = pathMatch[1];
		}
	}

	const contentKey = /"(?:contents|content|body|text|code)"\s*:\s*"/i.exec(trimmed);
	if (contentKey) {
		const start = contentKey.index + contentKey[0].length;
		let out = '';
		let i = start;
		while (i < trimmed.length) {
			const ch = trimmed[i];
			if (ch === '\\' && i + 1 < trimmed.length) {
				const next = trimmed[i + 1];
				if (next === 'n') { out += '\n'; i += 2; continue; }
				if (next === 'r') { out += '\r'; i += 2; continue; }
				if (next === 't') { out += '\t'; i += 2; continue; }
				if (next === '"' || next === '\\' || next === '/') { out += next; i += 2; continue; }
				out += next;
				i += 2;
				continue;
			}
			if (ch === '"') {
				const rest = trimmed.slice(i + 1).trimStart();
				if (!rest || rest.startsWith(',') || rest.startsWith('}')) {
					break;
				}
			}
			out += ch;
			i++;
		}
		recovered.contents = out;
		recovered.content = out;
	}

	return recovered;
}

function parseOpenAIStreamBuffer(
	buffer: string,
	toolAcc: Map<number, { id: string; name: string; arguments: string }>,
	contentParser: StreamContentParser,
): { rest: string; parts: IChatResponsePart[] } {
	const parts: IChatResponsePart[] = [];
	let rest = buffer;
	while (true) {
		const newline = rest.indexOf('\n');
		if (newline === -1) {
			break;
		}
		const line = rest.slice(0, newline).trim();
		rest = rest.slice(newline + 1);
		if (!line.startsWith('data:')) {
			continue;
		}
		const payload = line.slice(5).trim();
		if (!payload || payload === '[DONE]') {
			continue;
		}
		try {
			const json = JSON.parse(payload);
			const choice = json?.choices?.[0];
			const delta = choice?.delta;
			const message = choice?.message;

			// Some providers emit complete tool_calls on the final message object, not in deltas.
			if (message?.tool_calls && Array.isArray(message.tool_calls)) {
				for (let i = 0; i < message.tool_calls.length; i++) {
					const tc = message.tool_calls[i];
					const index = typeof tc.index === 'number' ? tc.index : i;
					let acc = toolAcc.get(index);
					if (!acc) {
						acc = { id: '', name: '', arguments: '' };
						toolAcc.set(index, acc);
					}
					if (typeof tc.id === 'string' && tc.id) {
						acc.id = tc.id;
					}
					if (typeof tc.function?.name === 'string' && tc.function.name) {
						acc.name = tc.function.name;
					}
					if (typeof tc.function?.arguments === 'string') {
						acc.arguments = tc.function.arguments;
					}
				}
			}

			if (!delta) {
				continue;
			}

			const reasoning = delta.reasoning_content ?? delta.reasoning ?? delta.thinking;
			if (typeof reasoning === 'string' && reasoning.length > 0) {
				parts.push({ type: 'thinking', value: reasoning } satisfies IChatResponseThinkingPart);
			}

			const content = delta.content;
			if (typeof content === 'string' && content.length > 0) {
				parts.push(...contentParser.push(content));
			}

			const toolCalls = delta.tool_calls;
			if (Array.isArray(toolCalls)) {
				for (const tc of toolCalls) {
					const index = typeof tc.index === 'number' ? tc.index : 0;
					let acc = toolAcc.get(index);
					if (!acc) {
						acc = { id: '', name: '', arguments: '' };
						toolAcc.set(index, acc);
					}
					if (typeof tc.id === 'string' && tc.id) {
						acc.id = tc.id;
					}
					if (typeof tc.function?.name === 'string' && tc.function.name) {
						acc.name = tc.function.name;
					}
					if (typeof tc.function?.arguments === 'string') {
						acc.arguments += tc.function.arguments;
					}
				}
			}
		} catch {
			// ignore malformed chunks
		}
	}
	return { rest, parts };
}

type StreamContentParser = {
	push: (content: string) => IChatResponsePart[];
	flush: () => IChatResponsePart[];
};

/** Splits streamed content into answer text vs think-tag blocks. */
function createStreamContentParser(): StreamContentParser {
	let mode: 'answer' | 'thinking' = 'answer';
	let carry = '';
	// Built in pieces so source never contains a literal think-tag that tooling may strip.
	const thinkOpen = '<' + 'think' + '>';
	const thinkClose = '<' + '/' + 'think' + '>';
	const tagHold = Math.max(thinkOpen.length, thinkClose.length) - 1;

	const emit = (text: string, kind: 'answer' | 'thinking'): IChatResponsePart[] => {
		if (!text) {
			return [];
		}
		return kind === 'thinking'
			? [{ type: 'thinking', value: text } satisfies IChatResponseThinkingPart]
			: [{ type: 'text', value: text } satisfies IChatResponseTextPart];
	};

	const stripThinkTags = (text: string): string => {
		if (!text) {
			return text;
		}
		return text.split(thinkOpen).join('').split(thinkClose).join('');
	};

	const drain = (): IChatResponsePart[] => {
		if (!carry) {
			return [];
		}
		const raw = carry;
		carry = '';
		if (mode === 'thinking') {
			return emit(raw, 'thinking');
		}
		// Drop leftover / partial tags at end-of-stream (never show them as answer prose).
		return emit(stripThinkTags(raw), 'answer');
	};

	return {
		push(content: string): IChatResponsePart[] {
			const out: IChatResponsePart[] = [];
			carry += content;
			while (carry.length > 0) {
				if (mode === 'answer') {
					const open = carry.indexOf(thinkOpen);
					const close = carry.indexOf(thinkClose);

					// Orphan close: common when thinking already arrived via reasoning_content
					// and content still echoes the closing tag — never surface it as answer.
					if (close !== -1 && (open === -1 || close < open)) {
						if (close > 0) {
							out.push(...emit(carry.slice(0, close), 'answer'));
						}
						carry = carry.slice(close + thinkClose.length);
						continue;
					}

					if (open === -1) {
						const safe = Math.max(0, carry.length - tagHold);
						if (safe > 0) {
							out.push(...emit(carry.slice(0, safe), 'answer'));
							carry = carry.slice(safe);
						}
						break;
					}
					if (open > 0) {
						out.push(...emit(carry.slice(0, open), 'answer'));
					}
					carry = carry.slice(open + thinkOpen.length);
					mode = 'thinking';
					continue;
				}

				const close = carry.indexOf(thinkClose);
				if (close === -1) {
					const safe = Math.max(0, carry.length - tagHold);
					if (safe > 0) {
						out.push(...emit(carry.slice(0, safe), 'thinking'));
						carry = carry.slice(safe);
					}
					break;
				}
				const chunk = carry.slice(0, close);
				if (chunk) {
					out.push(...emit(chunk, 'thinking'));
				}
				carry = carry.slice(close + thinkClose.length);
				mode = 'answer';
			}
			return out;
		},
		flush(): IChatResponsePart[] {
			return drain();
		},
	};
}
