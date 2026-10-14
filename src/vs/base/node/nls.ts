/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { join } from '../common/path.js';
import { promises } from 'fs';
import { mark } from '../common/performance.js';
import { ILanguagePack, ILanguagePacks, INLSConfiguration } from '../../nls.js';
import { Promises } from './pfs.js';

export interface IResolveNLSConfigurationContext {

	/**
	 * Location where `nls.messages.json` and `nls.keys.json` are stored.
	 */
	readonly nlsMetadataPath: string;

	/**
	 * Path to the user data directory. Used as a cache for
	 * language packs converted to the format we need.
	 */
	readonly userDataPath: string;

	/**
	 * Commit of the running application. Can be `undefined`
	 * when not built.
	 */
	readonly commit: string | undefined;

	/**
	 * Locale as defined in `argv.json` or `app.getLocale()`.
	 */
	readonly userLocale: string;

	/**
	 * Locale as defined by the OS (e.g. `app.getPreferredSystemLanguages()`).
	 */
	readonly osLocale: string;
}

export async function resolveNLSConfiguration({ userLocale, osLocale, userDataPath, commit, nlsMetadataPath }: IResolveNLSConfigurationContext): Promise<INLSConfiguration> {
	mark('code/willGenerateNls');

	const effectiveCommit = commit || 'dev';
	if (
		userLocale === 'pseudo' ||
		userLocale.startsWith('en') ||
		!userDataPath
	) {
		return defaultNLSConfiguration(userLocale, osLocale, nlsMetadataPath);
	}

	try {
		const languagePacks = await getLanguagePackConfigurations(userDataPath, nlsMetadataPath);
		if (!languagePacks) {
			return defaultNLSConfiguration(userLocale, osLocale, nlsMetadataPath);
		}

		const resolvedLanguage = resolveLanguagePackLanguage(languagePacks, userLocale);
		if (!resolvedLanguage) {
			return defaultNLSConfiguration(userLocale, osLocale, nlsMetadataPath);
		}

		const languagePack = languagePacks[resolvedLanguage];
		const mainLanguagePackPath = languagePack?.translations?.['vscode'];
		if (
			!languagePack ||
			typeof languagePack.hash !== 'string' ||
			!languagePack.translations ||
			typeof mainLanguagePackPath !== 'string' ||
			!(await Promises.exists(mainLanguagePackPath))
		) {
			return defaultNLSConfiguration(userLocale, osLocale, nlsMetadataPath);
		}

		const languagePackId = `${languagePack.hash}.${resolvedLanguage}`;
		const globalLanguagePackCachePath = join(userDataPath, 'clp', languagePackId);
		const commitLanguagePackCachePath = join(globalLanguagePackCachePath, effectiveCommit);
		const languagePackMessagesFile = join(commitLanguagePackCachePath, 'nls.messages.json');
		const translationsConfigFile = join(globalLanguagePackCachePath, 'tcf.json');
		const languagePackCorruptMarkerFile = join(globalLanguagePackCachePath, 'corrupted.info');

		if (await Promises.exists(languagePackCorruptMarkerFile)) {
			await promises.rm(globalLanguagePackCachePath, { recursive: true, force: true, maxRetries: 3 }); // delete corrupted cache folder
		}

		const result: INLSConfiguration = {
			userLocale,
			osLocale,
			resolvedLanguage,
			defaultMessagesFile: join(nlsMetadataPath, 'nls.messages.json'),
			languagePack: {
				translationsConfigFile,
				messagesFile: languagePackMessagesFile,
				corruptMarkerFile: languagePackCorruptMarkerFile
			},

			// NLS: below properties are a relic from old times only used by vscode-nls and deprecated
			locale: userLocale,
			availableLanguages: { '*': resolvedLanguage },
			_languagePackId: languagePackId,
			_languagePackSupport: true,
			_translationsConfigFile: translationsConfigFile,
			_cacheRoot: globalLanguagePackCachePath,
			_resolvedLanguagePackCoreLocation: commitLanguagePackCachePath,
			_corruptedFile: languagePackCorruptMarkerFile
		};

		if (await Promises.exists(languagePackMessagesFile)) {
			touch(commitLanguagePackCachePath).catch(() => { }); // We don't wait for this. No big harm if we can't touch
			mark('code/didGenerateNls');
			return result;
		}

		let keysPath = join(nlsMetadataPath, 'nls.keys.json');
		let messagesPath = join(nlsMetadataPath, 'nls.messages.json');
		if (!(await Promises.exists(keysPath))) {
			const fallbackKeys = join(nlsMetadataPath, '..', 'out-build', 'nls.keys.json');
			const fallbackMessages = join(nlsMetadataPath, '..', 'out-build', 'nls.messages.json');
			if (await Promises.exists(fallbackKeys)) {
				keysPath = fallbackKeys;
				messagesPath = fallbackMessages;
			}
		}

		const [
			nlsDefaultKeys,
			nlsDefaultMessages,
			nlsPackdata
		]:
			[Array<[string, string[]]>, string[], { contents: Record<string, Record<string, string>> }]
			//      ^moduleId ^nlsKeys                               ^moduleId      ^nlsKey ^nlsValue
			= await Promise.all([
				promises.readFile(keysPath, 'utf-8').then(content => JSON.parse(content)),
				promises.readFile(messagesPath, 'utf-8').then(content => JSON.parse(content)),
				promises.readFile(mainLanguagePackPath, 'utf-8').then(content => JSON.parse(content)),
			]);

		const nlsResult: string[] = [];

		// We expect NLS messages to be in a flat array in sorted order as they
		// where produced during build time. We use `nls.keys.json` to know the
		// right order and then lookup the related message from the translation.
		// If a translation does not exist, we fallback to the default message.

		let nlsIndex = 0;
		for (const [moduleId, nlsKeys] of nlsDefaultKeys) {
			const moduleTranslations = nlsPackdata.contents[moduleId];
			for (const nlsKey of nlsKeys) {
				nlsResult.push(moduleTranslations?.[nlsKey] || nlsDefaultMessages[nlsIndex]);
				nlsIndex++;
			}
		}

		await promises.mkdir(commitLanguagePackCachePath, { recursive: true });

		await Promise.all([
			promises.writeFile(languagePackMessagesFile, JSON.stringify(nlsResult), 'utf-8'),
			promises.writeFile(translationsConfigFile, JSON.stringify(languagePack.translations), 'utf-8')
		]);

		mark('code/didGenerateNls');

		return result;
	} catch (error) {
		console.error('Generating translation files failed.', error);
	}

	return defaultNLSConfiguration(userLocale, osLocale, nlsMetadataPath);
}

