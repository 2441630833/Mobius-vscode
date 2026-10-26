const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { Readable } = require("node:stream");
const { pipeline } = require("node:stream/promises");

const MODEL_ID = "onnx-community/GLM-OCR-ONNX";
const MODEL_FILES = [
  "config.json",
  "generation_config.json",
  "preprocessor_config.json",
  "processor_config.json",
  "tokenizer.json",
  "tokenizer_config.json",
  "chat_template.jinja",
  ...["vision_encoder", "embed_tokens", "decoder_model_merged"].flatMap(
    (name) => [`onnx/${name}_q4f16.onnx`, `onnx/${name}_q4f16.onnx_data`]
  ),
];

function validModelFile(filename, modelName = filename) {
  try {
    const size = fs.statSync(filename).size;
    if (size < (modelName.endsWith(".onnx_data") ? 10 * 1024 * 1024 : 1))
      return false;
    if (modelName.endsWith(".json"))
      JSON.parse(fs.readFileSync(filename, "utf8"));
    const descriptor = fs.openSync(filename, "r");
    try {
      const prefix = Buffer.alloc(64);
      fs.readSync(descriptor, prefix, 0, prefix.length, 0);
      return !prefix
        .toString()
        .startsWith("version https://git-lfs.github.com/");
    } finally {
      fs.closeSync(descriptor);
    }
  } catch {
    return false;
  }
}

async function ensureModel(modelsDirectory, fetchImpl = fetch) {
  const directory = path.join(modelsDirectory, MODEL_ID);
  await Promise.all(
    MODEL_FILES.map(async (relative) => {
      const destination = path.join(directory, relative);
      if (validModelFile(destination)) return;
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      const temporary = `${destination}.download`;
      const failures = [];
      for (const origin of [
        "https://huggingface.co",
        "https://hf-mirror.com",
      ]) {
        try {
          const response = await fetchImpl(
            `${origin}/${MODEL_ID}/resolve/main/${relative}`,
            { signal: AbortSignal.timeout(600_000) }
          );
          if (!response.ok || !response.body)
            throw new Error(`HTTP ${response.status}`);
          await pipeline(
            Readable.fromWeb(response.body),
            fs.createWriteStream(temporary)
          );
          if (!validModelFile(temporary, relative)) {
            throw new Error("incomplete model file or invalid JSON");
          }
          fs.renameSync(temporary, destination);
          return;
        } catch (error) {
          failures.push(`${origin}: ${error.message}`);
        }
        fs.rmSync(temporary, { force: true });
      }
      throw new Error(
        `GLM-OCR model download failed for ${relative}: ${failures.join("; ")}`
      );
    })
  );
}

function packageRuntime(extensionDirectory, target, install = spawnSync) {
  const [os, cpu] = target.split("-");
  if (
    !["win32", "linux", "darwin"].includes(os) ||
    !["x64", "arm64"].includes(cpu)
  ) {
    throw new Error(`Unsupported OCR runtime target: ${target}`);
  }
  const coreManifest = JSON.parse(
    fs.readFileSync(
      path.join(
        extensionDirectory,
        "../../core/node_modules/@huggingface/transformers/package.json"
      ),
      "utf8"
    )
  );
  const version = coreManifest.version;
  const runtime = path.join(extensionDirectory, "out/glm-ocr-runtime");
  fs.mkdirSync(runtime, { recursive: true });
  fs.writeFileSync(
    path.join(runtime, "package.json"),
    JSON.stringify(
      {
        name: "mobius-local-ocr-runtime",
        version: "1.0.0",
        private: true,
        dependencies: { "@huggingface/transformers": version },
        // ORT 1.24's npm tarball omits Intel macOS binaries. Keep the compatible
        // CPU runtime that still includes that target, rather than shipping no binding.
        ...(target === "darwin-x64"
          ? { overrides: { "onnxruntime-node": "1.23.2" } }
          : {}),
      },
      null,
      2
    )
  );
  // Keep Transformers' newer ORT separate from MiniLM's ORT 1.14. CPU native
  // bindings and sharp platform packages ship in npm; CUDA install scripts are unnecessary.
  const args = [
    "install",
    "--omit=dev",
    "--include=optional",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    `--os=${os}`,
    `--cpu=${cpu}`,
  ];
  const result =
    process.platform === "win32"
      ? install(
          process.env.ComSpec || "cmd.exe",
          ["/d", "/s", "/c", `npm ${args.join(" ")}`],
          { cwd: runtime, stdio: "inherit" }
        )
      : install("npm", args, { cwd: runtime, stdio: "inherit" });
  if (result.error || result.status !== 0)
    throw new Error(
      `GLM-OCR runtime install failed: ${
        result.error?.message ?? result.status
      }`
    );
  return runtime;
}

function validateRuntime(extensionDirectory, target) {
  const runtime = path.join(extensionDirectory, "out/glm-ocr-runtime");
  const [os, cpu] = target.split("-");
  const bin = path.join(runtime, "node_modules/onnxruntime-node/bin");
  if (
    !fs.existsSync(bin) ||
    !fs
      .readdirSync(bin)
      .some((abi) =>
        fs.existsSync(path.join(bin, abi, os, cpu, "onnxruntime_binding.node"))
      )
  ) {
    throw new Error(`GLM-OCR native ONNX binding missing for ${target}`);
  }
  if (
    !fs.existsSync(
      path.join(runtime, "node_modules/@img", `sharp-${target}`, "package.json")
    )
  ) {
    throw new Error(`GLM-OCR native image decoder missing for ${target}`);
  }
}

function validatePackage(extensionDirectory, target) {
  validateRuntime(extensionDirectory, target);
  for (const relative of MODEL_FILES) {
    if (
      !validModelFile(
        path.join(extensionDirectory, "models", MODEL_ID, relative)
      )
    ) {
      throw new Error(`GLM-OCR model file missing/incomplete: ${relative}`);
    }
  }
}

async function packageGlmOcr(extensionDirectory, target) {
  packageRuntime(extensionDirectory, target);
  validateRuntime(extensionDirectory, target);
  await ensureModel(path.join(extensionDirectory, "models"));
  validatePackage(extensionDirectory, target);
  console.log(`[info] Bundled local GLM-OCR runtime and model for ${target}`);
}

module.exports = {
  MODEL_FILES,
  validModelFile,
  ensureModel,
  packageRuntime,
  packageGlmOcr,
  validatePackage,
};
if (require.main === module) {
  const directory = path.resolve(__dirname, "..");
  const verifyOnly = process.argv[2] === "--verify";
  const target =
    process.argv[verifyOnly ? 3 : 2] || `${process.platform}-${process.arch}`;
  Promise.resolve()
    .then(() =>
      verifyOnly
        ? validatePackage(directory, target)
        : packageGlmOcr(directory, target)
    )
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
