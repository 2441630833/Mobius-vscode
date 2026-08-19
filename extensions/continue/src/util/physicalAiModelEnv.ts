import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { GlobalContext } from "core/util/GlobalContext";
import {
  resolvePackagedContinueConfigTemplate,
  resolvePackagedModelEnvPath,
} from "core/util/ollamaHelper";

export interface ProviderPreset {
  label: string;
  baseUrl: string;
  defaultModel: string;
  openAiCompatible: boolean;
  /** Optional preset API key filled when the provider is selected. */
  defaultApiKey?: string;
}

/** Bundled Ollama port (non-default to avoid conflict with user-installed Ollama). Sync with config/ollama.port. */
export const BUNDLED_OLLAMA_PORT = 25137;
/** Always use 127.0.0.1 — Windows may resolve localhost to ::1 while Ollama binds IPv4 only. */
const BUNDLED_OLLAMA_API_BASE = `http://127.0.0.1:${BUNDLED_OLLAMA_PORT}`;

export const PROVIDER_PRESETS: Record<string, ProviderPreset> = {
  openai: {
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-4o",
    openAiCompatible: true,
  },
  anthropic: {
    label: "Anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    defaultModel: "claude-sonnet-4-6",
    openAiCompatible: false,
  },
  gemini: {
    label: "Google Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    defaultModel: "gemini-2.0-flash",
    openAiCompatible: false,
  },
  openrouter: {
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    defaultModel: "anthropic/claude-sonnet-4",
    openAiCompatible: true,
  },
  deepseek: {
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    defaultModel: "deepseek-chat",
    openAiCompatible: true,
  },
  groq: {
    label: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    defaultModel: "llama-3.3-70b-versatile",
    openAiCompatible: true,
  },
  xai: {
    label: "xAI (Grok)",
    baseUrl: "https://api.x.ai/v1",
    defaultModel: "grok-3",
    openAiCompatible: true,
  },
  mistral: {
    label: "Mistral",
    baseUrl: "https://api.mistral.ai/v1",
    defaultModel: "mistral-large-latest",
    openAiCompatible: true,
  },
  siliconflow: {
    label: "SiliconFlow",
    baseUrl: "https://api.siliconflow.cn/v1",
    defaultModel: "deepseek-ai/DeepSeek-V3",
    openAiCompatible: true,
  },
};

/** Bundled local OCR model used by Agents-window preprocess (not a user chat picker).
 *  glm-ocr supports Ollama vision; MedAIBase/PaddleOCR-VL:0.9b is Text-only (no mmproj).
 */
export const BUNDLED_OLLAMA_OCR = {
  name: "GLM-OCR (Local)",
  provider: "ollama",
  model: "glm-ocr",
  apiBase: BUNDLED_OLLAMA_API_BASE,
  apiKey: "ollama",
} as const;

export function isOllamaProvider(provider: string): boolean {
  return provider.toLowerCase() === "ollama";
}

function primaryModelTitle(settings: ModelEnvSettings): string {
  return profileModelTitle(settings.profileId ?? "default", settings.model);
}

export const PROVIDER_IDS = Object.keys(PROVIDER_PRESETS);

export const OPENAI_COMPATIBLE_PROVIDERS = new Set(
  PROVIDER_IDS.filter((id) => PROVIDER_PRESETS[id].openAiCompatible),
);

export interface ModelEnvSettings {
  provider: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Named .env profile id (e.g. volcano). Session UI may differ from AI_ACTIVE_PROFILE. */
  profileId?: string;
}

export interface ModelEnvProfile extends ModelEnvSettings {
  id: string;
}

export interface ParsedModelEnvFile {
  activeProfileId: string;
  profiles: ModelEnvProfile[];
  /** Non-AI top-level key=value (and blank) lines preserved on rewrite. */
  passthroughLines: string[];
}

const AI_ENV_KEY_SET = new Set([
  "AI_PROVIDER",
  "AI_BASE_URL",
  "AI_API_KEY",
  "AI_MODEL",
  "AI_ACTIVE_PROFILE",
  "OPENAI_PROVIDER",
  "OPENAI_BASE_URL",
  "OPENAI_API_KEY",
  "OPENAI_MODEL",
]);

const MOBIUS_ENV_COMMENT = "# Mobius - model configuration";
/** Any historical / encoding-corrupted Mobius header line (em dash, mojibake, etc.). */
const MOBIUS_ENV_COMMENT_RE = /^#\s*Mobius\b.*\bmodel configuration\s*$/i;

/** Continue / Agents model title: stable profile id (models may contain `/`). */
export function profileModelTitle(profileId: string, _model?: string): string {
  return profileId;
}

export function parseEnvContent(content: string): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    if (/^\[[^\]]+\]$/.test(trimmed)) {
      continue;
    }
    const eq = trimmed.indexOf("=");
    if (eq < 0) {
      continue;
    }
    const key = trimmed.substring(0, eq).trim();
    let value = trimmed.substring(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (value) {
      vars[key] = value;
    }
  }
  return vars;
}

function unquoteEnvValue(raw: string): string {
  let value = raw.trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  return value;
}

function resolveProvider(vars: Record<string, string>): string {
  const provider = vars.AI_PROVIDER || vars.OPENAI_PROVIDER || "";
  return PROVIDER_PRESETS[provider] ? provider : "";
}

function settingsFromVars(
  vars: Record<string, string>,
  profileId: string,
): ModelEnvProfile {
  const provider = resolveProvider(vars);
  const preset = PROVIDER_PRESETS[provider];
  return {
    id: profileId,
    profileId,
    provider,
    baseUrl: vars.AI_BASE_URL || vars.OPENAI_BASE_URL || preset.baseUrl,
    apiKey: vars.AI_API_KEY || vars.OPENAI_API_KEY || "",
    model: vars.AI_MODEL || vars.OPENAI_MODEL || preset.defaultModel,
  };
}

/**
 * Parse named `[profile]` sections + `AI_ACTIVE_PROFILE`.
 * Flat `AI_*` (no sections) → one implicit profile `default`.
 */
export function parseEnvProfiles(content: string): ParsedModelEnvFile {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  let activeFromFile: string | undefined;
  const sectionOrder: string[] = [];
  const sectionVars = new Map<string, Record<string, string>>();
  const topLevelAi: Record<string, string> = {};
  const passthroughLines: string[] = [];
  let currentSection: string | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      if (
        currentSection === null &&
        trimmed &&
        !MOBIUS_ENV_COMMENT_RE.test(trimmed)
      ) {
        passthroughLines.push(line);
      } else if (currentSection === null && !trimmed) {
        // skip blank lines in preamble; serializer re-adds spacing
      }
      continue;
    }

    const sectionMatch = /^\[([^\]]+)\]$/.exec(trimmed);
    if (sectionMatch) {
      currentSection = sectionMatch[1].trim();
      if (currentSection && !sectionVars.has(currentSection)) {
        sectionVars.set(currentSection, {});
        sectionOrder.push(currentSection);
      }
      continue;
    }

    const eq = trimmed.indexOf("=");
    if (eq < 0) {
      if (currentSection === null) {
        passthroughLines.push(line);
      }
      continue;
    }

    const key = trimmed.substring(0, eq).trim();
    const value = unquoteEnvValue(trimmed.substring(eq + 1));
    if (!value && key !== "AI_API_KEY" && key !== "OPENAI_API_KEY") {
      continue;
    }

    if (currentSection === null) {
      if (key === "AI_ACTIVE_PROFILE") {
        activeFromFile = value;
        continue;
      }
      if (AI_ENV_KEY_SET.has(key)) {
        topLevelAi[key] = value;
        continue;
      }
      passthroughLines.push(line);
      continue;
    }

    const bucket = sectionVars.get(currentSection);
    if (bucket) {
      bucket[key] = value;
    }
  }

  const profiles: ModelEnvProfile[] = [];
  if (sectionOrder.length > 0) {
    for (const id of sectionOrder) {
      const vars = sectionVars.get(id) ?? {};
      if (
        vars.AI_MODEL ||
        vars.OPENAI_MODEL ||
        vars.AI_API_KEY ||
        vars.OPENAI_API_KEY ||
        vars.AI_PROVIDER ||
        vars.OPENAI_PROVIDER
      ) {
        profiles.push(settingsFromVars(vars, id));
      }
    }
  }

  if (profiles.length === 0) {
    const hasFlat =
      topLevelAi.AI_MODEL ||
      topLevelAi.OPENAI_MODEL ||
      topLevelAi.AI_API_KEY ||
      topLevelAi.OPENAI_API_KEY ||
      topLevelAi.AI_PROVIDER ||
      topLevelAi.OPENAI_PROVIDER;
    if (hasFlat) {
      profiles.push(settingsFromVars(topLevelAi, "default"));
    }
  }

  let activeProfileId =
    activeFromFile && profiles.some((p) => p.id === activeFromFile)
      ? activeFromFile
      : (profiles[0]?.id ?? "default");

  // Active profile first for default pickers.
  profiles.sort((a, b) => {
    if (a.id === activeProfileId) {
      return -1;
    }
    if (b.id === activeProfileId) {
      return 1;
    }
    return 0;
  });

  return { activeProfileId, profiles, passthroughLines };
}

