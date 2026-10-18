import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { makeContext, setupSchema } from './helpers/db';
import { makeR2 } from './helpers/r2';
import emailService from '../src/service/email-service';
import settingService from '../src/service/setting-service';
import { emailConst } from '../src/const/entity-const';
import { t } from '../src/i18n/i18n';

// 非 R2 对象存储后端通过 mock 的 AWS SDK 客户端驱动。
vi.mock('@aws-sdk/client-s3', () => {
	class Command {
		constructor(input) { this.input = input; }
	}
	class S3Client {
		constructor(config) { this.config = config; this.middlewareStack = { add: () => {} }; }
		send(command) { return globalThis.__s3Send(command); }
	}
	return {
		S3Client,
		GetObjectCommand: Command,
		PutObjectCommand: Command,
		DeleteObjectsCommand: Command,
	};
});

const ADMIN_EMAIL = 'admin@example.com';
const BREVO_KEY = 'xkeysib-inline-secret';
const PNG_DATA_URL = 'data:image/png;base64,aGVsbG8=';
const S3_IMAGE_BYTES = new Uint8Array([9, 8, 7]);
let userId;
let accountId;

function r2Context({ failPutAt, failDelete = false } = {}) {
	const { r2, objects } = makeR2({ failPutAt, failDelete });
	return {
		ctx: makeContext({ env: { ...env, r2 } }),
		objects,
	};
}

// Cloudflare Email binding 无法通过测试配置注入，用克隆 env 的 stub 覆盖该路径。
function cloudflareContext() {
	const sent = [];
	return {
		ctx: makeContext({
			env: {
				...env,
				email: { send: async (form) => { sent.push(form); return { messageId: 'cf-inline' }; } },
			},
		}),
		sent,
	};
}

