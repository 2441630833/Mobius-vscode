/*---------------------------------------------------------------------------------------------
 *  Mobius — local Ollama OCR preprocess before cloud/agent chat
 *--------------------------------------------------------------------------------------------*/

import { decodeBase64, encodeBase64, streamToBuffer, VSBuffer } from '../../../../base/common/buffer.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { getMediaMime } from '../../../../base/common/mime.js';
import { URI } from '../../../../base/common/uri.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IRequestService } from '../../../../platform/request/common/request.js';
import {
	ChatImageMimeType,
	IChatMessageImagePart,
} from '../../chat/common/languageModels.js';
import {
	IChatRequestVariableEntry,
	isChatRequestFileEntry,
	isImageVariableEntry,
	isNotebookOutputVariableEntry,
} from '../../chat/common/attachments/chatVariableEntries.js';
import { coerceImageBuffer } from '../../chat/common/chatImageExtraction.js';
import { CHAT_ATTACHABLE_IMAGE_MIME_TYPES } from '../../chat/common/model/chatModel.js';
import { IChatAgentRequest } from '../../chat/common/participants/chatAgents.js';
import { BUNDLED_OLLAMA_OCR, BUNDLED_OLLAMA_PORT } from './continueModelConfig.js';

const OCR_API_BASE = `http://127.0.0.1:${BUNDLED_OLLAMA_PORT}`;
/** CPU-only hosts often need >60s for cold load + vision encode; keep generous. */
const OCR_REQUEST_TIMEOUT_MS = 180_000;
const OCR_MAX_IMAGES = 4;
const OCR_MAX_CHARS_PER_IMAGE = 12_000;
/** Cap generation — glm-ocr on CPU otherwise burns the whole timeout emitting empty fences. */
const OCR_NUM_PREDICT = 512;

const IMAGE_EXT_RE = new RegExp(
	`\\.(${Object.keys(CHAT_ATTACHABLE_IMAGE_MIME_TYPES).join('|')}|bmp)$`,
	'i',
);

const OCR_PROMPT = `Text Recognition: Extract all readable text from this image in reading order.
Preserve simple table structure with plain text or a single markdown table when helpful.
Return ONLY the extracted text. Do not wrap in markdown code fences. Do not repeat blank lines or fences.
If there is no text, reply exactly: (no text found)`;

export interface ContinueOcrImageInput {
	readonly name: string;
	readonly mimeType: string;
	readonly base64: string;
}

export interface ContinueOcrResult {
	readonly extractBlock: string | undefined;
	readonly imageCount: number;
	readonly successCount: number;
	/** True when request had image-like attachments but bytes could not be read. */
	readonly unresolvedAttachments: number;
	/** Last per-image OCR failure message (e.g. model lacks vision). */
	readonly lastError?: string;
}

/**
 * Extract attached images from an agent request and run local Ollama OCR.
 * Returns a text block to inject into the user message for the cloud/agent model.
 */
export async function preprocessAgentRequestOcr(
	request: IChatAgentRequest,
	requestService: IRequestService,
	fileService: IFileService,
	logService: ILogService,
	token: CancellationToken,
): Promise<ContinueOcrResult> {
	const variables = request.variables?.variables ?? [];
	if (variables.length) {
		const summary = variables.map(v => `${v.kind}:${v.name}`).join(', ');
		logService.info(`[Continue][OCR] request variables (${variables.length}): ${summary}`);
	}

	const { images, unresolved } = await collectAgentRequestImages(request, fileService, logService);
	if (!images.length) {
		return { extractBlock: undefined, imageCount: 0, successCount: 0, unresolvedAttachments: unresolved };
	}

	const limited = images.slice(0, OCR_MAX_IMAGES);
	const parts: string[] = [];
	let successCount = 0;
	let lastError: string | undefined;

	for (let i = 0; i < limited.length; i++) {
		if (token.isCancellationRequested) {
			break;
		}
		const image = limited[i];
		try {
			const text = await runLocalOcr(image, requestService, token);
			const trimmed = text?.trim();
			if (!trimmed || trimmed === '(no text found)') {
				logService.info(`[Continue][OCR] No text from image ${i + 1}/${limited.length}: ${image.name}`);
				continue;
			}
			successCount++;
			const clipped = trimmed.length > OCR_MAX_CHARS_PER_IMAGE
				? `${trimmed.slice(0, OCR_MAX_CHARS_PER_IMAGE)}\n…(truncated)`
				: trimmed;
			parts.push(`<image name="${escapeAttr(image.name)}">\n${clipped}\n</image>`);
		} catch (err) {
			lastError = err instanceof Error ? err.message : String(err);
			logService.warn(`[Continue][OCR] Failed for ${image.name}: ${lastError}`);
		}
	}

	if (!parts.length) {
		return { extractBlock: undefined, imageCount: limited.length, successCount: 0, unresolvedAttachments: unresolved, lastError };
	}

		const extractBlock = `<ocr-extract model="${BUNDLED_OLLAMA_OCR.model}">\n${parts.join('\n\n')}\n</ocr-extract>`;
	return { extractBlock, imageCount: limited.length, successCount, unresolvedAttachments: unresolved, lastError };
}

