import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import KvConst from '../src/const/kv-const.js';
import { emailConst } from '../src/const/entity-const.js';

const SECRET = 'whsec_test';
const RAW = '{"type":"email.delivered","data":{"email_id":"msg_1"}}';
// 独立来源的已知向量：HMAC-SHA256("whsec_test", RAW)
const SIG = '1f50de774e230728710bbbd2fe9e1946fd4f6f75f2900750d09b0ae61c888383';

async function seedSetting(secret = SECRET) {
	await env.kv.put(KvConst.SETTING, JSON.stringify({
		emailPrefixFilter: '',
		resendTokens: {},
		sendkitTokens: {},
		sendProviders: {},
		sendkitWebhookSecret: secret
	}));
}

async function sign(raw) {
	const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
	const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(raw));
	return [...new Uint8Array(mac)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function post(raw, signature) {
	const headers = { 'Content-Type': 'application/json' };
	if (signature !== undefined) {
		headers['X-Webhook-Signature'] = signature;
	}
	return SELF.fetch('http://example.com/webhooks/sendkit', { method: 'POST', headers, body: raw });
}

function rawFor(emailId, type = 'email.delivered') {
	return JSON.stringify({ type, data: { email_id: emailId } });
}

async function seedEmail(emailId, status) {
	await env.db.prepare('INSERT INTO email (email_id, status) VALUES (?, ?)').bind(emailId, status).run();
}

async function seedMapping(emailId, providerMessageId, status) {
	await env.db.prepare(
		"INSERT INTO email_provider_message (email_id, provider, provider_message_id, recipient, status) VALUES (?, 'sendkit', ?, '', ?)"
	).bind(emailId, providerMessageId, status).run();
}

async function mappingStatus(providerMessageId) {
	const row = await env.db.prepare('SELECT status FROM email_provider_message WHERE provider_message_id = ?').bind(providerMessageId).first();
	return row?.status;
}

async function emailStatus(emailId) {
	const row = await env.db.prepare('SELECT status FROM email WHERE email_id = ?').bind(emailId).first();
	return row?.status;
}

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
		update_time DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL
	)`).run();
	await seedSetting();
});

describe('POST /webhooks/sendkit', () => {
	it('有效签名把映射与主邮件状态更新为 DELIVERED', async () => {
		await seedEmail(1, emailConst.status.SENT);
		await seedMapping(1, 'msg_1', emailConst.status.SENT);

		const res = await post(RAW, SIG);

		expect(res.status).toBe(200);
		expect(await mappingStatus('msg_1')).toBe(emailConst.status.DELIVERED);
		expect(await emailStatus(1)).toBe(emailConst.status.DELIVERED);
	});

	it('重复投递幂等，不产生重复记录', async () => {
		await seedEmail(2, emailConst.status.SENT);
		await seedMapping(2, 'msg_dup', emailConst.status.SENT);
		const raw = rawFor('msg_dup');
		const signature = await sign(raw);

		const first = await post(raw, signature);
		const second = await post(raw, signature);

		expect(first.status).toBe(200);
		expect(second.status).toBe(200);
		const { count } = await env.db.prepare("SELECT COUNT(*) AS count FROM email_provider_message WHERE provider_message_id = 'msg_dup'").first();
		expect(count).toBe(1);
	});

	it('缺少签名返回 401', async () => {
		const res = await post(RAW, undefined);
		expect(res.status).toBe(401);
	});

	it('错误签名返回 401', async () => {
		const res = await post(RAW, 'sha256=deadbeef');
		expect(res.status).toBe(401);
	});

	it('未知 provider message id 返回非 2xx 以便 SendKit 重试', async () => {
		const raw = rawFor('does-not-exist');
		const res = await post(raw, await sign(raw));
		expect(res.status).toBeGreaterThanOrEqual(400);
	});

	it('opened 等非投递事件仅确认接收', async () => {
		await seedEmail(3, emailConst.status.SENT);
		await seedMapping(3, 'msg_open', emailConst.status.SENT);
		const raw = rawFor('msg_open', 'opened');
		const res = await post(raw, await sign(raw));

		expect(res.status).toBe(200);
		expect(await mappingStatus('msg_open')).toBe(emailConst.status.SENT);
	});

	it('缺少签名密钥返回 503', async () => {
		await seedSetting('');
		const res = await post(RAW, SIG);
		await seedSetting();

		expect(res.status).toBe(503);
	});
});