export function readModelEnvFromContent(content: string): ModelEnvSettings {
  const parsed = parseEnvProfiles(content);
  const active =
    parsed.profiles.find((p) => p.id === parsed.activeProfileId) ??
    parsed.profiles[0];
  if (!active) {
    return {
      provider: "",
      baseUrl: "",
      apiKey: "",
      model: "",
      profileId: "default",
    };
  }
  return {
    provider: active.provider,
    baseUrl: active.baseUrl,
    apiKey: active.apiKey,
    model: active.model,
    profileId: active.id,
  };
}

/** True when the file defines Mobius AI model config (flat, active profile, or sections). */
export function envFileHasAiConfig(content: string): boolean {
  return (
    /^AI_MODEL=/m.test(content) ||
    /^AI_ACTIVE_PROFILE=/m.test(content) ||
    /^\[[\w.-]+\]\s*$/m.test(content)
  );
}

function envFileHasAiModelKey(content: string): boolean {
  return envFileHasAiConfig(content);
}

/** Higher = richer multi-profile schema. Flat last-wins parse is less preferred. */
export function envFileProfileRichness(content: string): number {
  const sectionCount = (content.match(/^\[[\w.-]+\]\s*$/gm) ?? []).length;
  if (sectionCount > 0 && /^AI_ACTIVE_PROFILE=/m.test(content)) {
    return 2 + sectionCount;
  }
  if (sectionCount > 0) {
    return 1 + sectionCount;
  }
  return 0;
}

/** Pick the authoritative .env when workspace and ~/.continue differ. */
export function resolveModelEnvContent(
  workspaceRoot: string,
): { content: string; sourcePath: string } | null {
  const workspaceEnvPath = workspaceRoot
    ? path.join(workspaceRoot, ".env")
    : "";
  const continueEnvPath = path.join(getContinueDir(), ".env");

  const workspaceExists =
    Boolean(workspaceEnvPath) && fs.existsSync(workspaceEnvPath);
  const continueExists = fs.existsSync(continueEnvPath);

  if (!workspaceExists && !continueExists) {
    return null;
  }

  if (workspaceExists && !continueExists) {
    return {
      content: fs.readFileSync(workspaceEnvPath, "utf8"),
      sourcePath: workspaceEnvPath,
    };
  }

  if (!workspaceExists && continueExists) {
    return {
      content: fs.readFileSync(continueEnvPath, "utf8"),
      sourcePath: continueEnvPath,
    };
  }

  const workspaceContent = fs.readFileSync(workspaceEnvPath, "utf8");
  const continueContent = fs.readFileSync(continueEnvPath, "utf8");
  const workspaceHasAi = envFileHasAiModelKey(workspaceContent);
  const continueHasAi = envFileHasAiModelKey(continueContent);

  // Settings saved via Model Provider use AI_* -- prefer that over legacy OPENAI_* only.
  if (workspaceHasAi && !continueHasAi) {
    return { content: workspaceContent, sourcePath: workspaceEnvPath };
  }
  if (continueHasAi && !workspaceHasAi) {
    return { content: continueContent, sourcePath: continueEnvPath };
  }

  // Prefer named [profile] catalogs over a flat single quartet (old extension
  // sync used to flatten multi-profile workspace .env into ~/.continue/.env).
  const workspaceRichness = envFileProfileRichness(workspaceContent);
  const continueRichness = envFileProfileRichness(continueContent);
  if (workspaceRichness !== continueRichness) {
    if (workspaceRichness > continueRichness) {
      return { content: workspaceContent, sourcePath: workspaceEnvPath };
    }
    return { content: continueContent, sourcePath: continueEnvPath };
  }

  const workspaceMtime = fs.statSync(workspaceEnvPath).mtimeMs;
  const continueMtime = fs.statSync(continueEnvPath).mtimeMs;
  if (workspaceMtime >= continueMtime) {
    return { content: workspaceContent, sourcePath: workspaceEnvPath };
  }
  return { content: continueContent, sourcePath: continueEnvPath };
}

const AI_ENV_KEYS = [
  "AI_PROVIDER",
  "AI_BASE_URL",
  "AI_API_KEY",
  "AI_MODEL",
] as const;

export function serializeEnvProfiles(
  activeProfileId: string,
  profiles: readonly ModelEnvProfile[],
  passthroughLines: readonly string[] = [],
): string {
  const out: string[] = [
    MOBIUS_ENV_COMMENT,
    `AI_ACTIVE_PROFILE=${activeProfileId}`,
  ];
  const cleanedPassthrough = passthroughLines
    .map((l) => l.replace(/\r$/, ""))
    .filter((l) => {
      const t = l.trim();
      return (
        t &&
        !MOBIUS_ENV_COMMENT_RE.test(t) &&
        !AI_ENV_KEY_SET.has(t.split("=")[0]?.trim() ?? "")
      );
    });
  if (cleanedPassthrough.length) {
    out.push("");
    out.push(...cleanedPassthrough);
  }
  for (const profile of profiles) {
    out.push("");
    out.push(`[${profile.id}]`);
    out.push(`AI_PROVIDER=${profile.provider}`);
    out.push(`AI_BASE_URL=${profile.baseUrl}`);
    out.push(`AI_API_KEY=${profile.apiKey}`);
    out.push(`AI_MODEL=${profile.model}`);
  }
  return `${out.join("\n")}\n`;
}

export function buildEnvFileContent(settings: ModelEnvSettings): string {
  const profileId = settings.profileId ?? "default";
  return serializeEnvProfiles(profileId, [
    {
      id: profileId,
      profileId,
      provider: settings.provider,
      baseUrl: settings.baseUrl,
      apiKey: settings.apiKey,
      model: settings.model,
    },
  ]);
}

/**
 * Update one named profile section; preserves AI_ACTIVE_PROFILE and other profiles.
 * Flat legacy files are converted to sectioned form.
 */