/**
 * Collect attached images as {@link IChatMessageImagePart} for direct multimodal
 * delivery to vision-capable chat models (skips local OCR).
 * ponytail: cap at 4 images / 5MB each — matches OCR path and the chat image limit.
 */
export async function collectAgentRequestImageParts(
	request: IChatAgentRequest,
	fileService: IFileService,
	logService: ILogService,
): Promise<{ parts: IChatMessageImagePart[]; unresolved: number; imageCount: number }> {
	const { images, unresolved } = await collectAgentRequestImages(request, fileService, logService);
	const limited = images.slice(0, OCR_MAX_IMAGES);
	const parts: IChatMessageImagePart[] = [];
	for (const image of limited) {
		const mimeType = toChatImageMimeType(image.mimeType);
		if (!mimeType) {
			logService.warn(`[Continue][Vision] Unsupported image MIME ${image.mimeType} for ${image.name}`);
			continue;
		}
		let bytes: Uint8Array;
		try {
			bytes = decodeBase64(image.base64).buffer;
		} catch {
			logService.warn(`[Continue][Vision] Could not decode base64 for ${image.name}`);
			continue;
		}
		parts.push({
			type: 'image_url',
			value: { mimeType, data: VSBuffer.wrap(bytes) },
		});
	}
	return { parts, unresolved, imageCount: limited.length };
}

function toChatImageMimeType(mime: string | undefined): ChatImageMimeType | undefined {
	switch (mime?.toLowerCase()) {
		case 'image/png': return ChatImageMimeType.PNG;
		case 'image/jpeg':
		case 'image/jpg': return ChatImageMimeType.JPEG;
		case 'image/gif': return ChatImageMimeType.GIF;
		case 'image/webp': return ChatImageMimeType.WEBP;
		case 'image/bmp':
		case 'image/x-ms-bmp': return ChatImageMimeType.BMP;
		default: return undefined;
	}
}

async function collectAgentRequestImages(
	request: IChatAgentRequest,
	fileService: IFileService,
	logService: ILogService,
): Promise<{ images: ContinueOcrImageInput[]; unresolved: number }> {
	const out: ContinueOcrImageInput[] = [];
	let unresolved = 0;
	const variables = request.variables?.variables ?? [];

	for (const entry of variables) {
		if (!isLikelyImageAttachment(entry)) {
			continue;
		}

		const resolved = await resolveImageBytes(entry, fileService, logService);
		if (!resolved) {
			unresolved++;
			continue;
		}

		out.push({
			name: entry.name || `image-${out.length + 1}`,
			mimeType: resolved.mimeType,
			base64: encodeBase64(VSBuffer.wrap(resolved.bytes)),
		});
	}

	return { images: out, unresolved };
}

function isLikelyImageAttachment(entry: IChatRequestVariableEntry): boolean {
	if (isImageVariableEntry(entry)) {
		return true;
	}
	if (isNotebookOutputVariableEntry(entry) && typeof entry.mimeType === 'string' && entry.mimeType.startsWith('image/')) {
		return true;
	}
	const uri = entryUri(entry);
	if (!uri) {
		return false;
	}
	if (isChatRequestFileEntry(entry) || entry.kind === 'implicit') {
		return IMAGE_EXT_RE.test(uri.path) || !!getMediaMime(uri.path)?.startsWith('image/');
	}
	return false;
}

function entryUri(entry: IChatRequestVariableEntry): URI | undefined {
	if (URI.isUri(entry.value)) {
		return entry.value;
	}
	if (entry.value && typeof entry.value === 'object' && 'uri' in entry.value) {
		const nested = (entry.value as { uri?: unknown }).uri;
		if (URI.isUri(nested)) {
			return nested;
		}
	}
	const ref = entry.references?.find(r => URI.isUri(r.reference))?.reference;
	return URI.isUri(ref) ? ref : undefined;
}

