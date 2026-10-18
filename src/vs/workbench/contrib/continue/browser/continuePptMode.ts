/*---------------------------------------------------------------------------------------------
 *  Mobius — PPT mode (presentation and slide deck generation powered by ppt-master)
 *--------------------------------------------------------------------------------------------*/

import { CONTINUE_PPT_AGENT_ID } from './continueProduct.js';
import { FileAccess } from '../../../../base/common/network.js';
import { URI } from '../../../../base/common/uri.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IChatAgentRequest } from '../../chat/common/participants/chatAgents.js';

export function hasPptIntent(message: string): boolean {
	const text = message.trim();
	return /^\/ppt\b/i.test(text)
		|| /\b(ppt|pptx|powerpoint|slides|slide\s*deck|presentation|pitch\s*deck|keynote)\b/i.test(text)
		|| /(生成|制作|导出|做|设计|写).{0,16}(pptx?|幻灯片|演示|deck|课件)/i.test(text)
		|| /(演示文稿|幻灯片|演讲稿|课件制作)/i.test(text);
}

export function isPptModeName(name: string | undefined): boolean {
	return typeof name === 'string' && /^ppt$/i.test(name.trim());
}

export function isPptModeExplicitlySelected(request: Pick<IChatAgentRequest, 'agentId' | 'modeInstructions'>): boolean {
	return request.agentId === CONTINUE_PPT_AGENT_ID
		|| isPptModeName(request.modeInstructions?.name);
}

export interface PptMasterSkill {
	readonly directory: URI;
	readonly instructions: string;
}

/** Resolve installation resources, never paths relative to a presentation workspace. */
export async function loadPptMasterSkill(fileService: Pick<IFileService, 'readFile'>, appRoot: string | undefined): Promise<PptMasterSkill | undefined> {
	const resourcePath = 'vs/workbench/contrib/continue/mobius/skills/ppt-master';
	const candidates = [FileAccess.asFileUri(resourcePath)];
	if (appRoot) {
		candidates.push(URI.joinPath(URI.file(appRoot), 'out', resourcePath));
	}
	for (const directory of candidates) {
		try {
			const instructions = (await fileService.readFile(URI.joinPath(directory, 'SKILL.md'))).value.toString();
			if (instructions.trim()) {
				return { directory, instructions };
			}
		} catch {
			// A missing or unreadable resource must not become a guessed workspace path.
		}
	}
	return undefined;
}

export function pptModeSystemHint(skill: PptMasterSkill): string {
	const skillDir = skill.directory.fsPath.replace(/\\/g, '/');
	return `You are in PPT Mode — dedicated to presentation design, slide deck creation, and PPTX generation.
- Powered by the bundled ppt-master engine. Its verified absolute base directory (SKILL_DIR) is ${JSON.stringify(skillDir)}.
- The contents of ${JSON.stringify(`${skillDir}/SKILL.md`)} are loaded below. Follow its mandatory load order and selected workflow.
- Resolve every relative workflow, reference, template, and script path against SKILL_DIR. Expand the concrete absolute path in each tool call; quote paths in terminal commands.
- Never look for the engine in the user's presentation workspace. Keep generated presentations in that workspace, not in SKILL_DIR.
- Do NOT open Godot.

<ppt-master-skill>
${skill.instructions}
</ppt-master-skill>`;
}