function brevoOk(id = '<inline@brevo>') {
	return vi.fn(async () => new Response(JSON.stringify({ messageId: id }), {
		status: 200,
		headers: { 'Content-Type': 'application/json' },
	}));
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

async function emailRows() {
	const { results } = await env.db.prepare(`SELECT * FROM email`).all();
	return results;
}

async function attachmentRows(emailId) {
	const { results } = await env.db.prepare(
		`SELECT * FROM attachments WHERE email_id = ? ORDER BY att_id`
	).bind(emailId).all();
	return results;
}

async function mappingRows() {
	const { results } = await env.db.prepare(`SELECT * FROM provider_message`).all();
	return results;
}

async function insertAttachmentRow(key, { emailId = 0, filename = 'stored.png' } = {}) {
	const row = await env.db.prepare(
		`INSERT INTO attachments (user_id, account_id, email_id, key, filename, mime_type, size, type)
		 VALUES (?, ?, ?, ?, ?, 'image/png', 5, 0) RETURNING att_id`
	).bind(userId, accountId, emailId, key, filename).first();
	return row.att_id;
}

async function insertOriginalEmail() {
	const row = await env.db.prepare(
		`INSERT INTO email (
			send_email, name, account_id, user_id, subject, content, text,
			type, status, message_id, in_reply_to, relation, is_del
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		RETURNING email_id`
	).bind(
		'bob@external.com', 'Bob', accountId, userId, 'Original', '<p>original</p>', 'original',
		emailConst.type.RECEIVE, emailConst.status.RECEIVE,
		'<parent@example.com>', '<older@example.com>',
		'<root@example.com> <older@example.com>', 0
	).first();
	return row.email_id;
}

async function attachmentRowCount() {
	const { results } = await env.db.prepare(`SELECT * FROM attachments`).all();
	return results.length;
}

beforeAll(async () => {
	await setupSchema(makeContext());

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
});

beforeEach(async () => {
	await env.db.prepare(`DELETE FROM provider_message`).run();
	await env.db.prepare(`DELETE FROM attachments`).run();
	await env.db.prepare(`DELETE FROM email`).run();
	await settingService.refresh(makeContext());
	await settingService.set(makeContext(), {
		send: 0,
		providerMap: { 'example.com': 'brevo' },
		brevoTokens: { 'example.com': BREVO_KEY },
		resendTokens: {},
		r2Domain: '',
		// 每个用例都从「无 S3 配置」开始，避免上一个用例的 S3 设置泄漏
		bucket: '',
		endpoint: '',
		s3AccessKey: '',
		s3SecretKey: '',
	});
});

afterEach(() => {
	delete globalThis.__s3Send;
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('issue 01 — Brevo Data URL / CID inline images', () => {
	it('sends a Base64 inline image with a matching contentId and persists EMBED', async () => {
		const { ctx, objects } = r2Context();
		const fetchMock = brevoOk();
		vi.stubGlobal('fetch', fetchMock);

		const [result] = await emailService.send(ctx, baseParams({
			content: `<p>look <img src="${PNG_DATA_URL}"></p>`,
		}), userId);

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [, init] = fetchMock.mock.calls[0];
		const body = JSON.parse(init.body);

		expect(body.attachment).toHaveLength(1);
		const inline = body.attachment[0];
		expect(inline.name).toMatch(/^inline-[a-f0-9]{32}\.png$/);
		expect(inline.content).toBe('aGVsbG8=');
		expect(inline.contentId).toMatch(/^[a-f0-9]{32}$/);
		expect(body.htmlContent).toContain(`cid:${inline.contentId}`);

		const rows = await attachmentRows(result.emailId);
		expect(rows).toHaveLength(1);
		expect(rows[0].type).toBe(1); // EMBED
		expect(rows[0].content_id).toBe(`<${inline.contentId}>`);
		expect(rows[0].mime_type).toBe('image/png');
		expect(rows[0].size).toBe(5);
		expect(objects.has(rows[0].key)).toBe(true);
		//本地正文保存为站内可访问的对象存储 URL，而不是 cid:
		expect(result.content).not.toContain('cid:');
		expect(result.content).toContain(rows[0].key);
	});

	it('sends multiple inline images with unique CIDs', async () => {
		const { ctx } = r2Context();
		const fetchMock = brevoOk();
		vi.stubGlobal('fetch', fetchMock);

		await emailService.send(ctx, baseParams({
			content: `<img src="${PNG_DATA_URL}"><img src="data:image/jpeg;base64,d29ybGQ=">`,
		}), userId);

		const body = JSON.parse(fetchMock.mock.calls[0][1].body);
		expect(body.attachment).toHaveLength(2);
		const cids = body.attachment.map(item => item.contentId);
		expect(new Set(cids).size).toBe(2);
		expect(body.attachment[0].name.endsWith('.png')).toBe(true);
		expect(body.attachment[1].name.endsWith('.jpg')).toBe(true);
		expect(body.htmlContent).toContain(`cid:${cids[0]}`);
		expect(body.htmlContent).toContain(`cid:${cids[1]}`);
	});

	it.each([
		['invalid Base64', 'data:image/png;base64,%%%bad%%%'],
		['not Base64 encoded', 'data:image/png,rawbytes'],
		['empty content', 'data:image/png;base64,'],
		['an invalid MIME type', 'data:image/;base64,aGVsbG8='],
	])('rejects %s images before calling Brevo', async (_label, src) => {
		const { ctx, objects } = r2Context();
		const fetchMock = brevoOk();
		vi.stubGlobal('fetch', fetchMock);

		await expect(emailService.send(ctx, baseParams({
			content: `<img src="${src}">`,
		}), userId)).rejects.toThrow();

		expect(fetchMock).not.toHaveBeenCalled();
		expect(await emailRows()).toHaveLength(0);
		expect(await mappingRows()).toHaveLength(0);
		expect(objects.size).toBe(0);
	});

	it('rejects an empty Brevo body with a localized error before calling Brevo', async () => {
		const { ctx, objects } = r2Context();
		const fetchMock = brevoOk();
		vi.stubGlobal('fetch', fetchMock);

		await expect(emailService.send(ctx, baseParams({
			text: '',
			content: '',
		}), userId)).rejects.toThrow(t('emptyEmail'));

		expect(fetchMock).not.toHaveBeenCalled();
		expect(await emailRows()).toHaveLength(0);
		expect(await mappingRows()).toHaveLength(0);
		expect(await attachmentRowCount()).toBe(0);
		expect(objects.size).toBe(0);
	});

	it('keeps regular attachments ordered and unchanged when inline images are added', async () => {
		const { ctx, objects } = r2Context();
		const fetchMock = brevoOk();
		vi.stubGlobal('fetch', fetchMock);

		const [result] = await emailService.send(ctx, baseParams({
			content: `<p>see below</p><img src="${PNG_DATA_URL}">`,
			attachments: [
				{ filename: 'first.txt', content: 'Zmlyc3Q=', contentType: 'text/plain' },
				{ filename: 'second.bin', content: new Uint8Array([1, 2, 3]), mimeType: 'application/octet-stream' },
			],
		}), userId);

		const body = JSON.parse(fetchMock.mock.calls[0][1].body);
		expect(body.attachment).toHaveLength(3);
		expect(body.attachment[0].contentId).toBeDefined();
		// 普通附件保持原有顺序与内容，且不带 contentId
		expect(body.attachment.slice(1)).toEqual([
			{ name: 'first.txt', content: 'Zmlyc3Q=' },
			{ name: 'second.bin', content: 'AQID' },
		]);

		const rows = await attachmentRows(result.emailId);
		expect(rows.map(row => row.type)).toEqual([1, 0, 0]);
		expect(rows.map(row => row.filename)).toEqual([
			expect.stringMatching(/^inline-[a-f0-9]{32}\.png$/),
			'first.txt',
			'second.bin',
		]);
		expect(rows[1].content_id).toBeNull();
		expect(rows[2].content_id).toBeNull();
		expect(objects.size).toBe(3);
	});

	it('creates a distinct CID and EMBED record for every occurrence of the same image', async () => {
		const { ctx, objects } = r2Context();
		const fetchMock = brevoOk();
		vi.stubGlobal('fetch', fetchMock);

		const [result] = await emailService.send(ctx, baseParams({
			content: `<img src="${PNG_DATA_URL}"><img src="${PNG_DATA_URL}">`,
		}), userId);

		const body = JSON.parse(fetchMock.mock.calls[0][1].body);
		expect(body.attachment).toHaveLength(2);
		expect(body.attachment[0].content).toBe(body.attachment[1].content);
		const cids = body.attachment.map(item => item.contentId);
		expect(new Set(cids).size).toBe(2);
		expect(body.htmlContent).toContain(`cid:${cids[0]}`);
		expect(body.htmlContent).toContain(`cid:${cids[1]}`);

		const rows = await attachmentRows(result.emailId);
		expect(rows).toHaveLength(2);
		expect(rows.every(row => row.type === 1)).toBe(true);
		expect(new Set(rows.map(row => row.key)).size).toBe(2);
		expect(objects.size).toBe(2);
	});
});

describe('issue 02 — Brevo object-storage inline images', () => {
	it('reads an attachments/ image from R2 and sends it inline', async () => {
		const { ctx, objects } = r2Context();
		const key = 'attachments/existing.png';
		objects.set(key, { bytes: new TextEncoder().encode('hello'), options: {} });
		await insertAttachmentRow(key);
		const fetchMock = brevoOk();
		vi.stubGlobal('fetch', fetchMock);

		const [result] = await emailService.send(ctx, baseParams({
			content: `<img src="${key}">`,
		}), userId);

		const body = JSON.parse(fetchMock.mock.calls[0][1].body);
		expect(body.attachment).toHaveLength(1);
		expect(body.attachment[0].name).toBe('stored.png');
		expect(body.attachment[0].content).toBe('aGVsbG8=');
		expect(body.htmlContent).toContain(`cid:${body.attachment[0].contentId}`);

		const rows = await attachmentRows(result.emailId);
		expect(rows).toHaveLength(1);
		expect(rows[0].type).toBe(1);
		expect(rows[0].key).toBe(key);
		//站内图片对象已存在，发送过程不重复写入
		expect(objects.size).toBe(1);
	});

	it('fails before Brevo when the stored object cannot be read', async () => {
		const { ctx, objects } = r2Context();
		const key = 'attachments/unreadable.png';
		objects.set(key, { bytes: new TextEncoder().encode('hello'), options: {} });
		await insertAttachmentRow(key);
		vi.spyOn(ctx.env.r2, 'get').mockRejectedValue(new Error('storage unavailable'));
		const fetchMock = brevoOk();
		vi.stubGlobal('fetch', fetchMock);

		await expect(emailService.send(ctx, baseParams({
			content: `<img src="${key}">`,
		}), userId)).rejects.toThrow(t('brevoInlineReadError'));

		expect(fetchMock).not.toHaveBeenCalled();
		expect(await emailRows()).toHaveLength(0);
		expect(await attachmentRowCount()).toBe(1);
	});

	it('reads a KV-backed object-storage image into an inline attachment', async () => {
		const key = 'attachments/kv-image.png';
		await env.kv.put(key, new Uint8Array([1, 2, 3]), { metadata: { contentType: 'image/png' } });
		await insertAttachmentRow(key, { filename: 'kv-image.png' });
		const fetchMock = brevoOk();
		vi.stubGlobal('fetch', fetchMock);

		const [result] = await emailService.send(makeContext(), baseParams({
			content: `<img src="${key}">`,
		}), userId);

		const body = JSON.parse(fetchMock.mock.calls[0][1].body);
		expect(body.attachment).toHaveLength(1);
		expect(body.attachment[0].name).toBe('kv-image.png');
		expect(body.attachment[0].content).toBe('AQID');
		expect(body.htmlContent).toContain(`cid:${body.attachment[0].contentId}`);
		const rows = await attachmentRows(result.emailId);
		expect(rows).toHaveLength(1);
		expect(rows[0].type).toBe(1);
		expect(rows[0].key).toBe(key);
		expect(rows[0].content_id).toBe(`<${body.attachment[0].contentId}>`);

		//站内图片对象未被改写或重复创建
		const stored = await env.kv.getWithMetadata(key, { type: 'arrayBuffer' });
		expect(new Uint8Array(stored.value)).toEqual(new Uint8Array([1, 2, 3]));
	});

	it('reads an S3-backed object-storage image into an inline attachment', async () => {
		globalThis.__s3Send = vi.fn(async () => ({ Body: S3_IMAGE_BYTES, ContentType: 'image/png' }));
		await settingService.set(makeContext(), {
			bucket: 'inline-bucket',
			endpoint: 'https://s3.example.com',
			s3AccessKey: 'inline-access',
			s3SecretKey: 'inline-secret',
		});
		const key = 'attachments/s3-image.png';
		await insertAttachmentRow(key, { filename: 's3-image.png' });
		const fetchMock = brevoOk();
		vi.stubGlobal('fetch', fetchMock);

		const [result] = await emailService.send(makeContext(), baseParams({
			content: `<img src="${key}">`,
		}), userId);

		const body = JSON.parse(fetchMock.mock.calls[0][1].body);
		expect(body.attachment).toHaveLength(1);
		expect(body.attachment[0].name).toBe('s3-image.png');
		expect(body.attachment[0].content).toBe('CQgH');
		expect(body.htmlContent).toContain(`cid:${body.attachment[0].contentId}`);

		const rows = await attachmentRows(result.emailId);
		expect(rows).toHaveLength(1);
		expect(rows[0].type).toBe(1);
		expect(rows[0].key).toBe(key);
	});

	it('fails before Brevo when the object metadata is missing', async () => {
		const { ctx, objects } = r2Context();
		objects.set('attachments/orphan.png', { bytes: new TextEncoder().encode('hello'), options: {} });
		const fetchMock = brevoOk();
		vi.stubGlobal('fetch', fetchMock);

		await expect(emailService.send(ctx, baseParams({
			content: '<img src="attachments/orphan.png">',
		}), userId)).rejects.toThrow();

		expect(fetchMock).not.toHaveBeenCalled();
		expect(await emailRows()).toHaveLength(0);
	});

	it('fails before Brevo when the object is missing', async () => {
		const { ctx } = r2Context();
		await insertAttachmentRow('attachments/missing.png');
		const fetchMock = brevoOk();
		vi.stubGlobal('fetch', fetchMock);

		await expect(emailService.send(ctx, baseParams({
			content: '<img src="attachments/missing.png">',
		}), userId)).rejects.toThrow();

		expect(fetchMock).not.toHaveBeenCalled();
		expect(await emailRows()).toHaveLength(0);
	});

	it('fails the whole email when any one of several images is missing', async () => {
		const { ctx, objects } = r2Context();
		objects.set('attachments/ok.png', { bytes: new TextEncoder().encode('hello'), options: {} });
		await insertAttachmentRow('attachments/ok.png');
		await insertAttachmentRow('attachments/gone.png');
		const fetchMock = brevoOk();
		vi.stubGlobal('fetch', fetchMock);

		await expect(emailService.send(ctx, baseParams({
			content: `<img src="attachments/ok.png"><img src="attachments/gone.png"><img src="${PNG_DATA_URL}">`,
		}), userId)).rejects.toThrow();

		expect(fetchMock).not.toHaveBeenCalled();
		expect(await emailRows()).toHaveLength(0);
		expect(objects.has('attachments/ok.png')).toBe(true);
		expect(objects.size).toBe(1);
	});
});

describe('issue 03 — mixed attachments, limits and compensation', () => {
	it('sends inline images and regular attachments in one request with distinct field mapping', async () => {
		const { ctx, objects } = r2Context();
		const fetchMock = brevoOk();
		vi.stubGlobal('fetch', fetchMock);

		const [result] = await emailService.send(ctx, baseParams({
			content: `<img src="${PNG_DATA_URL}">`,
			attachments: [{ filename: 'a.txt', content: 'ZmlsZQ==', contentType: 'text/plain' }],
		}), userId);

		const body = JSON.parse(fetchMock.mock.calls[0][1].body);
		expect(body.attachment).toHaveLength(2);
		expect(body.attachment[0].contentId).toBeDefined();
		expect(body.attachment[1].contentId).toBeUndefined();
		expect(body.attachment[1]).toEqual({ name: 'a.txt', content: 'ZmlsZQ==' });

		const rows = await attachmentRows(result.emailId);
		expect(rows).toHaveLength(2);
		// 内嵌图片只写 EMBED，普通附件只写 ATT
		expect(rows.filter(row => row.type === 1)).toHaveLength(1);
		expect(rows.filter(row => row.type === 0)).toHaveLength(1);
		expect(objects.size).toBe(2);
	});

	it('counts inline images towards the 10-attachment limit', async () => {
		const { ctx } = r2Context();
		const fetchMock = brevoOk();
		vi.stubGlobal('fetch', fetchMock);
		const attachment = { filename: 'a.txt', content: 'YQ==', contentType: 'text/plain' };

		await expect(emailService.send(ctx, baseParams({
			content: `<img src="${PNG_DATA_URL}">`,
			attachments: Array.from({ length: 10 }, () => ({ ...attachment })),
		}), userId)).rejects.toThrow();

		expect(fetchMock).not.toHaveBeenCalled();
		expect(await emailRows()).toHaveLength(0);
	});

	it('cleans inline image objects and records when persistence fails', async () => {
		await env.db.prepare(`DROP TRIGGER IF EXISTS fail_attachment_insert`).run();
		await env.db.prepare(`
			CREATE TRIGGER fail_attachment_insert
			BEFORE INSERT ON attachments
			WHEN NEW.type = 0
			BEGIN
				SELECT RAISE(ABORT, 'forced attachment insert failure');
			END
		`).run();

		try {
			const { ctx, objects } = r2Context();
			const fetchMock = brevoOk();
			vi.stubGlobal('fetch', fetchMock);

			await expect(emailService.send(ctx, baseParams({
				content: `<img src="${PNG_DATA_URL}">`,
				attachments: [{ filename: 'a.txt', content: 'ZmlsZQ==', contentType: 'text/plain' }],
			}), userId)).rejects.toThrow('forced attachment insert failure');

			expect(fetchMock).toHaveBeenCalledTimes(1);
			expect(await emailRows()).toHaveLength(0);
			expect(await mappingRows()).toHaveLength(0);
			expect((await env.db.prepare(`SELECT * FROM attachments`).all()).results).toHaveLength(0);
			//普通附件和内嵌图片的对象都被清理
			expect(objects.size).toBe(0);
		} finally {
			await env.db.prepare(`DROP TRIGGER IF EXISTS fail_attachment_insert`).run();
		}
	});

	it('accepts inline images and regular attachments at the exact 10-attachment boundary', async () => {
		const { ctx } = r2Context();
		const fetchMock = brevoOk();
		vi.stubGlobal('fetch', fetchMock);

		const [result] = await emailService.send(ctx, baseParams({
			content: `<img src="${PNG_DATA_URL}">`,
			attachments: Array.from({ length: 9 }, (_, index) => ({
				filename: `a${index}.txt`,
				content: 'YQ==',
				contentType: 'text/plain',
			})),
		}), userId);

		const body = JSON.parse(fetchMock.mock.calls[0][1].body);
		expect(body.attachment).toHaveLength(10);
		const rows = await attachmentRows(result.emailId);
		expect(rows.filter(row => row.type === 1)).toHaveLength(1);
		expect(rows.filter(row => row.type === 0)).toHaveLength(9);
	});

	it('rejects an inline image that pushes the request over 4 MiB before any local write', async () => {
		const { ctx, objects } = r2Context();
		const fetchMock = brevoOk();
		vi.stubGlobal('fetch', fetchMock);

		await expect(emailService.send(ctx, baseParams({
			content: `<img src="data:image/png;base64,${'A'.repeat(4_500_000)}">`,
		}), userId)).rejects.toThrow(t('brevoAttachmentTooLarge'));

		expect(fetchMock).not.toHaveBeenCalled();
		expect(await emailRows()).toHaveLength(0);
		expect(await mappingRows()).toHaveLength(0);
		expect(await attachmentRowCount()).toBe(0);
		expect(objects.size).toBe(0);
	});

	it('sends one multi-recipient Brevo request with inline images and maps every recipient', async () => {
		const { ctx } = r2Context();
		const fetchMock = brevoOk('<multi-inline@brevo>');
		vi.stubGlobal('fetch', fetchMock);

		const [result] = await emailService.send(ctx, baseParams({
			receiveEmail: ['a@external.com', 'b@external.com'],
			content: `<img src="${PNG_DATA_URL}">`,
		}), userId);

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const body = JSON.parse(fetchMock.mock.calls[0][1].body);
		expect(body.to).toEqual([{ email: 'a@external.com' }, { email: 'b@external.com' }]);
		expect(body.attachment).toHaveLength(1);

		const mappings = await mappingRows();
		expect(mappings).toHaveLength(2);
		expect(mappings.every(row => row.provider_message_id === '<multi-inline@brevo>')).toBe(true);
		expect(mappings.every(row => row.email_id === result.emailId)).toBe(true);
	});

	it('keeps reply thread headers when the reply contains an inline image', async () => {
		const { ctx } = r2Context();
		const originalEmailId = await insertOriginalEmail();
		const fetchMock = brevoOk('<reply-inline@brevo>');
		vi.stubGlobal('fetch', fetchMock);

		const [result] = await emailService.send(ctx, baseParams({
			sendType: 'reply',
			emailId: originalEmailId,
			content: `<p>re</p><img src="${PNG_DATA_URL}">`,
		}), userId);

		const body = JSON.parse(fetchMock.mock.calls[0][1].body);
		expect(body.headers).toEqual({
			'In-Reply-To': '<parent@example.com>',
			References: '<root@example.com> <older@example.com> <parent@example.com>',
		});
		expect(body.attachment).toHaveLength(1);
		expect(body.attachment[0].contentId).toBeDefined();

		const rows = await attachmentRows(result.emailId);
		expect(rows).toHaveLength(1);
		expect(rows[0].type).toBe(1);
	});
});

describe('issue 04 — cross-provider regression for inline images', () => {
	it('keeps Resend inline behavior unchanged (no strict validation)', async () => {
		await settingService.set(makeContext(), {
			providerMap: { 'example.com': 'resend' },
			resendTokens: { 'example.com': 're_inline_key' },
			brevoTokens: {},
		});
		const fetchMock = vi.fn(async () => new Response(
			JSON.stringify({ id: 'resend-inline-id' }),
			{ status: 200, headers: { 'Content-Type': 'application/json' } }
		));
		vi.stubGlobal('fetch', fetchMock);

		const [result] = await emailService.send(makeContext(), baseParams({
			content: `<img src="${PNG_DATA_URL}">`,
		}), userId);

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(result.status).toBe(emailConst.status.SENT);
		const rows = await attachmentRows(result.emailId);
		expect(rows).toHaveLength(1);
		expect(rows[0].type).toBe(1);
	});

	it('keeps internal mail inline behavior unchanged', async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);

		const [result] = await emailService.send(makeContext(), baseParams({
			receiveEmail: ['friend@example.com'],
			content: `<img src="${PNG_DATA_URL}">`,
		}), userId);

		expect(fetchMock).not.toHaveBeenCalled();
		const rows = await attachmentRows(result.emailId);
		expect(rows).toHaveLength(1);
	});

	it('does not persist or fall back when Brevo rejects an inline request', async () => {
		const { ctx, objects } = r2Context();
		const fetchMock = vi.fn(async () => new Response(
			JSON.stringify({ message: 'inline rejected' }),
			{ status: 400, headers: { 'Content-Type': 'application/json' } }
		));
		vi.stubGlobal('fetch', fetchMock);

		await expect(emailService.send(ctx, baseParams({
			content: `<img src="${PNG_DATA_URL}">`,
		}), userId)).rejects.toThrow('inline rejected');

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(await emailRows()).toHaveLength(0);
		expect(await mappingRows()).toHaveLength(0);
		expect((await env.db.prepare(`SELECT * FROM attachments`).all()).results).toHaveLength(0);
		expect(objects.size).toBe(0);
	});

	it('keeps the lenient Resend behavior when a stored image is missing', async () => {
		await settingService.set(makeContext(), {
			providerMap: { 'example.com': 'resend' },
			resendTokens: { 'example.com': 're_inline_key' },
			brevoTokens: {},
		});
		const fetchMock = vi.fn(async () => new Response(
			JSON.stringify({ id: 'resend-lenient-id' }),
			{ status: 200, headers: { 'Content-Type': 'application/json' } }
		));
		vi.stubGlobal('fetch', fetchMock);

		const [result] = await emailService.send(makeContext(), baseParams({
			content: '<img src="attachments/absent.png">',
		}), userId);

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(result.status).toBe(emailConst.status.SENT);
		expect(await attachmentRows(result.emailId)).toHaveLength(0);
	});

	it('keeps the lenient Cloudflare Email behavior when a stored image is missing', async () => {
		await settingService.set(makeContext(), { providerMap: { 'example.com': '' } });
		const { ctx, sent } = cloudflareContext();

		const [result] = await emailService.send(ctx, baseParams({
			content: '<img src="attachments/absent.png">',
		}), userId);

		expect(sent).toHaveLength(1);
		expect(result.status).toBe(emailConst.status.DELIVERED);
		expect(await attachmentRows(result.emailId)).toHaveLength(0);
	});

	it('sends Cloudflare inline images without Brevo strict validation', async () => {
		await settingService.set(makeContext(), { providerMap: { 'example.com': '' } });
		const { ctx, sent } = cloudflareContext();

		const [result] = await emailService.send(ctx, baseParams({
			content: `<img src="${PNG_DATA_URL}">`,
		}), userId);

		expect(sent[0].attachments).toHaveLength(1);
		expect(sent[0].attachments[0].disposition).toBe('inline');
		expect(sent[0].attachments[0].contentId).toMatch(/^[a-f0-9]{32}$/);
		expect(await attachmentRows(result.emailId)).toHaveLength(1);
	});
});
