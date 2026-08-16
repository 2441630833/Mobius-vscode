/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import es from 'event-stream';
import fs from 'fs';
import { gulp, bom, sourcemaps } from './gulp/facade.ts';
import path from 'path';
import * as monacodts from './monaco-api.ts';
import * as nls from './nls.ts';
import { createReporter } from './reporter.ts';
import * as util from './util.ts';
import fancyLog from 'fancy-log';
import ansiColors from 'ansi-colors';
import os from 'os';
import File from 'vinyl';
import * as task from './gulp/task.ts';
import { Mangler } from './mangle/index.ts';
import type { RawSourceMap } from 'source-map';
import ts from 'typescript';
import watch from './watch/index.ts';
import * as tsb from './tsb/index.ts';
import { createTsgoStream, spawnTsgo } from './tsgo.ts';


import { extractExtensionPointNamesFromFile } from './extractExtensionPoints.ts';
import glob from 'glob';

const BUILD_PROGRESS_INTERVAL_MS = 15_000;
const PROGRESS_BAR_WIDTH = 30;

type EmitPhase = 'read' | 'mangle' | 'compile';

class EmitPipelineProgress {
	private totalFiles: number;
	private counts: Record<EmitPhase, number> = { read: 0, mangle: 0, compile: 0 };
	private readonly weights: Record<EmitPhase, number>;
	private lastRender = 0;
	private lastLineLog = 0;
	private currentPhase: EmitPhase = 'read';
	private finished = false;

	constructor(totalFiles: number, withMangle: boolean) {
		this.totalFiles = Math.max(totalFiles, 1);
		this.weights = withMangle
			? { read: 0.05, mangle: 0.10, compile: 0.85 }
			: { read: 0.10, mangle: 0, compile: 0.90 };
	}

	setActualTotal(count: number): void {
		if (count > 0) {
			this.totalFiles = count;
		}
	}

	tick(phase: EmitPhase): void {
		this.counts[phase]++;
		this.currentPhase = phase;
		this.render();
	}

	phaseComplete(phase: EmitPhase, actualCount?: number): void {
		if (actualCount !== undefined && actualCount > 0) {
			this.counts[phase] = actualCount;
			if (phase === 'read') {
				this.setActualTotal(actualCount);
			}
		} else {
			this.counts[phase] = this.totalFiles;
		}
		this.render(true);
	}

	private phaseLabel(): string {
		switch (this.currentPhase) {
			case 'read': return 'reading source';
			case 'mangle': return 'applying mangling';
			case 'compile': return 'typescript compile + write';
		}
	}

	private percent(): number {
		const t = this.totalFiles;
		const raw =
			(Math.min(this.counts.read, t) / t) * this.weights.read +
			(Math.min(this.counts.mangle, t) / t) * this.weights.mangle +
			(Math.min(this.counts.compile, t) / t) * this.weights.compile;
		return Math.min(100, Math.floor(raw * 100));
	}

	private bar(pct: number): string {
		const filled = Math.round((pct / 100) * PROGRESS_BAR_WIDTH);
		return `[${'█'.repeat(filled)}${'░'.repeat(PROGRESS_BAR_WIDTH - filled)}]`;
	}

	private formatLine(): string {
		const pct = this.percent();
		return `${this.bar(pct)} ${String(pct).padStart(3)}% | ${this.phaseLabel()} | ${this.counts[this.currentPhase]}/${this.totalFiles} files`;
	}

	render(force = false): void {
		if (this.finished) {
			return;
		}
		const now = Date.now();
		const minInterval = process.stderr.isTTY ? 500 : BUILD_PROGRESS_INTERVAL_MS;
		if (!force && now - this.lastRender < minInterval) {
			return;
		}
		this.lastRender = now;

		if (process.stderr.isTTY) {
			const line = `${ansiColors.magenta('[build-progress]')} ${this.formatLine()}`;
			process.stderr.write(`\r${line}${' '.repeat(20)}`);
		} else if (force || now - this.lastLineLog >= BUILD_PROGRESS_INTERVAL_MS) {
			this.lastLineLog = now;
			fancyLog(ansiColors.magenta('[build-progress]'), this.formatLine());
		}
	}

	logStart(src: string, out: string, withMangle: boolean): void {
		fancyLog(
			ansiColors.magenta('[build-progress]'),
			`emit pipeline: ${src} -> ${out} | ${this.totalFiles} files${withMangle ? ' | phases: 5% read, 10% mangle, 85% compile' : ' | phases: 10% read, 90% compile'}`
		);
	}

