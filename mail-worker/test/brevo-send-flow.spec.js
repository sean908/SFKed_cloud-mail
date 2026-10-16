import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { makeContext, setupSchema } from './helpers/db';
import emailService from '../src/service/email-service';
import settingService from '../src/service/setting-service';
import { emailConst } from '../src/const/entity-const';

const c = makeContext();
const ADMIN_EMAIL = 'admin@example.com';
const BREVO_KEY = 'xkeysib-send-flow-secret-key';
let userId;
let accountId;

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

	it('rejects attachments before calling Brevo', async () => {
		const fetchMock = brevoOk();
		vi.stubGlobal('fetch', fetchMock);

		await expect(emailService.send(c, {
			...baseParams(),
			attachments: [{ filename: 'a.txt', content: 'ZmlsZQ==', contentType: 'text/plain' }],
		}, userId)).rejects.toThrow();

		expect(fetchMock).not.toHaveBeenCalled();
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
});
