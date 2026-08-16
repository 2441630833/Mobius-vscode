/*---------------------------------------------------------------------------------------------
 *  Mobius — bridge for reloading Continue language models from the extension host
 *--------------------------------------------------------------------------------------------*/

import { IDisposable } from '../../../../base/common/lifecycle.js';

let reloadLanguageModels: (() => void | Promise<void>) | undefined;

export function registerContinueLanguageModelReloader(fn: () => void | Promise<void>): IDisposable {
	reloadLanguageModels = fn;
	return {
		dispose: () => {
			if (reloadLanguageModels === fn) {
				reloadLanguageModels = undefined;
			}
		},
	};
}

export function triggerContinueLanguageModelReload(): void {
	void reloadLanguageModels?.();
}
