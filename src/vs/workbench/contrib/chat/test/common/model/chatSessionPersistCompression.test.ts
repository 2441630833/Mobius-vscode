/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { VSBuffer } from '../../../../../../base/common/buffer.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { compressResponsePartForPersistence, compressStringForPersistence, PERSIST_COMPRESS_MAX_CHARS, PERSIST_COMPRESS_MARKER } from '../../../common/model/chatSessionPersistCompression.js';
import * as Adapt from '../../../common/model/objectMutationLog.js';

suite('ChatSessionPersistCompression', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	function bigLog(lines: number): string {
		const out: string[] = [];
		for (let i = 0; i < lines; i++) {
			out.push(`INFO step ${i} ok`);
		}
		out.splice(lines / 2, 0, 'Traceback (most recent call last):', '  File "a.py", line 3, in <module>', 'FATAL disk full');
		out.push('3 passed, 1 failed');
		return out.join('\n');
	}

	test('keeps short strings unchanged', () => {
		assert.strictEqual(compressStringForPersistence('hello'), 'hello');
		const medium = 'x '.repeat(1000);
		assert.strictEqual(compressStringForPersistence(medium), medium);
	});

	test('keeps errors, traces, summaries, head and tail of a long log', () => {
		const log = bigLog(5000);
		const out = compressStringForPersistence(log);
		assert.ok(out.length < 4096, `compressed to ${out.length}`);
		for (const needle of ['FATAL disk full', 'Traceback', 'File "a.py"', '3 passed, 1 failed', 'INFO step 0 ok', 'INFO step 4999 ok', PERSIST_COMPRESS_MARKER]) {
			assert.ok(out.includes(needle), needle);
		}
	});

	test('is idempotent', () => {
		for (const input of [bigLog(5000), 'word '.repeat(10000), '中文'.repeat(20000), `head\n${'x'.repeat(50000)}\ntail`]) {
			const once = compressStringForPersistence(input);
			assert.ok(once.length <= PERSIST_COMPRESS_MAX_CHARS + 200);
			assert.strictEqual(compressStringForPersistence(once), once);
		}
	});

	test('elides dense machine-generated lines', () => {
		const out = compressStringForPersistence(`head\n${'x'.repeat(50000)}\ntail`);
		assert.ok(out.length < 1000);
		assert.ok(out.includes('dense machine-generated content elided'));
	});

	test('compresses tool parts copy-on-write without mutating the live part', () => {
		const log = bigLog(5000);
		const image = { type: 'data', mimeType: 'image/png', base64Data: 'A'.repeat(9000) };
		const message = { value: 'run' };
		const part = { kind: 'toolInvocationSerialized', toolSpecificData: { kind: 'terminal', terminalCommandOutput: { text: log } }, resultDetails: { output: image }, invocationMessage: message };
		const before = JSON.stringify(part);
		const out = compressResponsePartForPersistence(part);
		assert.strictEqual(JSON.stringify(part), before);
		assert.notStrictEqual(out, part);
		assert.ok(out.toolSpecificData.terminalCommandOutput.text.length < 4096);
		assert.strictEqual(out.resultDetails, part.resultDetails, 'image data untouched');
		assert.strictEqual(out.invocationMessage, message, 'unchanged branches keep their reference');
		assert.deepStrictEqual(compressResponsePartForPersistence(part), out, 'deterministic');
	});

	test('leaves answers and edits alone', () => {
		const log = bigLog(5000);
		const edit = { kind: 'textEditGroup', edits: [[{ text: log }]] };
		assert.strictEqual(compressResponsePartForPersistence(edit), edit);
		const md = { value: log };
		assert.strictEqual(compressResponsePartForPersistence(md), md);
	});
});

suite('ObjectMutationLog size-based compaction', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	interface Doc { text: string; items: string[] }
	const schema = Adapt.object<Doc, Doc>({
		text: Adapt.t(d => d.text, Adapt.value()),
		items: Adapt.t(d => d.items, Adapt.array(Adapt.value<string, string>())),
	});

	test('replaces the log once appended bytes exceed the budget', () => {
		const log = new Adapt.ObjectMutationLog<Doc, Doc>(schema, 10_000, { compactAfterBytes: 1000 });
		const doc: Doc = { text: '', items: [] };
		assert.strictEqual(log.write(doc).op, 'replace');
		log.confirmWrite();
		const ops: string[] = [];
		for (let i = 0; i < 10; i++) {
			doc.text = 'y'.repeat(300 + i);
			ops.push(log.write(doc).op);
			log.confirmWrite();
		}
		assert.ok(ops.includes('replace'), ops.join(','));
		assert.ok(ops.indexOf('replace') <= 4, ops.join(','));
	});

	test('unconfirmed appends do not count toward the budget', () => {
		const log = new Adapt.ObjectMutationLog<Doc, Doc>(schema, 10_000, { compactAfterBytes: 1000 });
		const doc: Doc = { text: '', items: [] };
		log.write(doc);
		log.confirmWrite();
		for (let i = 0; i < 10; i++) {
			doc.text = 'z'.repeat(400 + i);
			assert.strictEqual(log.write(doc).op, 'append');
			// write failed: no confirmWrite
		}
	});

	test('compacts a large log on its first write after load', () => {
		const writer = new Adapt.ObjectMutationLog<Doc, Doc>(schema);
		const big = writer.createInitial({ text: 'p'.repeat(5000), items: [] });
		const log = new Adapt.ObjectMutationLog<Doc, Doc>(schema, 10_000, { compactOnLoadBytes: 2000 });
		const state = log.read(big);
		assert.strictEqual(log.needsCompaction, true);
		assert.strictEqual(log.write(state).op, 'replace');
		log.confirmWrite();
		assert.strictEqual(log.needsCompaction, false);

		const small = new Adapt.ObjectMutationLog<Doc, Doc>(schema, 10_000, { compactOnLoadBytes: 2000 });
		small.read(VSBuffer.fromString(JSON.stringify({ kind: 0, v: { text: 'a', items: [] } }) + '\n'));
		assert.strictEqual(small.needsCompaction, false);
	});
});

suite('headroomCompressText budgets', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('never exceeds maxChars, marker included', async () => {
		const { headroomCompressText } = await import('../../../common/headroom/headroomCompressor.js');
		const inputs = [
			Array.from({ length: 5000 }, (_, i) => `line ${i} ${'q'.repeat(30)}`).join('\n'),
			'word '.repeat(20000),
			`a\n${'x'.repeat(80000)}\nb`,
		];
		for (const maxChars of [2000, 12000, 16384]) {
			for (const input of inputs) {
				const out = headroomCompressText(input, { minChars: maxChars, maxChars, label: 'test' });
				assert.ok(out.length <= maxChars, `${out.length} > ${maxChars}`);
				assert.strictEqual(headroomCompressText(out, { minChars: maxChars, maxChars, label: 'test' }), out);
			}
		}
	});
});
