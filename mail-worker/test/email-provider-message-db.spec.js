import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import emailProviderMessageService from '../src/service/email-provider-message-service.js';
import { emailConst } from '../src/const/entity-const.js';

const c = { env };

beforeAll(async () => {
	await env.db.prepare('CREATE TABLE IF NOT EXISTS email (email_id INTEGER PRIMARY KEY AUTOINCREMENT, status INTEGER NOT NULL DEFAULT 0)').run();
	await env.db.prepare(`CREATE TABLE IF NOT EXISTS email_provider_message (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		email_id INTEGER NOT NULL,
		provider TEXT NOT NULL,
		provider_message_id TEXT NOT NULL,
		recipient TEXT NOT NULL DEFAULT '',
		status INTEGER NOT NULL DEFAULT 0,
		message TEXT,
		last_event_at DATETIME,
		create_time DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
		update_time DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
		UNIQUE (provider, provider_message_id)
	)`).run();
});

async function seedEmail(emailId) {
	await env.db.prepare('INSERT INTO email (email_id, status) VALUES (?, ?)').bind(emailId, emailConst.status.SENT).run();
}

describe('emailProviderMessageService.saveMappings', () => {
	it('多收件人按返回顺序逐条建立映射', async () => {
		await seedEmail(10);
		await emailProviderMessageService.saveMappings(c, {
			emailId: 10,
			provider: 'sendkit',
			ids: ['m1', 'm2', 'm3'],
			recipients: ['a@x.com', 'b@x.com', 'c@x.com'],
			status: emailConst.status.SENT
		});

		const rows = await emailProviderMessageService.listByEmailId(c, 10);
		expect(rows.map(row => [row.providerMessageId, row.recipient])).toEqual([
			['m1', 'a@x.com'],
			['m2', 'b@x.com'],
			['m3', 'c@x.com']
		]);
	});
});

describe('emailProviderMessageService.applyStatus', () => {
	it('更新映射并刷新主邮件聚合状态', async () => {
		await seedEmail(11);
		await emailProviderMessageService.saveMappings(c, {
			emailId: 11,
			provider: 'sendkit',
			ids: ['d1', 'd2'],
			recipients: ['a@x.com', 'b@x.com']
		});

		const first = await emailProviderMessageService.findByProviderMessageId(c, 'sendkit', 'd1');
		await emailProviderMessageService.applyStatus(c, first, emailConst.status.DELIVERED, null, '2026-01-01T00:00:02Z');

		let emailRow = await env.db.prepare('SELECT status FROM email WHERE email_id = 11').first();
		expect(emailRow.status).toBe(emailConst.status.SENT);

		const second = await emailProviderMessageService.findByProviderMessageId(c, 'sendkit', 'd2');
		await emailProviderMessageService.applyStatus(c, second, emailConst.status.DELIVERED, null, '2026-01-01T00:00:03Z');

		emailRow = await env.db.prepare('SELECT status FROM email WHERE email_id = 11').first();
		expect(emailRow.status).toBe(emailConst.status.DELIVERED);
	});

	it('乱序事件不回退终态', async () => {
		await seedEmail(12);
		await emailProviderMessageService.saveMappings(c, {
			emailId: 12,
			provider: 'sendkit',
			ids: ['e1'],
			recipients: ['a@x.com']
		});

		const row = await emailProviderMessageService.findByProviderMessageId(c, 'sendkit', 'e1');
		await emailProviderMessageService.applyStatus(c, row, emailConst.status.BOUNCED, null, '2026-01-01T00:00:05Z');
		await emailProviderMessageService.applyStatus(c, { ...row, status: emailConst.status.BOUNCED }, emailConst.status.SENT, null, '2026-01-01T00:00:01Z');

		const after = await emailProviderMessageService.findByProviderMessageId(c, 'sendkit', 'e1');
		expect(after.status).toBe(emailConst.status.BOUNCED);
	});
});
