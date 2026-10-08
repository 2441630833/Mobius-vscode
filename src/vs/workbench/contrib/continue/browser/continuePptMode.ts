/*---------------------------------------------------------------------------------------------
 *  Mobius — PPT mode (presentation and slide deck generation powered by ppt-master)
 *--------------------------------------------------------------------------------------------*/

import { CONTINUE_PPT_AGENT_ID } from './continueProduct.js';
import { IChatAgentRequest } from '../../chat/common/participants/chatAgents.js';

export function hasPptIntent(message: string): boolean {
	return /\b(ppt|pptx|powerpoint|slides|slide\s*deck|presentation|pitch\s*deck|keynote)\b|演示文稿|幻灯片|做ppt|生成ppt|制作ppt|演讲稿|课件制作/i.test(message);
}

export function isPptModeName(name: string | undefined): boolean {
	return typeof name === 'string' && /^ppt$/i.test(name.trim());
}

export function isPptModeExplicitlySelected(request: Pick<IChatAgentRequest, 'agentId' | 'modeInstructions'>): boolean {
	return request.agentId === CONTINUE_PPT_AGENT_ID
		|| isPptModeName(request.modeInstructions?.name);
}

export function pptModeSystemHint(): string {
	return `You are in PPT Mode — dedicated to presentation design, slide deck creation, and PPTX generation.
- Powered by the ppt-master engine (.agents/skills/ppt-master/).
- Do NOT open Godot.
- When generating presentations: provide clear structure (Title, Agenda, Content slides, Summary), visual hierarchy, and actionable design cues.
- You can utilize Python tools in .agents/skills/ppt-master/scripts/ for deck creation, SVG generation, text measurement, and PPTX authoring.`;
}
