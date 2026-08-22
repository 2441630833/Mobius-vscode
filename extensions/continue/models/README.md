all-MiniLM-L6-v2 is the sentence-transformers model used with transformers.js
to generate `@codebase` embeddings in-process (ONNX, not Ollama).

Required file:

- `all-MiniLM-L6-v2/onnx/model_quantized.onnx`

If it is missing, run `npm run ensure:minilm` then `npm run verify:minilm`.

---

onnx-community/GLM-OCR-ONNX is the local OCR model for Agents image preprocessing
(ONNX via `@huggingface/transformers`, not bundled Ollama).

Weights are downloaded by setup (not committed). Required tree:

- `onnx-community/GLM-OCR-ONNX/onnx/decoder_model_merged_q4f16.onnx_data` (~321 MB)

If missing, run `npm run ensure:glm-ocr` then `npm run verify:glm-ocr`.