interface IBundledLanguagePackResult {
	languageId: string;
	pack: ILanguagePack;
}

async function findBundledLanguagePack(nlsMetadataPath?: string): Promise<IBundledLanguagePackResult | undefined> {
	const candidateDirNames = ['vscode-language-pack-zh-hans', 'ms-ceintl.vscode-language-pack-zh-hans'];
	const searchRoots: string[] = [];

	if (nlsMetadataPath) {
		searchRoots.push(join(nlsMetadataPath, '..', 'extensions'));
		searchRoots.push(join(nlsMetadataPath, '..', '..', 'extensions'));
	}
	searchRoots.push(join(process.cwd(), 'vscode', 'extensions'));
	searchRoots.push(join(process.cwd(), 'resources', 'app', 'extensions'));
	searchRoots.push(join(process.cwd(), 'extensions'));

	for (const root of searchRoots) {
		for (const dirName of candidateDirNames) {
			const candidateDir = join(root, dirName);
			const pkgPath = join(candidateDir, 'package.json');
			try {
				if (await Promises.exists(pkgPath)) {
					const pkgContent = await promises.readFile(pkgPath, 'utf-8');
					const pkg = JSON.parse(pkgContent);
					const localizations = pkg.contributes?.localizations;
					if (Array.isArray(localizations) && localizations.length > 0) {
						const loc = localizations.find((l: any) => l.languageId === 'zh-cn') || localizations[0];
						const translations: { [id: string]: string } = {};
						if (Array.isArray(loc.translations)) {
							for (const t of loc.translations) {
								if (t.id && t.path) {
									translations[t.id] = join(candidateDir, t.path);
								}
							}
						}
						const hash = 'mobius-builtin-zh-hans';
						return {
							languageId: loc.languageId || 'zh-cn',
							pack: {
								hash,
								label: loc.localizedLanguageName || loc.languageName || '中文(简体)',
								extensions: [{
									extensionIdentifier: { id: pkg.name || 'ms-ceintl.vscode-language-pack-zh-hans' },
									version: pkg.version || '1.0.0'
								}],
								translations
							}
						};
					}
				}
			} catch {
				// continue searching other roots
			}
		}
	}
	return undefined;
}

/**
 * The `languagepacks.json` file is a JSON file that contains all metadata
 * about installed language extensions per language. Specifically, for
 * core (`vscode`) and all extensions it supports, it points to the related
 * translation files.
 *
 * The file is updated whenever a new language pack is installed or removed.
 */
async function getLanguagePackConfigurations(userDataPath: string, nlsMetadataPath?: string): Promise<ILanguagePacks | undefined> {
	const configFile = join(userDataPath, 'languagepacks.json');
	let languagePacks: ILanguagePacks | undefined = undefined;
	try {
		languagePacks = JSON.parse(await promises.readFile(configFile, 'utf-8'));
	} catch (err) {
		languagePacks = undefined;
	}

	if (!languagePacks || Object.keys(languagePacks).length === 0 || !languagePacks['zh-cn']) {
		const bundled = await findBundledLanguagePack(nlsMetadataPath);
		if (bundled) {
			languagePacks = languagePacks || {};
			languagePacks[bundled.languageId] = bundled.pack;
			try {
				await promises.writeFile(configFile, JSON.stringify(languagePacks), 'utf-8');
			} catch {
				// ignore disk write errors
			}
		}
	}

	return languagePacks;
}

function resolveLanguagePackLanguage(languagePacks: ILanguagePacks, locale: string | undefined): string | undefined {
	try {
		while (locale) {
			if (languagePacks[locale]) {
				return locale;
			}

			const index = locale.lastIndexOf('-');
			if (index > 0) {
				locale = locale.substring(0, index);
			} else {
				return undefined;
			}
		}
	} catch (error) {
		console.error('Resolving language pack configuration failed.', error);
	}

	return undefined;
}

function defaultNLSConfiguration(userLocale: string, osLocale: string, nlsMetadataPath: string): INLSConfiguration {
	mark('code/didGenerateNls');

	return {
		userLocale,
		osLocale,
		resolvedLanguage: 'en',
		defaultMessagesFile: join(nlsMetadataPath, 'nls.messages.json'),

		// NLS: below 2 are a relic from old times only used by vscode-nls and deprecated
		locale: userLocale,
		availableLanguages: {}
	};
}

//#region fs helpers

function touch(path: string): Promise<void> {
	const date = new Date();

	return promises.utimes(path, date, date);
}

//#endregion
