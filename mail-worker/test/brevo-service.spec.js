import { describe, it, expect, vi, afterEach } from 'vitest';
import brevoService, { BREVO_REQUEST_SIZE_LIMIT } from '../src/service/brevo-service';
import BizError from '../src/error/biz-error';
import { t } from '../src/i18n/i18n';

const API_KEY = 'xkeysib-SUPERSECRETKEY1234567890';

const params = {
	name: 'Alice',
	accountEmail: 'alice@example.com',
	receiveEmail: ['bob@external.com'],
	subject: 'Hello',
	text: 'plain body',
	html: '<p>html body</p>',
};

function jsonResponse(body, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json' },
	});
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('brevoService.send', () => {
	it('sends and returns a single messageId', async () => {
		const fetchMock = vi.fn(async () => jsonResponse({ messageId: '<abc@brevo>' }));
		vi.stubGlobal('fetch', fetchMock);

		const result = await brevoService.send(API_KEY, params);

		expect(result.error).toBeNull();
		expect(result.data.id).toBe('<abc@brevo>');
	});

	it('returns an array of messageIds for multiple recipients', async () => {
		const ids = ['<a@brevo>', '<b@brevo>'];
		const fetchMock = vi.fn(async () => jsonResponse({ messageId: ids }));
		vi.stubGlobal('fetch', fetchMock);

		const result = await brevoService.send(API_KEY, {
			...params,
			receiveEmail: ['a@x.com', 'b@x.com'],
		});

		expect(result.error).toBeNull();
		expect(result.data.id).toEqual(ids);
	});

	it('reports a provider response error when no messageId is returned', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({})));

		const result = await brevoService.send(API_KEY, params);

		expect(result.data).toBeNull();
		expect(result.error).toBeDefined();
		expect(result.error.message.length).toBeGreaterThan(0);
	});

	it.each([
		['empty array', []],
		['blank string', '   '],
		['object', {}],
		['array with invalid entries', ['<ok@brevo>', null]],
	])('rejects an invalid messageId shape: %s', async (_label, messageId) => {
		const fetchMock = vi.fn(async () => jsonResponse({ messageId }));
		vi.stubGlobal('fetch', fetchMock);

		const result = await brevoService.send(API_KEY, params);

		expect(result.data).toBeNull();
		expect(result.error).toBeDefined();
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('parses a structured (JSON) error response', async () => {
		vi.stubGlobal('fetch', vi.fn(async () =>
			jsonResponse({ code: 'invalid_parameter', message: 'sender invalid' }, 400)));

		const result = await brevoService.send(API_KEY, params);

		expect(result.data).toBeNull();
		expect(result.error.message).toContain('sender invalid');
	});

	it('parses a non-JSON error response', async () => {
		vi.stubGlobal('fetch', vi.fn(async () =>
			new Response('<html>bad gateway</html>', { status: 502 })));

		const result = await brevoService.send(API_KEY, params);

		expect(result.data).toBeNull();
		expect(result.error.message).toContain('502');
	});

	it('handles a network exception without throwing', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('connection reset'); }));

		const result = await brevoService.send(API_KEY, params);

		expect(result.data).toBeNull();
		expect(result.error.message).toContain('connection reset');
	});

	it('does not retry and does not switch provider on failure', async () => {
		const fetchMock = vi.fn(async () => jsonResponse({ message: 'nope' }, 500));
		vi.stubGlobal('fetch', fetchMock);

		await brevoService.send(API_KEY, params);

		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('sets the required auth and content-type headers', async () => {
		const fetchMock = vi.fn(async () => jsonResponse({ messageId: '<x@brevo>' }));
		vi.stubGlobal('fetch', fetchMock);

		await brevoService.send(API_KEY, params);

		const [, init] = fetchMock.mock.calls[0];
		expect(init.method).toBe('POST');
		expect(init.headers['api-key']).toBe(API_KEY);
		expect(init.headers['Content-Type']).toBe('application/json');
		expect(init.headers['Accept']).toBe('application/json');
	});

	it('maps sender, recipients, subject, text and html into the request body', async () => {
		const fetchMock = vi.fn(async () => jsonResponse({ messageId: '<x@brevo>' }));
		vi.stubGlobal('fetch', fetchMock);

		await brevoService.send(API_KEY, params);

		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe('https://api.brevo.com/v3/smtp/email');
		const body = JSON.parse(init.body);
		expect(body.sender).toEqual({ name: 'Alice', email: 'alice@example.com' });
		expect(body.to).toEqual([{ email: 'bob@external.com' }]);
		expect(body.subject).toBe('Hello');
		expect(body.textContent).toBe('plain body');
		expect(body.htmlContent).toBe('<p>html body</p>');
		expect(body.headers).toBeUndefined();
	});

	it('maps reply thread data into standard Brevo headers', async () => {
		const fetchMock = vi.fn(async () => jsonResponse({ messageId: '<x@brevo>' }));
		vi.stubGlobal('fetch', fetchMock);

		await brevoService.send(API_KEY, {
			...params,
			sendType: 'reply',
			replyHeaders: {
				inReplyTo: '<parent@example.com>',
				references: '<older@example.com> <parent@example.com>',
			},
		});

		const [, init] = fetchMock.mock.calls[0];
		const body = JSON.parse(init.body);
		expect(body.headers).toEqual({
			'In-Reply-To': '<parent@example.com>',
			References: '<older@example.com> <parent@example.com>',
		});
	});

	it('rejects a reply without complete thread data before fetching', async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);

		expect(() => brevoService.prepareRequest({
			...params,
			sendType: 'reply',
			replyHeaders: { inReplyTo: '   ', references: '<parent@example.com>' },
		})).toThrow(BizError);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('does not set scheduled sending', async () => {
		const fetchMock = vi.fn(async () => jsonResponse({ messageId: '<x@brevo>' }));
		vi.stubGlobal('fetch', fetchMock);

		await brevoService.send(API_KEY, params);

		const [, init] = fetchMock.mock.calls[0];
		const body = JSON.parse(init.body);
		expect(body.scheduledAt).toBeUndefined();
	});

	it('maps normalized attachments to ordered attachment entries', async () => {
		const fetchMock = vi.fn(async () => jsonResponse({ messageId: '<x@brevo>' }));
		vi.stubGlobal('fetch', fetchMock);

		await brevoService.send(API_KEY, {
			...params,
			attachments: [
				{ filename: 'first.txt', content: 'aGVsbG8=', contentType: 'text/plain' },
				{ filename: 'second.txt', content: 'd29ybGQ=', contentType: 'text/plain' },
				{ filename: 'first.txt', content: 'aGVsbG8=', contentType: 'text/plain' },
			],
		});

		const [, init] = fetchMock.mock.calls[0];
		const body = JSON.parse(init.body);
		expect(body.attachment).toEqual([
			{ name: 'first.txt', content: 'aGVsbG8=' },
			{ name: 'second.txt', content: 'd29ybGQ=' },
			{ name: 'first.txt', content: 'aGVsbG8=' },
		]);
		expect(body.attachments).toBeUndefined();
	});

	it('accepts 10 attachments but rejects 11 before fetching', async () => {
		const fetchMock = vi.fn(async () => jsonResponse({ messageId: '<x@brevo>' }));
		vi.stubGlobal('fetch', fetchMock);
		const attachment = { filename: 'a.txt', content: 'YQ==', contentType: 'text/plain' };

		await brevoService.send(API_KEY, {
			...params,
			attachments: Array.from({ length: 10 }, () => ({ ...attachment })),
		});
		expect(fetchMock).toHaveBeenCalledTimes(1);

		expect(() => brevoService.prepareRequest({
			...params,
			attachments: Array.from({ length: 11 }, () => ({ ...attachment })),
		})).toThrow(BizError);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('maps inline attachments with contentId and leaves regular attachments untouched', () => {
		const prepared = brevoService.prepareRequest({
			...params,
			html: '<p>body</p><img src="cid:inline-cid">',
			attachments: [
				{ filename: 'logo.png', content: 'aGVsbG8=', contentType: 'image/png', contentId: 'inline-cid' },
				{ filename: 'report.pdf', content: 'ZmlsZQ==', contentType: 'application/pdf' },
			],
		});

		const body = JSON.parse(prepared.serializedBody);
		expect(body.attachment).toEqual([
			{ name: 'logo.png', content: 'aGVsbG8=', contentId: 'inline-cid' },
			{ name: 'report.pdf', content: 'ZmlsZQ==' },
		]);
		expect(body.htmlContent).toContain('cid:inline-cid');
	});

	it('strips angle brackets from an inline contentId before sending', () => {
		const prepared = brevoService.prepareRequest({
			...params,
			html: '<img src="cid:inline-cid">',
			attachments: [
				{ filename: 'logo.png', content: 'aGVsbG8=', contentType: 'image/png', contentId: '<inline-cid>' },
			],
		});

		const body = JSON.parse(prepared.serializedBody);
		expect(body.attachment[0].contentId).toBe('inline-cid');
	});

	it('counts inline attachments towards the 10-attachment limit', () => {
		const attachment = { filename: 'a.txt', content: 'YQ==', contentType: 'text/plain' };

		expect(() => brevoService.prepareRequest({
			...params,
			html: '<img src="cid:inline-cid">',
			attachments: [
				{ filename: 'logo.png', content: 'aGVsbG8=', contentType: 'image/png', contentId: 'inline-cid' },
				...Array.from({ length: 10 }, () => ({ ...attachment })),
			],
		})).toThrow(BizError);
	});

	it('counts inline attachment bytes towards the 4 MiB limit', () => {
		expect(() => brevoService.prepareRequest({
			...params,
			html: '<img src="cid:inline-cid">',
			attachments: [{
				filename: 'big.png',
				content: 'A'.repeat(4 * 1024 * 1024),
				contentType: 'image/png',
				contentId: 'inline-cid',
			}],
		})).toThrow(BizError);
	});

	it.each([
		['an empty contentId', ''],
		['a whitespace-only contentId', '   '],
		['a contentId with inner whitespace', 'inline cid'],
		['a contentId with control characters', 'inline\u0000cid'],
	])('rejects %s before fetching', (_label, contentId) => {
		const fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);

		expect(() => brevoService.prepareRequest({
			...params,
			html: '<img src="cid:inline-cid">',
			attachments: [{ filename: 'logo.png', content: 'aGVsbG8=', contentType: 'image/png', contentId }],
		})).toThrow(BizError);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('rejects a duplicated inline contentId before fetching', () => {
		const fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);

		expect(() => brevoService.prepareRequest({
			...params,
			html: '<img src="cid:inline-cid">',
			attachments: [
				{ filename: 'one.png', content: 'aGVsbG8=', contentType: 'image/png', contentId: 'inline-cid' },
				{ filename: 'two.png', content: 'd29ybGQ=', contentType: 'image/png', contentId: 'inline-cid' },
			],
		})).toThrow(t('brevoInlineCidDuplicate'));
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('rejects an inline attachment whose contentId is missing from the HTML', () => {
		const fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);

		expect(() => brevoService.prepareRequest({
			...params,
			html: '<p>no reference here</p>',
			attachments: [
				{ filename: 'logo.png', content: 'aGVsbG8=', contentType: 'image/png', contentId: 'inline-cid' },
			],
		})).toThrow(t('brevoInlineCidMismatch'));
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('does not accept a longer cid reference as a match', () => {
		const fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);

		expect(() => brevoService.prepareRequest({
			...params,
			html: '<img src="cid:inline-cid-longer">',
			attachments: [
				{ filename: 'logo.png', content: 'aGVsbG8=', contentType: 'image/png', contentId: 'inline-cid' },
			],
		})).toThrow(t('brevoInlineCidMismatch'));

		const prepared = brevoService.prepareRequest({
			...params,
			html: '<img src="cid:inline-cid"><img src="cid:inline-cid-longer">',
			attachments: [
				{ filename: 'logo.png', content: 'aGVsbG8=', contentType: 'image/png', contentId: 'inline-cid' },
			],
		});
		expect(JSON.parse(prepared.serializedBody).attachment[0].contentId).toBe('inline-cid');
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('rejects a request whose UTF-8 JSON body exceeds 4 MiB before fetching', () => {
		const fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);

		expect(() => brevoService.prepareRequest({
			...params,
			text: '中'.repeat(1_400_000),
		})).toThrow(BizError);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('rejects a single oversized attachment before fetching', () => {
		const fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);

		expect(() => brevoService.prepareRequest({
			...params,
			attachments: [{
				filename: 'large.bin',
				content: 'A'.repeat(4 * 1024 * 1024),
				contentType: 'application/octet-stream',
			}],
		})).toThrow(BizError);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('rejects multiple attachments whose combined request exceeds 4 MiB', () => {
		const fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);
		const content = 'A'.repeat(2 * 1024 * 1024);

		expect(() => brevoService.prepareRequest({
			...params,
			attachments: [
				{ filename: 'one.bin', content, contentType: 'application/octet-stream' },
				{ filename: 'two.bin', content, contentType: 'application/octet-stream' },
				{ filename: 'three.bin', content, contentType: 'application/octet-stream' },
			],
		})).toThrow(BizError);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('accepts a request inside the 4 MiB budget', () => {
		const prepared = brevoService.prepareRequest({
			...params,
			text: 'body '.repeat(1000),
			attachments: [{ filename: 'a.txt', content: 'aGVsbG8=', contentType: 'text/plain' }],
		});

		expect(prepared.attachments).toHaveLength(1);
		expect(prepared.attachments[0].size).toBe(5);
	});

	it('accepts the exact 4 MiB boundary and rejects one byte over', () => {
		const base = brevoService.prepareRequest({ ...params, text: 'a' });
		const baseSize = new TextEncoder().encode(base.serializedBody).byteLength;
		const fill = BREVO_REQUEST_SIZE_LIMIT - baseSize;

		const atLimit = brevoService.prepareRequest({
			...params,
			text: 'a' + 'x'.repeat(fill),
		});
		expect(new TextEncoder().encode(atLimit.serializedBody).byteLength).toBe(BREVO_REQUEST_SIZE_LIMIT);

		expect(() => brevoService.prepareRequest({
			...params,
			text: 'a' + 'x'.repeat(fill + 1),
		})).toThrow(BizError);
	});

	it('never leaks the API key in any error message', async () => {
		const scenarios = [
			vi.fn(async () => jsonResponse({ message: 'bad' }, 401)),
			vi.fn(async () => new Response('unauthorized', { status: 401 })),
			vi.fn(async () => { throw new Error('socket hang up'); }),
			vi.fn(async () => jsonResponse({})),
		];

		for (const mock of scenarios) {
			vi.stubGlobal('fetch', mock);
			const result = await brevoService.send(API_KEY, params);
			const serialized = JSON.stringify(result);
			expect(serialized).not.toContain(API_KEY);
			expect(serialized).not.toContain('SUPERSECRETKEY');
		}
	});
});
