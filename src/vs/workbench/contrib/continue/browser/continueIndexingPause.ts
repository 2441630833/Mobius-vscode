/*---------------------------------------------------------------------------------------------
 *  Mobius — pause Continue codebase indexing while Agents are running (refcount).
 *--------------------------------------------------------------------------------------------*/

import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ILogService } from '../../../../platform/log/common/log.js';

const CONTINUE_SET_INDEXING_PAUSED = 'continue.setIndexingPaused';

let pauseCount = 0;

/**
 * Pause MiniLM codebase indexing for the lifetime of an Agent turn.
 * Multiple concurrent sessions share one pause via refcount.
 */
export function acquireIndexingPause(
	commandService: ICommandService,
	logService: ILogService,
): () => void {
	pauseCount++;
	if (pauseCount === 1) {
		logService.info('[MobiusEmbed] pausing codebase index (agent session started)');
		void commandService.executeCommand(CONTINUE_SET_INDEXING_PAUSED, true).then(
			undefined,
			(err) => logService.warn('[MobiusEmbed] continue.setIndexingPaused failed', err),
		);
	}
	let released = false;
	return () => {
		if (released) {
			return;
		}
		released = true;
		pauseCount = Math.max(0, pauseCount - 1);
		if (pauseCount === 0) {
			logService.info('[MobiusEmbed] resuming codebase index (all agent sessions idle)');
			void commandService.executeCommand(CONTINUE_SET_INDEXING_PAUSED, false).then(
				undefined,
				(err) => logService.warn('[MobiusEmbed] continue.setIndexingPaused failed', err),
			);
		}
	};
}
