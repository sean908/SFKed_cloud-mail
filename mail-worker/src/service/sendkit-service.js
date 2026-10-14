import BizError from '../error/biz-error';

// SendKit 事务邮件 REST 适配器。
// 官方文档：https://docs.sendkit.dev/api-reference/endpoint/send-email
// 只使用原生 fetch，不引入 Node SDK。
const SENDKIT_ENDPOINT = 'https://api.sendkit.dev/emails';
const MAX_RECIPIENTS = 50;
const MAX_ATTACHMENTS = 10;

const sendkitService = {

	SENDKIT_ENDPOINT,
	MAX_RECIPIENTS,
	MAX_ATTACHMENTS,

	// 把内部统一的发信参数映射为 SendKit 请求体。
	buildPayload(params) {
		const payload = {
			from: `${params.name} <${params.accountEmail}>`,
			to: [...params.receiveEmail],
			subject: params.subject
		};

		if (params.text) {
			payload.text = params.text;
		}

		if (params.html) {
			payload.html = params.html;
		}

		if (params.sendType === 'reply' && params.messageId) {
			payload.headers = {
				'in-reply-to': params.messageId,
				'references': params.messageId
			};
		}

		const attachments = this.toAttachments(params.attachments);
		if (attachments.length > 0) {
			payload.attachments = attachments;
		}

		return payload;
	},

	// 普通附件以 Base64 发送：filename / content / content_type。
	toAttachments(attachments = []) {
		const result = [];

		for (const attachment of attachments) {
			const content = attachment?.content;
			if (!content) {
				continue;
			}

			result.push({
				filename: attachment.filename,
				content: this.normalizeBase64(content),
				content_type: attachment.contentType || attachment.mimeType || attachment.type || 'application/octet-stream'
			});
		}

		return result;
	},

	normalizeBase64(content) {
		if (typeof content !== 'string') {
			return content;
		}
		let value = content;
		if (value.startsWith('data:')) {
			value = value.split(',')[1] || value;
		}
		return value.replace(/\s+/g, '');
	},

	// 兼容 { id } 与 { data: [{ id }] } 两种 202 响应结构。
	extractIds(body) {
		if (!body) {
			return [];
		}
		if (Array.isArray(body.data)) {
			return body.data.map(item => item?.id).filter(Boolean);
		}
		if (body.data?.id) {
			return [body.data.id];
		}
		if (body.id) {
			return [body.id];
		}
		return [];
	},

	// 只接受 202；其它状态一律抛出，保留 SendKit 的 name/message。
	parseResponse(status, bodyText, headers) {
		const body = this.tryParseJson(bodyText);

		if (status === 202) {
			const ids = this.extractIds(body);
			if (ids.length === 0) {
				throw new BizError('SendKit 响应缺少邮件 ID');
			}
			return { ids };
		}

		let message = body?.message || body?.name || (typeof bodyText === 'string' ? bodyText.trim() : '') || `SendKit 请求失败 (${status})`;

		if (status === 429) {
			const retryAfter = this.readHeader(headers, 'retry-after');
			if (retryAfter) {
				message = `${message} (Retry-After: ${retryAfter})`;
			}
		}

		throw new BizError(message, status >= 400 && status < 600 ? status : 502);
	},

	tryParseJson(text) {
		if (!text) {
			return null;
		}
		try {
			return JSON.parse(text);
		} catch (e) {
			return null;
		}
	},

	readHeader(headers, name) {
		if (!headers) {
			return null;
		}
		if (typeof headers.get === 'function') {
			return headers.get(name);
		}
		return headers[name] ?? headers[name.toLowerCase()] ?? null;
	},

	async send({ apiKey, payload, fetchFn = fetch }) {
		const res = await fetchFn(SENDKIT_ENDPOINT, {
			method: 'POST',
			headers: {
				'Authorization': `Bearer ${apiKey}`,
				'Content-Type': 'application/json'
			},
			body: JSON.stringify(payload)
		});

		const text = await res.text();
		return this.parseResponse(res.status, text, res.headers);
	}

};

export default sendkitService;
