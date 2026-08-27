/*---------------------------------------------------------------------------------------------
 *  Mobius — Agents-window FPGA tools (same CLI as scripts/fpga-cli.js)
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { URI } from '../../../../base/common/uri.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { ILanguageModelToolsService } from '../../chat/common/tools/languageModelToolsService.js';
import type { ContinueAgentToolSchema } from './continueAgentToolsBridge.js';
import { executeRunTerminalCommand, TerminalCommandContext } from './continueTerminalTool.js';

export interface FpgaToolHost {
	readonly fileService: IFileService;
	readonly workspaceService: IWorkspaceContextService;
	readonly appRoot?: string;
}

interface FpgaResolvedPaths {
	readonly mobiusRoot: URI;
	readonly script: URI;
	readonly chipDir: URI;
}

const FPGA_TOOL_NAMES = new Set([
	'fpga_detect',
	'fpga_paths',
	'fpga_setup',
	'fpga_lint',
	'fpga_simulate',
	'fpga_synthesize',
	'fpga_clean',
	'fpga_flash',
	'fpga_list_cables',
	'fpga_device_info',
	'fpga_sample_token',
	'fpga_sample_sequence',
	'fpga_verify_distribution',
	'fpga_trng_entropy',
	'fpga_self_test',
	'fpga_close_link',
	'fpga_reference_distribution',
]);

export function isFpgaTool(name: string): boolean {
	return FPGA_TOOL_NAMES.has(name);
}

const EMPTY_PARAMS = { type: 'object', properties: {} };

export const FPGA_TOOL_SCHEMAS: readonly ContinueAgentToolSchema[] = [
	{
		type: 'function',
		function: {
			name: 'fpga_detect',
			description:
				'Probe chip-design/, vendor/ submodules, Verilator, Yosys, openXC7 (nextpnr-xilinx), openFPGALoader, and the Arty serial port. Call this first. Docker is optional. Missing a board is normal — still run fpga_lint/fpga_simulate.',
			parameters: EMPTY_PARAMS,
		},
	},
	{
		type: 'function',
		function: {
			name: 'fpga_paths',
			description: 'Show resolved Mobius / chip-design / vendor / RTL paths this toolchain is using.',
			parameters: EMPTY_PARAMS,
		},
	},
	{
		type: 'function',
		function: {
			name: 'fpga_setup',
			description: 'List remaining setup commands (venv, submodules, OSS CAD Suite, openXC7) without installing anything.',
			parameters: EMPTY_PARAMS,
		},
	},
	{
		type: 'function',
		function: {
			name: 'fpga_lint',
			description: 'Verilator lint of existing chip-design/rtl (top sampler_uart_top). Do not invent a new RTL tree or install iverilog.',
			parameters: {
				type: 'object',
				properties: {
					top: { type: 'string', description: 'Top module (default: sampler_uart_top).' },
				},
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'fpga_simulate',
			description: 'Run the chip-design/sim Verilator testbench (UART framing, CRC, distribution). Uses vendor-backed RTL already in chip-design/rtl/.',
			parameters: {
				type: 'object',
				properties: {
					samples: { type: 'number', description: 'Draws to collect (default 2000).' },
					seed: { type: 'number', description: 'RNG seed (default 1).' },
				},
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'fpga_synthesize',
			description: 'Host Yosys + openXC7 (nextpnr-xilinx) using tools/oss-cad-suite and tools/openxc7. Docker F4PGA is fallback only. If native tools are missing, tell the user to run npm run chip:openxc7 — do not fake a bitstream.',
			parameters: {
				type: 'object',
				properties: {
					no_pull: { type: 'boolean', description: 'Fail instead of pulling the F4PGA image.' },
					timeout: { type: 'number', description: 'Seconds (default 1800).' },
				},
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'fpga_clean',
			description: 'Delete chip-design/build artefacts.',
			parameters: EMPTY_PARAMS,
		},
	},
	{
		type: 'function',
		function: {
			name: 'fpga_flash',
			description: 'Program the Arty A7 with openFPGALoader (host, not Docker). Call fpga_close_link first if the UART is held.',
			parameters: {
				type: 'object',
				properties: {
					bitstream: { type: 'string', description: 'Bitstream path (default: last synthesize output).' },
					persist: { type: 'boolean', description: 'Write SPI flash instead of SRAM.' },
				},
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'fpga_list_cables',
			description: 'Enumerate JTAG probes via openFPGALoader.',
			parameters: EMPTY_PARAMS,
		},
	},
	{
		type: 'function',
		function: {
			name: 'fpga_device_info',
			description: 'Identify the running bitstream over UART (K, protocol version).',
			parameters: {
				type: 'object',
				properties: {
					port: { type: 'string' },
					baud: { type: 'number' },
				},
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'fpga_sample_token',
			description: 'Draw one token_id on the FPGA from a logit vector. Never invent a token_id.',
			parameters: {
				type: 'object',
				properties: {
					logits: {
						type: 'array',
						items: { type: 'number' },
						description: 'Natural-log logits (top-K window).',
					},
					port: { type: 'string' },
					baud: { type: 'number' },
				},
				required: ['logits'],
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'fpga_sample_sequence',
			description: 'Sample one token per step over a single UART session.',
			parameters: {
				type: 'object',
				properties: {
					steps: {
						type: 'array',
						items: { type: 'array', items: { type: 'number' } },
					},
					port: { type: 'string' },
					baud: { type: 'number' },
				},
				required: ['steps'],
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'fpga_verify_distribution',
			description: 'Repeated hardware draws vs the RTL softmax model. Acceptance test after flash.',
			parameters: {
				type: 'object',
				properties: {
					logits: { type: 'array', items: { type: 'number' } },
					samples: { type: 'number' },
					port: { type: 'string' },
					baud: { type: 'number' },
				},
				required: ['logits'],
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'fpga_trng_entropy',
			description: 'Capture whitened TRNG bytes and run health tests. Prove entropy is alive.',
			parameters: {
				type: 'object',
				properties: {
					n_bytes: { type: 'number' },
					port: { type: 'string' },
					baud: { type: 'number' },
				},
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'fpga_self_test',
			description: 'Identify bitstream, entropy health, one sample, then distribution. Stops at first hard failure.',
			parameters: {
				type: 'object',
				properties: {
					samples: { type: 'number' },
					port: { type: 'string' },
					baud: { type: 'number' },
				},
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'fpga_close_link',
			description: 'Release the cached serial port so openFPGALoader can claim FTDI.',
			parameters: EMPTY_PARAMS,
		},
	},
	{
		type: 'function',
		function: {
			name: 'fpga_reference_distribution',
			description: 'Host-side quantised-softmax model (no board). Compare before blaming hardware.',
			parameters: {
				type: 'object',
				properties: {
					logits: { type: 'array', items: { type: 'number' } },
				},
				required: ['logits'],
			},
		},
	},
];

const CHIP_EXECUTE_HINT = `CHIP DESIGN (Chip mode — FPGA physical token sampler; never open Godot):
The project ALREADY exists. Do not create a parallel RTL tree (no ro_inv.v, no new chip-design/).
Existing synthesizable RTL (edit these, do not replace the top):
  chip-design/rtl/trng_ring_osc.v
  chip-design/rtl/sc_core.v
  chip-design/rtl/sc_softmax_sampler.v
  chip-design/rtl/uart_rx.v
  chip-design/rtl/uart_tx.v
  chip-design/rtl/sampler_uart_top.v
vendor/ is READ-ONLY reference (trng, scsynth, f4pga, litex, …). Never edit a submodule.

You MUST call native tools — never guess iverilog/verilator/docker shell:
1. fpga_detect (auto-run at Chip start) — read its JSON. Missing Verilator/openXC7/board is normal.
2. fpga_lint then fpga_simulate against the files above. If Verilator is missing, say so; do not install iverilog as a substitute.
3. fpga_synthesize uses host Yosys + openXC7 (npm run chip:openxc7). Docker is optional fallback only. If a board: fpga_close_link, fpga_flash, fpga_trng_entropy, fpga_verify_distribution, fpga_sample_token.
4. Never invent a token_id, bitstream path, or timing numbers.

Loop: host logits → UART → ring-oscillator TRNG → stochastic softmax → token_id.`;

export function chipDesignSystemHint(): string {
	return CHIP_EXECUTE_HINT;
}

function quotePs(value: string): string {
	return `'${value.replace(/'/g, "''")}'`;
}

function jsonArg(value: unknown): string {
	return quotePs(JSON.stringify(value));
}

async function resolveFpgaPaths(
	host: FpgaToolHost,
	workingDirectory: URI | undefined,
): Promise<FpgaResolvedPaths | undefined> {
	const folder = workingDirectory ?? host.workspaceService.getWorkspace().folders[0]?.uri;
	const candidates: URI[] = [];
	if (folder) {
		let cur = folder;
		for (let depth = 0; depth < 10; depth++) {
			candidates.push(cur);
			const parent = URI.joinPath(cur, '..');
			if (parent.fsPath === cur.fsPath) {
				break;
			}
			cur = parent;
		}
	}
	if (host.appRoot) {
		const appRootUri = URI.file(host.appRoot);
		for (let depth = 0; depth < 6; depth++) {
			let candidate = appRootUri;
			for (let i = 0; i < depth; i++) {
				candidate = URI.joinPath(candidate, '..');
			}
			candidates.push(candidate);
		}
	}

	for (const root of candidates) {
		const script = URI.joinPath(root, 'scripts', 'fpga-cli.js');
		const chipDir = URI.joinPath(root, 'chip-design');
		if (await host.fileService.exists(script) && await host.fileService.exists(chipDir)) {
			return { mobiusRoot: root, script, chipDir };
		}
	}
	return undefined;
}

export function createFpgaToolHost(
	fileService: IFileService,
	workspaceService: IWorkspaceContextService,
	appRoot?: string,
): FpgaToolHost {
	return { fileService, workspaceService, appRoot };
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
	const value = args[key];
	return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function optionalNumber(args: Record<string, unknown>, key: string): number | undefined {
	const value = args[key];
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function buildFpgaCli(scriptPath: string, name: string, args: Record<string, unknown>, envPrefix = ''): string {
	const parts = [`${envPrefix}node ${quotePs(scriptPath)}`];
	const port = optionalString(args, 'port');
	const baud = optionalNumber(args, 'baud');
	const pushSerial = () => {
		if (port) {
			parts.push('--port', quotePs(port));
		}
		if (baud !== undefined) {
			parts.push('--baud', String(Math.floor(baud)));
		}
	};

	switch (name) {
		case 'fpga_detect':
			parts.push('detect');
			break;
		case 'fpga_paths':
			parts.push('paths');
			break;
		case 'fpga_setup':
			parts.push('setup');
			break;
		case 'fpga_lint':
			parts.push('lint');
			if (optionalString(args, 'top')) {
				parts.push('--top', quotePs(optionalString(args, 'top')!));
			}
			break;
		case 'fpga_simulate': {
			parts.push('simulate');
			const samples = optionalNumber(args, 'samples');
			const seed = optionalNumber(args, 'seed');
			if (samples !== undefined) {
				parts.push('--samples', String(Math.floor(samples)));
			}
			if (seed !== undefined) {
				parts.push('--seed', String(Math.floor(seed)));
			}
			break;
		}
		case 'fpga_synthesize':
			parts.push('synthesize');
			if (args.no_pull === true) {
				parts.push('--no-pull');
			}
			if (optionalNumber(args, 'timeout') !== undefined) {
				parts.push('--timeout', String(optionalNumber(args, 'timeout')));
			}
			break;
		case 'fpga_clean':
			parts.push('clean');
			break;
		case 'fpga_flash':
			parts.push('flash');
			if (optionalString(args, 'bitstream')) {
				parts.push(quotePs(optionalString(args, 'bitstream')!));
			}
			if (args.persist === true) {
				parts.push('--persist');
			}
			break;
		case 'fpga_list_cables':
			parts.push('cables');
			break;
		case 'fpga_device_info':
			parts.push('info');
			pushSerial();
			break;
		case 'fpga_sample_token':
			parts.push('sample', jsonArg(args.logits ?? []));
			pushSerial();
			break;
		case 'fpga_sample_sequence':
			parts.push('sequence', jsonArg(args.steps ?? []));
			pushSerial();
			break;
		case 'fpga_verify_distribution':
			parts.push('verify', jsonArg(args.logits ?? []));
			if (optionalNumber(args, 'samples') !== undefined) {
				parts.push('--samples', String(Math.floor(optionalNumber(args, 'samples')!)));
			}
			pushSerial();
			break;
		case 'fpga_trng_entropy':
			parts.push('entropy');
			if (optionalNumber(args, 'n_bytes') !== undefined) {
				parts.push('--bytes', String(Math.floor(optionalNumber(args, 'n_bytes')!)));
			}
			pushSerial();
			break;
		case 'fpga_self_test':
			parts.push('self-test');
			if (optionalNumber(args, 'samples') !== undefined) {
				parts.push('--samples', String(Math.floor(optionalNumber(args, 'samples')!)));
			}
			pushSerial();
			break;
		case 'fpga_close_link':
			parts.push('close');
			break;
		case 'fpga_reference_distribution':
			parts.push('reference', jsonArg(args.logits ?? []));
			break;
		default:
			parts.push('detect');
	}
	return parts.join(' ');
}

export async function executeFpgaTool(
	host: FpgaToolHost,
	toolsService: ILanguageModelToolsService,
	logService: ILogService,
	context: TerminalCommandContext,
	toolName: string,
	args: Record<string, unknown>,
	token: CancellationToken,
): Promise<{ ok: boolean; text: string }> {
	const paths = await resolveFpgaPaths(host, context.workingDirectory);
	if (!paths) {
		return {
			ok: false,
			text: 'Cannot locate scripts/fpga-cli.js and chip-design/. Open the Mobius repo (or packaged resources/mobius-chip) as the workspace root.',
		};
	}
	const envPrefix = `$env:MOBIUS_ROOT=${quotePs(paths.mobiusRoot.fsPath)}; `;
	const command = buildFpgaCli(paths.script.fsPath, toolName, args, envPrefix);
	logService.info(`[Continue][FPGA] ${toolName} → MOBIUS_ROOT=${paths.mobiusRoot.fsPath}`);
	return executeRunTerminalCommand(
		toolsService,
		logService,
		context,
		command,
		true,
		token,
	);
}

export async function bootstrapChipModeDetect(
	host: FpgaToolHost,
	toolsService: ILanguageModelToolsService,
	logService: ILogService,
	context: TerminalCommandContext,
	token: CancellationToken,
): Promise<{ ok: boolean; text: string }> {
	return executeFpgaTool(host, toolsService, logService, context, 'fpga_detect', {}, token);
}
