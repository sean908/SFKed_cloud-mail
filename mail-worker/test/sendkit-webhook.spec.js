import { describe, it, expect } from 'vitest';
import sendkitWebhookService from '../src/service/sendkit-webhook-service.js';
import { emailConst } from '../src/const/entity-const.js';

describe('sendkitWebhookService.verifySignature', () => {
	// 独立来源的已知向量：HMAC-SHA256("test-secret", "hello")
	const known = 'bcc889a40667cab715e1dc22ad280692cf4bf1c3a280eeeca60d8dbcd8e4b993';

	it('裸 hex 签名校验通过', async () => {
		expect(await sendkitWebhookService.verifySignature('test-secret', 'hello', known)).toBe(true);
	});

	it('sha256= 前缀签名校验通过', async () => {
		expect(await sendkitWebhookService.verifySignature('test-secret', 'hello', `sha256=${known}`)).toBe(true);
	});

	it('错误签名校验失败', async () => {
		expect(await sendkitWebhookService.verifySignature('test-secret', 'hello', 'deadbeef')).toBe(false);
	});

	it('缺少密钥或签名时校验失败', async () => {
		expect(await sendkitWebhookService.verifySignature('', 'hello', known)).toBe(false);
		expect(await sendkitWebhookService.verifySignature('test-secret', 'hello', '')).toBe(false);
	});
});

describe('sendkitWebhookService.EVENT_STATUS', () => {
	it('映射全部 SendKit 投递事件', () => {
		expect(sendkitWebhookService.EVENT_STATUS).toMatchObject({
			'email.sent': emailConst.status.SENT,
			'email.delivered': emailConst.status.DELIVERED,
			'email.bounced': emailConst.status.BOUNCED,
			'email.complained': emailConst.status.COMPLAINED,
			'email.delivery_delayed': emailConst.status.DELAYED,
			'email.failed': emailConst.status.FAILED,
			'email.rejected': emailConst.status.FAILED
		});
	});

	it('opened/clicked/contact 不在映射内（仅确认接收）', () => {
		expect(sendkitWebhookService.EVENT_STATUS['opened']).toBeUndefined();
		expect(sendkitWebhookService.EVENT_STATUS['clicked']).toBeUndefined();
	});

	it('messageFor 不读取 Resend 专属字段，缺失也不抛异常', () => {
		expect(sendkitWebhookService.messageFor({ type: 'email.bounced', data: { email_id: 'm1' } })).toBe(null);
		expect(sendkitWebhookService.messageFor({})).toBe(null);
	});
});
