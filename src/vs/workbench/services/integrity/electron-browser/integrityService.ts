/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ChecksumPair, IIntegrityService, IntegrityTestResult } from '../common/integrity.js';
import { URI } from '../../../../base/common/uri.js';
import { ILifecycleService, LifecyclePhase } from '../../lifecycle/common/lifecycle.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { FileAccess, AppResourcePath } from '../../../../base/common/network.js';
import { IChecksumService } from '../../../../platform/checksum/common/checksumService.js';
import { ILogService } from '../../../../platform/log/common/log.js';

export class IntegrityService implements IIntegrityService {

	declare readonly _serviceBrand: undefined;

		private readonly isPurePromise: Promise<IntegrityTestResult>;
	isPure(): Promise<IntegrityTestResult> { return this.isPurePromise; }

	constructor(
		@ILifecycleService private readonly lifecycleService: ILifecycleService,
		@IProductService private readonly productService: IProductService,
		@IChecksumService private readonly checksumService: IChecksumService,
		@ILogService private readonly logService: ILogService
	) {
		this.isPurePromise = this._isPure();

		this._compute();
	}

		private async _compute(): Promise<void> {
		const { isPure, proof } = await this.isPure();
		if (isPure) {
			return; // all is good
		}

		// Mobius is a source-build fork: binaries are rebuilt frequently and are
		// not signed/reproducible, so a checksum mismatch is the normal state of
		// the install, not evidence of tampering. The upstream dialog ("Your
		// installation appears to be corrupt, please reinstall") tripped on
		// every queue-built binary, so for this fork it is reduced to a log
		// entry; restore upstream behaviour with: git checkout -- <this file>.
		const failures = proof.filter(p => !p.isPure);
		this.logService.warn([
			'installation files differ from recorded checksums (' +
			'expected only for locally-built / incremental Mobius packages; a real ' +
			'concern only if the files changed without your knowledge):',
			...failures.map(f => `  ${f.uri.path}  (expected ${f.expected}, got ${f.actual})`),
		].join('\n'));
	}

	private async _isPure(): Promise<IntegrityTestResult> {
		const expectedChecksums = this.productService.checksums || {};

		await this.lifecycleService.when(LifecyclePhase.Eventually);

		const allResults = await Promise.all(Object.keys(expectedChecksums).map(filename => this._resolve(<AppResourcePath>filename, expectedChecksums[filename])));

		let isPure = true;
		for (let i = 0, len = allResults.length; i < len; i++) {
			if (!allResults[i].isPure) {
				isPure = false;
				break;
			}
		}

		return {
			isPure,
			proof: allResults
		};
	}

	private async _resolve(filename: AppResourcePath, expected: string): Promise<ChecksumPair> {
		const fileUri = FileAccess.asFileUri(filename);

		try {
			const checksum = await this.checksumService.checksum(fileUri);

			return IntegrityService._createChecksumPair(fileUri, checksum, expected);
		} catch (error) {
			return IntegrityService._createChecksumPair(fileUri, '', expected);
		}
	}

	private static _createChecksumPair(uri: URI, actual: string, expected: string): ChecksumPair {
		return {
			uri: uri,
			actual: actual,
			expected: expected,
			isPure: (actual === expected)
		};
	}

	
}

registerSingleton(IIntegrityService, IntegrityService, InstantiationType.Delayed);
