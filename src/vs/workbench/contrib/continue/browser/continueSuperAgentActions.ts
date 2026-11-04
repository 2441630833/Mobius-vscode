/*---------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { URI } from '../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { resolvePath } from '../../../../base/common/resources.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IStatusbarService, StatusbarAlignment } from '../../../services/statusbar/browser/statusbar.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
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

const superAgentMenu = 'workbench.action.mobius.superagent.show';
interface BackgroundStatus { mode?: string; active?: number; pending?: number; attention?: readonly object[]; stopped?: boolean; updatedAt?: number; url?: string }

async function stateDirectory(files: IFileService, root: URI): Promise<URI> {
	let git = URI.joinPath(root, '.git');
	if (!(await files.stat(git)).isDirectory) {
		const pointer = (await files.readFile(git)).value.toString().trim();
		if (!pointer.startsWith('gitdir: ')) { throw new Error('Invalid Git worktree metadata'); }
		git = resolvePath(root, pointer.slice(8).trim());
	}
	const common = URI.joinPath(git, 'commondir');
	if (await files.exists(common)) { git = resolvePath(git, (await files.readFile(common)).value.toString().trim()); }
	return URI.joinPath(git, 'mobius-superagent');
}

export function superAgentStatusLabel(status: BackgroundStatus | undefined, now = Date.now()): string {
	if (!status || status.stopped) { return localize('superagent.off', 'Not running'); }
	if (!status.updatedAt || now - status.updatedAt > 15000) { return localize('superagent.unknown', 'Status unavailable'); }
	return localize('superagent.live', '{0} · {1} running · {2} need attention', status.mode ?? 'unknown', status.active ?? 0, status.attention?.length ?? 0);
}

async function readStatus(files: IFileService, root?: URI): Promise<{ directory?: URI; status?: BackgroundStatus }> {
	if (!root || root.scheme !== 'file') { return {}; }
	try {
		const directory = await stateDirectory(files, root);
		try { return { directory, status: JSON.parse((await files.readFile(URI.joinPath(directory, 'status.json'))).value.toString()) }; }
		catch { return { directory }; }
	} catch { return {}; }
}

registerAction2(class extends Action2 {
	constructor() {
		super({ id: superAgentMenu, title: localize2('superagent.show', 'Super Agent: Background Coding'), icon: Codicon.hubot, f1: true,
			menu: [{ id: MenuId.ChatInput, group: 'navigation', order: 7 }] });
	}
	override async run(accessor: ServicesAccessor): Promise<void> {
		const files = accessor.get(IFileService); const workspace = accessor.get(IWorkspaceContextService);
		const quickInput = accessor.get(IQuickInputService); const commands = accessor.get(ICommandService);
		const opener = accessor.get(IOpenerService); const editor = accessor.get(IEditorService);
		const { status, directory } = await readStatus(files, workspace.getWorkspace().folders[0]?.uri);
		const selected = await quickInput.pick([
			{ label: localize('superagent.openPanel', 'Open Results Panel'), action: 'panel', description: superAgentStatusLabel(status) },
			{ label: localize('superagent.enable', 'Start / Resume Autonomous Coding'), action: 'start', description: localize('superagent.usesModel', 'Uses your configured model; creates review branches in separate worktrees') },
			{ label: localize('superagent.pauseMenu', 'Pause New Tasks'), action: 'pause' },
			{ label: localize('superagent.stopMenu', 'Stop Background Coding'), action: 'stop' },
			{ label: localize('superagent.rulesMenu', 'Project Rules and Budgets'), action: 'policy' },
			{ label: localize('superagent.statusMenu', 'Inspect Background Status'), action: 'status' },
		], { title: 'Super Agent', placeHolder: localize('superagent.explain', 'Discovers project work automatically. Only useful results and blockers need your attention.') });
		if (!selected) { return; }
		if (selected.action === 'panel' && status && !status.stopped && status.updatedAt && Date.now() - status.updatedAt < 15000 && /^http:\/\/127\.0\.0\.1:\d+$/.test(status.url ?? '')) {
			await opener.open(URI.parse(status.url!), { openExternal: true }); return;
		}
		if (selected.action === 'policy' && directory && await files.exists(URI.joinPath(directory, 'config.json'))) {
			await editor.openEditor({ resource: URI.joinPath(directory, 'config.json') }); return;
		}
		await commands.executeCommand(`workbench.action.mobius.superagent.${selected.action === 'panel' ? 'status' : selected.action === 'policy' ? 'init' : selected.action}`);
	}
});

class SuperAgentStatusContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'mobius.superagent.status';
	constructor(@IStatusbarService statusbar: IStatusbarService, @IFileService files: IFileService, @IWorkspaceContextService workspace: IWorkspaceContextService) {
		super();
		const base = { name: 'Super Agent', text: '$(hubot) Super Agent', ariaLabel: 'Super Agent', command: superAgentMenu };
		const entry = this._register(statusbar.addEntry({ ...base, tooltip: localize('superagent.statusTip', 'Proactive background coding — click to manage') }, SuperAgentStatusContribution.ID, StatusbarAlignment.RIGHT, 50));
		const timer = this._register(new RunOnceScheduler(() => { void update(); }, 5000));
		const update = async () => {
			const { status } = await readStatus(files, workspace.getWorkspace().folders[0]?.uri);
			if (this._store.isDisposed) { return; }
			entry.update({ ...base, text: `${base.text}: ${superAgentStatusLabel(status)}`, tooltip: localize('superagent.statusTip', 'Proactive background coding — click to manage') });
			timer.schedule();
		};
		void update();
	}
}
registerWorkbenchContribution2(SuperAgentStatusContribution.ID, SuperAgentStatusContribution, WorkbenchPhase.AfterRestored);

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