	complete(): void {
		this.finished = true;
		this.counts = { read: this.totalFiles, mangle: this.totalFiles, compile: this.totalFiles };
		const line = `${this.bar(100)} 100% | emit pipeline complete | ${this.totalFiles}/${this.totalFiles} files`;
		if (process.stderr.isTTY) {
			process.stderr.write(`\r${ansiColors.magenta('[build-progress]')} ${line}${' '.repeat(10)}\n`);
		} else {
			fancyLog(ansiColors.magenta('[build-progress]'), line);
		}
	}
}

function countPipelineFiles(src: string): number {
	const srcRoot = path.join(import.meta.dirname, '../../', src);
	return glob.sync('**/*', { cwd: srcRoot, nodir: true }).length;
}

function createProgressTap(progress: EmitPipelineProgress, phase: EmitPhase): NodeJS.ReadWriteStream {
	let count = 0;
	return es.through(
		function (file: File) {
			count++;
			progress.tick(phase);
			this.push(file);
		},
		function end() {
			progress.phaseComplete(phase, count);
			this.push(null);
		}
	);
}


// --- gulp-tsb: compile and transpile --------------------------------

const reporter = createReporter();

function getTypeScriptCompilerOptions(src: string): ts.CompilerOptions {
	const rootDir = path.join(import.meta.dirname, `../../${src}`);
	const options: ts.CompilerOptions = {};
	options.verbose = false;
	options.sourceMap = true;
	if (process.env['VSCODE_NO_SOURCEMAP']) { // To be used by developers in a hurry
		options.sourceMap = false;
	}
	options.rootDir = rootDir;
	options.baseUrl = rootDir;
	options.sourceRoot = util.toFileUri(rootDir);
	options.newLine = /\r\n/.test(fs.readFileSync(import.meta.filename, 'utf8')) ? 0 : 1;
	return options;
}

interface ICompileTaskOptions {
	readonly build: boolean;
	readonly emitError: boolean;
	readonly transpileOnly: boolean | { esbuild: boolean };
	readonly preserveEnglish: boolean;
	readonly noEmit?: boolean;
}

export function createCompile(src: string, { build, emitError, transpileOnly, preserveEnglish, noEmit }: ICompileTaskOptions) {
	const projectPath = path.join(import.meta.dirname, '../../', src, 'tsconfig.json');
	const overrideOptions = { ...getTypeScriptCompilerOptions(src), inlineSources: Boolean(build) };
	if (!build) {
		overrideOptions.inlineSourceMap = true;
	}
	if (noEmit) {
		overrideOptions.noEmit = true;
	}

	const compilation = tsb.create(projectPath, overrideOptions, {
		verbose: false,
		transpileOnly: Boolean(transpileOnly),
		transpileWithEsbuild: typeof transpileOnly !== 'boolean' && transpileOnly.esbuild
	}, err => reporter(err));

	function pipeline(token?: util.ICancellationToken) {

		const tsFilter = util.filter(data => /\.ts$/.test(data.path));
		const isUtf8Test = (f: File) => /(\/|\\)test(\/|\\).*utf8/.test(f.path);
		const isRuntimeJs = (f: File) => f.path.endsWith('.js') && !f.path.includes('fixtures');
		const noDeclarationsFilter = util.filter(data => !(/\.d\.ts$/.test(data.path)));

		const input = es.through();
		const output = input
			.pipe(util.$if(isUtf8Test, bom())) // this is required to preserve BOM in test files that loose it otherwise
			.pipe(util.$if(!build && isRuntimeJs, util.appendOwnPathSourceURL()))
			.pipe(tsFilter)
			.pipe(util.loadSourcemaps())
			.pipe(compilation(token))
			.pipe(noDeclarationsFilter)
			.pipe(util.$if(build, nls.nls({ preserveEnglish })))
			.pipe(noDeclarationsFilter.restore)
			.pipe(util.$if(!transpileOnly, sourcemaps.write('.', {
				addComment: false,
				includeContent: !!build,
				sourceRoot: overrideOptions.sourceRoot
			})))
			.pipe(tsFilter.restore)
			.pipe(reporter.end(!!emitError));

		return es.duplex(input, output);
	}
	pipeline.tsProjectSrc = () => {
		return compilation.src({ base: src });
	};
	pipeline.projectPath = projectPath;
	return pipeline;
}

