/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { ToggleWebSearchAction } from '../../browser/continueWebSearchAction.js';
import { CONTINUE_WEB_SEARCH_ENABLED_SETTING, isWebSearchEnabled } from '../../browser/continueWebSearch.js';

suite('Continue Web Search Toggle', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('clicks persist off and on at user scope', async () => {
		const configuration = new TestConfigurationService();
		const writes: unknown[][] = [];
		const notifications: string[] = [];
		const services = store.add(new TestInstantiationService());
		services.stub(IConfigurationService, configuration);
		services.stub(IConfigurationService, 'updateValue', async (key: string, value: unknown, target: ConfigurationTarget) => {
			writes.push([key, value, target]);
			await configuration.setUserConfiguration(key, value);
		});
		services.stub(INotificationService, {
			info: (message: string) => { notifications.push(message); },
		} as INotificationService);
		const action = new ToggleWebSearchAction();
		await services.invokeFunction(accessor => action.run(accessor));
		assert.strictEqual(isWebSearchEnabled(configuration), false);
		await services.invokeFunction(accessor => action.run(accessor));
		assert.strictEqual(isWebSearchEnabled(configuration), true);
		assert.deepStrictEqual(writes, [
			[CONTINUE_WEB_SEARCH_ENABLED_SETTING, false, ConfigurationTarget.USER],
			[CONTINUE_WEB_SEARCH_ENABLED_SETTING, true, ConfigurationTarget.USER],
		]);
		assert.strictEqual(notifications.length, 2);
	});
});
