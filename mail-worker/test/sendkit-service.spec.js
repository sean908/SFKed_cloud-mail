import { describe, it, expect } from 'vitest';
import sendkitService from '../src/service/sendkit-service.js';

const baseParams = () => ({
	name: 'Alice',
	accountEmail: 'alice@example.com',
	receiveEmail: ['bob@external.com'],
	subject: 'Hello',
	text: 'plain',
	html: '<p>html</p>',
	sendType: 'send',
	messageId: null,
	attachments: []
});

describe('sendkitService.buildPayload', () => {
	it('映射 from/to/subject/text/html', () => {
		const payload = sendkitService.buildPayload(baseParams());
		expect(payload).toEqual({
			from: 'Alice <alice@example.com>',
			to: ['bob@external.com'],
			subject: 'Hello',
			text: 'plain',
			html: '<p>html</p>'
		});
	});

	it('回复场景带上 in-reply-to 与 references', () => {
		const payload = sendkitService.buildPayload({ ...baseParams(), sendType: 'reply', messageId: '<orig@id>' });
		expect(payload.headers).toEqual({ 'in-reply-to': '<orig@id>', 'references': '<orig@id>' });
	});

	it('普通附件映射为 filename/content/content_type', () => {
		const payload = sendkitService.buildPayload({
			...baseParams(),
			attachments: [{ filename: 'a.txt', content: 'data:text/plain;base64,SGVsbG8=', mimeType: 'text/plain' }]
		});
		expect(payload.attachments).toEqual([
			{ filename: 'a.txt', content: 'SGVsbG8=', content_type: 'text/plain' }
		]);
	});
});

describe('sendkitService.parseResponse', () => {
	it('202 + { id }', () => {
		expect(sendkitService.parseResponse(202, JSON.stringify({ id: 'm1' }), null)).toEqual({ ids: ['m1'] });
	});

	it('202 + { data: [{ id }] }', () => {
		const body = JSON.stringify({ data: [{ id: 'm1' }, { id: 'm2' }] });
		expect(sendkitService.parseResponse(202, body, null)).toEqual({ ids: ['m1', 'm2'] });
	});

	it('401 保留 SendKit 的 message 与状态码', () => {
		const body = JSON.stringify({ name: 'unauthorized', message: 'invalid api key' });
		expect(() => sendkitService.parseResponse(401, body, null)).toThrowError(/invalid api key/);
		try {
			sendkitService.parseResponse(401, body, null);
		} catch (e) {
			expect(e.code).toBe(401);
		}
	});

	it('422 使用返回的 message', () => {
		const body = JSON.stringify({ name: 'validation_error', message: 'to is required' });
		expect(() => sendkitService.parseResponse(422, body, null)).toThrowError(/to is required/);
	});

	it('429 记录 Retry-After', () => {
		const headers = new Headers({ 'Retry-After': '30' });
		expect(() => sendkitService.parseResponse(429, JSON.stringify({ message: 'rate limited' }), headers))
			.toThrowError(/Retry-After: 30/);
	});

	it('非 JSON 错误体不抛解析异常', () => {
		expect(() => sendkitService.parseResponse(500, '<html>oops</html>', null)).toThrowError(/oops/);
	});
});

describe('sendkitService.send', () => {
	it('以 Bearer 头 POST 到 SendKit 端点并解析 202', async () => {
		let captured;
		const fetchFn = async (url, options) => {
			captured = { url, options };
			return {
				status: 202,
				headers: new Headers(),
				text: async () => JSON.stringify({ id: 'm1' })
			};
		};

		const result = await sendkitService.send({ apiKey: 'sk_test', payload: { to: ['a@b.com'] }, fetchFn });

		expect(result).toEqual({ ids: ['m1'] });
		expect(captured.url).toBe('https://api.sendkit.dev/emails');
		expect(captured.options.headers.Authorization).toBe('Bearer sk_test');
		expect(JSON.parse(captured.options.body)).toEqual({ to: ['a@b.com'] });
	});
});
