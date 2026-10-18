import { t } from '../i18n/i18n'
import BizError from '../error/biz-error';
import { normalizeAttachments } from '../utils/attachment-utils';

const BREVO_API_URL = 'https://api.brevo.com/v3/smtp/email';
export const BREVO_ATTACHMENT_LIMIT = 10;
export const BREVO_REQUEST_SIZE_LIMIT = 4 * 1024 * 1024;

const brevoService = {

	prepareRequest(params) {
		const attachments = params.attachments || [];
		if (attachments.length > BREVO_ATTACHMENT_LIMIT) {
			throw new BizError(t('brevoAttachmentLimit'));
		}

		const normalizedAttachments = normalizeAttachments(attachments);
		const body = {
			sender: { name: params.name, email: params.accountEmail },
			to: params.receiveEmail.map(email => ({ email })),
			subject: params.subject
		};

		if (params.text) {
			body.textContent = params.text;
		}
		if (params.html) {
			body.htmlContent = params.html;
		}
		if (params.sendType === 'reply') {
			const inReplyTo = params.replyHeaders?.inReplyTo;
			const references = params.replyHeaders?.references;
			if (!inReplyTo?.trim() || !references?.trim()) {
				throw new BizError(t('brevoReplyMessageIdMissing'));
			}
			body.headers = {
				'In-Reply-To': inReplyTo,
				References: references,
			};
		}
		if (normalizedAttachments.length > 0) {
			body.attachment = normalizedAttachments.map(attachment => ({
				name: attachment.filename,
				content: attachment.content,
			}));
		}

		const serializedBody = JSON.stringify(body);
		if (new TextEncoder().encode(serializedBody).byteLength > BREVO_REQUEST_SIZE_LIMIT) {
			throw new BizError(t('brevoAttachmentTooLarge'));
		}

		return {
			serializedBody,
			attachments: normalizedAttachments,
		};
	},

	async send(apiKey, params) {
		const prepared = this.prepareRequest(params);
		let response;
		try {
			response = await fetch(BREVO_API_URL, {
				method: 'POST',
				headers: {
					'api-key': apiKey,
					'Content-Type': 'application/json',
					'Accept': 'application/json'
				},
				body: prepared.serializedBody
			});
		} catch (e) {
			// Network error — do not retry, do not switch provider
			return {
				data: null,
				error: { message: t('brevoSendError') + ': ' + e.message }
			};
		}

		// Try to parse JSON response
		let result;
		try {
			result = await response.json();
		} catch (e) {
			// Non-JSON response
			const text = await response.text().catch(() => '');
			return {
				data: null,
				error: { message: t('brevoSendError') + ': ' + (text || response.status) }
			};
		}

		if (!response.ok) {
			// Structured error from Brevo
			const errorMsg = result.message || result.error || JSON.stringify(result);
			return {
				data: null,
				error: { message: t('brevoSendError') + ': ' + errorMsg }
			};
		}

		// Success — extract message ID(s)
		// Brevo returns messageId as a string for single recipient,
		// or an array of strings for multiple recipients
		const messageId = result.messageId;
		const messageIds = Array.isArray(messageId) ? messageId : [messageId];

		if (
			messageIds.length === 0
			|| messageIds.some(id => typeof id !== 'string' || !id.trim())
		) {
			return {
				data: null,
				error: { message: t('brevoResponseError') },
				attachments: prepared.attachments,
			};
		}

		return {
			data: { id: messageId },
			error: null,
			attachments: prepared.attachments,
		};
	}
};

export default brevoService;
