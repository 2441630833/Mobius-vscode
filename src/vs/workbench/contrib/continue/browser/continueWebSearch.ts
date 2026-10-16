/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';

export const CONTINUE_WEB_SEARCH_ENABLED_SETTING = 'continue.webSearch.enabled';

export function isWebSearchEnabled(configurationService?: IConfigurationService): boolean {
	return configurationService?.getValue<boolean>(CONTINUE_WEB_SEARCH_ENABLED_SETTING) !== false;
}
