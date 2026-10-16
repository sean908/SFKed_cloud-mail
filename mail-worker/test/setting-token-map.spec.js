import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { makeContext, setupSchema } from './helpers/db';
import settingService from '../src/service/setting-service';

const c = makeContext();

beforeAll(async () => {
	await setupSchema(c);
});

beforeEach(async () => {
	// reset token maps + provider map to empty for a predictable baseline
	await env.db.prepare(`UPDATE setting SET resend_tokens = '{}', brevo_tokens = '{}', provider_map = '{}'`).run();
	await settingService.refresh(c);
});

async function rawSetting() {
	return env.db.prepare('SELECT resend_tokens, brevo_tokens, provider_map FROM setting').first();
}

describe('issue 01 — settings migration & token map persistence', () => {
	it('creates brevo_tokens and provider_map columns', async () => {
		const cols = await env.db.prepare(`SELECT name FROM pragma_table_info('setting')`).all();
		const names = cols.results.map(r => r.name);
		expect(names).toContain('brevo_tokens');
		expect(names).toContain('provider_map');
	});

	it('creates the provider_message table with the unique index', async () => {
		const tables = await env.db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all();
		expect(tables.results.map(r => r.name)).toContain('provider_message');

		const indexes = await env.db.prepare(`SELECT name FROM sqlite_master WHERE type='index'`).all();
		expect(indexes.results.map(r => r.name)).toContain('idx_pm_provider_msg_recipient');
	});

	it('re-running v3_4DB migration is idempotent', async () => {
		const { dbInit } = await import('../src/init/init');
		await expect(dbInit.v3_4DB(c)).resolves.not.toThrow();
	});

	it('merges brevo tokens when the request includes the map', async () => {
		await settingService.set(c, { brevoTokens: { 'example.com': 'brevo-key-1' } });
		let raw = await rawSetting();
		expect(JSON.parse(raw.brevo_tokens)['example.com']).toBe('brevo-key-1');

		await settingService.set(c, { brevoTokens: { 'example2.com': 'brevo-key-2' } });
		raw = await rawSetting();
		const map = JSON.parse(raw.brevo_tokens);
		expect(map['example.com']).toBe('brevo-key-1');
		expect(map['example2.com']).toBe('brevo-key-2');
	});

	it('does not clear existing brevo tokens on unrelated updates', async () => {
		await settingService.set(c, { brevoTokens: { 'example.com': 'brevo-key-1' } });
		await settingService.set(c, { title: 'New Title' });
		const raw = await rawSetting();
		expect(JSON.parse(raw.brevo_tokens)['example.com']).toBe('brevo-key-1');
	});

	it('deletes a brevo token when explicitly set to empty', async () => {
		await settingService.set(c, { brevoTokens: { 'example.com': 'brevo-key-1' } });
		await settingService.set(c, { brevoTokens: { 'example.com': '' } });
		const raw = await rawSetting();
		expect(JSON.parse(raw.brevo_tokens)['example.com']).toBeUndefined();
	});

	it('keeps resend tokens untouched when only brevo tokens are updated', async () => {
		await settingService.set(c, { resendTokens: { 'example.com': 'resend-key-1' } });
		await settingService.set(c, { brevoTokens: { 'example.com': 'brevo-key-1' } });
		const raw = await rawSetting();
		expect(JSON.parse(raw.resend_tokens)['example.com']).toBe('resend-key-1');
		expect(JSON.parse(raw.brevo_tokens)['example.com']).toBe('brevo-key-1');
	});

	it('persists and merges the provider map', async () => {
		await settingService.set(c, { providerMap: { 'example.com': 'brevo' } });
		await settingService.set(c, { providerMap: { 'example2.com': 'resend' } });
		const raw = await rawSetting();
		const map = JSON.parse(raw.provider_map);
		expect(map['example.com']).toBe('brevo');
		expect(map['example2.com']).toBe('resend');
	});

	it('does not clear the provider map on unrelated updates', async () => {
		await settingService.set(c, { providerMap: { 'example.com': 'brevo' } });
		await settingService.set(c, { title: 'Another Title' });
		const raw = await rawSetting();
		expect(JSON.parse(raw.provider_map)['example.com']).toBe('brevo');
	});

	it('masks brevo tokens in the admin settings query', async () => {
		await settingService.set(c, { brevoTokens: { 'example.com': 'xkeysib-abcdefghijklmnop' } });
		await settingService.refresh(c);
		const settings = await settingService.get(c);
		expect(settings.brevoTokens['example.com']).toBe('xkeysib-abcd******');
		expect(settings.brevoTokens['example.com']).not.toContain('mnop');
	});

	it('masks resend tokens in the admin settings query', async () => {
		await settingService.set(c, { resendTokens: { 'example.com': 're_abcdefghijklmnop' } });
		await settingService.refresh(c);
		const settings = await settingService.get(c);
		expect(settings.resendTokens['example.com']).toBe('re_abcdefghi******');
	});

	it('masks the Brevo webhook secret in the admin settings query', async () => {
		await settingService.set(c, { brevoWebhookSecret: 'whsec-abcdefghijklmnop' });
		await settingService.refresh(c);
		const settings = await settingService.get(c);
		expect(settings.brevoWebhookSecret).toBe('whsec-******');
	});

	it('never exposes the Brevo webhook secret through websiteConfig', async () => {
		await settingService.set(c, { brevoWebhookSecret: 'whsec-supersecret' });
		await settingService.refresh(c);
		const config = await settingService.websiteConfig(c);
		expect(JSON.stringify(config)).not.toContain('whsec-supersecret');
		expect(config.brevoWebhookSecret).toBeUndefined();
	});

	it('never exposes tokens or provider maps through websiteConfig', async () => {
		await settingService.set(c, {
			brevoTokens: { 'example.com': 'brevo-secret-key' },
			resendTokens: { 'example.com': 'resend-secret-key' },
			providerMap: { 'example.com': 'brevo' },
		});
		await settingService.refresh(c);
		const config = await settingService.websiteConfig(c);
		const serialized = JSON.stringify(config);
		expect(serialized).not.toContain('brevo-secret-key');
		expect(serialized).not.toContain('resend-secret-key');
		expect(config.brevoTokens).toBeUndefined();
		expect(config.resendTokens).toBeUndefined();
		expect(config.providerMap).toBeUndefined();
	});
});
