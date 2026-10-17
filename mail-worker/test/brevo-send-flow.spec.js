import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { makeContext, setupSchema } from './helpers/db';
import { makeR2 } from './helpers/r2';
import emailService from '../src/service/email-service';
import settingService from '../src/service/setting-service';
import { emailConst } from '../src/const/entity-const';

const c = makeContext();
const ADMIN_EMAIL = 'admin@example.com';
const BREVO_KEY = 'xkeysib-send-flow-secret-key';
let userId;
let accountId;

function r2Context() {
	const { r2, objects } = makeR2();

	return {
		ctx: makeContext({ env: { ...env, r2 } }),
		objects,
	};
}

function brevoOk(id = '<sent@brevo>') {
	return vi.fn(async () => new Response(JSON.stringify({ messageId: id }), {
		status: 200, headers: { 'Content-Type': 'application/json' }
	}));
}

beforeAll(async () => {
	await setupSchema(c);

	const u = await env.db.prepare(
		`INSERT INTO user (email, type, password, salt, status) VALUES (?, 1, 'x', 'x', 0) RETURNING user_id`
	).bind(ADMIN_EMAIL).first();
	userId = u.user_id;

	const a = await env.db.prepare(
		`INSERT INTO account (email, user_id, status) VALUES ('alice@example.com', ?, 0) RETURNING account_id`
	).bind(userId).first();
	accountId = a.account_id;
});

