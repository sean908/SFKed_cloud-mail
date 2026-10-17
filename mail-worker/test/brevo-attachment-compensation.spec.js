import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { makeContext, setupSchema } from './helpers/db';
import { makeR2 } from './helpers/r2';
import emailService from '../src/service/email-service';
import settingService from '../src/service/setting-service';
import { buildNormalizedAttachmentKey } from '../src/service/att-service';
import { normalizeAttachment } from '../src/utils/attachment-utils';

const ADMIN_EMAIL = 'admin@example.com';
const BREVO_KEY = 'xkeysib-compensation-secret';
let userId;
let accountId;

function r2Context({ failPutAt, failDelete = false } = {}) {
	const { r2, objects } = makeR2({ failPutAt, failDelete });

	return {
		ctx: makeContext({ env: { ...env, r2 } }),
		objects,
	};
}

function baseParams(over = {}) {
	return {
		accountId,
		name: 'Alice',
		sendType: 'new',
		receiveEmail: ['bob@external.com'],
		text: 'hello world',
		content: '<p>hello world</p>',
		subject: 'Hi',
		attachments: [],
		...over,
	};
}

function brevoOk(id = '<accepted@brevo>') {
	return vi.fn(async () => new Response(JSON.stringify({ messageId: id }), {
		status: 200,
		headers: { 'Content-Type': 'application/json' },
	}));
}

async function tableCount(table) {
	const row = await env.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first();
	return row.count;
}

async function userSendCount() {
	const row = await env.db.prepare(`SELECT send_count FROM user WHERE user_id = ?`)
		.bind(userId).first();
	return row.send_count;
}

async function dropTriggers() {
	for (const name of [
		'fail_email_insert',
		'fail_provider_message_insert',
		'fail_attachment_insert',
	]) {
		await env.db.prepare(`DROP TRIGGER IF EXISTS ${name}`).run();
	}
}

beforeAll(async () => {
	const c = makeContext();
	await setupSchema(c);

	const user = await env.db.prepare(
		`INSERT INTO user (email, type, password, salt, status)
		 VALUES (?, 1, 'x', 'x', 0) RETURNING user_id`
	).bind(ADMIN_EMAIL).first();
	userId = user.user_id;

	const account = await env.db.prepare(
		`INSERT INTO account (email, user_id, status)
		 VALUES ('alice@example.com', ?, 0) RETURNING account_id`
	).bind(userId).first();
	accountId = account.account_id;

	await env.db.prepare(
		`UPDATE role SET send_count = 100, send_type = 'count' WHERE role_id = 1`
	).run();
});

