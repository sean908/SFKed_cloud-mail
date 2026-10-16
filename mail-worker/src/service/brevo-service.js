import { t } from '../i18n/i18n'
import BizError from '../error/biz-error';

const BREVO_API_URL = 'https://api.brevo.com/v3/smtp/email';

const brevoService = {

	// Send email via Brevo HTTP API (no SDK)
	async send(apiKey, params) {
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

		let response;
		try {
			response = await fetch(BREVO_API_URL, {
				method: 'POST',
				headers: {
					'api-key': apiKey,
					'Content-Type': 'application/json',
					'Accept': 'application/json'
				},
				body: JSON.stringify(body)
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

		if (!messageId) {
			return {
				data: null,
				error: { message: t('brevoResponseError') }
			};
		}

		return {
			data: { id: messageId },
			error: null
		};
	}
};

export default brevoService;