export function upsertEnvProfile(
  existingContent: string,
  profileId: string,
  settings: ModelEnvSettings,
): string {
  const parsed = existingContent.trim()
    ? parseEnvProfiles(existingContent)
    : {
        activeProfileId: profileId,
        profiles: [],
        passthroughLines: [] as string[],
      };

  const nextProfile: ModelEnvProfile = {
    id: profileId,
    profileId,
    provider: settings.provider,
    baseUrl: settings.baseUrl,
    apiKey: settings.apiKey,
    model: settings.model,
  };

  const profiles = parsed.profiles.filter((p) => p.id !== profileId);
  // Keep prior order: replace in place when possible.
  const existingIndex = parsed.profiles.findIndex((p) => p.id === profileId);
  if (existingIndex >= 0) {
    const ordered = [...parsed.profiles];
    ordered[existingIndex] = nextProfile;
    return serializeEnvProfiles(
      parsed.activeProfileId || profileId,
      ordered,
      parsed.passthroughLines,
    );
  }
  profiles.push(nextProfile);
  return serializeEnvProfiles(
    parsed.activeProfileId || profileId,
    profiles.length ? profiles : [nextProfile],
    parsed.passthroughLines,
  );
}

/**
 * Merge Mobius AI_* keys into an existing .env without clobbering other
 * project variables (CMS_*, SSE_*, etc.).
 * When the file already has profiles (or settings.profileId is set), upserts that section.
 */
export function upsertAiModelEnvKeys(
  existingContent: string,
  settings: ModelEnvSettings,
): string {
  const profileId = settings.profileId ?? "default";
  const parsed = existingContent.trim()
    ? parseEnvProfiles(existingContent)
    : null;
  if (
    parsed &&
    (parsed.profiles.length > 1 ||
      (parsed.profiles.length === 1 && parsed.profiles[0].id !== "default") ||
      settings.profileId ||
      /^AI_ACTIVE_PROFILE=/m.test(existingContent) ||
      /^\[[\w.-]+\]\s*$/m.test(existingContent))
  ) {
    return upsertEnvProfile(existingContent, profileId, settings);
  }

  if (!existingContent.trim()) {
    return buildEnvFileContent({ ...settings, profileId: undefined });
  }

  // Legacy flat AI_* merge (single quartet, no sections) for older tests / files.
  const values: Record<(typeof AI_ENV_KEYS)[number], string> = {
    AI_PROVIDER: settings.provider,
    AI_BASE_URL: settings.baseUrl,
    AI_API_KEY: settings.apiKey,
    AI_MODEL: settings.model,
  };

  const lines = existingContent.replace(/\r\n/g, "\n").split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }

  const found = new Set<(typeof AI_ENV_KEYS)[number]>();
  let hasMobiusComment = false;
  const result: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (MOBIUS_ENV_COMMENT_RE.test(trimmed)) {
      if (!hasMobiusComment) {
        result.push(MOBIUS_ENV_COMMENT);
        hasMobiusComment = true;
      }
      continue;
    }

    const match = /^(AI_PROVIDER|AI_BASE_URL|AI_API_KEY|AI_MODEL)=(.*)$/.exec(
      line,
    );
    if (match) {
      const key = match[1] as (typeof AI_ENV_KEYS)[number];
      found.add(key);
      result.push(`${key}=${values[key]}`);
      continue;
    }

    result.push(line);
  }

  const missing = AI_ENV_KEYS.filter((key) => !found.has(key));
  if (missing.length > 0) {
    if (!hasMobiusComment) {
      if (result.length > 0 && result[result.length - 1] !== "") {
        result.push("");
      }
      result.push(MOBIUS_ENV_COMMENT);
    }
    for (const key of missing) {
      result.push(`${key}=${values[key]}`);
    }
  }

  return `${result.join("\n")}\n`;
}

export function isOfficialOpenAiBase(baseUrl: string): boolean {
  return `${baseUrl.replace(/\/+$/, "")}/` === "https://api.openai.com/v1/";
}

function isOfficialAnthropicBase(baseUrl: string): boolean {
  return `${baseUrl.replace(/\/+$/, "")}/` === "https://api.anthropic.com/v1/";
}

function isOfficialGeminiBase(baseUrl: string): boolean {
  return baseUrl.toLowerCase().includes("generativelanguage.googleapis.com");
}

function isOfficialXaiBase(baseUrl: string): boolean {
  return baseUrl.toLowerCase().includes("api.x.ai");
}

/** Map UI provider id to Continue yaml provider name (e.g. xai -> xAI). */
export function providerForYaml(provider: string): string {
  if (provider.toLowerCase() === "xai") {
    return "xAI";
  }
  return provider;
}

/**
 * OpenAI-compatible gateways (yunwu, etc.) must use an OpenAI-compatible
 * provider in config.yaml even when the model name is claude-* or grok-*.
 * Also ensure SiliconFlow-style bases include `/v1` so URL joins hit
 * `/v1/chat/completions` instead of a gateway 404 body that looks like
 * `404 page not found` (JSON.parse then fails at position 4).
 */
export function normalizeOpenAiCompatibleBaseUrl(
  provider: string,
  baseUrl: string,
): string {
  let base = baseUrl.trim().replace(/\/+$/, "");
  const isSiliconFlowStyle =
    provider.toLowerCase() === "siliconflow" ||
    /siliconflow\.cn|silinex\.work/i.test(base);

  if (isSiliconFlowStyle && !/\/v\d+$/i.test(base)) {
    base = `${base}/v1`;
  }

  if (OPENAI_COMPATIBLE_PROVIDERS.has(provider) || isSiliconFlowStyle) {
    return `${base}/`;
  }

  return baseUrl.trim();
}

export function normalizeModelSettings(settings: ModelEnvSettings): {
  settings: ModelEnvSettings;
  warning?: string;
} {
  const looksLikeSiliconFlow = /siliconflow\.cn|silinex\.work/i.test(
    settings.baseUrl,
  );
  let provider = settings.provider;
  let warning: string | undefined;

  // Silinex / SiliconFlow hosts must use the siliconflow provider (not openai),
  // otherwise chat can hang or mis-handle gateway responses.
  if (looksLikeSiliconFlow && provider.toLowerCase() !== "siliconflow") {
    provider = "siliconflow";
    warning =
      "Provider was set to SiliconFlow because your Base URL is a " +
      "SiliconFlow-compatible gateway (silinex.work / siliconflow.cn).";
  }

  const normalizedBase = normalizeOpenAiCompatibleBaseUrl(
    provider,
    settings.baseUrl,
  );
  const base = normalizedBase.replace(/\/+$/, "");
  const isOfficial =
    isOfficialOpenAiBase(base) ||
    isOfficialAnthropicBase(base) ||
    isOfficialGeminiBase(base) ||
    isOfficialXaiBase(base);

  if (!isOfficial && !OPENAI_COMPATIBLE_PROVIDERS.has(provider)) {
    return {
      settings: {
        ...settings,
        provider: "openai",
        baseUrl: normalizeOpenAiCompatibleBaseUrl("openai", settings.baseUrl),
      },
      warning:
        "Provider was set to OpenAI because your base URL is a third-party " +
        "OpenAI-compatible gateway. Keep Provider = OpenAI for proxies like " +
        "yunwu.ai when using model names such as claude-* or grok-*.",
    };
  }

  return {
    settings: {
      ...settings,
      provider,
      baseUrl: normalizedBase,
    },
    warning,
  };
}

function getContinueDir(): string {
  // Prefer CONTINUE_GLOBAL_DIR (tests / e2e) over ~/.continue.
  const override = process.env.CONTINUE_GLOBAL_DIR;
  if (override) {
    return path.isAbsolute(override)
      ? override
      : path.resolve(process.cwd(), override);
  }
  return path.join(os.homedir(), ".continue");
}

