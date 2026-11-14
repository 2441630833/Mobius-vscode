/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Resolves whether an agent-host model can accept image input.
 *
 * Background: the agent host protocol only reports `supportsVision` when the
 * upstream model catalogue declares it. User-configured OpenAI-compatible
 * endpoints (Continue `config.yaml`, self-hosted gateways, …) are usually not
 * part of that catalogue, so they arrive with `supportsVision === undefined`
 * even when the endpoint happily accepts `image_url` content parts. Treating
 * "not reported" as "cannot see images" made the chat surface swallow pasted
 * images and fall back to local OCR.
 *
 * The server is the authority: unless a model is *explicitly* declared as
 * text-only, images are forwarded and an endpoint that really cannot handle
 * them reports the error itself.
 *
 * Escape hatches:
 * - `TIGNN_STRICT_VISION=1` restores the old, conservative behaviour
 *   (unreported models are treated as text-only).
 * - `TIGNN_ALLOW_UNKNOWN_VISION=1` forces images on for every model.
 */

/** Tokens that positively declare image/multimodal input support. */
const IMAGE_CAPABLE_TOKENS: ReadonlySet<string> = new Set([
	'image_input',
	'imageinput',
	'image_inputs',
	'image',
	'images',
	'vision',
	'vision_input',
	'image_url',
	'multimodal',
	'multi_modal',
	'image_understanding',
]);

/** Tokens that explicitly declare a text-only model. */
const TEXT_ONLY_TOKENS: ReadonlySet<string> = new Set([
	'no_image_input',
	'noimages',
	'no_images',
	'text_only',
	'text-only',
	'textonly',
]);

/**
 * Model-id fragments that are known to serve multimodal requests. Kept as a
 * narrow allow-list of unambiguous families; everything else falls through to
 * the permissive default below.
 */
const VISION_MODEL_HINTS: readonly RegExp[] = [
	/gpt-4o/i,
	/gpt-4\.1/i,
	/gpt-5/i,
	/o1\b/i,
	/o3\b/i,
	/o4\b/i,
	/claude-3/i,
	/claude-4/i,
	/claude-sonnet/i,
	/claude-opus/i,
	/claude-haiku/i,
	/gemini/i,
	/llava/i,
	/qwen.*vl/i,
	/qwen2?\.?5?-vl/i,
	/pixtral/i,
	/internvl/i,
	/glm-4\.?[15]?-?v/i,
	/deepseek-?v?l/i,
	/deepseek-v4/i,
	/vision/i,
	/multimodal/i,
	/\bvl\b/i,
];

function readEnvFlag(name: string): boolean {
	try {
		const raw = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[name];
		return ['1', 'true', 'yes', 'on'].includes(String(raw ?? '').toLowerCase());
	} catch {
		return false;
	}
}

/** True when unreported models must be treated as text-only (legacy behaviour). */
export function strictAgentVisionMode(): boolean {
	return readEnvFlag('TIGNN_STRICT_VISION');
}

/** True when image input must be allowed even for explicitly text-only models. */
export function allowUnknownAgentVision(): boolean {
	return readEnvFlag('TIGNN_ALLOW_UNKNOWN_VISION');
}

function normalizeToken(token: string): string {
	return token.trim().toLowerCase().replace(/\s+/g, '_');
}

/**
 * Descriptor for a model whose image capabilities should be resolved.
 */
export interface AgentModelVisionInput {
	/** Model id as reported by the agent host (e.g. `deepseek-v4.1-flash-1017`). */
	readonly id?: string;
	/** Display name shown in the picker. */
	readonly name?: string;
	/** Declared capability tokens, when the producer exposes them. */
	readonly capabilities?: readonly string[] | undefined;
	/** Upstream `supportsVision` flag, if the protocol reported one. */
	readonly reportedSupportsVision?: boolean | undefined;
	/** Declared input modalities, when the producer exposes them. */
	readonly inputModalities?: readonly string[] | undefined;
}

/**
 * Whether the given model should be advertised as image capable.
 *
 * Order of precedence:
 * 1. `TIGNN_ALLOW_UNKNOWN_VISION=1` → always yes.
 * 2. Explicit text-only declaration → no (unless strict mode is off *and* an
 *    image token is also declared — declarations win).
 * 3. Explicit `supportsVision: true` / image token / `image` modality → yes.
 * 4. Known multimodal model family → yes.
 * 5. Otherwise → yes unless `TIGNN_STRICT_VISION=1`.
 */
export function resolveAgentModelVision(input: AgentModelVisionInput | undefined): boolean {
	if (allowUnknownAgentVision()) {
		return true;
	}

	if (!input) {
		return !strictAgentVisionMode();
	}

	const tokens = new Set<string>();
	for (const token of input.capabilities ?? []) {
		tokens.add(normalizeToken(token));
	}
	for (const modality of input.inputModalities ?? []) {
		tokens.add(normalizeToken(modality));
	}

	let declaresImage = false;
	for (const token of tokens) {
		if (IMAGE_CAPABLE_TOKENS.has(token)) {
			declaresImage = true;
			break;
		}
	}

	let declaresTextOnly = false;
	for (const token of tokens) {
		if (TEXT_ONLY_TOKENS.has(token)) {
			declaresTextOnly = true;
			break;
		}
	}

	if (declaresImage) {
		return true;
	}

	if (declaresTextOnly) {
		return false;
	}

	if (input.reportedSupportsVision === true) {
		return true;
	}

	const haystack = `${input.id ?? ''} ${input.name ?? ''}`.trim();
	if (haystack) {
		for (const hint of VISION_MODEL_HINTS) {
			if (hint.test(haystack)) {
				return true;
			}
		}
	}

	// Unknown model with no declaration: let the endpoint decide.
	return !strictAgentVisionMode();
}