export function transpileTask(src: string, out: string, esbuild?: boolean): task.StreamTask {

	const task = () => {

		const transpile = createCompile(src, { build: false, emitError: true, transpileOnly: { esbuild: !!esbuild }, preserveEnglish: false });
		const srcPipe = gulp.src(`${src}/**`, { base: `${src}` });

		return srcPipe
			.pipe(transpile())
			.pipe(gulp.dest(out));
	};

	task.taskName = `transpile-${path.basename(src)}`;
	return task;
}

export function compileTask(src: string, out: string, build: boolean, options: { disableMangle?: boolean; preserveEnglish?: boolean } = {}): task.Task {

	const task = async () => {

		if (os.totalmem() < 4_000_000_000) {
			throw new Error('compilation requires 4GB of RAM');
		}

		// For dev builds we can transpile with esbuild for speed and type-check with tsgo (no emit).
		// For `build`, keep the full tsb pipeline because the NLS step requires `file.sourceMap`.
		const compile = createCompile(src, { build, emitError: true, transpileOnly: build ? false : { esbuild: true }, preserveEnglish: !!options.preserveEnglish });
		const srcPipe = gulp.src(`${src}/**`, { base: `${src}` });
		const generator = new MonacoGenerator(false);
		if (src === 'src') {
			generator.execute();
		}

		const withMangle = Boolean(build && !options.disableMangle);
		const progress = new EmitPipelineProgress(countPipelineFiles(src), withMangle);
		progress.logStart(src, out, withMangle);

		// mangle: TypeScript to TypeScript
		let mangleStream = es.through();
		if (withMangle) {
			let ts2tsMangler: Mangler | undefined = new Mangler(compile.projectPath, (...data) => fancyLog(ansiColors.blue('[mangler]'), ...data), { mangleExports: true, manglePrivateFields: true });
			const newContentsByFileName = ts2tsMangler.computeNewFileContents(new Set(['saveState']));
			let mangleCount = 0;
			mangleStream = es.through(async function write(data: File & { sourceMap?: RawSourceMap }) {
				type TypeScriptExt = typeof ts & { normalizePath(path: string): string };
				const tsNormalPath = (ts as TypeScriptExt).normalizePath(data.path);
				const newContents = (await newContentsByFileName).get(tsNormalPath);
				if (newContents !== undefined) {
					data.contents = Buffer.from(newContents.out);
					data.sourceMap = newContents.sourceMap && JSON.parse(newContents.sourceMap);
				}
				mangleCount++;
				progress.tick('mangle');
				this.push(data);
			}, async function end() {
				progress.phaseComplete('mangle', mangleCount);
				// free resources
				(await newContentsByFileName).clear();

				this.push(null);
				ts2tsMangler = undefined;
			});
		}

		const emit = util.streamToPromise(srcPipe
			.pipe(createProgressTap(progress, 'read'))
			.pipe(mangleStream)
			.pipe(generator.stream)
			.pipe(compile())
			.pipe(createProgressTap(progress, 'compile'))
			.pipe(gulp.dest(out)));

		const typecheck = spawnTsgo(compile.projectPath, { taskName: `compile-${path.basename(src)}`, noEmit: true });

		await Promise.all([emit, typecheck]);
		progress.complete();
	};

	task.taskName = `compile-${path.basename(src)}`;
	return task;
}

export function watchTypeCheckTask(src: string): task.Task {
	return task.define(`watch-typecheck-${path.basename(src)}`, () => {
		const projectPath = path.join(import.meta.dirname, '../../', src, 'tsconfig.json');
		const generator = new MonacoGenerator(true);
		generator.execute();
		const watchInput = watch(`${src}/**`, { base: src, readDelay: 200 });
		const tsgoStream = watchInput.pipe(generator.stream).pipe(util.debounce(() => {
			const stream = createTsgoStream(projectPath, { taskName: 'watch-client-noEmit', noEmit: true });
			const result = es.through();
			stream.on('end', () => {
				result.emit('end');
			});
			stream.on('error', err => {
				reporter(err);
				fancyLog.error(ansiColors.red('[tsgo] watch-client-noEmit failed'));
				result.emit('end');
			});
			return result.pipe(reporter.end(false));
		}));
		return tsgoStream;
	});
}

const REPO_SRC_FOLDER = path.join(import.meta.dirname, '../../src');

class MonacoGenerator {
	private readonly _isWatch: boolean;
	public readonly stream: NodeJS.ReadWriteStream;

	private readonly _watchedFiles: { [filePath: string]: boolean };
	private readonly _fsProvider: monacodts.FSProvider;
	private readonly _declarationResolver: monacodts.DeclarationResolver;

