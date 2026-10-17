import { describe, expect, it } from 'vitest';
import BizError from '../src/error/biz-error';
import {
	normalizeAttachment,
	normalizeAttachments,
} from '../src/utils/attachment-utils';

function decodeText(bytes) {
	return new TextDecoder().decode(bytes);
}

describe('attachmentUtils.normalizeAttachment', () => {
	it('normalizes raw Base64 and uses the decoded byte length', () => {
		const result = normalizeAttachment({
			filename: 'hello.txt',
			content: 'aGVsbG8=',
			contentType: 'text/plain',
			size: 999,
		});

		expect(result.filename).toBe('hello.txt');
		expect(result.contentType).toBe('text/plain');
		expect(result.content).toBe('aGVsbG8=');
		expect(decodeText(result.bytes)).toBe('hello');
		expect(result.size).toBe(5);
	});

	it('normalizes Data URL Base64, strips whitespace, and reads the Data URL MIME type', () => {
		const result = normalizeAttachment({
			filename: ' hello.txt ',
			content: 'data:text/plain;charset=utf-8;base64,aGVs\nbG8=',
		});

		expect(result.filename).toBe('hello.txt');
		expect(result.contentType).toBe('text/plain');
		expect(result.content).toBe('aGVsbG8=');
		expect(result.size).toBe(5);
	});

	it('uses request MIME fields before the Data URL MIME type', () => {
		const result = normalizeAttachment({
			filename: 'report.bin',
			content: 'data:image/png;base64,aGVsbG8=',
			contentType: 'text/csv; charset=utf-8',
			mimeType: 'application/json',
			type: 'text/plain',
		});

		expect(result.contentType).toBe('text/csv');
	});

	it('normalizes ArrayBuffer and Uint8Array views using their actual bytes', () => {
		const source = new TextEncoder().encode('xxhello');
		const offsetView = source.subarray(2);
		const buffer = offsetView.buffer.slice(offsetView.byteOffset, offsetView.byteOffset + offsetView.byteLength);

		const fromBuffer = normalizeAttachment({
			filename: 'buffer.txt',
			content: buffer,
			mimeType: 'text/plain',
		});
		const fromView = normalizeAttachment({
			filename: 'view.txt',
			content: offsetView,
			type: 'text/plain',
		});

		expect(decodeText(fromBuffer.bytes)).toBe('hello');
		expect(decodeText(fromView.bytes)).toBe('hello');
		expect(fromBuffer.size).toBe(5);
		expect(fromView.size).toBe(5);
	});

	it('defaults the MIME type when none is supplied', () => {
		const result = normalizeAttachment({
			filename: 'unknown.bin',
			content: 'aGVsbG8=',
		});

		expect(result.contentType).toBe('application/octet-stream');
	});

	it.each(['font/woff2', 'model/gltf-binary'])(
		'accepts the registered MIME top-level type %s',
		contentType => {
			const result = normalizeAttachment({
				filename: 'asset.bin',
				content: 'aGVsbG8=',
				contentType,
			});

			expect(result.contentType).toBe(contentType);
		}
	);

	it.each([
		['missing filename', { content: 'aGVsbG8=' }],
		['empty content', { filename: 'a.txt', content: '' }],
		['empty Data URL content', { filename: 'a.txt', content: 'data:text/plain;base64,' }],
		['zero-byte buffer', { filename: 'a.txt', content: new ArrayBuffer(0) }],
		['invalid Base64', { filename: 'a.txt', content: '%%%not-base64%%%' }],
		['unsupported MIME type', { filename: 'a.txt', content: 'aGVsbG8=', contentType: 'not-a-mime' }],
		['unknown MIME top-level type', { filename: 'a.txt', content: 'aGVsbG8=', contentType: 'foo/bar' }],
		['wildcard MIME type', { filename: 'a.txt', content: 'aGVsbG8=', contentType: '*/*' }],
		['wildcard MIME subtype', { filename: 'a.txt', content: 'aGVsbG8=', contentType: 'text/*' }],
		['non-string filename', { filename: 42, content: 'aGVsbG8=' }],
		['non-Base64 Data URL', { filename: 'a.txt', content: 'data:text/plain,hello' }],
		['null attachment entry', null],
	])('rejects %s', (_label, attachment) => {
		expect(() => normalizeAttachment(attachment)).toThrow(BizError);
	});
});

describe('attachmentUtils.normalizeAttachments', () => {
	it('preserves attachment order and duplicate entries', () => {
		const input = [
			{ filename: 'first.txt', content: 'aGVsbG8=', contentType: 'text/plain' },
			{ filename: 'second.txt', content: 'd29ybGQ=', contentType: 'text/plain' },
			{ filename: 'first.txt', content: 'aGVsbG8=', contentType: 'text/plain' },
		];

		const result = normalizeAttachments(input);

		expect(result.map(item => item.filename)).toEqual(['first.txt', 'second.txt', 'first.txt']);
		expect(result.map(item => item.content)).toEqual(['aGVsbG8=', 'd29ybGQ=', 'aGVsbG8=']);
	});
});
