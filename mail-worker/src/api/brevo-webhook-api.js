import app from '../hono/hono';
import brevoWebhookService from '../service/brevo-webhook-service';
import settingService from '../service/setting-service';

// Admin configures this header in the Brevo webhook settings.
export const BREVO_WEBHOOK_SECRET_HEADER = 'x-brevo-webhook-secret';

app.post('/webhooks/brevo', async (c) => {

	const setting = await settingService.query(c);
	const storedSecret = setting.brevoWebhookSecret;
	const providedSecret = c.req.header(BREVO_WEBHOOK_SECRET_HEADER);

	if (!brevoWebhookService.verifySecret(providedSecret, storedSecret)) {
		return c.text('unauthorized', 401);
	}

	let body;
	try {
		body = await c.req.json();
	} catch (e) {
		return c.text('invalid payload', 400);
	}

	try {
		await brevoWebhookService.handle(c, body);
		return c.text('success', 200);
	} catch (e) {
		// Non-2xx so Brevo retries (e.g. unknown message id).
		return c.text(e.message, e.code && e.code >= 400 ? e.code : 500);
	}
});
