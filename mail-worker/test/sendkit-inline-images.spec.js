import { describe, it, expect, vi, afterEach } from 'vitest';
import emailService from '../src/service/email-service.js';

const setting = { bucket: '', endpoint: '', s3AccessKey: '', s3SecretKey: '', r2Domain: 'cdn.example.com' };

function fakeContext(env = {}) {
	return {
		env,
		get: () => setting,
		set: () => {}
	};
}

const inlineImage = () => ({
	key: 'attachments/pic.png',
	contentId: 'cid-1',
	filename: 'pic.png',
	mimeType: 'image/png',
	buff: new ArrayBuffer(4)
});

const params = (imageDataList) => ({
	name: 'Alice',
	accountEmail: 'alice@example.com',
	receiveEmail: ['bob@external.com'],
	subject: 'Hi',
	text: 'plain',
	html: '<p>x</p><img src="cid:cid-1">',
	sendType: 'send',
	messageId: null,
	attachments: [],
	imageDataList,
	r2Domain: 'cdn.example.com'
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('emailService.cidToUrl', () => {
	it('把正文中的 cid: 图片改写为 R2 公网 URL', () => {
		const html = emailService.cidToUrl(
			'<img src="cid:cid-1">',
			[{ contentId: 'cid-1', key: 'attachments/pic.png' }],
			'https://cdn.example.com'
		);
		expect(html).toContain('src="https://cdn.example.com/attachments/pic.png"');
		expect(html).not.toContain('cid:');
	});
});

describe('emailService.sendBySendkit', () => {
	it('无 R2 binding 时拒绝发送内嵌图片', async () => {
		const c = fakeContext({});
		await expect(emailService.sendBySendkit(c, 'sk_test', params([inlineImage()])))
			.rejects.toThrow(/对象存储/);
	});

	it('无内嵌图片时不要求 R2', async () => {
		vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ id: 'm1' }), { status: 202 }));
		const c = fakeContext({});
		const result = await emailService.sendBySendkit(c, 'sk_test', params([]));
		expect(result).toEqual({ ids: ['m1'] });
	});

	it('provider 失败时清理本次预上传对象', async () => {
		const put = vi.fn().mockResolvedValue(undefined);
		const del = vi.fn().mockResolvedValue(undefined);
		const c = fakeContext({ r2: { put, delete: del } });
		vi.stubGlobal('fetch', async () => new Response('boom', { status: 500 }));

		await expect(emailService.sendBySendkit(c, 'sk_test', params([inlineImage()]))).rejects.toThrow();

		expect(put).toHaveBeenCalledWith('attachments/pic.png', expect.anything(), expect.anything());
		expect(del).toHaveBeenCalledWith('attachments/pic.png');
	});

	it('成功时保留预上传对象', async () => {
		const put = vi.fn().mockResolvedValue(undefined);
		const del = vi.fn().mockResolvedValue(undefined);
		const c = fakeContext({ r2: { put, delete: del } });
		vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ id: 'm1' }), { status: 202 }));

		const result = await emailService.sendBySendkit(c, 'sk_test', params([inlineImage()]));

		expect(result).toEqual({ ids: ['m1'] });
		expect(put).toHaveBeenCalled();
		expect(del).not.toHaveBeenCalled();
	});
});
