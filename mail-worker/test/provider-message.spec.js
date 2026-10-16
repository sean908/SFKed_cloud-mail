import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { makeContext, setupSchema } from './helpers/db';
import providerMessageService from '../src/service/provider-message-service';
import { emailConst, providerConst } from '../src/const/entity-const';

const c = makeContext();

beforeAll(async () => {
	await setupSchema(c);
});

beforeEach(async () => {
	await env.db.prepare(`DELETE FROM provider_message`).run();
});

async function rows() {
	const { results } = await env.db.prepare(`SELECT * FROM provider_message`).all();
	return results;
}

describe('issue 01 — provider message persistence', () => {
	it('stores a single shared id for every recipient', async () => {
		await providerMessageService.saveMappings(c, 10, providerConst.BREVO, ['a@x.com', 'b@x.com'], '<shared@brevo>');
		const r = await rows();
		expect(r.length).toBe(2);
		expect(r.every(row => row.provider_message_id === '<shared@brevo>')).toBe(true);
	});

	it('stores one id per recipient when given a list', async () => {
		await providerMessageService.saveMappings(c, 10, providerConst.BREVO, ['a@x.com', 'b@x.com'], ['<a@brevo>', '<b@brevo>']);
		const r = await rows();
		const a = r.find(x => x.recipient === 'a@x.com');
		const b = r.find(x => x.recipient === 'b@x.com');
		expect(a.provider_message_id).toBe('<a@brevo>');
		expect(b.provider_message_id).toBe('<b@brevo>');
	});

	it('rejects a mismatched id count before writing anything', async () => {
		await expect(
			providerMessageService.saveMappings(c, 10, providerConst.BREVO, ['a@x.com', 'b@x.com'], ['<only@brevo>', '<two@brevo>', '<three@brevo>'])
		).rejects.toThrow();
		expect((await rows()).length).toBe(0);
	});

	it('initialises new mappings with the SENT status', async () => {
		await providerMessageService.saveMappings(c, 10, providerConst.BREVO, ['a@x.com'], '<x@brevo>');
		const r = await rows();
		expect(r[0].status).toBe(emailConst.status.SENT);
	});

	it('prevents duplicate mappings for the same provider/message/recipient', async () => {
		await providerMessageService.saveMappings(c, 10, providerConst.BREVO, ['a@x.com'], '<dup@brevo>');
		await expect(
			providerMessageService.saveMappings(c, 10, providerConst.BREVO, ['a@x.com'], '<dup@brevo>')
		).rejects.toThrow();
		expect((await rows()).length).toBe(1);
	});

	it('allows the same provider id for different recipients', async () => {
		await providerMessageService.saveMappings(c, 10, providerConst.BREVO, ['a@x.com'], '<same@brevo>');
		await providerMessageService.saveMappings(c, 10, providerConst.BREVO, ['b@x.com'], '<same@brevo>');
		expect((await rows()).length).toBe(2);
	});

	it('finds mappings by provider and recipient', async () => {
		await providerMessageService.saveMappings(c, 10, providerConst.BREVO, ['a@x.com'], '<find@brevo>');
		const found = await providerMessageService.findByProviderAndRecipient(c, providerConst.BREVO, 'a@x.com');
		expect(found.length).toBe(1);
		expect(found[0].providerMessageId).toBe('<find@brevo>');
	});

	it('finds mappings by email id', async () => {
		await providerMessageService.saveMappings(c, 10, providerConst.BREVO, ['a@x.com', 'b@x.com'], '<email@brevo>');
		await providerMessageService.saveMappings(c, 99, providerConst.BREVO, ['c@x.com'], '<other@brevo>');
		const found = await providerMessageService.findByEmailId(c, 10);
		expect(found.length).toBe(2);
		expect(found.every(row => row.emailId === 10)).toBe(true);
	});

	it('updates the status of a mapping', async () => {
		await providerMessageService.saveMappings(c, 10, providerConst.BREVO, ['a@x.com'], '<upd@brevo>');
		const [row] = await rows();
		await providerMessageService.updateStatus(c, row.pm_id, emailConst.status.DELIVERED, null, '2030-01-01T00:00:00Z');
		const after = await rows();
		expect(after[0].status).toBe(emailConst.status.DELIVERED);
		expect(after[0].event_time).toBe('2030-01-01T00:00:00Z');
	});
});
