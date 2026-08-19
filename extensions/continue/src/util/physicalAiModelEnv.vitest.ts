import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildEnvFileContent,
  dedupeUseResponsesApiKeys,
  ensureLocalEmbedBlock,
  envFileProfileRichness,
  getDefaultModelEnvSettings,
  normalizeModelSettings,
  parseEnvProfiles,
  profileModelTitle,
  PROVIDER_IDS,
  PROVIDER_PRESETS,
  providerForYaml,
  resetModelEnvToDefault,
  saveModelEnv,
  syncModelEnvFromFiles,
  upsertAiModelEnvKeys,
  upsertEnvProfile,
  type ModelEnvSettings,
} from "./physicalAiModelEnv";

const sampleSettings: ModelEnvSettings = {
  provider: "openai",
  baseUrl: "http://ai.demxs.com/v1",
  apiKey: "sk-test-key",
  model: "demx_llm",
};

describe("upsertAiModelEnvKeys", () => {
  it("builds a Mobius-only file when existing content is empty", () => {
    expect(upsertAiModelEnvKeys("", sampleSettings)).toBe(
      buildEnvFileContent(sampleSettings),
    );
  });

  it("preserves non-AI project keys when inserting AI_*", () => {
    const existing = `CMS_ALLOW_PUBLIC_ADMIN=false
# SSE unique code
SSE_UNIQUE_CODE=abc123
`;
    const merged = upsertAiModelEnvKeys(existing, sampleSettings);
    expect(merged).toContain("CMS_ALLOW_PUBLIC_ADMIN=false");
    expect(merged).toContain("SSE_UNIQUE_CODE=abc123");
    expect(merged).toContain("AI_PROVIDER=openai");
    expect(merged).toContain("AI_MODEL=demx_llm");
    expect(merged).toContain("# Mobius - model configuration");
  });

  it("updates existing AI_* keys in place without dropping others", () => {
    const existing = `FOO=bar
AI_PROVIDER=anthropic
AI_BASE_URL=https://api.anthropic.com/v1
AI_API_KEY=old
AI_MODEL=claude
BAZ=qux
`;
    const merged = upsertAiModelEnvKeys(existing, sampleSettings);
    expect(merged).toContain("FOO=bar");
    expect(merged).toContain("BAZ=qux");
    expect(merged).toContain("AI_PROVIDER=openai");
    expect(merged).toContain("AI_BASE_URL=http://ai.demxs.com/v1");
    expect(merged).toContain("AI_API_KEY=sk-test-key");
    expect(merged).toContain("AI_MODEL=demx_llm");
    expect(merged).not.toContain("AI_PROVIDER=anthropic");
  });

  it("rewrites encoding-corrupted Mobius comment headers to ASCII", () => {
    const existing = `# Mobius 鈥?model configuration
AI_PROVIDER=openai
AI_BASE_URL=http://ai.demxs.com/v1/
AI_API_KEY=old
AI_MODEL=demx_llm
`;
    const merged = upsertAiModelEnvKeys(existing, sampleSettings);
    expect(merged).toContain("# Mobius - model configuration");
    expect(merged).not.toContain("鈥?");
  });
});

