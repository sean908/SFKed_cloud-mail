import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { makeContext, setupSchema } from './helpers/db';
import brevoWebhookService from '../src/service/brevo-webhook-service';
import settingService from '../src/service/setting-service';
import { emailConst } from '../src/const/entity-const';

const SECRET = 'webhook-secret-value';
const HEADER = 'x-brevo-webhook-secret';
const c = makeContext();

beforeAll(async () => {
	await setupSchema(c);
});

beforeEach(async () => {
	await env.db.prepare(`DELETE FROM provider_message`).run();
	await env.db.prepare(`DELETE FROM email`).run();
	await settingService.refresh(c);
	await settingService.set(c, { brevoWebhookSecret: SECRET });
});

async function insertEmail(status = emailConst.status.SENT) {
	const row = await env.db.prepare(
		`INSERT INTO email (account_id, user_id, type, status, to_email) VALUES (1, 1, 1, ?, 'bob@external.com') RETURNING email_id`
	).bind(status).first();
	return row.email_id;
}

async function insertPM(emailId, messageId, recipient, status = emailConst.status.SENT, eventTime = null) {
	await env.db.prepare(
		`INSERT INTO provider_message (email_id, provider, provider_message_id, recipient, status, event_time) VALUES (?, 'brevo', ?, ?, ?, ?)`
	).bind(emailId, messageId, recipient, status, eventTime).run();
}

async function pmRows() {
	const { results } = await env.db.prepare(`SELECT * FROM provider_message`).all();
	return results;
}

async function emailStatus(emailId) {
	const row = await env.db.prepare(`SELECT status FROM email WHERE email_id = ?`).bind(emailId).first();
	return row.status;
}

describe('issue 06 — Brevo webhook: authentication', () => {
	it('rejects a request with no secret header (401)', async () => {
		const res = await SELF.fetch('http://example.com/api/webhooks/brevo', {
			method: 'POST',
			body: JSON.stringify({ event: 'delivered' }),
		});
		expect(res.status).toBe(401);
	});

	it('rejects a request with the wrong secret (401)', async () => {
		const res = await SELF.fetch('http://example.com/api/webhooks/brevo', {
			method: 'POST',
			headers: { [HEADER]: 'wrong' },
			body: JSON.stringify({ event: 'delivered' }),
		});
		expect(res.status).toBe(401);
	});

	it('accepts a request with the correct secret', async () => {
		const emailId = await insertEmail();
		await insertPM(emailId, '<m1@brevo>', 'bob@external.com');

		const res = await SELF.fetch('http://example.com/api/webhooks/brevo', {
			method: 'POST',
			headers: { [HEADER]: SECRET },
			body: JSON.stringify({ event: 'delivered', 'message-id': '<m1@brevo>', email: 'bob@external.com', date: new Date().toISOString() }),
		});
		expect(res.status).toBe(200);
	});

	it('compares secrets in constant time (verifySecret)', () => {
		expect(brevoWebhookService.verifySecret(SECRET, SECRET)).toBe(true);
		expect(brevoWebhookService.verifySecret('nope', SECRET)).toBe(false);
		expect(brevoWebhookService.verifySecret('', SECRET)).toBe(false);
		expect(brevoWebhookService.verifySecret(SECRET, '')).toBe(false);
	});
});

describe('issue 06 — Brevo webhook: message matching', () => {
	it('returns a non-2xx for an unknown message id', async () => {
		const res = await SELF.fetch('http://example.com/api/webhooks/brevo', {
			method: 'POST',
			headers: { [HEADER]: SECRET },
			body: JSON.stringify({ event: 'delivered', 'message-id': '<unknown@brevo>', email: 'bob@external.com' }),
		});
		expect(res.status).toBeGreaterThanOrEqual(400);
	});

	it('matches when the stored id has no angle brackets', async () => {
		const emailId = await insertEmail();
		await insertPM(emailId, 'm1@brevo', 'bob@external.com');

		await brevoWebhookService.handle(c, {
			event: 'delivered', 'message-id': '<m1@brevo>', email: 'bob@external.com', date: new Date().toISOString()
		});

		const rows = await pmRows();
		expect(rows[0].status).toBe(emailConst.status.DELIVERED);
	});
});

describe('issue 06 — Brevo webhook: status mapping', () => {
	const cases = [
		['request', emailConst.status.SENT],
		['sent', emailConst.status.SENT],
		['delivered', emailConst.status.DELIVERED],
		['deferred', emailConst.status.DELAYED],
		['soft_bounce', emailConst.status.DELAYED],
		['hard_bounce', emailConst.status.BOUNCED],
		['blocked', emailConst.status.BOUNCED],
		['invalid', emailConst.status.BOUNCED],
		['error', emailConst.status.FAILED],
		['spam', emailConst.status.COMPLAINED],
		['unsubscribed', emailConst.status.COMPLAINED],
	];

	for (const [eventName, expected] of cases) {
		it(`maps "${eventName}" to status ${expected}`, async () => {
			const emailId = await insertEmail();
			await insertPM(emailId, '<map@brevo>', 'bob@external.com', emailConst.status.SENT);

			await brevoWebhookService.handle(c, {
				event: eventName, 'message-id': '<map@brevo>', email: 'bob@external.com', date: new Date().toISOString()
			});

			const rows = await pmRows();
			expect(rows[0].status).toBe(expected);
		});
	}

	it('advances the main email status to DELIVERED', async () => {
		const emailId = await insertEmail(emailConst.status.SENT);
		await insertPM(emailId, '<e@brevo>', 'bob@external.com');

		await brevoWebhookService.handle(c, {
			event: 'delivered', 'message-id': '<e@brevo>', email: 'bob@external.com', date: new Date().toISOString()
		});

		expect(await emailStatus(emailId)).toBe(emailConst.status.DELIVERED);
	});
});