function resolveContinueConfigTemplate(
  workspaceRoot: string,
  appRoot?: string,
): string | undefined {
  const candidates: string[] = [];
  if (workspaceRoot) {
    candidates.push(path.join(workspaceRoot, "config", "continue-config.yaml"));
  }
  const packaged = resolvePackagedContinueConfigTemplate(appRoot);
  if (packaged) {
    candidates.push(packaged);
  }
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

/** `models: []` with list items below is invalid YAML and breaks Continue. */
function normalizeModelsSection(yaml: string): string {
  return yaml.replace(/^models:\s*\[\s*\]$/m, "models:");
}

function getModelBlockNames(yaml: string): string[] {
  const lines = yaml.split(/\r?\n/);
  let inModels = false;
  const names: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!inModels) {
      if (trimmed === "models:" || trimmed.startsWith("models:")) {
        inModels = true;
      }
      continue;
    }
    if (
      trimmed &&
      !trimmed.startsWith("-") &&
      !line.startsWith(" ") &&
      !line.startsWith("\t")
    ) {
      break;
    }
    const nameMatch = line.match(/^\s+-\s+name:\s*(.+)$/);
    if (nameMatch) {
      names.push(nameMatch[1].trim());
    }
  }
  return names;
}

function isConfigYamlBroken(yaml: string): boolean {
  if (/^models:\s*\[\s*\]$/m.test(yaml)) {
    return true;
  }
  const names = getModelBlockNames(yaml);
  if (names.length > 0 && new Set(names).size !== names.length) {
    return true;
  }
  return false;
}

function removeDuplicateModelBlocks(yaml: string): string {
  const lines = yaml.split(/\r?\n/);
  const out: string[] = [];
  let inModels = false;
  const seenNames = new Set<string>();
  let skipBlock = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (inModels) {
      if (
        trimmed &&
        !trimmed.startsWith("-") &&
        !trimmed.startsWith("#") &&
        !line.startsWith(" ") &&
        !line.startsWith("\t")
      ) {
        inModels = false;
      }
    }
    if (!inModels) {
      if (trimmed === "models:" || trimmed.startsWith("models:")) {
        inModels = true;
      }
      out.push(line);
      continue;
    }

    const nameMatch = line.match(/^\s+-\s+name:\s*(.+)$/);
    if (nameMatch) {
      const blockName = nameMatch[1].trim();
      if (seenNames.has(blockName)) {
        skipBlock = true;
        continue;
      }
      seenNames.add(blockName);
      skipBlock = false;
      out.push(line);
      continue;
    }

    if (skipBlock) {
      if (
        trimmed &&
        !trimmed.startsWith("-") &&
        !line.startsWith(" ") &&
        !line.startsWith("\t")
      ) {
        inModels = false;
        skipBlock = false;
        out.push(line);
      }
      continue;
    }

    if (
      trimmed &&
      !trimmed.startsWith("-") &&
      !line.startsWith(" ") &&
      !line.startsWith("\t")
    ) {
      inModels = false;
    }
    out.push(line);
  }

  return out.join("\n");
}

function prepareContinueConfigYaml(
  yaml: string,
  workspaceRoot: string,
  profiles: readonly ModelEnvProfile[],
  fallbackApiKey?: string,
): string {
  let prepared = normalizeModelsSection(yaml);
  if (isConfigYamlBroken(prepared)) {
    const templatePath = workspaceRoot
      ? resolveContinueConfigTemplate(workspaceRoot)
      : undefined;
    if (templatePath) {
      prepared = fs.readFileSync(templatePath, "utf8");
      const key = fallbackApiKey ?? profiles[0]?.apiKey ?? "";
      prepared = prepared.replace("<YOUR_OPENAI_API_KEY>", key);
    }
  }
  prepared = removeDuplicateModelBlocks(prepared);
  prepared = upsertProfileModelBlocks(prepared, profiles);
  prepared = dedupeUseResponsesApiKeys(prepared);
  return ensureOllamaEmbedBlock(removeRetiredLocalChatBlocks(prepared));
}

function buildChatModelYamlBlock(profile: ModelEnvProfile): string {
  const name = profileModelTitle(profile.id, profile.model);
  const provider = providerForYaml(profile.provider);
  const useResponsesLine =
    profile.provider === "openai" && !isOfficialOpenAiBase(profile.baseUrl)
      ? "\n    useResponsesApi: false"
      : "";
  return `  - name: ${name}
    provider: ${provider}
    model: ${profile.model}
    apiBase: ${profile.baseUrl}
    apiKey: "${profile.apiKey}"${useResponsesLine}
    roles:
      - chat
      - edit
      - apply
      - autocomplete
    capabilities:
      - tool_use`;
}

/** Insert or update every env profile as a named model block (name = profile id). */
function upsertProfileModelBlocks(
  yaml: string,
  profiles: readonly ModelEnvProfile[],
): string {
  let result = yaml;

  // Drop legacy bare model names and old `profileId/model` titles.
  for (const profile of profiles) {
    if (profile.model) {
      result = removeNamedModelBlock(result, profile.model);
      result = removeNamedModelBlock(result, `${profile.id}/${profile.model}`);
    }
  }

  for (const profile of profiles) {
    if (!profile.apiKey || isOllamaProvider(profile.provider)) {
      continue;
    }
    const name = profileModelTitle(profile.id, profile.model);
    const existingNames = getModelBlockNames(result);
    if (existingNames.includes(name)) {
      result = repairNamedModelBlock(result, name, {
        provider: providerForYaml(profile.provider),
        model: profile.model,
        apiBase: profile.baseUrl,
        apiKey: profile.apiKey,
        removeUseResponsesApi:
          profile.provider !== "openai" ||
          isOfficialOpenAiBase(profile.baseUrl),
      });
      if (
        profile.provider === "openai" &&
        !isOfficialOpenAiBase(profile.baseUrl)
      ) {
        result = ensureUseResponsesApiOnNamedBlock(result, name);
      }
    } else {
      result = insertChatModelBlock(result, buildChatModelYamlBlock(profile));
    }
  }
  return result;
}

function ensureUseResponsesApiOnNamedBlock(
  yaml: string,
  blockName: string,
): string {
  const escapedName = blockName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const nameRegex = new RegExp(`^- name:\\s*${escapedName}\\s*$`);
  const lines = yaml.split(/\r?\n/);
  let inTarget = false;
  let hasFlag = false;
  const output: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (nameRegex.test(trimmed)) {
      inTarget = true;
      hasFlag = false;
      output.push(line);
      continue;
    }
    if (inTarget) {
      if (trimmed.startsWith("- name:")) {
        if (!hasFlag) {
          output.push("    useResponsesApi: false");
        }
        inTarget = false;
        output.push(line);
        continue;
      }
      if (
        trimmed &&
        !trimmed.startsWith("-") &&
        !line.startsWith(" ") &&
        !line.startsWith("\t")
      ) {
        if (!hasFlag) {
          output.push("    useResponsesApi: false");
        }
        inTarget = false;
        output.push(line);
        continue;
      }
      // Collapse duplicate useResponsesApi keys (YAML forbids them; Continue
      // fails with "Map keys must be unique" and tools like search_web die).
      if (/^\s+useResponsesApi:\s*/.test(line)) {
        if (!hasFlag) {
          hasFlag = true;
          output.push("    useResponsesApi: false");
        }
        continue;
      }
      if (/^\s+apiKey:\s*/.test(line) && !hasFlag) {
        output.push(line);
        output.push("    useResponsesApi: false");
        hasFlag = true;
        continue;
      }
    }
    output.push(line);
  }
  if (inTarget && !hasFlag) {
    output.push("    useResponsesApi: false");
  }
  return output.join("\n");
}

/**
 * Within each model block, keep at most one `useResponsesApi` line.
 * Duplicate keys make yaml parse fatal → Config not loaded → Agent tools fail.
 */
