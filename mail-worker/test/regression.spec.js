import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { makeContext, setupSchema } from './helpers/db';
import emailService from '../src/service/email-service';
import settingService from '../src/service/setting-service';
import { emailConst } from '../src/const/entity-const';

const c = makeContext();

// Cloudflare Email binding cannot be injected via the test wrangler config,
// so the Cloudflare path is exercised with a stubbed binding on a cloned env.
function cloudflareContext() {
	const sent = [];
	return {
		ctx: makeContext({
			env: {
				...env,
				email: { send: async (form) => { sent.push(form); return { messageId: 'cf-<test>' }; } },
			},
		}),
		sent,
	};
}
const ADMIN_EMAIL = 'admin@example.com';
const RESEND_KEY = 're_regression_secret_key';
let userId;
let accountId;

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

	await env.db.prepare(
		`INSERT INTO account (email, user_id, status) VALUES ('friend@example.com', ?, 0)`
	).bind(userId).run();
});

beforeEach(async () => {
	await env.db.prepare(`DELETE FROM provider_message`).run();
	await env.db.prepare(`DELETE FROM email`).run();
	await settingService.refresh(c);
	await settingService.set(c, {
		send: 0,
		providerMap: {},
		brevoTokens: {},
		resendTokens: {},
		r2Domain: '',
	});
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

const baseParams = (over = {}) => ({
	accountId,
	name: 'Alice',
	sendType: 'new',
	receiveEmail: ['bob@external.com'],
	text: 'hello world',
	content: '<p>hello world</p>',
	subject: 'Hi',
	attachments: [],
	...over,
});

async function insertOriginalEmail({
	messageId = '<parent@example.com>',
	relation = '<root@example.com> <older@example.com>',
} = {}) {
	const row = await env.db.prepare(
		`INSERT INTO email (
			send_email, name, account_id, user_id, subject, content, text,
			type, status, message_id, in_reply_to, relation, is_del
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		RETURNING email_id`
	).bind(
		'bob@external.com', 'Bob', accountId, userId, 'Original', '<p>original</p>', 'original',
		emailConst.type.RECEIVE, emailConst.status.RECEIVE, messageId, '<older@example.com>', relation, 0
	).first();
	return row.email_id;
}

async function emails() {
	const { results } = await env.db.prepare(`SELECT * FROM email`).all();
	return results;
}

async function attachments() {
	const { results } = await env.db.prepare(`SELECT * FROM attachments ORDER BY att_id`).all();
	return results;
}

describe('issue 05 — regression: existing paths unaffected by Brevo', () => {
	it('keeps the legacy resend configuration readable', async () => {
		await settingService.set(c, { resendTokens: { 'example.com': RESEND_KEY } });
		await settingService.refresh(c);
		const settings = await settingService.query(c);
		expect(settings.resendTokens['example.com']).toBe(RESEND_KEY);
		// no provider map entry is required for the legacy flow to work
		expect(settings.providerMap['example.com']).toBeUndefined();
	});

	it('still delivers internal-only mail without any external provider', async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);

		const [sent] = await emailService.send(c, baseParams({ receiveEmail: ['friend@example.com'] }), userId);

		expect(fetchMock).not.toHaveBeenCalled();
		const all = await emails();
		const received = all.filter(e => e.type === emailConst.type.RECEIVE);
		expect(received.length).toBe(1);
		expect(received[0].to_email).toBe('friend@example.com');
		expect(received[0].status).toBe(emailConst.status.RECEIVE);
	});

	it('still sends through Cloudflare Email when the binding is present', async () => {
		const { ctx, sent } = cloudflareContext();

		const [emailResult] = await emailService.send(ctx, baseParams(), userId);

		expect(sent.length).toBe(1);
		expect(sent[0].to).toEqual(['bob@external.com']);
		// Cloudflare is a synchronous-accept channel → DELIVERED
		expect(emailResult.status).toBe(emailConst.status.DELIVERED);
	});

	it('still sends through Resend when a resend token is configured', async () => {
		await settingService.set(c, { resendTokens: { 'example.com': RESEND_KEY } });

		const fetchMock = vi.fn(async () => new Response(
			JSON.stringify({ id: 'resend-msg-id' }),
			{ status: 200, headers: { 'Content-Type': 'application/json' } }
		));
		vi.stubGlobal('fetch', fetchMock);

		const [sent] = await emailService.send(c, baseParams(), userId);

		expect(fetchMock).toHaveBeenCalled();
		expect(sent.status).toBe(emailConst.status.SENT);
	});

	it('still allows attachments on the Resend path', async () => {
		await settingService.set(c, { resendTokens: { 'example.com': RESEND_KEY } });
		vi.stubGlobal('fetch', vi.fn(async () => new Response(
			JSON.stringify({ id: 'resend-msg-id' }),
			{ status: 200, headers: { 'Content-Type': 'application/json' } }
		)));

		const [sent] = await emailService.send(c, baseParams({
			attachments: [{ filename: 'a.txt', content: 'ZmlsZQ==', contentType: 'text/plain' }],
		}), userId);

		const rows = await attachments();
		expect(sent.emailId).toBeDefined();
		expect(rows).toHaveLength(1);
		expect(rows[0].filename).toBe('a.txt');
		expect(rows[0].size).toBe(4);
	});

	it('still allows attachments on the Cloudflare path', async () => {
		const { ctx, sent } = cloudflareContext();

		const [result] = await emailService.send(ctx, baseParams({
			attachments: [{ filename: 'a.txt', content: 'ZmlsZQ==', contentType: 'text/plain' }],
		}), userId);

		expect(sent[0].attachments).toHaveLength(1);
		expect(sent[0].attachments[0].filename).toBe('a.txt');
		expect(result.attList).toHaveLength(1);
	});

	it('still stores attachments for internal-only mail', async () => {
		vi.stubGlobal('fetch', vi.fn());

		const [result] = await emailService.send(c, baseParams({
			receiveEmail: ['friend@example.com'],
			attachments: [{ filename: 'a.txt', content: 'ZmlsZQ==', contentType: 'text/plain' }],
		}), userId);

		const rows = await attachments();
		expect(result.attList).toHaveLength(1);
		expect(rows.filter(row => row.filename === 'a.txt')).toHaveLength(2);
	});

	it('still delivers internal replies without an external provider', async () => {
		const originalEmailId = await insertOriginalEmail();
		const fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);

		const [result] = await emailService.send(c, baseParams({
			sendType: 'reply',
			emailId: originalEmailId,
			receiveEmail: ['friend@example.com'],
		}), userId);

		expect(fetchMock).not.toHaveBeenCalled();
		expect(result.inReplyTo).toBe('<parent@example.com>');
		expect(result.relation).toBe('<parent@example.com>');
		const received = (await emails()).filter(
			row => row.type === emailConst.type.RECEIVE && row.to_email === 'friend@example.com'
		);
		expect(received).toHaveLength(1);
	});

	it('still sends reply thread headers on the Cloudflare path', async () => {
		const { ctx, sent } = cloudflareContext();

		const originalEmailId = await insertOriginalEmail();

		const [result] = await emailService.send(ctx, baseParams({
			sendType: 'reply',
			emailId: originalEmailId,
		}), userId);

		expect(sent[0].headers).toEqual({
			'in-reply-to': '<parent@example.com>',
			references: '<parent@example.com>',
		});
		expect(result.inReplyTo).toBe('<parent@example.com>');
		expect(result.relation).toBe('<parent@example.com>');
	});

	it('still sends reply thread headers on the Resend path', async () => {
		await settingService.set(c, { resendTokens: { 'example.com': RESEND_KEY } });
		const originalEmailId = await insertOriginalEmail();
		const fetchMock = vi.fn(async () => new Response(
			JSON.stringify({ id: 'resend-reply-id' }),
			{ status: 200, headers: { 'Content-Type': 'application/json' } }
		));
		vi.stubGlobal('fetch', fetchMock);

		const [result] = await emailService.send(c, baseParams({
			sendType: 'reply',
			emailId: originalEmailId,
		}), userId);

		const [, init] = fetchMock.mock.calls[0];
		const body = JSON.parse(init.body);
		expect(body.headers).toEqual({
			'in-reply-to': '<parent@example.com>',
			references: '<parent@example.com>',
		});
		expect(result.inReplyTo).toBe('<parent@example.com>');
		expect(result.relation).toBe('<parent@example.com>');
	});

	it('never persists provider message rows for Cloudflare sends', async () => {
		const { ctx } = cloudflareContext();
		await emailService.send(ctx, baseParams(), userId);
		const { results } = await env.db.prepare(`SELECT * FROM provider_message`).all();
		expect(results.length).toBe(0);
	});
});