beforeEach(async () => {
	await dropTriggers();
	await env.db.prepare(`DELETE FROM provider_message`).run();
	await env.db.prepare(`DELETE FROM attachments`).run();
	await env.db.prepare(`DELETE FROM email`).run();
	await env.db.prepare(`UPDATE user SET send_count = 0 WHERE user_id = ?`).bind(userId).run();
	await settingService.refresh(makeContext());
	await settingService.set(makeContext(), {
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

describe('Brevo attachment persistence compensation', () => {
	it('rolls back the send count when the email insert fails after Brevo accepts', async () => {
		await env.db.prepare(`
			CREATE TRIGGER fail_email_insert
			BEFORE INSERT ON email
			WHEN NEW.subject = 'force-email-failure'
			BEGIN
				SELECT RAISE(ABORT, 'forced email insert failure');
			END
		`).run();
		const fetchMock = brevoOk();
		vi.stubGlobal('fetch', fetchMock);

		let error;
		try {
			await emailService.send(makeContext(), baseParams({ subject: 'force-email-failure' }), userId);
		} catch (e) {
			error = e;
		}

		expect(error?.message).toContain('forced email insert failure');
		expect(await userSendCount()).toBe(0);
		expect(await tableCount('email')).toBe(0);
		expect(await tableCount('provider_message')).toBe(0);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('removes the email and mapping when provider mapping insertion fails', async () => {
		await env.db.prepare(`
			CREATE TRIGGER fail_provider_message_insert
			BEFORE INSERT ON provider_message
			WHEN NEW.provider_message_id = 'fail@brevo'
			BEGIN
				SELECT RAISE(ABORT, 'forced mapping insert failure');
			END
		`).run();
		const { ctx, objects } = r2Context();
		const fetchMock = brevoOk('fail@brevo');
		vi.stubGlobal('fetch', fetchMock);

		let error;
		try {
			await emailService.send(ctx, baseParams({
				attachments: [{ filename: 'a.txt', content: 'aGVsbG8=', contentType: 'text/plain' }],
			}), userId);
		} catch (e) {
			error = e;
		}

		expect(error?.message).toContain('forced mapping insert failure');
		expect(error?.providerMessageIds).toEqual(['fail@brevo']);
		expect(await userSendCount()).toBe(0);
		expect(await tableCount('email')).toBe(0);
		expect(await tableCount('provider_message')).toBe(0);
		expect(await tableCount('attachments')).toBe(0);
		expect(objects.size).toBe(0);
	});

	it('removes the email, mapping and count when attachment insertion fails', async () => {
		await env.db.prepare(`
			CREATE TRIGGER fail_attachment_insert
			BEFORE INSERT ON attachments
			WHEN NEW.filename = 'fail.txt'
			BEGIN
				SELECT RAISE(ABORT, 'forced attachment insert failure');
			END
		`).run();
		const { ctx, objects } = r2Context();
		vi.stubGlobal('fetch', brevoOk());

		await expect(emailService.send(ctx, baseParams({
			attachments: [{ filename: 'fail.txt', content: 'aGVsbG8=', contentType: 'text/plain' }],
		}), userId)).rejects.toThrow('forced attachment insert failure');

		expect(await userSendCount()).toBe(0);
		expect(await tableCount('email')).toBe(0);
		expect(await tableCount('provider_message')).toBe(0);
		expect(await tableCount('attachments')).toBe(0);
		expect(objects.size).toBe(0);
	});

	it('cleans rows and the already-written object after a partial R2 failure', async () => {
		const { ctx, objects } = r2Context({ failPutAt: 2 });
		vi.stubGlobal('fetch', brevoOk());

		await expect(emailService.send(ctx, baseParams({
			attachments: [
				{ filename: 'one.txt', content: 'b25l', contentType: 'text/plain' },
				{ filename: 'two.txt', content: 'dHdv', contentType: 'text/plain' },
			],
		}), userId)).rejects.toThrow('forced R2 put failure');

		expect(await userSendCount()).toBe(0);
		expect(await tableCount('email')).toBe(0);
		expect(await tableCount('provider_message')).toBe(0);
		expect(await tableCount('attachments')).toBe(0);
		expect(objects.size).toBe(0);
	});

	it('cleans an exclusively referenced R2 key used by duplicate attachments', async () => {
		const { ctx, objects } = r2Context({ failPutAt: 1 });
		vi.stubGlobal('fetch', brevoOk());
		const duplicate = { filename: 'same.txt', content: 'c2FtZQ==', contentType: 'text/plain' };

		await expect(emailService.send(ctx, baseParams({
			attachments: [{ ...duplicate }, { ...duplicate }],
		}), userId)).rejects.toThrow('forced R2 put failure');

		expect(await tableCount('attachments')).toBe(0);
		expect(objects.size).toBe(0);
	});

	it('keeps an R2 object that another email still references', async () => {
		const { ctx, objects } = r2Context();
		vi.stubGlobal('fetch', brevoOk());

		const normalized = normalizeAttachment({
			filename: 'shared.txt',
			content: 'c2hhcmVk',
			contentType: 'text/plain',
		});
		const bytes = normalized.bytes;
		const key = await buildNormalizedAttachmentKey(normalized);
		const otherEmail = await env.db.prepare(
			`INSERT INTO email (account_id, user_id, subject, type, status)
			 VALUES (?, ?, 'other', 1, 1) RETURNING email_id`
		).bind(accountId, userId).first();
		await env.db.prepare(
			`INSERT INTO attachments
			 (user_id, email_id, account_id, key, filename, mime_type, size, type)
			 VALUES (?, ?, ?, ?, 'shared.txt', 'text/plain', 6, 0)`
		).bind(userId, otherEmail.email_id, accountId, key).run();
		objects.set(key, { bytes, options: {} });

		await env.db.prepare(`
			CREATE TRIGGER fail_attachment_insert
			BEFORE INSERT ON attachments
			WHEN NEW.filename = 'shared.txt'
			BEGIN
				SELECT RAISE(ABORT, 'forced attachment insert failure');
			END
		`).run();

		await expect(emailService.send(ctx, baseParams({
			attachments: [{ filename: 'shared.txt', content: 'c2hhcmVk', contentType: 'text/plain' }],
		}), userId)).rejects.toThrow('forced attachment insert failure');

		expect(objects.has(key)).toBe(true);
		const shared = await env.db.prepare(
			`SELECT COUNT(*) AS count FROM attachments WHERE key = ?`
		).bind(key).first();
		expect(shared.count).toBe(1);
	});

	it('preserves the original persistence error when cleanup also fails', async () => {
		await env.db.prepare(`
			CREATE TRIGGER fail_attachment_insert
			BEFORE INSERT ON attachments
			WHEN NEW.filename = 'fail.txt'
			BEGIN
				SELECT RAISE(ABORT, 'forced attachment insert failure');
			END
		`).run();
		const { ctx } = r2Context({ failDelete: true });
		vi.stubGlobal('fetch', brevoOk());
		vi.spyOn(console, 'error').mockImplementation(() => {});

		let error;
		try {
			await emailService.send(ctx, baseParams({
				attachments: [{ filename: 'fail.txt', content: 'aGVsbG8=', contentType: 'text/plain' }],
			}), userId);
		} catch (e) {
			error = e;
		}

		expect(error?.message).toContain('forced attachment insert failure');
		expect(error?.message).not.toContain('forced R2 delete failure');
		expect(await userSendCount()).toBe(0);
		expect(await tableCount('email')).toBe(0);
		expect(await tableCount('provider_message')).toBe(0);
		expect(await tableCount('attachments')).toBe(0);
	});
});