describe("syncModelEnvFromFiles / saveModelEnv disk behavior", () => {
  let workspaceRoot: string;
  let continueDir: string;
  let prevContinueGlobalDir: string | undefined;

  beforeEach(() => {
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mobius-ws-"));
    continueDir = fs.mkdtempSync(path.join(os.tmpdir(), "mobius-continue-"));
    prevContinueGlobalDir = process.env.CONTINUE_GLOBAL_DIR;
    process.env.CONTINUE_GLOBAL_DIR = continueDir;
  });

  afterEach(() => {
    if (prevContinueGlobalDir === undefined) {
      delete process.env.CONTINUE_GLOBAL_DIR;
    } else {
      process.env.CONTINUE_GLOBAL_DIR = prevContinueGlobalDir;
    }
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
    fs.rmSync(continueDir, { recursive: true, force: true });
  });

  it("does not overwrite a project .env that has no AI_* keys (revert scenario)", () => {
    const projectEnv = `CMS_ALLOW_PUBLIC_ADMIN=false
# SSE unique code
SSE_UNIQUE_CODE=abc123
`;
    fs.writeFileSync(path.join(workspaceRoot, ".env"), projectEnv, "utf8");
    fs.writeFileSync(
      path.join(continueDir, ".env"),
      buildEnvFileContent(sampleSettings),
      "utf8",
    );

    const result = syncModelEnvFromFiles(workspaceRoot);

    expect(result).not.toBeNull();
    expect(result?.model).toBe("demx_llm");
    expect(fs.readFileSync(path.join(workspaceRoot, ".env"), "utf8")).toBe(
      projectEnv,
    );
    expect(fs.readFileSync(path.join(continueDir, ".env"), "utf8")).toContain(
      "AI_MODEL=demx_llm",
    );
  });

  it("still syncs Continue config from ~/.continue when workspace has no AI_*", () => {
    fs.writeFileSync(
      path.join(workspaceRoot, ".env"),
      "CMS_ALLOW_PUBLIC_ADMIN=false\n",
      "utf8",
    );
    fs.writeFileSync(
      path.join(continueDir, ".env"),
      buildEnvFileContent(sampleSettings),
      "utf8",
    );

    syncModelEnvFromFiles(workspaceRoot);

    expect(fs.existsSync(path.join(continueDir, "config.yaml"))).toBe(true);
    const yaml = fs.readFileSync(path.join(continueDir, "config.yaml"), "utf8");
    expect(yaml).toContain("demx_llm");
    expect(yaml).toContain("http://ai.demxs.com/v1");
  });

  it("saveModelEnv writes only ~/.continue/.env and leaves workspace .env untouched", () => {
    const projectEnv = `CMS_ALLOW_PUBLIC_ADMIN=false
SSE_UNIQUE_CODE=abc123
`;
    fs.writeFileSync(path.join(workspaceRoot, ".env"), projectEnv, "utf8");

    saveModelEnv(workspaceRoot, sampleSettings);

    expect(fs.readFileSync(path.join(workspaceRoot, ".env"), "utf8")).toBe(
      projectEnv,
    );
    const continueEnv = fs.readFileSync(path.join(continueDir, ".env"), "utf8");
    expect(continueEnv).toContain("AI_PROVIDER=openai");
    expect(continueEnv).toContain("AI_MODEL=demx_llm");
  });

  it("saveModelEnv does not create a workspace .env when the project has none", () => {
    expect(fs.existsSync(path.join(workspaceRoot, ".env"))).toBe(false);

    saveModelEnv(workspaceRoot, sampleSettings);

    expect(fs.existsSync(path.join(workspaceRoot, ".env"))).toBe(false);
    expect(fs.existsSync(path.join(continueDir, ".env"))).toBe(true);
  });

  it("after reverting workspace .env, sync leaves the restored content unchanged", () => {
    const restored = `CMS_ALLOW_PUBLIC_ADMIN=false
SSE_UNIQUE_CODE=abc123
`;
    // Pretend Continue still has AI settings from a prior sync.
    fs.writeFileSync(
      path.join(continueDir, ".env"),
      buildEnvFileContent(sampleSettings),
      "utf8",
    );
    // User reverted workspace .env via git.
    fs.writeFileSync(path.join(workspaceRoot, ".env"), restored, "utf8");

    syncModelEnvFromFiles(workspaceRoot);

    expect(fs.readFileSync(path.join(workspaceRoot, ".env"), "utf8")).toBe(
      restored,
    );
  });
});

describe("siliconflow provider preset", () => {
  it("is selectable and OpenAI-compatible", () => {
    expect(PROVIDER_IDS).toContain("siliconflow");
    expect(PROVIDER_PRESETS.siliconflow.label).toBe("SiliconFlow");
    expect(PROVIDER_PRESETS.siliconflow.baseUrl).toBe(
      "https://api.siliconflow.cn/v1",
    );
    expect(PROVIDER_PRESETS.siliconflow.openAiCompatible).toBe(true);
    expect(providerForYaml("siliconflow")).toBe("siliconflow");
  });

  it("keeps siliconflow for SiliconFlow-compatible gateways", () => {
    const { settings, warning } = normalizeModelSettings({
      provider: "siliconflow",
      baseUrl: "https://api.siliconflow.cn/v1",
      apiKey: "sk-test",
      model: "Qwen/QwQ-32B",
    });
    expect(settings.provider).toBe("siliconflow");
    expect(settings.baseUrl).toBe("https://api.siliconflow.cn/v1/");
    expect(warning).toBeUndefined();
  });

  it("auto-appends /v1/ when SiliconFlow base URL omits it", () => {
    const { settings } = normalizeModelSettings({
      provider: "siliconflow",
      baseUrl: "https://api.siliconflow.cn",
      apiKey: "sk-test",
      model: "moonshotai/Kimi-K2.7-Code",
    });
    expect(settings.baseUrl).toBe("https://api.siliconflow.cn/v1/");
  });

  it("forces siliconflow provider when Base URL is a Silinex gateway", () => {
    const { settings, warning } = normalizeModelSettings({
      provider: "openai",
      baseUrl: "https://api.sr.silinex.work/v1/",
      apiKey: "sk-test",
      model: "moonshotai/Kimi-K2.7-Code",
    });
    expect(settings.provider).toBe("siliconflow");
    expect(warning).toMatch(/SiliconFlow/i);
  });

  it("writes siliconflow into Continue config.yaml", () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mobius-sf-"));
    const continueDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "mobius-sf-continue-"),
    );
    const prev = process.env.CONTINUE_GLOBAL_DIR;
    process.env.CONTINUE_GLOBAL_DIR = continueDir;

    try {
      saveModelEnv(workspaceRoot, {
        provider: "siliconflow",
        baseUrl: "https://api.siliconflow.cn/v1",
        apiKey: "sk-test",
        model: "Qwen/QwQ-32B",
      });

      const yaml = fs.readFileSync(
        path.join(continueDir, "config.yaml"),
        "utf8",
      );
      expect(yaml).toContain("provider: siliconflow");
      expect(yaml).toContain("apiBase: https://api.siliconflow.cn/v1");
      expect(yaml).toContain("model: Qwen/QwQ-32B");
      expect(yaml).not.toMatch(/useResponsesApi:/);
    } finally {
      if (prev === undefined) {
        delete process.env.CONTINUE_GLOBAL_DIR;
      } else {
        process.env.CONTINUE_GLOBAL_DIR = prev;
      }
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
      fs.rmSync(continueDir, { recursive: true, force: true });
    }
  });
});