async function resolveImageBytes(
	entry: IChatRequestVariableEntry,
	fileService: IFileService,
	logService: ILogService,
): Promise<{ bytes: Uint8Array; mimeType: string } | undefined> {
	let bytes = coerceImageBuffer(entry.value);

	if ((!bytes || bytes.byteLength === 0) && entry.value && typeof entry.value === 'object' && '$base64' in (entry.value as object)) {
		const b64 = (entry.value as { $base64?: unknown }).$base64;
		if (typeof b64 === 'string' && b64) {
			try {
				bytes = decodeBase64(b64).buffer;
			} catch {
				bytes = undefined;
			}
		}
	}

	const uri = entryUri(entry);
	if ((!bytes || bytes.byteLength === 0) && uri) {
		if (uri.scheme === 'file' || uri.scheme === 'vscode-file' || uri.scheme === 'vscode-userdata') {
			try {
				const file = await fileService.readFile(uri);
				bytes = file.value.buffer;
			} catch (err) {
				logService.warn(`[Continue][OCR] Could not read image URI ${uri.toString()}: ${err instanceof Error ? err.message : String(err)}`);
			}
		} else {
			logService.warn(`[Continue][OCR] Unsupported image URI scheme for ${entry.name}: ${uri.scheme}`);
		}
	}

	if (!bytes || bytes.byteLength === 0) {
		logService.warn(`[Continue][OCR] No bytes for attachment kind=${entry.kind} name=${entry.name}`);
		return undefined;
	}

	const mimeType =
		(isImageVariableEntry(entry) || isNotebookOutputVariableEntry(entry) ? entry.mimeType : undefined)
		?? (uri ? getMediaMime(uri.path) : undefined)
		?? 'image/png';

	return { bytes, mimeType };
}

async function runLocalOcr(
	image: ContinueOcrImageInput,
	requestService: IRequestService,
	token: CancellationToken,
): Promise<string | undefined> {
	const body = JSON.stringify({
		model: BUNDLED_OLLAMA_OCR.model,
		messages: [{
			role: 'user',
			content: OCR_PROMPT,
			images: [image.base64],
		}],
		stream: false,
		keep_alive: '30m',
		options: {
			num_predict: OCR_NUM_PREDICT,
			temperature: 0,
		},
		stop: ['```\n```', '\n```\n```\n```'],
	});

	const context = await requestService.request({
		type: 'POST',
		url: `${OCR_API_BASE}/api/chat`,
		callSite: 'ContinueOcrPreprocessor.ocr',
		headers: {
			'Content-Type': 'application/json',
		},
		data: body,
		timeout: OCR_REQUEST_TIMEOUT_MS,
	}, token);

	const raw = (await streamToBuffer(context.stream)).toString();
	if (context.res.statusCode && context.res.statusCode >= 400) {
		throw new Error(`Ollama OCR HTTP ${context.res.statusCode}: ${raw.slice(0, 400)}`);
	}

	try {
		const json = JSON.parse(raw);
		if (typeof json?.error === 'string' && json.error) {
			throw new Error(json.error);
		}
		const content = json?.message?.content;
		if (typeof content === 'string') {
			return sanitizeOcrContent(content);
		}
	} catch (err) {
		if (err instanceof SyntaxError) {
			throw new Error(`Ollama OCR returned non-JSON: ${raw.slice(0, 200)}`);
		}
		throw err;
	}
	return undefined;
}

/** Drop runaway empty fences / repetition that glm-ocr sometimes emits on CPU. */
function sanitizeOcrContent(content: string): string | undefined {
	let text = content.replace(/(?:```(?:\w*)?\s*\n?){2,}/g, '\n').trim();
	// Collapse long runs of bare fence lines.
	text = text.replace(/(?:^```\s*\n?){2,}/gm, '```\n').trim();
	const lines = text.split(/\r?\n/);
	const kept: string[] = [];
	let emptyFenceStreak = 0;
	for (const line of lines) {
		if (/^\s*```\s*$/.test(line)) {
			emptyFenceStreak++;
			if (emptyFenceStreak > 1) {
				continue;
			}
		} else {
			emptyFenceStreak = 0;
		}
		kept.push(line);
	}
	text = kept.join('\n').trim();
	return text || undefined;
}

function escapeAttr(value: string): string {
	return value.replace(/[<>&"']/g, ch => {
		switch (ch) {
			case '<': return '&lt;';
			case '>': return '&gt;';
			case '&': return '&amp;';
			case '"': return '&quot;';
			case '\'': return '&apos;';
			default: return ch;
		}
	});
}
