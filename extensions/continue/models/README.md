all-MiniLM-L6-v2 is the sentence-transformers model used with transformers.js
to generate `@codebase` embeddings in-process (ONNX, not Ollama).

Required file:

- `all-MiniLM-L6-v2/onnx/model_quantized.onnx`

If it is missing, run `npm run ensure:minilm` then `npm run verify:minilm`.
