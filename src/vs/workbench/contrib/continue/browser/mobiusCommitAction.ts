/*---------------------------------------------------------------------------------------------
 *  Mobius — one-click AI commit: stage, generate message, commit.
 *--------------------------------------------------------------------------------------------*/

import { localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { ISCMService } from '../../scm/common/scm.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { basename } from '../../../../base/common/resources.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { ChatMessageRole, ILanguageModelsService } from '../../chat/common/languageModels.js';
import { IGitService } from '../../git/common/gitService.js';

function cleanCommitMessage(raw: string): string {
	let text = raw.trim().replace(/\r\n/g, '\n');
	const fenced = /^```(?:text|gitcommit)?\s*([\s\S]*?)\s*```$/i.exec(text);
	if (fenced) {
		text = fenced[1].trim();
	}
	text = text.replace(/^(?:commit message|subject)\s*:\s*/i, '');
	return text;
}

registerAction2(class MobiusGenerateCommitAction extends Action2 {
	constructor() {
		super({
			id: 'mobius.generateCommitMessage',
			title: localize2('mobius.generateCommitMessage', "Generate Commit Message and Commit"),
			f1: false,
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const commandService = accessor.get(ICommandService);
		const logService = accessor.get(ILogService);
		const notificationService = accessor.get(INotificationService);
		const scmService = accessor.get(ISCMService);
		const contextService = accessor.get(IWorkspaceContextService);
		const languageModels = accessor.get(ILanguageModelsService);
		const gitService = accessor.get(IGitService);

		try {
			const workspaceRoot = contextService.getWorkspace().folders[0]?.uri;
			if (!workspaceRoot) {
				notificationService.warn('No workspace folder open.');
				return;
			}

			const repo = await gitService.openRepository(workspaceRoot);
			if (!repo) {
				notificationService.warn('No git repository found.');
				return;
			}

			// 1. Stage all changes
			await commandService.executeCommand('git.stageAll');

			// 2. Read staged diff summary
			const diffChanges = await repo.diffBetweenWithStats2('--cached');
			if (!diffChanges || diffChanges.length === 0) {
				notificationService.info('No staged changes to commit.');
				return;
			}

			const fileSummaries = diffChanges.slice(0, 200).map(c => {
				const path = c.uri.fsPath.replace(workspaceRoot.fsPath + '\\', '').replace(workspaceRoot.fsPath + '/', '');
				return `${path} (+${c.insertions}/-${c.deletions})`;
			});
			let diffText = fileSummaries.join('\n');
			const MAX_DIFF_CHARS = 20_000;
			if (diffText.length > MAX_DIFF_CHARS) {
				diffText = diffText.substring(0, MAX_DIFF_CHARS) + '\n... [truncated]';
			}

			// 3. Get a language model
			const modelIds = await languageModels.selectLanguageModels({});
			if (!modelIds || modelIds.length === 0) {
				notificationService.warn('No AI model available. Configure a model provider in Settings, then try again.');
				return;
			}
			const modelId = modelIds[0];

			// 4. Generate commit message
			const messages = [
				{
					role: ChatMessageRole.System,
					content: [{
						type: 'text' as const,
						value: [
							'You generate concise Git commit messages.',
							'Return ONLY the commit message text, no markdown, no code fences, no explanation.',
							'Use imperative mood. Keep the subject line under 72 characters.',
							'Add a blank line and a body only when the change is non-trivial.',
						].join(' '),
					}],
				},
				{
					role: ChatMessageRole.User,
					content: [{
						type: 'text' as const,
						value: [
							`Repository: ${basename(workspaceRoot)}`,
							'',
							'Staged changes:',
							diffText,
						].join('\n'),
					}],
				},
			];

			notificationService.info('Generating commit message...');

			const response = await languageModels.sendChatRequest(
				modelId,
				undefined,
				messages,
				{},
				CancellationToken.None,
			);

			let message = '';
			for await (const part of response.stream) {
				const parts = Array.isArray(part) ? part : [part];
				for (const p of parts) {
					if (p.type === 'text') {
						message += p.value;
					}
				}
			}

			message = cleanCommitMessage(message);
			if (!message) {
				notificationService.warn('AI returned an empty commit message.');
				return;
			}

			// 5. Put message into SCM input box (so user can see/edit it)
			const scmRepo = scmService.getRepository(workspaceRoot);
			if (scmRepo) {
				scmRepo.input.setValue(message, false);
			}

			// 6. Commit via the built-in git extension (honors signing, hooks, etc.)
			await commandService.executeCommand('git.commitStaged');

			// Actively refresh the git status so the uncommitted-changes observable
			// updates (clearing the file list and Commit button) even if the
			// extension-host change event was not delivered yet.
			try {
				await repo.status();
			} catch {
				// The onDidChange event chain is the fallback; ignore a failed refresh.
			}

			notificationService.info(`Committed: ${message.split('\n')[0]}`);
			logService.info(`[MobiusCommit] Committed: ${message.split('\n')[0]}`);

		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			logService.error('[MobiusCommit] Failed:', msg);
			notificationService.notify({
				severity: Severity.Error,
				message: `Commit failed: ${msg}`,
			});
		}
	}
});
