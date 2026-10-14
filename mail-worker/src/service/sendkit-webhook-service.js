import settingService from './setting-service';
import emailProviderMessageService from './email-provider-message-service';
import { emailConst } from '../const/entity-const';
import { SEND_PROVIDER } from '../lib/send-provider';

// SendKit 事件 -> 邮件状态。
// opened / clicked / contact 等非投递事件不在表内，仅确认接收并忽略。
const EVENT_STATUS = {
	'email.sent': emailConst.status.SENT,
	'email.delivered': emailConst.status.DELIVERED,
	'email.bounced': emailConst.status.BOUNCED,
	'email.complained': emailConst.status.COMPLAINED,
	'email.delivery_delayed': emailConst.status.DELAYED,
	'email.failed': emailConst.status.FAILED,
	'email.rejected': emailConst.status.FAILED
};

const sendkitWebhookService = {

	EVENT_STATUS,

	// 用 Web Crypto 计算 HMAC-SHA256 并做常量时间比较。
	// 兼容 `sha256=<hex>` 与裸 hex 两种签名写法。
	async verifySignature(secret, rawBody, signature) {
		if (!secret || !signature) {
			return false;
		}

		const provided = String(signature).trim().replace(/^sha256=/i, '').toLowerCase();
		if (!provided) {
			return false;
		}

		const key = await crypto.subtle.importKey(
			'raw',
			new TextEncoder().encode(secret),
			{ name: 'HMAC', hash: 'SHA-256' },
			false,
			['sign']
		);
		const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody));
		const expected = [...new Uint8Array(mac)].map(byte => byte.toString(16).padStart(2, '0')).join('');

		return timingSafeEqual(expected, provided);
	},

	// 处理顺序：读原始 body -> 校验签名 -> 解析 JSON -> 按 data.email_id 更新。
	async handle(c) {
		const setting = await settingService.query(c);
		const secret = setting.sendkitWebhookSecret;

		if (!secret) {
			return c.text('webhook secret not configured', 503);
		}

		const raw = await c.req.text();
		const signature = c.req.header('X-Webhook-Signature');

		if (!signature || !(await this.verifySignature(secret, raw, signature))) {
			return c.text('invalid signature', 401);
		}

		let body;
		try {
			body = JSON.parse(raw);
		} catch (e) {
			return c.text('invalid payload', 400);
		}

		const providerMessageId = body?.data?.email_id;
		if (!providerMessageId) {
			return c.text('missing email_id', 400);
		}

		const mapping = await emailProviderMessageService.findByProviderMessageId(c, SEND_PROVIDER.SENDKIT, providerMessageId);
		if (!mapping) {
			// 未找到映射 -> 非 2xx，让 SendKit 按其重试机制再次投递。
			return c.text('unknown email id', 404);
		}

		const status = EVENT_STATUS[body?.type];
		if (status === undefined) {
			return c.text('ignored', 200);
		}

		await emailProviderMessageService.applyStatus(c, mapping, status, this.messageFor(body), this.eventTime(body));
		return c.text('success', 200);
	},

	// 只读取通用的可读字段；缺失或结构不同都不抛异常。
	messageFor(body) {
		const data = body?.data;
		if (!data) {
			return null;
		}
		if (typeof data.message === 'string' && data.message) {
			return data.message;
		}
		if (typeof data.reason === 'string' && data.reason) {
			return data.reason;
		}
		return null;
	},

	eventTime(body) {
		return body?.created_at || body?.data?.created_at || null;
	}

};

function timingSafeEqual(a, b) {
	if (a.length !== b.length) {
		return false;
	}
	let diff = 0;
	for (let i = 0; i < a.length; i++) {
		diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	}
	return diff === 0;
}

export default sendkitWebhookService;
