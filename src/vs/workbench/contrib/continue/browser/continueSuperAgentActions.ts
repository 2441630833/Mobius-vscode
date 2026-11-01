/*---------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { URI } from '../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { Extensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IWorkspaceTrustManagementService } from '../../../../platform/workspace/common/workspaceTrust.js';
import { IWorkbenchEnvironmentService } from '../../../services/environment/common/environmentService.js';
import { IPathService } from '../../../services/path/common/pathService.js';
import { ITerminalService } from '../../terminal/browser/terminal.js';
import { loadContinueModels } from './continueModelConfig.js';

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	id: 'mobiusSuperAgent', title: 'Mobius Background Coding', type: 'object', properties: {
		'mobius.superagent.nodePath': { type: 'string', default: 'node', description: localize('superagent.node', "Node.js 24 executable for the background coding service.") },
		'mobius.superagent.runtimePath': { type: 'string', default: '', description: localize('superagent.runtime', "Optional absolute path to Mobius scripts/superagent/cli.mjs. The installed runtime is detected automatically.") },
	},
});

for (const entry of [
	{ action: 'start', title: localize2('superagent.start', "Mobius: Start Autonomous Background Coding") },
	{ action: 'observe', title: localize2('superagent.observe', "Mobius: Observe Coding Opportunities Only") },
	{ action: 'pause', title: localize2('superagent.pause', "Mobius: Pause Background Coding") },
	{ action: 'stop', title: localize2('superagent.stop', "Mobius: Stop Background Coding") },
	{ action: 'status', title: localize2('superagent.status', "Mobius: Background Coding Status and Panel") },
	{ action: 'init', title: localize2('superagent.init', "Mobius: Initialize Background Coding Policy") },
]) {
	registerAction2(class extends Action2 {
		constructor() { super({ id: `workbench.action.mobius.superagent.${entry.action}`, title: entry.title, f1: true }); }
		override async run(accessor: ServicesAccessor): Promise<void> {
			const config = accessor.get(IConfigurationService);
			const files = accessor.get(IFileService);
			const workspace = accessor.get(IWorkspaceContextService);
			const pathService = accessor.get(IPathService);
			const terminalService = accessor.get(ITerminalService);
			const environment = accessor.get(IWorkbenchEnvironmentService);
			const trust = accessor.get(IWorkspaceTrustManagementService);
			const root = workspace.getWorkspace().folders[0]?.uri;
			if (!root || root.scheme !== 'file' || !trust.isWorkspaceTrusted()) {
				throw new Error(localize('superagent.local', "Open a trusted local Git repository to use background coding."));
			}
			const appRoot = (environment as IWorkbenchEnvironmentService & { appRoot?: string }).appRoot;
			const explicit = config.getValue<string>('mobius.superagent.runtimePath');
			const candidates = explicit ? [URI.file(explicit)] : [
				...(appRoot ? [URI.joinPath(URI.file(appRoot), '..', '..', 'scripts', 'superagent', 'cli.mjs'), URI.joinPath(URI.file(appRoot), '..', 'scripts', 'superagent', 'cli.mjs')] : []),
				URI.joinPath(root, 'scripts', 'superagent', 'cli.mjs'),
			];
			let runtime: URI | undefined;
			for (const candidate of candidates) { if (await files.exists(candidate)) { runtime = candidate; break; } }
			if (!runtime) { throw new Error(localize('superagent.missing', "Background runtime is missing. Set mobius.superagent.runtimePath to the Mobius cli.mjs path.")); }
			const env: Record<string, string> = {};
			if (entry.action === 'start') {
				const models = await loadContinueModels(files, pathService, workspace, appRoot);
				const model = models[0];
				if (!model) { throw new Error(localize('superagent.model', "Configure a Mobius OpenAI-compatible model before starting background coding.")); }
				env.AI_MODEL = model.model; env.AI_API_KEY = model.apiKey; env.AI_BASE_URL = model.apiBase;
			}
			const instance = await terminalService.createTerminal({ config: {
				name: 'Mobius Background Coding', executable: config.getValue<string>('mobius.superagent.nodePath') || 'node',
				args: [runtime.fsPath, entry.action, '--repo', root.fsPath, ...(entry.action === 'start' ? ['--auto'] : [])], cwd: root, env,
			} });
			await terminalService.setActiveInstance(instance);
			await terminalService.revealActiveTerminal();
		}
	});
}
