import orm from '../entity/orm';
import { providerMessage } from '../entity/provider-message';
import { eq, and } from 'drizzle-orm';
import { providerMessageStatus } from '../const/entity-const';

const providerMessageService = {

	// Save provider message mappings for a sent email.
	// messageIdList can be a single ID (shared across all recipients)
	// or an array matching recipients length.
	async saveMappings(c, emailId, provider, recipients, messageIdOrList) {

		const ids = Array.isArray(messageIdOrList) ? messageIdOrList : [messageIdOrList];

		// If multiple IDs, count must match recipients
		if (ids.length > 1 && ids.length !== recipients.length) {
			throw new Error(`Provider message ID count (${ids.length}) does not match recipient count (${recipients.length})`);
		}

		const values = [];

		if (ids.length === 1) {
			// Single ID shared by all recipients
			for (const recipient of recipients) {
				values.push({
					emailId,
					provider,
					providerMessageId: ids[0],
					recipient,
					status: providerMessageStatus.SENT
				});
			}
		} else {
			// One ID per recipient
			for (let i = 0; i < recipients.length; i++) {
				values.push({
					emailId,
					provider,
					providerMessageId: ids[i],
					recipient: recipients[i],
					status: providerMessageStatus.SENT
				});
			}
		}

		await orm(c).insert(providerMessage).values(values).run();
	},

	// Find a provider message by provider, messageId and recipient
	async findByProviderMessageId(c, provider, providerMessageId, recipient) {
		const conditions = [
			eq(providerMessage.provider, provider),
			eq(providerMessage.providerMessageId, providerMessageId)
		];
		if (recipient) {
			conditions.push(eq(providerMessage.recipient, recipient));
		}
		return orm(c).select().from(providerMessage).where(and(...conditions)).all();
	},

	// Update provider message status (for webhook)
	async updateStatus(c, pmId, status, message, eventTime) {
		const updateData = { status };
		if (message !== undefined) updateData.message = message;
		if (eventTime !== undefined) updateData.eventTime = eventTime;
		return orm(c).update(providerMessage).set(updateData).where(eq(providerMessage.pmId, pmId)).returning().get();
	},

	// Find all provider messages for an email
	async findByEmailId(c, emailId) {
		return orm(c).select().from(providerMessage).where(eq(providerMessage.emailId, emailId)).all();
	}
};

export default providerMessageService;