describe('issue 06 — Brevo webhook: behaviour & robustness', () => {
	it('ignores behavioural events and keeps the row unchanged', async () => {
		const emailId = await insertEmail();
		await insertPM(emailId, '<b@brevo>', 'bob@external.com', emailConst.status.DELIVERED);

		await brevoWebhookService.handle(c, { event: 'opened', 'message-id': '<b@brevo>', email: 'bob@external.com' });
		await brevoWebhookService.handle(c, { event: 'click', 'message-id': '<b@brevo>', email: 'bob@external.com' });

		const rows = await pmRows();
		expect(rows[0].status).toBe(emailConst.status.DELIVERED);
	});

	it('is idempotent for duplicate events', async () => {
		const emailId = await insertEmail();
		await insertPM(emailId, '<d@brevo>', 'bob@external.com');
		const event = { event: 'delivered', 'message-id': '<d@brevo>', email: 'bob@external.com', date: new Date().toISOString() };

		await brevoWebhookService.handle(c, event);
		await brevoWebhookService.handle(c, event);

		const rows = await pmRows();
		expect(rows.length).toBe(1);
		expect(rows[0].status).toBe(emailConst.status.DELIVERED);
	});

	it('does not roll back on an out-of-order (older) event', async () => {
		const emailId = await insertEmail();
		const later = new Date('2030-01-02T00:00:00Z').toISOString();
		await insertPM(emailId, '<o@brevo>', 'bob@external.com', emailConst.status.DELAYED, later);

		await brevoWebhookService.handle(c, {
			event: 'sent', 'message-id': '<o@brevo>', email: 'bob@external.com',
			date: '2030-01-01T00:00:00Z',
		});

		const rows = await pmRows();
		expect(rows[0].status).toBe(emailConst.status.DELAYED);
	});

	it('protects a reached terminal state from a later bounce', async () => {
		const emailId = await insertEmail();
		await insertPM(emailId, '<t@brevo>', 'bob@external.com', emailConst.status.SENT);

		await brevoWebhookService.handle(c, { event: 'delivered', 'message-id': '<t@brevo>', email: 'bob@external.com', date: '2030-01-01T00:00:00Z' });
		await brevoWebhookService.handle(c, { event: 'hard_bounce', 'message-id': '<t@brevo>', email: 'bob@external.com', date: '2030-01-02T00:00:00Z' });

		const rows = await pmRows();
		expect(rows[0].status).toBe(emailConst.status.DELIVERED);
		expect(await emailStatus(emailId)).toBe(emailConst.status.DELIVERED);
	});

	it('uses the epoch field when the event time field is absent', async () => {
		const emailId = await insertEmail();
		await insertPM(emailId, '<ep@brevo>', 'bob@external.com', emailConst.status.SENT);

		await brevoWebhookService.handle(c, {
			event: 'delivered', 'message-id': '<ep@brevo>', email: 'bob@external.com',
			ts_event: 1893456000,
		});

		const rows = await pmRows();
		expect(rows[0].status).toBe(emailConst.status.DELIVERED);
		expect(rows[0].event_time).toBeTruthy();
	});

	it('handles multiple recipients sharing the same message id independently', async () => {
		const emailId = await insertEmail();
		await insertPM(emailId, '<shared@brevo>', 'a@external.com', emailConst.status.SENT);
		await insertPM(emailId, '<shared@brevo>', 'b@external.com', emailConst.status.SENT);

		await brevoWebhookService.handle(c, {
			event: 'delivered', 'message-id': '<shared@brevo>', email: 'a@external.com', date: new Date().toISOString()
		});

		const rows = await pmRows();
		const a = rows.find(r => r.recipient === 'a@external.com');
		const b = rows.find(r => r.recipient === 'b@external.com');
		expect(a.status).toBe(emailConst.status.DELIVERED);
		expect(b.status).toBe(emailConst.status.SENT);
	});

	it('processes a batch payload (array of events)', async () => {
		const emailId = await insertEmail();
		await insertPM(emailId, '<batch1@brevo>', 'a@external.com');
		await insertPM(emailId, '<batch2@brevo>', 'b@external.com');

		await brevoWebhookService.handle(c, [
			{ event: 'delivered', 'message-id': '<batch1@brevo>', email: 'a@external.com', date: new Date().toISOString() },
			{ event: 'delivered', 'message-id': '<batch2@brevo>', email: 'b@external.com', date: new Date().toISOString() },
		]);

		const rows = await pmRows();
		expect(rows.every(r => r.status === emailConst.status.DELIVERED)).toBe(true);
	});
});