describe("dedupeUseResponsesApiKeys", () => {
  it("keeps a single useResponsesApi per model block", () => {
    const yaml = `models:
  - name: volcano
    provider: openai
    model: ark-code-latest
    apiBase: https://example.com/v3/
    apiKey: "sk-test"
    useResponsesApi: false
    useResponsesApi: false
    useResponsesApi: false
    roles:
      - chat
`;
    const next = dedupeUseResponsesApiKeys(yaml);
    expect(next.match(/useResponsesApi:/g)?.length).toBe(1);
    expect(next).toContain("    useResponsesApi: false");
  });

  it("saveModelEnv does not accumulate duplicate useResponsesApi on re-save", () => {
    const workspaceRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "mobius-ura-ws-"),
    );
    const continueDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "mobius-ura-continue-"),
    );
    const prev = process.env.CONTINUE_GLOBAL_DIR;
    process.env.CONTINUE_GLOBAL_DIR = continueDir;

    try {
      const settings: ModelEnvSettings = {
        provider: "openai",
        baseUrl: "https://ark.cn-beijing.volces.com/api/coding/v3/",
        apiKey: "sk-test",
        model: "ark-code-latest",
      };
      saveModelEnv(workspaceRoot, settings);
      saveModelEnv(workspaceRoot, settings);
      saveModelEnv(workspaceRoot, settings);

      const yaml = fs.readFileSync(
        path.join(continueDir, "config.yaml"),
        "utf8",
      );
      expect(yaml.match(/useResponsesApi:/g)?.length).toBe(1);
    } finally {
      if (prev === undefined) {
        delete process.env.CONTINUE_GLOBAL_DIR;
      } else {
        process.env.CONTINUE_GLOBAL_DIR = prev;
      }
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
      fs.rmSync(continueDir, { recursive: true, force: true });
    }
  });
});

describe("resetModelEnvToDefault", () => {
  it("clears cloud providers and leaves an embed-only config (no built-in key)", () => {
    const workspaceRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "mobius-reset-ws-"),
    );
    const continueDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "mobius-reset-continue-"),
    );
    const prev = process.env.CONTINUE_GLOBAL_DIR;
    process.env.CONTINUE_GLOBAL_DIR = continueDir;

    try {
      saveModelEnv(workspaceRoot, {
        provider: "siliconflow",
        baseUrl: "https://api.siliconflow.cn/v1",
        apiKey: "sk-custom",
        model: "Qwen/QwQ-32B",
      });

      const { settings } = resetModelEnvToDefault(workspaceRoot);
      const defaults = getDefaultModelEnvSettings();

      // No bundled cloud key -> defaults are empty; user must onboard.
      expect(settings.provider).toBe(defaults.provider);
      expect(settings.apiKey).toBe("");
      expect(defaults.apiKey).toBe("");

      const yaml = fs.readFileSync(
        path.join(continueDir, "config.yaml"),
        "utf8",
      );
      // local embed remains; no cloud chat block was seeded by reset.
      expect(yaml).toContain("name: local-embed");
      expect(yaml).toContain("provider: transformers.js");
      expect(yaml).toContain("all-MiniLM-L6-v2");
      expect(yaml).not.toContain("nomic-embed-text");
      expect(yaml).not.toContain("Qwen/QwQ-32B");

      const continueEnv = fs.readFileSync(
        path.join(continueDir, ".env"),
        "utf8",
      );
      expect(continueEnv).toContain(`AI_PROVIDER=${defaults.provider}`);

      // Reset must not create/pollute the project .env.
      expect(fs.existsSync(path.join(workspaceRoot, ".env"))).toBe(false);
    } finally {
      if (prev === undefined) {
        delete process.env.CONTINUE_GLOBAL_DIR;
      } else {
        process.env.CONTINUE_GLOBAL_DIR = prev;
      }
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
      fs.rmSync(continueDir, { recursive: true, force: true });
    }
  });
});