beforeEach(async () => {
	await env.db.prepare(`DELETE FROM provider_message`).run();
	await env.db.prepare(`DELETE FROM email`).run();
	await settingService.refresh(c);
	await settingService.set(c, {
		send: 0,
		providerMap: { 'example.com': 'brevo' },
		brevoTokens: { 'example.com': BREVO_KEY },
		resendTokens: {},
		r2Domain: '',
	});
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

const baseParams = () => ({
	accountId,
	name: 'Alice',
	sendType: 'new',
	receiveEmail: ['bob@external.com'],
	text: 'hello world',
	content: '<p>hello world</p>',
	subject: 'Hi',
	attachments: [],
});

async function pmRows() {
	const { results } = await env.db.prepare(`SELECT * FROM provider_message`).all();
	return results;
}

describe('issue 03 — Brevo send flow', () => {
	it('sends via Brevo when the domain is mapped to brevo', async () => {
		const fetchMock = brevoOk('<one@brevo>');
		vi.stubGlobal('fetch', fetchMock);

		const [result] = await emailService.send(c, baseParams(), userId);

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(result.status).toBe(emailConst.status.SENT);
	});

	it('records SENT (not DELIVERED) and stores the provider message mapping', async () => {
		vi.stubGlobal('fetch', brevoOk('<one@brevo>'));

		const [result] = await emailService.send(c, baseParams(), userId);

		expect(result.status).toBe(emailConst.status.SENT);
		const rows = await pmRows();
		expect(rows.length).toBe(1);
		expect(rows[0].provider).toBe('brevo');
		expect(rows[0].provider_message_id).toBe('<one@brevo>');
		expect(rows[0].recipient).toBe('bob@external.com');
		expect(rows[0].email_id).toBe(result.emailId);
	});

	it('sends and persists normalized attachments for a successful Brevo send', async () => {
		const { ctx, objects } = r2Context();
		const fetchMock = brevoOk('<with-attachments@brevo>');
		vi.stubGlobal('fetch', fetchMock);

		const [result] = await emailService.send(ctx, {
			...baseParams(),
			attachments: [
				{
					filename: 'hello.txt',
					content: 'data:text/plain;base64,aGVsbG8=',
					size: 9999,
				},
				{
					filename: 'report.csv',
					content: new TextEncoder().encode('a,b\n1,2'),
					mimeType: 'text/csv',
				},
				{
					filename: 'hello.txt',
					content: 'aGVsbG8=',
					contentType: 'text/plain',
				},
			],
		}, userId);

		const [, init] = fetchMock.mock.calls[0];
		const body = JSON.parse(init.body);
		expect(body.attachment).toEqual([
			{ name: 'hello.txt', content: 'aGVsbG8=' },
			{ name: 'report.csv', content: btoa('a,b\n1,2') },
			{ name: 'hello.txt', content: 'aGVsbG8=' },
		]);

		const { results } = await env.db.prepare(
			`SELECT * FROM attachments WHERE email_id = ? ORDER BY att_id`
		).bind(result.emailId).all();
		expect(results).toHaveLength(3);
		expect(results.map(row => row.filename)).toEqual(['hello.txt', 'report.csv', 'hello.txt']);
		expect(results.map(row => row.mime_type)).toEqual(['text/plain', 'text/csv', 'text/plain']);
		expect(results.map(row => row.size)).toEqual([5, 7, 5]);
		expect(results[0].key).toBe(results[2].key);
		expect(objects.size).toBe(2);

		const helloObject = objects.get(results[0].key);
		expect(new TextDecoder().decode(helloObject.bytes)).toBe('hello');
		expect(helloObject.options.httpMetadata.contentType).toBe('text/plain');
		expect(helloObject.options.httpMetadata.contentDisposition).toBe('attachment;filename=hello.txt');

		const pm = await pmRows();
		expect(pm).toHaveLength(1);
		expect(pm[0].email_id).toBe(result.emailId);
		expect(result.status).toBe(emailConst.status.SENT);
	});

	it('uses distinct R2 objects when identical bytes have different attachment metadata', async () => {
		const { ctx, objects } = r2Context();
		vi.stubGlobal('fetch', brevoOk());

		const [result] = await emailService.send(ctx, {
			...baseParams(),
			attachments: [
				{ filename: 'alpha.txt', content: 'c2FtZQ==', contentType: 'text/plain' },
				{ filename: 'beta.txt', content: 'c2FtZQ==', contentType: 'application/octet-stream' },
			],
		}, userId);

		const { results } = await env.db.prepare(
			`SELECT * FROM attachments WHERE email_id = ? ORDER BY att_id`
		).bind(result.emailId).all();
		expect(results).toHaveLength(2);
		expect(results[0].key).not.toBe(results[1].key);
		expect(objects.size).toBe(2);
		expect(objects.get(results[0].key).options.httpMetadata.contentDisposition)
			.toBe('attachment;filename=alpha.txt');
		expect(objects.get(results[1].key).options.httpMetadata.contentDisposition)
			.toBe('attachment;filename=beta.txt');
	});

	it('sends the configured API key in the request header', async () => {
		const fetchMock = brevoOk();
		vi.stubGlobal('fetch', fetchMock);

		await emailService.send(c, baseParams(), userId);

		const [, init] = fetchMock.mock.calls[0];
		expect(init.headers['api-key']).toBe(BREVO_KEY);
	});

	it('shares a single message id across all recipients', async () => {
		vi.stubGlobal('fetch', brevoOk('<shared@brevo>'));

		await emailService.send(c, { ...baseParams(), receiveEmail: ['a@x.com', 'b@x.com'] }, userId);

		const rows = await pmRows();
		expect(rows.length).toBe(2);
		expect(rows.every(r => r.provider_message_id === '<shared@brevo>')).toBe(true);
	});

	it('fails with a config error when brevo is selected but no key exists', async () => {
		await settingService.set(c, { brevoTokens: { 'example.com': '' } });
		const fetchMock = brevoOk();
		vi.stubGlobal('fetch', fetchMock);

		await expect(emailService.send(c, baseParams(), userId)).rejects.toThrow();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('bypasses the external provider for all-internal recipients', async () => {
		const fetchMock = brevoOk();
		vi.stubGlobal('fetch', fetchMock);

		await emailService.send(c, { ...baseParams(), receiveEmail: ['friend@example.com'] }, userId);

		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('rejects invalid attachments before calling Brevo or writing locally', async () => {
		const { ctx, objects } = r2Context();
		const fetchMock = brevoOk();
		vi.stubGlobal('fetch', fetchMock);

		await expect(emailService.send(ctx, {
			...baseParams(),
			attachments: [{ filename: 'a.txt', content: '%%%invalid%%%', contentType: 'text/plain' }],
		}, userId)).rejects.toThrow();

		expect(fetchMock).not.toHaveBeenCalled();
		const { results } = await env.db.prepare(`SELECT * FROM email`).all();
		expect(results).toHaveLength(0);
		expect(objects.size).toBe(0);
	});

	it('rejects reply emails before calling Brevo', async () => {
		const fetchMock = brevoOk();
		vi.stubGlobal('fetch', fetchMock);

		await expect(emailService.send(c, {
			...baseParams(),
			sendType: 'reply',
			emailId: 999999,
		}, userId)).rejects.toThrow();

		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('rejects an empty body before calling Brevo', async () => {
		const fetchMock = brevoOk();
		vi.stubGlobal('fetch', fetchMock);

		await expect(emailService.send(c, {
			...baseParams(),
			text: '',
			content: '',
		}, userId)).rejects.toThrow();

		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('does not leak the API key when Brevo returns an error', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => new Response(
			JSON.stringify({ message: 'invalid key' }), { status: 401, headers: { 'Content-Type': 'application/json' } }
		)));

		let err;
		try {
			await emailService.send(c, baseParams(), userId);
		} catch (e) {
			err = e;
		}
		expect(err).toBeDefined();
		expect(String(err.message)).not.toContain(BREVO_KEY);
	});

	it('does not persist or fall back when the Brevo API rejects the request', async () => {
		const { ctx, objects } = r2Context();
		const fetchMock = vi.fn(async () => new Response(
			JSON.stringify({ message: 'provider rejected' }),
			{ status: 400, headers: { 'Content-Type': 'application/json' } }
		));
		vi.stubGlobal('fetch', fetchMock);

		await expect(emailService.send(ctx, baseParams({
			attachments: [{ filename: 'a.txt', content: 'aGVsbG8=', contentType: 'text/plain' }],
		}), userId)).rejects.toThrow('provider rejected');

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect((await env.db.prepare(`SELECT * FROM email`).all()).results).toHaveLength(0);
		expect((await env.db.prepare(`SELECT * FROM provider_message`).all()).results).toHaveLength(0);
		expect((await env.db.prepare(`SELECT * FROM attachments`).all()).results).toHaveLength(0);
		expect(objects.size).toBe(0);
	});

	it('does not persist or fall back when the Brevo network request fails', async () => {
		const { ctx, objects } = r2Context();
		const fetchMock = vi.fn(async () => { throw new Error('network unavailable'); });
		vi.stubGlobal('fetch', fetchMock);

		await expect(emailService.send(ctx, baseParams({
			attachments: [{ filename: 'a.txt', content: 'aGVsbG8=', contentType: 'text/plain' }],
		}), userId)).rejects.toThrow('network unavailable');

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect((await env.db.prepare(`SELECT * FROM email`).all()).results).toHaveLength(0);
		expect((await env.db.prepare(`SELECT * FROM provider_message`).all()).results).toHaveLength(0);
		expect((await env.db.prepare(`SELECT * FROM attachments`).all()).results).toHaveLength(0);
		expect(objects.size).toBe(0);
	});

	it('rejects more than 10 attachments before fetching or writing locally', async () => {
		const { ctx, objects } = r2Context();
		const fetchMock = brevoOk();
		vi.stubGlobal('fetch', fetchMock);
		const attachment = { filename: 'a.txt', content: 'YQ==', contentType: 'text/plain' };

		await expect(emailService.send(ctx, {
			...baseParams(),
			attachments: Array.from({ length: 11 }, () => ({ ...attachment })),
		}, userId)).rejects.toThrow();

		expect(fetchMock).not.toHaveBeenCalled();
		expect((await env.db.prepare(`SELECT * FROM email`).all()).results).toHaveLength(0);
		expect((await env.db.prepare(`SELECT * FROM attachments`).all()).results).toHaveLength(0);
		expect(objects.size).toBe(0);
	});

	it('rejects a UTF-8 request over 4 MiB before fetching or writing locally', async () => {
		const { ctx, objects } = r2Context();
		const fetchMock = brevoOk();
		vi.stubGlobal('fetch', fetchMock);

		await expect(emailService.send(ctx, {
			...baseParams(),
			text: '中'.repeat(1_400_000),
		}, userId)).rejects.toThrow();

		expect(fetchMock).not.toHaveBeenCalled();
		expect((await env.db.prepare(`SELECT * FROM email`).all()).results).toHaveLength(0);
		expect((await env.db.prepare(`SELECT * FROM attachments`).all()).results).toHaveLength(0);
		expect(objects.size).toBe(0);
	});
});