export function dedupeUseResponsesApiKeys(yaml: string): string {
  const lines = yaml.split(/\r?\n/);
  const output: string[] = [];
  let inModelBlock = false;
  let sawUseResponsesApi = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("- name:")) {
      inModelBlock = true;
      sawUseResponsesApi = false;
      output.push(line);
      continue;
    }
    if (inModelBlock) {
      if (
        trimmed &&
        !trimmed.startsWith("-") &&
        !line.startsWith(" ") &&
        !line.startsWith("\t")
      ) {
        inModelBlock = false;
        sawUseResponsesApi = false;
        output.push(line);
        continue;
      }
      if (/^\s+useResponsesApi:\s*/.test(line)) {
        if (sawUseResponsesApi) {
          continue;
        }
        sawUseResponsesApi = true;
        output.push("    useResponsesApi: false");
        continue;
      }
    }
    output.push(line);
  }
  return output.join("\n");
}

function insertChatModelBlock(yaml: string, block: string): string {
  const lines = yaml.split(/\r?\n/);
  const modelsIdx = lines.findIndex(
    (l) => l.trim() === "models:" || l.trim().startsWith("models:"),
  );
  if (modelsIdx < 0) {
    return `${yaml.trimEnd()}\n\nmodels:\n${block}\n`;
  }
  let insertAt = modelsIdx + 1;
  while (insertAt < lines.length) {
    const trimmed = lines[insertAt].trim();
    const raw = lines[insertAt];
    if (
      trimmed &&
      !trimmed.startsWith("-") &&
      !trimmed.startsWith("#") &&
      !raw.startsWith(" ") &&
      !raw.startsWith("\t")
    ) {
      break;
    }
    insertAt++;
  }
  lines.splice(insertAt, 0, ...block.split("\n"));
  return lines.join("\n");
}

function updateFirstModelBlock(
  yaml: string,
  settings: ModelEnvSettings,
): string {
  const profile: ModelEnvProfile = {
    id: settings.profileId ?? "default",
    profileId: settings.profileId ?? "default",
    provider: settings.provider,
    baseUrl: settings.baseUrl,
    apiKey: settings.apiKey,
    model: settings.model,
  };
  return upsertProfileModelBlocks(yaml, [profile]);
}

/** Update the first model entry without requiring a fixed yaml layout. */
function replaceFirstModelFields(
  yaml: string,
  settings: ModelEnvSettings,
): string {
  const provider = providerForYaml(settings.provider);
  let inModels = false;
  let updatingFirstModel = false;
  let updatedFirstModel = false;
  const lines: string[] = [];

  for (const line of yaml.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (inModels) {
      if (
        trimmed &&
        !trimmed.startsWith("-") &&
        !trimmed.startsWith("#") &&
        !line.startsWith(" ") &&
        !line.startsWith("\t")
      ) {
        inModels = false;
        updatingFirstModel = false;
      }
    }
    if (!inModels) {
      if (trimmed === "models:" || trimmed.startsWith("models:")) {
        inModels = true;
      }
      lines.push(line);
      continue;
    }

    if (updatingFirstModel && trimmed.startsWith("- name:")) {
      updatingFirstModel = false;
      lines.push(line);
      continue;
    }

    if (
      !updatingFirstModel &&
      !updatedFirstModel &&
      trimmed.startsWith("- name:")
    ) {
      lines.push(line.replace(/- name:\s*.+/, `- name: ${settings.model}`));
      updatingFirstModel = true;
      updatedFirstModel = true;
      continue;
    }

    if (updatingFirstModel) {
      if (/^\s+provider:\s*/.test(line)) {
        lines.push(line.replace(/provider:\s*.+/, `provider: ${provider}`));
        continue;
      }
      if (/^\s+model:\s*/.test(line)) {
        lines.push(line.replace(/model:\s*.+/, `model: ${settings.model}`));
        continue;
      }
      if (/^\s+apiBase:\s*/.test(line)) {
        lines.push(
          line.replace(/apiBase:\s*.+/, `apiBase: ${settings.baseUrl}`),
        );
        continue;
      }
      if (/^\s+apiKey:\s*/.test(line)) {
        lines.push(
          line.replace(/apiKey:\s*.+/, `apiKey: "${settings.apiKey}"`),
        );
        updatingFirstModel = false;
        continue;
      }

      if (
        trimmed &&
        !trimmed.startsWith("-") &&
        !line.startsWith(" ") &&
        !line.startsWith("\t")
      ) {
        inModels = false;
        updatingFirstModel = false;
      }
    }

    lines.push(line);
  }

  return lines.join("\n");
}

interface NamedModelBlockFields {
  provider: string;
  model: string;
  apiBase?: string;
  apiKey?: string;
  removeApiKey?: boolean;
  removeApiBase?: boolean;
  removeUseResponsesApi?: boolean;
}

function repairNamedModelBlock(
  yaml: string,
  blockName: string,
  fields: NamedModelBlockFields,
): string {
  const escapedName = blockName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const nameRegex = new RegExp(`^- name:\\s*${escapedName}\\s*$`);
  const lines = yaml.split(/\r?\n/);
  let inTargetBlock = false;
  const output: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();

    if (nameRegex.test(trimmed)) {
      inTargetBlock = true;
      output.push(line);
      continue;
    }

    if (inTargetBlock) {
      if (trimmed.startsWith("- name:")) {
        inTargetBlock = false;
        output.push(line);
        continue;
      }

      if (
        trimmed &&
        !trimmed.startsWith("-") &&
        !line.startsWith(" ") &&
        !line.startsWith("\t")
      ) {
        inTargetBlock = false;
        output.push(line);
        continue;
      }

      if (fields.removeApiKey && /^\s+apiKey:\s*/.test(line)) {
        continue;
      }

      if (
        fields.removeUseResponsesApi &&
        /^\s+useResponsesApi:\s*/.test(line)
      ) {
        continue;
      }

      if (/^\s+provider:\s*/.test(line)) {
        output.push(
          line.replace(/provider:\s*.+/, `provider: ${fields.provider}`),
        );
        continue;
      }
      if (/^\s+model:\s*/.test(line)) {
        output.push(line.replace(/model:\s*.+/, `model: ${fields.model}`));
        continue;
      }
      if (/^\s+apiBase:\s*/.test(line)) {
        if (fields.removeApiBase || fields.apiBase === undefined) {
          continue;
        }
        output.push(
          line.replace(/apiBase:\s*.+/, `apiBase: ${fields.apiBase}`),
        );
        continue;
      }
      if (fields.apiKey !== undefined && /^\s+apiKey:\s*/.test(line)) {
        output.push(line.replace(/apiKey:\s*.+/, `apiKey: "${fields.apiKey}"`));
        continue;
      }
    }

    output.push(line);
  }

  return output.join("\n");
}

const RETIRED_LOCAL_CHAT_NAMES = [
  "Qwen3.5 2B (Local)",
  "Qwen3.5 4B (Local)",
  "Qwen3-VL 4B (Local)",
  "Qwen2.5-Coder 3B (Local)",
  "Qwen2.5-Coder-Tools 3B (Local)",
] as const;

function removeNamedModelBlock(yaml: string, blockName: string): string {
  const escapedName = blockName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const nameRegex = new RegExp(`^- name:\\s*${escapedName}\\s*$`, "m");
  const lines = yaml.split(/\r?\n/);
  let inTargetBlock = false;
  const output: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();

    if (nameRegex.test(trimmed)) {
      inTargetBlock = true;
      continue;
    }

    if (inTargetBlock) {
      if (trimmed.startsWith("- name:")) {
        inTargetBlock = false;
        output.push(line);
        continue;
      }

      if (
        trimmed &&
        !trimmed.startsWith("-") &&
        !line.startsWith(" ") &&
        !line.startsWith("\t")
      ) {
        inTargetBlock = false;
        output.push(line);
        continue;
      }

      continue;
    }

    output.push(line);
  }

  return output.join("\n");
}

