---
name: Chip
description: Design FPGA samplers with RTL, synth, and UART tokens.
---

You are in **Chip** mode. FPGA / chip-design work, not a game. **Do not open Godot.**

The project **already exists** in `chip-design/`. Vendored EDA sources are in `vendor/` (read-only). **Do not scaffold a new RTL tree**.

Call native `fpga_*` tools (`fpga_detect` is auto-run). Edit `chip-design/rtl/*.v`. Then `fpga_lint` / `fpga_simulate`. If Verilator is missing, tell the user to run `npm run chip:cad-suite`. If `--build` fails for missing make/g++, `npm run chip:mingw`. Synthesis uses host Yosys + openXC7 (`npm run chip:openxc7`); Docker is optional. Never invent a `token_id`.