	constructor(isWatch: boolean) {
		this._isWatch = isWatch;
		this.stream = es.through();
		this._watchedFiles = {};
		const onWillReadFile = (moduleId: string, filePath: string) => {
			if (!this._isWatch) {
				return;
			}
			if (this._watchedFiles[filePath]) {
				return;
			}
			this._watchedFiles[filePath] = true;

			fs.watchFile(filePath, () => {
				this._declarationResolver.invalidateCache(moduleId);
				this._executeSoon();
			});
		};
		this._fsProvider = new class extends monacodts.FSProvider {
			public readFileSync(moduleId: string, filePath: string): Buffer {
				onWillReadFile(moduleId, filePath);
				return super.readFileSync(moduleId, filePath);
			}
		};
		this._declarationResolver = new monacodts.DeclarationResolver(this._fsProvider);

		if (this._isWatch) {
			fs.watchFile(monacodts.RECIPE_PATH, () => {
				this._executeSoon();
			});
		}
	}

	private _executeSoonTimer: NodeJS.Timeout | null = null;
	private _executeSoon(): void {
		if (this._executeSoonTimer !== null) {
			clearTimeout(this._executeSoonTimer);
			this._executeSoonTimer = null;
		}
		this._executeSoonTimer = setTimeout(() => {
			this._executeSoonTimer = null;
			this.execute();
		}, 20);
	}

	private _run(): monacodts.IMonacoDeclarationResult | null {
		const r = monacodts.run3(this._declarationResolver);
		if (!r && !this._isWatch) {
			// The build must always be able to generate the monaco.d.ts
			throw new Error(`monaco.d.ts generation error - Cannot continue`);
		}
		return r;
	}

	private _log(message: string, ...rest: unknown[]): void {
		fancyLog(ansiColors.cyan('[monaco.d.ts]'), message, ...rest);
	}

	public execute(): void {
		const startTime = Date.now();
		const result = this._run();
		if (!result) {
			// nothing really changed
			return;
		}
		if (result.isTheSame) {
			return;
		}

		fs.writeFileSync(result.filePath, result.content);
		fs.writeFileSync(path.join(REPO_SRC_FOLDER, 'vs/editor/common/standalone/standaloneEnums.ts'), result.enums);
		this._log(`monaco.d.ts is changed - total time took ${Date.now() - startTime} ms`);
		if (!this._isWatch) {
			this.stream.emit('error', 'monaco.d.ts is no longer up to date. Please run gulp watch and commit the new file.');
		}
	}
}

function generateApiProposalNames() {
	let eol: string;

	try {
		const src = fs.readFileSync('src/vs/platform/extensions/common/extensionsApiProposals.ts', 'utf-8');
		const match = /\r?\n/m.exec(src);
		eol = match ? match[0] : os.EOL;
	} catch {
		eol = os.EOL;
	}

	const pattern = /vscode\.proposed\.([a-zA-Z\d]+)\.d\.ts$/;
	const proposals = new Map<string, { proposal: string }>();

	const input = es.through();
	const output = input
		.pipe(util.filter((f: File) => pattern.test(f.path)))
		.pipe(es.through((f: File) => {
			const name = path.basename(f.path);
			const match = pattern.exec(name);

			if (!match) {
				return;
			}

			const proposalName = match[1];

			proposals.set(proposalName, {
				proposal: `https://raw.githubusercontent.com/microsoft/vscode/main/src/vscode-dts/vscode.proposed.${proposalName}.d.ts`,
			});
		}, function () {
			const names = [...proposals.keys()].sort();
			const contents = [
				'/*---------------------------------------------------------------------------------------------',
				' *  Copyright (c) Microsoft Corporation. All rights reserved.',
				' *  Licensed under the MIT License. See License.txt in the project root for license information.',
				' *--------------------------------------------------------------------------------------------*/',
				'',
				'// THIS IS A GENERATED FILE. DO NOT EDIT DIRECTLY.',
				'',
				'const _allApiProposals = {',
				`${names.map(proposalName => {
					const proposal = proposals.get(proposalName)!;
					return `\t${proposalName}: {${eol}\t\tproposal: '${proposal.proposal}',${eol}\t}`;
				}).join(`,${eol}`)}`,
				'};',
				'export const allApiProposals = Object.freeze<{ [proposalName: string]: Readonly<{ proposal: string }> }>(_allApiProposals);',
				'export type ApiProposalName = keyof typeof _allApiProposals;',
				'',
			].join(eol);

			const filePath = 'vs/platform/extensions/common/extensionsApiProposals.ts';
			try {
				const existing = fs.readFileSync(path.join('src', filePath), 'utf-8');
				if (existing === contents) {
					this.emit('end');
					return;
				}
			} catch {
				// File doesn't exist yet, emit it
			}
			this.emit('data', new File({
				path: filePath,
				contents: Buffer.from(contents)
			}));
			this.emit('end');
		}));

	return es.duplex(input, output);
}

