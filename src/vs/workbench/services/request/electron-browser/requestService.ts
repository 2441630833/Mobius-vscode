/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { AbstractRequestService, AuthInfo, Credentials, IRequestService } from '../../../../platform/request/common/request.js';
import { RequestChannelClient } from '../../../../platform/request/common/requestIpc.js';
import { INativeHostService } from '../../../../platform/native/common/native.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { IRequestContext, IRequestOptions } from '../../../../base/parts/request/common/request.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { request } from '../../../../base/parts/request/common/requestImpl.js';
import { ILoggerService } from '../../../../platform/log/common/log.js';
import { localize } from '../../../../nls.js';
import { windowLogGroup } from '../../log/common/logConstants.js';
import { LogService } from '../../../../platform/log/common/logService.js';

function isCleartextHttpUrl(url: string | undefined): boolean {
	return typeof url === 'string' && /^http:\/\//i.test(url);
}

function hasAuthorizationHeader(headers: IRequestOptions['headers']): boolean {
	if (!headers) {
		return false;
	}
	return Object.keys(headers).some(key => /^authorization$/i.test(key));
}

/**
 * Prefer the Node/Electron net stack (shared process) when Chromium fetch would fail:
 * - cleartext http:// from vscode-file:// (mixed content)
 * - https:// LLM gateways that omit Authorization from Access-Control-Allow-Headers (Volcengine Ark, etc.)
 */
function shouldRequestViaSharedProcess(options: IRequestOptions): boolean {
	const url = options.url;
	if (isCleartextHttpUrl(url)) {
		return true;
	}
	if (typeof url === 'string' && /^https:\/\//i.test(url) && hasAuthorizationHeader(options.headers)) {
		return true;
	}
	return false;
}

export class NativeRequestService extends AbstractRequestService implements IRequestService {

	declare readonly _serviceBrand: undefined;

	constructor(
		@INativeHostService private readonly nativeHostService: INativeHostService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ISharedProcessService private readonly sharedProcessService: ISharedProcessService,
		@ILoggerService loggerService: ILoggerService,
	) {
		const logger = loggerService.createLogger(`network`, { name: localize('network', "Network"), group: windowLogGroup });
		const logService = new LogService(logger);
		super(logService);
		this._register(logger);
		this._register(logService);
	}

	async request(options: IRequestOptions, token: CancellationToken): Promise<IRequestContext> {
		if (!options.proxyAuthorization) {
			options.proxyAuthorization = this.configurationService.inspect<string>('http.proxyAuthorization').userLocalValue;
		}

		if (shouldRequestViaSharedProcess(options)) {
			return this.logAndRequest(options, () => this._requestViaSharedProcess(options, token));
		}

		return this.logAndRequest(options, () => request(options, token, () => navigator.onLine));
	}

	private _requestViaSharedProcess(options: IRequestOptions, token: CancellationToken): Promise<IRequestContext> {
		const channel = this.sharedProcessService.getChannel('request');
		return new RequestChannelClient(channel).request(options, token);
	}

	async resolveProxy(url: string): Promise<string | undefined> {
		return this.nativeHostService.resolveProxy(url);
	}

	async lookupAuthorization(authInfo: AuthInfo): Promise<Credentials | undefined> {
		return this.nativeHostService.lookupAuthorization(authInfo);
	}

	async lookupKerberosAuthorization(url: string): Promise<string | undefined> {
		return this.nativeHostService.lookupKerberosAuthorization(url);
	}

	async loadCertificates(): Promise<string[]> {
		return this.nativeHostService.loadCertificates();
	}
}

registerSingleton(IRequestService, NativeRequestService, InstantiationType.Delayed);