describe("parseEnvProfiles", () => {
  it("parses named sections and AI_ACTIVE_PROFILE", () => {
    const content = `# Mobius - model configuration
AI_ACTIVE_PROFILE=volcano

[siliconflow]
AI_PROVIDER=siliconflow
AI_BASE_URL=https://api.siliconflow.cn/v1
AI_API_KEY=sk-sf
AI_MODEL=deepseek-ai/DeepSeek-V3

[volcano]
AI_PROVIDER=openai
AI_BASE_URL=https://ark.example/v3
AI_API_KEY=ark-key
AI_MODEL=ark-code-latest
`;
    const parsed = parseEnvProfiles(content);
    expect(parsed.activeProfileId).toBe("volcano");
    expect(parsed.profiles.map((p) => p.id)).toEqual([
      "volcano",
      "siliconflow",
    ]);
    expect(profileModelTitle("siliconflow", "deepseek-ai/DeepSeek-V3")).toBe(
      "siliconflow",
    );
    expect(parsed.profiles[0].model).toBe("ark-code-latest");
  });

  it("treats flat AI_* as profile default", () => {
    const content = `AI_PROVIDER=openai
AI_BASE_URL=https://api.openai.com/v1
AI_API_KEY=sk-x
AI_MODEL=gpt-4o
`;
    const parsed = parseEnvProfiles(content);
    expect(parsed.activeProfileId).toBe("default");
    expect(parsed.profiles).toHaveLength(1);
    expect(parsed.profiles[0].id).toBe("default");
    expect(parsed.profiles[0].model).toBe("gpt-4o");
  });

  it("upsertEnvProfile preserves sibling sections and AI_ACTIVE_PROFILE", () => {
    const existing = `# Mobius - model configuration
AI_ACTIVE_PROFILE=volcano

[volcano]
AI_PROVIDER=openai
AI_BASE_URL=https://ark.example/v3
AI_API_KEY=old
AI_MODEL=ark-code-latest

[siliconflow]
AI_PROVIDER=siliconflow
AI_BASE_URL=https://api.siliconflow.cn/v1
AI_API_KEY=sk-sf
AI_MODEL=deepseek-ai/DeepSeek-V3
`;
    const next = upsertEnvProfile(existing, "volcano", {
      provider: "openai",
      baseUrl: "https://ark.example/v3",
      apiKey: "new-key",
      model: "ark-code-latest",
      profileId: "volcano",
    });
    expect(next).toContain("AI_ACTIVE_PROFILE=volcano");
    expect(next).toContain("AI_API_KEY=new-key");
    expect(next).toContain("[siliconflow]");
    expect(next).toContain("sk-sf");
  });

  it("prefers multi-profile workspace over flattened continue .env", () => {
    const multi = `AI_ACTIVE_PROFILE=volcano\n[volcano]\nAI_MODEL=a\n[intranet]\nAI_MODEL=b\n`;
    const flat = `AI_PROVIDER=openai\nAI_MODEL=demx_llm\nAI_API_KEY=x\n`;
    expect(envFileProfileRichness(multi)).toBeGreaterThan(
      envFileProfileRichness(flat),
    );
  });
});

describe("ensureLocalEmbedBlock", () => {
  it("migrates Ollama nomic-embed-text to in-process transformers.js", () => {
    const yaml = `name: Mobius
version: 1.0.0
schema: v1

models:
  - name: local-embed
    provider: ollama
    model: nomic-embed-text
    apiBase: http://127.0.0.1:25137
    roles:
      - embed

context:
  - provider: code
`;
    const updated = ensureLocalEmbedBlock(yaml);
    expect(updated).toContain("provider: transformers.js");
    expect(updated).toContain("model: all-MiniLM-L6-v2");
    expect(updated).not.toContain("nomic-embed-text");
    expect(updated).not.toContain("127.0.0.1:25137");
    expect(updated).toContain("name: local-embed");
  });

  it("inserts a transformers.js embed block when none exists", () => {
    const yaml = `name: Mobius
models:
  - name: gpt
    provider: openai
    model: gpt-4o

context:
  - provider: code
`;
    const updated = ensureLocalEmbedBlock(yaml);
    expect(updated).toContain("name: local-embed");
    expect(updated).toContain("provider: transformers.js");
    expect(updated.indexOf("name: local-embed")).toBeLessThan(
      updated.indexOf("context:"),
    );
  });
});