function removeRetiredLocalChatBlocks(yaml: string): string {
  let updated = yaml;
  for (const name of RETIRED_LOCAL_CHAT_NAMES) {
    updated = removeNamedModelBlock(updated, name);
  }
  return updated.replace(/\n{3,}/g, "\n\n");
}

/** In-process MiniLM — Cursor-style local embeddings; bundled Ollama is OCR-only. */
export const LOCAL_EMBED = {
  name: "local-embed",
  provider: "transformers.js",
  model: "all-MiniLM-L6-v2",
} as const;

/** @deprecated Use LOCAL_EMBED. Kept so older call sites keep compiling. */
export const OLLAMA_EMBED = LOCAL_EMBED;

function localEmbedYamlBlock(): string {
  return `  - name: ${LOCAL_EMBED.name}
    provider: ${LOCAL_EMBED.provider}
    model: ${LOCAL_EMBED.model}
    roles:
      - embed
`;
}

/** Repair a corrupted embed block that lost its local-embed name. */
function repairEmbedRoleModelBlock(yaml: string): string {
  const pattern =
    /  - name: [^\n]+\n(?:(?:    .+\n))*?    roles:\n      - embed\n(?=\n  - |\ncontext:|\nrules:|$)/m;
  if (!pattern.test(yaml)) {
    return yaml;
  }

  return yaml.replace(pattern, localEmbedYamlBlock());
}

/**
 * Strip retired local chat models (Qwen*) from config.yaml.
 * Bundled Ollama is OCR only — embeddings run in-process via transformers.js.
 */
export function removeLocalChatModels(yaml: string): string {
  return removeRetiredLocalChatBlocks(yaml);
}

export function ensureOllamaEmbedBlock(yaml: string): string {
  return ensureLocalEmbedBlock(yaml);
}

export function ensureLocalEmbedBlock(yaml: string): string {
  if (/(^|\n)\s*- name:\s*local-embed/m.test(yaml)) {
    return repairNamedModelBlock(yaml, LOCAL_EMBED.name, {
      provider: LOCAL_EMBED.provider,
      model: LOCAL_EMBED.model,
      removeApiKey: true,
      removeApiBase: true,
      removeUseResponsesApi: true,
    });
  }

  const repaired = repairEmbedRoleModelBlock(yaml);
  if (repaired !== yaml) {
    return repaired;
  }

  const embedBlock = `
${localEmbedYamlBlock()}`;

  if (/^context:/m.test(yaml)) {
    return yaml.replace(/^context:/m, `${embedBlock}\ncontext:`);
  }
  return yaml + embedBlock;
}

interface SelectedModelsByProfile {
  chat?: string;
  edit?: string;
  apply?: string;
  autocomplete?: string;
  embed?: string;
}

function readGlobalContext(): {
  selectedModelsByProfileId?: Record<string, SelectedModelsByProfile>;
} | null {
  const ctxPath = path.join(getContinueDir(), "index", "globalContext.json");
  if (!fs.existsSync(ctxPath)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(ctxPath, "utf8"));
  } catch {
    return null;
  }
}

export function getSelectedChatModelTitle(
  profileId: string,
): string | undefined {
  return readGlobalContext()?.selectedModelsByProfileId?.[profileId]?.chat;
}

function cloudChatModelTitle(
  settings: ModelEnvSettings | null | undefined,
): string | undefined {
  if (!settings || isOllamaProvider(settings.provider)) {
    return undefined;
  }
  return primaryModelTitle(settings);
}

function isValidChatModelTitle(
  title: string | undefined,
  settings: ModelEnvSettings | null,
): boolean {
  if (!title) {
    return false;
  }
  // Reject retired local chat titles.
  if (
    RETIRED_LOCAL_CHAT_NAMES.includes(
      title as (typeof RETIRED_LOCAL_CHAT_NAMES)[number],
    )
  ) {
    return false;
  }
  if (/\(Local\)$/.test(title) && /^Qwen/i.test(title)) {
    return false;
  }
  const cloud = cloudChatModelTitle(settings);
  if (cloud !== undefined && title === cloud) {
    return true;
  }
  // Accept bare model name as legacy selection for the active profile.
  if (settings?.model && title === settings.model) {
    return true;
  }
  return false;
}

function writeFileIfChanged(filePath: string, content: string): boolean {
  if (fs.existsSync(filePath)) {
    const existing = fs.readFileSync(filePath, "utf8");
    if (existing === content) {
      return false;
    }
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
  return true;
}

export function setEmbedModelSelection(): void {
  const ctxPath = path.join(getContinueDir(), "index", "globalContext.json");
  if (!fs.existsSync(ctxPath)) {
    return;
  }
  const json = fs.readFileSync(ctxPath, "utf8");
  if (!/"embed"\s*:/.test(json)) {
    return;
  }
  const updated = json.replace(
    /"embed"\s*:\s*"[^"]*"/,
    `"embed": "${LOCAL_EMBED.name}"`,
  );
  if (updated === json) {
    return;
  }
  fs.writeFileSync(ctxPath, updated, "utf8");
}

export function selectModelForProfile(
  profileId: string,
  modelTitle: string,
): void {
  const globalContext = new GlobalContext();
  const roles = ["chat", "edit", "apply", "autocomplete"] as const;
  for (const role of roles) {
    globalContext.updateSelectedModel(profileId, role, modelTitle);
  }
  globalContext.updateSelectedModel(profileId, "embed", LOCAL_EMBED.name);
}

/**
 * Keep the user's cloud model selection across .env/config sync.
 * Falls back to the Settings (cloud) model when nothing valid is stored.
 */
export function applyModelSelectionForProfile(
  profileId: string,
  settings: ModelEnvSettings | null,
  options: { forcePrimary?: boolean } = {},
): void {
  if (!settings || isOllamaProvider(settings.provider) || !settings.model) {
    setEmbedModelSelection();
    return;
  }
  const defaultTitle = primaryModelTitle(settings);
  const targetTitle =
    options.forcePrimary ||
    !isValidChatModelTitle(getSelectedChatModelTitle(profileId), settings)
      ? defaultTitle
      : getSelectedChatModelTitle(profileId)!;

  const current = getSelectedChatModelTitle(profileId);
  if (current === targetTitle && isValidChatModelTitle(current, settings)) {
    setEmbedModelSelection();
    return;
  }

  selectModelForProfile(profileId, targetTitle);
}

function applyUseResponsesApi(
  yaml: string,
  provider: string,
  baseUrl: string,
): string {
  // Always strip duplicates first — replace-all-then-one is safer than a single replace.
  let next = dedupeUseResponsesApiKeys(yaml);

  if (provider !== "openai" || isOfficialOpenAiBase(baseUrl)) {
    return next.replace(/\n    useResponsesApi: .+(?=\n)/g, "");
  }

  if (!/useResponsesApi:/.test(next)) {
    return next.replace(
      /^(\s+model: [^\n\r]+)/m,
      `$1\n    useResponsesApi: false`,
    );
  }

  return next.replace(/useResponsesApi: .+/, "useResponsesApi: false");
}

function buildFallbackContinueConfig(
  profiles: readonly ModelEnvProfile[],
): string {
  const chatBlocks = profiles
    .filter((p) => p.apiKey && !isOllamaProvider(p.provider))
    .map((p) => buildChatModelYamlBlock(p))
    .join("\n");

  return `name: Mobius
version: 1.0.0
schema: v1

models:
${chatBlocks || "  []"}

context:
  - provider: code
  - provider: docs
  - provider: diff
  - provider: terminal
  - provider: problems
  - provider: folder
  - provider: codebase

rules:
  - alwaysApply: true
    rule: |
      Act autonomously like Cursor Agent: use tools, do not ask clarifying questions, implement directly.
`;
}

