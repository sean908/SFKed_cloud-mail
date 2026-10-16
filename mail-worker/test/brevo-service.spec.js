import { describe, it, expect, vi, afterEach } from 'vitest';
import brevoService from '../src/service/brevo-service';

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
	});

	it('does not set scheduled sending', async () => {
		const fetchMock = vi.fn(async () => jsonResponse({ messageId: '<x@brevo>' }));
		vi.stubGlobal('fetch', fetchMock);

		await brevoService.send(API_KEY, params);

		const [, init] = fetchMock.mock.calls[0];
		const body = JSON.parse(init.body);
		expect(body.scheduledAt).toBeUndefined();
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
