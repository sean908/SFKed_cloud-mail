import app from '../hono/hono';
import sendkitWebhookService from '../service/sendkit-webhook-service';

app.post('/webhooks/sendkit', async (c) => {
	return sendkitWebhookService.handle(c);
});