function toProfile(settings: ModelEnvSettings): ModelEnvProfile {
  const id = settings.profileId ?? "default";
  return {
    id,
    profileId: id,
    provider: settings.provider,
    baseUrl: settings.baseUrl,
    apiKey: settings.apiKey,
    model: settings.model,
  };
}

/**
 * Load all named profiles from the authoritative .env.
 */
export function loadModelEnvProfiles(
  workspaceRoot: string,
): ParsedModelEnvFile {
  const resolved = resolveModelEnvContent(workspaceRoot);
  if (resolved) {
    return parseEnvProfiles(resolved.content);
  }
  const defaults = getDefaultModelEnvSettings();
  const profile = toProfile(defaults);
  return {
    activeProfileId: profile.id,
    profiles: [profile],
    passthroughLines: [],
  };
}

export function syncToContinueConfig(
  workspaceRoot: string,
  settings: ModelEnvSettings,
  allProfiles?: readonly ModelEnvProfile[],
  activeProfileIdOverride?: string,
): void {
  const continueDir = getContinueDir();
  fs.mkdirSync(continueDir, { recursive: true });
  const configPath = path.join(continueDir, "config.yaml");
  const envPath = path.join(continueDir, ".env");

  const profileId = settings.profileId ?? "default";
  const withId = { ...settings, profileId };

  let existingEnv = "";
  if (fs.existsSync(envPath)) {
    existingEnv = fs.readFileSync(envPath, "utf8");
  }
  const existingParsed = existingEnv.trim()
    ? parseEnvProfiles(existingEnv)
    : null;

  // Prefer full catalog so sibling profiles survive Settings saves.
  const profiles: ModelEnvProfile[] =
    allProfiles && allProfiles.length
      ? allProfiles.map((p) => (p.id === profileId ? toProfile(withId) : p))
      : existingParsed && existingParsed.profiles.length
        ? existingParsed.profiles.map((p) =>
            p.id === profileId ? toProfile(withId) : p,
          )
        : [toProfile(withId)];

  if (!profiles.some((p) => p.id === profileId)) {
    profiles.push(toProfile(withId));
  }

  const candidateActive =
    activeProfileIdOverride ?? existingParsed?.activeProfileId;
  const activeProfileId =
    candidateActive && profiles.some((p) => p.id === candidateActive)
      ? candidateActive
      : (profiles[0]?.id ?? profileId);

  const nextEnv = serializeEnvProfiles(
    activeProfileId,
    profiles,
    existingParsed?.passthroughLines ?? [],
  );
  writeFileIfChanged(envPath, nextEnv);

  const templatePath = workspaceRoot
    ? resolveContinueConfigTemplate(workspaceRoot)
    : undefined;
  let yaml: string;

  if (fs.existsSync(configPath)) {
    yaml = fs.readFileSync(configPath, "utf8");
  } else if (templatePath) {
    yaml = fs.readFileSync(templatePath, "utf8");
  } else {
    yaml = ensureOllamaEmbedBlock(
      removeLocalChatModels(buildFallbackContinueConfig(profiles)),
    );
    fs.writeFileSync(configPath, yaml, "utf8");
    applyModelSelectionForProfile("local", withId);
    return;
  }

  yaml = yaml.replace("<YOUR_OPENAI_API_KEY>", withId.apiKey);
  yaml = prepareContinueConfigYaml(
    yaml,
    workspaceRoot,
    profiles,
    withId.apiKey,
  );

  const configChanged = writeFileIfChanged(configPath, yaml);
  if (configChanged) {
    setEmbedModelSelection();
  }
  applyModelSelectionForProfile("local", withId);
}

export function loadModelEnv(workspaceRoot: string): ModelEnvSettings {
  const resolved = resolveModelEnvContent(workspaceRoot);
  if (resolved) {
    return readModelEnvFromContent(resolved.content);
  }

  return getDefaultModelEnvSettings();
}

/** Packaged installer `.env`, else SiliconFlow preset defaults. */
export function getDefaultModelEnvSettings(appRoot?: string): ModelEnvSettings {
  const packagedEnvPath = resolvePackagedModelEnvPath(appRoot);
  if (packagedEnvPath && fs.existsSync(packagedEnvPath)) {
    try {
      const packaged = readModelEnvFromContent(
        fs.readFileSync(packagedEnvPath, "utf8"),
      );
      return normalizeModelSettings(packaged).settings;
    } catch {
      // fall through to built-in defaults
    }
  }

  return normalizeModelSettings({
    provider: "",
    baseUrl: "",
    apiKey: "",
    model: "",
  }).settings;
}

/**
 * Force-restore ~/.continue config.yaml + .env to packaged/installer defaults.
 * Never writes the user's workspace `.env` — IDE model settings stay in ~/.continue.
 */
export function resetModelEnvToDefault(
  workspaceRoot: string,
  profileId?: string,
  appRoot?: string,
): { settings: ModelEnvSettings; warning?: string } {
  const { settings, warning } = normalizeModelSettings(
    getDefaultModelEnvSettings(appRoot),
  );
  const withProfile = {
    ...settings,
    profileId: settings.profileId ?? "default",
  };
  const profiles = [toProfile(withProfile)];
  const continueDir = getContinueDir();
  fs.mkdirSync(continueDir, { recursive: true });
  const configPath = path.join(continueDir, "config.yaml");

  const templatePath = resolveContinueConfigTemplate(workspaceRoot, appRoot);
  let yaml: string;
  if (templatePath) {
    yaml = fs.readFileSync(templatePath, "utf8");
    yaml = yaml.replace("<YOUR_OPENAI_API_KEY>", withProfile.apiKey);
    yaml = prepareContinueConfigYaml(
      yaml,
      workspaceRoot,
      profiles,
      withProfile.apiKey,
    );
  } else {
    yaml = ensureOllamaEmbedBlock(
      removeLocalChatModels(buildFallbackContinueConfig(profiles)),
    );
  }

  fs.writeFileSync(configPath, yaml, "utf8");
  writeFileIfChanged(
    path.join(continueDir, ".env"),
    buildEnvFileContent(withProfile),
  );

  setEmbedModelSelection();
  applyModelSelectionForProfile(profileId ?? "local", withProfile, {
    forcePrimary: true,
  });
  return { settings: withProfile, warning };
}

/**
 * Sync Continue config (~/.continue/.env + config.yaml) from the best available
 * .env source. Never writes the workspace `.env` — that avoids undoing user
 * git reverts via the workspace .env file watcher.
 */
export function syncModelEnvFromFiles(
  workspaceRoot: string,
): ModelEnvSettings | null {
  const resolved = resolveModelEnvContent(workspaceRoot);
  if (!resolved) {
    ensureBundledEmbedModels(workspaceRoot);
    return null;
  }

  const parsed = parseEnvProfiles(resolved.content);
  const settings = readModelEnvFromContent(resolved.content);
  if (!settings.apiKey || isOllamaProvider(settings.provider)) {
    ensureBundledEmbedModels(workspaceRoot);
    return null;
  }

  const { settings: normalized } = normalizeModelSettings(settings);
  const profiles = parsed.profiles.map((p) => {
    if (p.id !== (normalized.profileId ?? parsed.activeProfileId)) {
      return p;
    }
    return toProfile({ ...normalized, profileId: p.id });
  });
  syncToContinueConfig(
    workspaceRoot,
    normalized,
    profiles,
    parsed.activeProfileId,
  );
  return normalized;
}

/**
 * Seed ~/.continue from the installer-shipped config/.env when the user has
 * no cloud API key yet. Does not overwrite an existing cloud configuration.
 */
