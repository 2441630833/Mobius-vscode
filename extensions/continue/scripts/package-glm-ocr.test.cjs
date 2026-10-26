const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  MODEL_FILES,
  ensureModel,
  packageRuntime,
} = require("./package-glm-ocr");

function fixtures() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mobius-ocr-fixture-"));
  const extension = path.join(root, "extensions/vscode");
  fs.mkdirSync(path.join(root, "core/node_modules/@huggingface/transformers"), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(root, "core/node_modules/@huggingface/transformers/package.json"),
    JSON.stringify({ version: "4.2.0" })
  );
  return { root, extension };
}

test("packages a target-specific isolated dependency graph, independent of skip flag", () => {
  const { extension } = fixtures();
  for (const target of [
    "win32-x64",
    "win32-arm64",
    "linux-x64",
    "linux-arm64",
    "darwin-x64",
    "darwin-arm64",
  ]) {
    let args, options;
    const runtime = packageRuntime(
      extension,
      target,
      (_exe, received, opts) => {
        args = received.join(" ");
        options = opts;
        return { status: 0 };
      }
    );
    assert(args.includes(`--os=${target.split("-")[0]}`));
    assert(args.includes(`--cpu=${target.split("-")[1]}`));
    assert(args.includes("--include=optional"));
    assert(args.includes("--ignore-scripts"));
    assert.equal(options.cwd, runtime);
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(runtime, "package.json")))
        .dependencies["@huggingface/transformers"],
      "4.2.0"
    );
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(runtime, "package.json")))
        .overrides?.["onnxruntime-node"],
      target === "darwin-x64" ? "1.23.2" : undefined
    );
  }
  assert.throws(() => packageRuntime(extension, "win32-ia32"), /Unsupported/);
  assert.throws(
    () => packageRuntime(extension, "linux-x64", () => ({ status: 1 })),
    /install failed/
  );
});

test("keeps complete model files offline and repairs invalid/missing metadata", async () => {
  const { root } = fixtures();
  const models = path.join(root, "models");
  for (const name of MODEL_FILES) {
    const file = path.join(models, "onnx-community/GLM-OCR-ONNX", name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, name.endsWith(".json") ? "{}" : "model");
    if (name.endsWith(".onnx_data")) fs.truncateSync(file, 11 * 1024 * 1024);
  }
  await ensureModel(models, () => {
    throw new Error("must remain offline");
  });
  const config = path.join(models, "onnx-community/GLM-OCR-ONNX/config.json");
  fs.writeFileSync(config, "version https://git-lfs.github.com/spec/v1");
  const requests = [];
  await ensureModel(models, async (url) => {
    requests.push(url);
    return requests.length === 1
      ? new Response("not JSON")
      : new Response('{"model_type":"glm_ocr"}');
  });
  assert.equal(requests.length, 2);
  assert(requests[1].startsWith("https://hf-mirror.com/"));
  assert.equal(JSON.parse(fs.readFileSync(config)).model_type, "glm_ocr");
});