const apiProposalNamesReporter = createReporter('api-proposal-names');

export const compileApiProposalNamesTask = task.define('compile-api-proposal-names', () => {
	return gulp.src('src/vscode-dts/**')
		.pipe(generateApiProposalNames())
		.pipe(gulp.dest('src'))
		.pipe(apiProposalNamesReporter.end(true));
});

function generateExtensionPointNames() {
	const collectedNames: string[] = [];

	const input = es.through();
	const output = input
		.pipe(es.through(function (file: File) {
			const contents = file.contents?.toString('utf-8');
			if (contents && contents.includes('registerExtensionPoint')) {
				const sourceFile = ts.createSourceFile(file.path, contents, ts.ScriptTarget.Latest, true);
				collectedNames.push(...extractExtensionPointNamesFromFile(sourceFile));
			}
		}, function () {
			collectedNames.sort();
			const content = JSON.stringify(collectedNames, undefined, '\t') + '\n';
			const filePath = 'vs/workbench/services/extensions/common/extensionPoints.json';
			try {
				const existing = fs.readFileSync(path.join('src', filePath), 'utf-8');
				if (existing.replace(/\r\n/g, '\n') === content) {
					this.emit('end');
					return;
				}
			} catch {
				// File doesn't exist yet, emit it
			}
			this.emit('data', new File({
				path: filePath,
				contents: Buffer.from(content)
			}));
			this.emit('end');
		}));

	return es.duplex(input, output);
}

const extensionPointNamesReporter = createReporter('extension-point-names');

export const compileExtensionPointNamesTask = task.define('compile-extension-point-names', () => {
	return gulp.src('src/vs/workbench/**/*.ts')
		.pipe(generateExtensionPointNames())
		.pipe(gulp.dest('src'))
		.pipe(extensionPointNamesReporter.end(true));
});

export const watchExtensionPointNamesTask = task.define('watch-extension-point-names', () => {
	const task = () => gulp.src('src/vs/workbench/**/*.ts')
		.pipe(generateExtensionPointNames())
		.pipe(extensionPointNamesReporter.end(true));

	return watch('src/vs/workbench/**/*.ts', { readDelay: 200 })
		.pipe(util.debounce(task))
		.pipe(gulp.dest('src'));
});

export const watchApiProposalNamesTask = task.define('watch-api-proposal-names', () => {
	const task = () => gulp.src('src/vscode-dts/**')
		.pipe(generateApiProposalNames())
		.pipe(apiProposalNamesReporter.end(true));

	return watch('src/vscode-dts/**', { readDelay: 200 })
		.pipe(util.debounce(task))
		.pipe(gulp.dest('src'));
});

// Codicons
const root = path.dirname(path.dirname(import.meta.dirname));
const codiconSource = path.join(root, 'node_modules', '@vscode', 'codicons', 'dist', 'codicon.ttf');
const codiconDest = path.join(root, 'src', 'vs', 'base', 'browser', 'ui', 'codicons', 'codicon', 'codicon.ttf');

function copyCodiconsImpl() {
	try {
		if (fs.existsSync(codiconSource)) {
			fs.mkdirSync(path.dirname(codiconDest), { recursive: true });
			fs.copyFileSync(codiconSource, codiconDest);
		} else {
			fancyLog(ansiColors.red('[codicons]'), `codicon.ttf not found in node_modules. Please run 'npm install' to install dependencies.`);
		}
	} catch (e) {
		fancyLog(ansiColors.red('[codicons]'), `Error copying codicon.ttf: ${e}`);
	}
}

export const copyCodiconsTask = task.define('copy-codicons', () => {
	copyCodiconsImpl();
	return Promise.resolve();
});
task.task(copyCodiconsTask);

export const watchCodiconsTask = task.define('watch-codicons', () => {
	copyCodiconsImpl();
	return watch('node_modules/@vscode/codicons/dist/**', { readDelay: 200 })
		.on('data', () => copyCodiconsImpl());
});
task.task(watchCodiconsTask);