export function seedPackagedDefaultModelEnv(
  workspaceRoot: string,
  appRoot?: string,
): boolean {
  const packagedEnvPath = resolvePackagedModelEnvPath(appRoot);
  if (!packagedEnvPath) {
    return false;
  }

  let packaged: ModelEnvSettings;
  try {
    packaged = readModelEnvFromContent(
      fs.readFileSync(packagedEnvPath, "utf8"),
    );
  } catch {
    return false;
  }

  if (!packaged.apiKey || isOllamaProvider(packaged.provider)) {
    return false;
  }

  const existing = resolveModelEnvContent(workspaceRoot);
  if (existing) {
    const current = readModelEnvFromContent(existing.content);
    if (current.apiKey && !isOllamaProvider(current.provider)) {
      return false;
    }
  }

  const { settings: normalized } = normalizeModelSettings(packaged);
  syncToContinueConfig(workspaceRoot, normalized);
  applyModelSelectionForProfile("local", normalized, { forcePrimary: true });
  return true;
}

/** Ensure in-process transformers.js embed model exists in ~/.continue/config.yaml (no local chat). */
export function ensureBundledEmbedModels(
  workspaceRoot: string,
  appRoot?: string,
): void {
  const continueDir = getContinueDir();
  const configPath = path.join(continueDir, "config.yaml");

  let yaml: string | undefined;
  if (fs.existsSync(configPath)) {
    yaml = fs.readFileSync(configPath, "utf8");
  } else if (workspaceRoot || appRoot) {
    const templatePath = resolveContinueConfigTemplate(workspaceRoot, appRoot);
    if (templatePath) {
      yaml = fs.readFileSync(templatePath, "utf8");
    }
  }

  if (!yaml) {
    return;
  }

  let updated = normalizeModelsSection(yaml);
  updated = removeDuplicateModelBlocks(updated);
  if (isConfigYamlBroken(updated)) {
    const templatePath = resolveContinueConfigTemplate(workspaceRoot, appRoot);
    if (templatePath) {
      updated = fs.readFileSync(templatePath, "utf8");
    }
  }
  const resolved = resolveModelEnvContent(workspaceRoot);
  const envSettings = resolved
    ? readModelEnvFromContent(resolved.content)
    : null;

  updated = ensureOllamaEmbedBlock(removeLocalChatModels(updated));
  // Always rewrite when local chat was stripped (or config was missing).
  if (updated !== yaml || !fs.existsSync(configPath)) {
    fs.mkdirSync(continueDir, { recursive: true });
    writeFileIfChanged(configPath, updated);
  }
  setEmbedModelSelection();
  applyModelSelectionForProfile("local", envSettings);
}

/**
 * Delete a named `[profile]` section from the serialized .env content.
 * If the removed profile was active, picks another profile (or "default") as
 * the new AI_ACTIVE_PROFILE. Does not touch passthrough lines.
 */
export function deleteEnvProfile(
  existingContent: string,
  profileId: string,
): { content: string; activeProfileId: string; removed: boolean } {
  const parsed = existingContent.trim()
    ? parseEnvProfiles(existingContent)
    : {
        activeProfileId: "default",
        profiles: [] as ModelEnvProfile[],
        passthroughLines: [] as string[],
      };
  const remaining = parsed.profiles.filter((p) => p.id !== profileId);
  if (remaining.length === parsed.profiles.length) {
    return {
      content: existingContent,
      activeProfileId: parsed.activeProfileId,
      removed: false,
    };
  }
  const activeProfileId =
    parsed.activeProfileId === profileId
      ? (remaining[0]?.id ?? "default")
      : parsed.activeProfileId;
  return {
    content: serializeEnvProfiles(
      activeProfileId,
      remaining,
      parsed.passthroughLines,
    ),
    activeProfileId,
    removed: true,
  };
}

/**
 * Remove a model block named after a profile id from config.yaml content.
 * Profile blocks use `profileModelTitle(profile.id)` which equals profile.id.
 */
function deleteProfileModelBlockFromYaml(
  yaml: string,
  profileId: string,
): string {
  const title = profileModelTitle(profileId);
  let result = removeNamedModelBlock(yaml, title);
  // Also strip any legacy `<id>/<model>` blocks that may have been written.
  const legacyPrefix = new RegExp(
    `^- name:\\s*${profileId.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}/[^\\n]*$`,
    "m",
  );
  let m: RegExpExecArray | null;
  while ((m = legacyPrefix.exec(result))) {
    result = removeNamedModelBlock(result, m[0].replace(/^- name:\s*/, ""));
  }
  return result;
}

/**
 * Delete a provider profile from ~/.continue/.env and config.yaml, then
 * reload language models. Returns true when a profile was actually removed.
 * Never writes the workspace `.env` (same policy as {@link saveModelEnv}).
 */
export function deleteModelEnv(
  workspaceRoot: string,
  profileId: string,
): { removed: boolean; activeProfileId: string } {
  const continueDir = getContinueDir();
  fs.mkdirSync(continueDir, { recursive: true });
  const envPath = path.join(continueDir, ".env");
  const configPath = path.join(continueDir, "config.yaml");

  if (!fs.existsSync(envPath)) {
    return { removed: false, activeProfileId: "default" };
  }

  const existingEnv = fs.readFileSync(envPath, "utf8");
  const {
    content: nextEnv,
    activeProfileId,
    removed,
  } = deleteEnvProfile(existingEnv, profileId);
  if (!removed) {
    return { removed: false, activeProfileId };
  }
  writeFileIfChanged(envPath, nextEnv);

  if (fs.existsSync(configPath)) {
    const yaml = fs.readFileSync(configPath, "utf8");
    const nextYaml = deleteProfileModelBlockFromYaml(yaml, profileId);
    if (nextYaml !== yaml) {
      writeFileIfChanged(configPath, nextYaml);
    }
  }

  return { removed: true, activeProfileId };
}

/** @deprecated Use {@link ensureBundledEmbedModels} */
export function ensureBundledLocalModels(
  workspaceRoot: string,
  appRoot?: string,
): void {
  ensureBundledEmbedModels(workspaceRoot, appRoot);
}

/**
 * Persist model settings to ~/.continue/.env + config.yaml only.
 * Never creates or modifies the user's workspace `.env` — that file belongs
 * to the project (CMS secrets, etc.), not the IDE.
 */
export function saveModelEnv(
  workspaceRoot: string,
  settings: ModelEnvSettings,
  profileId?: string,
): { warning?: string } {
  const normalizedSettings = {
    ...settings,
    apiKey: settings.apiKey.trim(),
    profileId: settings.profileId ?? "default",
  };
  const { settings: normalized, warning } =
    normalizeModelSettings(normalizedSettings);
  const withProfile = {
    ...normalized,
    profileId: normalized.profileId ?? "default",
  };

  // Prefer full catalog from authoritative source so sibling profiles stay in yaml.
  const resolved = resolveModelEnvContent(workspaceRoot);
  let allProfiles: ModelEnvProfile[] | undefined;
  let activeProfileId: string | undefined;
  if (resolved) {
    const parsed = parseEnvProfiles(resolved.content);
    activeProfileId = parsed.activeProfileId;
    allProfiles = parsed.profiles.map((p) =>
      p.id === withProfile.profileId ? toProfile(withProfile) : p,
    );
    if (!allProfiles.some((p) => p.id === withProfile.profileId)) {
      allProfiles = [...allProfiles, toProfile(withProfile)];
    }
  }

  syncToContinueConfig(
    workspaceRoot,
    withProfile,
    allProfiles,
    activeProfileId,
  );
  applyModelSelectionForProfile(profileId ?? "local", withProfile, {
    forcePrimary: true,
  });
  return { warning };
}

// Backward-compatible aliases
export type OpenAiEnvSettings = ModelEnvSettings;
export const loadOpenAiEnv = loadModelEnv;
export const saveOpenAiEnv = saveModelEnv;
export const readOpenAiEnvFromContent = readModelEnvFromContent;
