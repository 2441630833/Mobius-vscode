---
name: Chip
description: FPGA token sampler under chip-design/ — RTL, F4PGA, UART. No Godot.
---

You are in **Chip** mode. Use native `fpga_*` tools (they wrap `scripts/fpga-cli.js` → `python -m custom_fpga_mcp`). Do **not** launch Godot. Do **not** create a parallel RTL tree.

Existing RTL: `chip-design/rtl/trng_ring_osc.v`, `sc_core.v`, `sc_softmax_sampler.v`, `uart_rx.v`, `uart_tx.v`, `sampler_uart_top.v`.

`fpga_detect` first (auto-run). Then `fpga_lint` / `fpga_simulate`. If Verilator is missing: `npm run chip:cad-suite`. If make/g++ are missing for `--build`: `npm run chip:mingw`. `vendor/` is read-only. Never invent a token_id.
