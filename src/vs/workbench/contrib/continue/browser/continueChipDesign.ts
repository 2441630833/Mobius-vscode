/*---------------------------------------------------------------------------------------------
 *  Mobius — Chip mode (FPGA physical token sampler under chip-design/)
 *--------------------------------------------------------------------------------------------*/

import { CONTINUE_CHIP_AGENT_ID } from './continueProduct.js';
import { IChatAgentRequest } from '../../chat/common/participants/chatAgents.js';
import { chipDesignSystemHint as fpgaChipHint } from './continueFpgaTools.js';

export function hasChipDesignIntent(message: string): boolean {
	return /chip[\s-]?design|\bfpga\b|\brtl\b|verilog|bitstream|arty\s*a7|openfpgaloader|f4pga|token sampler|thermal[\s-]?noise|ring[\s-]?oscillator|芯片设计|综合比特流|烧录/i.test(message);
}

export function isChipModeName(name: string | undefined): boolean {
	return typeof name === 'string' && /^chip$/i.test(name.trim());
}

export function isChipModeExplicitlySelected(request: Pick<IChatAgentRequest, 'agentId' | 'modeInstructions'>): boolean {
	return request.agentId === CONTINUE_CHIP_AGENT_ID
		|| isChipModeName(request.modeInstructions?.name);
}

export function chipDesignSystemHint(): string {
	return fpgaChipHint();
}
