---
name: Chip
description: Design FPGA samplers with RTL, synth, and UART tokens.
---

You are in **Chip** mode. FPGA / chip-design work, not a game. **Do not open Godot.**

The project **already exists** in `chip-design/`. Vendored EDA sources are in `vendor/` (read-only). **Do not scaffold a new RTL tree**.

## Loop (every request)

1. `fpga_detect` is auto-run at mode start — read its JSON. Missing tools/board are normal.
2. Edit `chip-design/rtl/*.v` (synthesizable Verilog-2001: no delays, no `initial` outside testbenches, reset every register).
3. `fpga_lint` (Verilator, `-DSIMULATION`). If Verilator missing → tell user `npm run chip:cad-suite`. Do **not** install iverilog as a substitute.
4. `fpga_simulate` (statistical testbench). If `--build` fails for missing make/g++ → `npm run chip:mingw`. A sampler can compile and answer every frame while being statistically wrong — only this test catches a swapped logit byte, a CDF off-by-one, or a bad exponent constant.
4b. Before spending board time: `fpga_bound` prints the roofline budget table (K = 8/16/32/64) from the actual device `sc_log2` and UART baud. Use it to pick K when throughput matters — e.g. at 115200 baud, K=8 can be ~4–5x faster than K=32. These are model estimates, never quote them as measured.
4c. When a board IS attached, compare the `model_ms` on each `fpga_sample_token` / `fpga_sample_sequence` result against the measured `ms_per_token`. A large `measured_minus_model_ms` means host-side overhead dominates — that is the thing to optimize, not the FPGA.
5. `fpga_synthesize` (host Yosys + openXC7; Docker F4PGA optional fallback). If native tools missing → `npm run chip:openxc7`. Do **not** fake a bitstream.
6. Board attached: `fpga_close_link` → `fpga_flash` → `fpga_trng_entropy` (prove the entropy source is alive before trusting tokens) → `fpga_sample_token` / `fpga_sample_sequence`.
7. After flash: `fpga_verify_distribution` is the acceptance test. "It answered" is not enough — a dead-TRNG sampler returns argmax every time and looks perfect.

## Hard rules

- **Never invent** a `token_id`, bitstream path, or timing/utilization number you did not read from a tool result.
- Keep the UART framing in `chip-design/rtl/sampler_uart_top.v` byte-compatible with `chip-design/mcp/custom_fpga_mcp/protocol.py`. Change one → change both → update `chip-design/tests/`.
- Logits are signed Q8.8; probabilities Q0.16. Host pre-filters to top-K (K ≤ 64, default 32). The exp_const table in `sc_softmax_sampler.v` encodes that scaling — changing LOGIT_W without regenerating the table silently changes the temperature.
- If setup is incomplete, run `fpga_setup` (or tell the user `npm run chip:setup`) rather than pip-installing into the system interpreter.

## Done means measured

Lint clean + simulation passing + — when a board is attached — a real `token_id` read over UART and `fpga_verify_distribution` consistent with the model. "Files written" is not done.

Throughput claims must pair the `fpga_bound` model number with a measured `tokens/s` from an actual `fpga_sample_sequence` run (Redwood rule: the roofline model is an upper bound, the FPGA measurement is the truth). Never report a model number as if it were measured.
