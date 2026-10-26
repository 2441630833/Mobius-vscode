// Exercise the packaged worker with no source-checkout NODE_PATH fallback.
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");
const { fork } = require("node:child_process");
const { MODEL_FILES, validModelFile } = require("./package-glm-ocr");

async function verify(extensionDirectory, execPath = process.execPath) {
  const models = path.join(extensionDirectory, "models");
  for (const name of MODEL_FILES) {
    if (
      !validModelFile(path.join(models, "onnx-community/GLM-OCR-ONNX", name))
    ) {
      throw new Error(`Missing/incomplete local GLM-OCR model: ${name}`);
    }
  }
  const runtimeRequire = createRequire(
    path.join(extensionDirectory, "out/glm-ocr-runtime/package.json")
  );
  const sharp = runtimeRequire("sharp");
  const image = await sharp(
    Buffer.from(
      '<svg width="480" height="120"><rect width="100%" height="100%" fill="white"/><text x="25" y="80" font-family="Arial" font-size="55" fill="black">OCR 123</text></svg>'
    )
  )
    .png()
    .toBuffer();
  const child = fork(
    path.join(extensionDirectory, "out/transformersJsGlmOcrWorker.js"),
    [],
    {
      execPath,
      execArgv: [],
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        GLM_OCR_LOCAL_MODEL_PATH: models,
        MOBIUS_GLM_OCR_DEVICE: "cpu",
        NODE_PATH: "",
        NODE_OPTIONS: "",
      },
    }
  );
  let stderr = "";
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`OCR smoke timed out: ${stderr}`)),
        120_000
      );
      const results = new Map();
      child.stdout.resume();
      child.stderr.on("data", (bytes) => {
        stderr = (stderr + bytes).slice(-8000);
      });
      child.on("error", reject);
      child.on("close", (code, signal) =>
        reject(new Error(`OCR child closed (${code}/${signal}): ${stderr}`))
      );
      child.on("message", (message) => {
        if (message.type === "init-error" || message.ok === false) {
          clearTimeout(timer);
          reject(new Error(message.error));
          return;
        }
        if (message.type === "ready") {
          console.log(
            `OCR worker ready (${process.platform}/${process.arch}, device=${message.device}, executable=${execPath})`
          );
          // Two attachments in the same OCR call, as in the reported failure.
          for (const id of [1, 2])
            child.send({
              id,
              op: "ocr",
              base64: image.toString("base64"),
              mimeType: "image/png",
              maxNewTokens: 32,
            });
        }
        if (message.ok === true) {
          results.set(message.id, message.text);
          console.log(
            `OCR image ${message.id}: ${JSON.stringify(message.text)}`
          );
          if (!/OCR\s*123/i.test(message.text)) {
            clearTimeout(timer);
            reject(new Error("OCR did not recognize the fixture text"));
            return;
          }
          if (results.size === 2) {
            clearTimeout(timer);
            resolve();
          }
        }
      });
    });
  } finally {
    child.kill();
  }
  console.log(
    "Packaged GLM-OCR passed two-image inference without source runtime fallback"
  );
}

module.exports = { verify };
if (require.main === module) {
  verify(
    path.resolve(process.argv[2] || path.join(__dirname, "..")),
    process.argv[3]
  ).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
