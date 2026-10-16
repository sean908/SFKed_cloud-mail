import orm from '../entity/orm';
import { eq } from 'drizzle-orm';
import email from '../entity/email';
import { emailConst, providerConst } from '../const/entity-const';
import providerMessageService from './provider-message-service';
import BizError from '../error/biz-error';

const S = emailConst.status;

// Brevo event name -> system email status
const brevoEventStatus = {
	request: S.SENT,
	sent: S.SENT,
	delivered: S.DELIVERED,
	deferred: S.DELAYED,
	soft_bounce: S.DELAYED,
	hard_bounce: S.BOUNCED,
	blocked: S.BOUNCED,
	invalid: S.BOUNCED,
	error: S.FAILED,
	spam: S.COMPLAINED,
	unsubscribed: S.COMPLAINED,
};

// Behavioural events that must be acknowledged but not acted upon
const ignoredEvents = new Set([
	'opened', 'click', 'unique_opened', 'unique_click', 'proxy_open',
]);

// Advancement rank used for terminal protection and email aggregation.
// Terminal states (rank >= TERMINAL_RANK) must never be rolled back.
const statusRank = {
	[S.SENT]: 1,
	[S.DELAYED]: 2,
	[S.DELIVERED]: 3,
	[S.BOUNCED]: 4,
	[S.COMPLAINED]: 4,
	[S.FAILED]: 4,
};
const TERMINAL_RANK = 3;

function isTerminal(status) {
	return (statusRank[status] || 0) >= TERMINAL_RANK;
}

// Strip surrounding angle brackets so "<id@host>" and "id@host" match.
function normalizeMessageId(id) {
	if (typeof id !== 'string') return '';
	return id.replace(/^</, '').replace(/>$/, '');
}

// Prefer the event time field, then fall back to the epoch field.
function eventTimeOf(event) {
	if (event.date) {
		const d = new Date(event.date);
		if (!isNaN(d.getTime())) return d.toISOString();
	}
	const epoch = event.ts_event != null ? event.ts_event : event.ts;
	if (epoch != null) {
		const d = new Date(Number(epoch) * 1000);
		if (!isNaN(d.getTime())) return d.toISOString();
	}
	return new Date().toISOString();
}

const brevoWebhookService = {

	// Constant-time string comparison to avoid leaking the secret via timing.
	secureCompare(a, b) {
		if (typeof a !== 'string' || typeof b !== 'string') return false;
		if (a.length !== b.length) return false;
		let diff = 0;
		for (let i = 0; i < a.length; i++) {
			diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
		}
		return diff === 0;
	},

	// Verify the custom header against the stored secret.
	verifySecret(providedSecret, storedSecret) {
		if (!storedSecret) return false;
		return this.secureCompare(providedSecret || '', storedSecret);
	},

	async handle(c, body) {

		const events = Array.isArray(body) ? body : [body];

		for (const event of events) {
			await this.handleEvent(c, event);
		}
	},

	async handleEvent(c, event) {

		const eventName = event.event;

		// Behavioural / unknown events: acknowledge without processing.
		if (!eventName || ignoredEvents.has(eventName)) {
			return;
		}

		const status = brevoEventStatus[eventName];
		if (status === undefined) {
			return;
		}

		const messageId = normalizeMessageId(event['message-id'] || event.messageId);
		const recipient = event.email;

		if (!messageId || !recipient) {
			return;
		}

		const rows = await providerMessageService.findByProviderAndRecipient(c, providerConst.BREVO, recipient);
		const matched = rows.filter(row => normalizeMessageId(row.providerMessageId) === messageId);

		// Unknown message: surface a non-2xx so Brevo retries.
		if (matched.length === 0) {
			throw new BizError('Provider message not found', 404);
		}

		const eventTime = eventTimeOf(event);
		const message = event.reason || event.description || null;
		let touched = false;

		for (const row of matched) {

			// Terminal protection: never change a row that already reached a terminal state.
			if (isTerminal(row.status)) {
				continue;
			}

			// Out-of-order guard: ignore events older than what we already recorded.
			if (row.eventTime && new Date(eventTime).getTime() < new Date(row.eventTime).getTime()) {
				continue;
			}

			// Idempotency: identical status needs no write.
			if (row.status === status) {
				continue;
			}

			await providerMessageService.updateStatus(c, row.pmId, status, message, eventTime);
			touched = true;
		}

		// Keep the main email record in sync with the most advanced recipient status.
		const emailId = matched[0].emailId;
		await this.syncEmailStatus(c, emailId);

		return touched;
	},

	async syncEmailStatus(c, emailId) {

		const rows = await providerMessageService.findByEmailId(c, emailId);
		if (rows.length === 0) return;

		let best = null;
		for (const row of rows) {
			const rank = statusRank[row.status] || 0;
			if (!best || rank > best.rank) {
				best = { rank, status: row.status };
			}
		}
		if (!best) return;

		const emailRow = await orm(c).select().from(email).where(eq(email.emailId, emailId)).get();
		if (!emailRow) return;

		const currentRank = statusRank[emailRow.status] || 0;

		// Only ever advance; never roll a reached terminal state back.
		if (best.rank > currentRank) {
			await orm(c).update(email).set({ status: best.status }).where(eq(email.emailId, emailId)).run();
		}
	}
};

export default brevoWebhookService;
