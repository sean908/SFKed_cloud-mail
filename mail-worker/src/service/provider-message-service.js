import orm from '../entity/orm';
import providerMessage from '../entity/provider-message';
import { eq, and } from 'drizzle-orm';
import { emailConst } from '../const/entity-const';
import BizError from '../error/biz-error';
import { t } from '../i18n/i18n';

const providerMessageService = {

	// Record the provider id(s) returned for a send. A single id is shared by every
	// recipient; a list carries one id per recipient.
	async saveMappings(c, emailId, provider, recipients, messageIdOrList) {

		const ids = Array.isArray(messageIdOrList) ? messageIdOrList : [messageIdOrList];

		if (ids.length > 1 && ids.length !== recipients.length) {
			throw new BizError(t('brevoIdCountMismatch'));
		}

		const values = recipients.map((recipient, index) => ({
			emailId,
			provider,
			providerMessageId: ids.length === 1 ? ids[0] : ids[index],
			recipient,
			status: emailConst.status.SENT
		}));

		await orm(c).insert(providerMessage).values(values).run();
	},

	findByProviderAndRecipient(c, provider, recipient) {
		return orm(c).select().from(providerMessage).where(and(
			eq(providerMessage.provider, provider),
			eq(providerMessage.recipient, recipient)
		)).all();
	},

	findByEmailId(c, emailId) {
		return orm(c).select().from(providerMessage).where(eq(providerMessage.emailId, emailId)).all();
	},

	removeByEmailId(c, emailId) {
		return orm(c).delete(providerMessage).where(eq(providerMessage.emailId, emailId)).run();
	},

	updateStatus(c, pmId, status, message, eventTime) {
		const updateData = { status };
		if (message !== undefined) updateData.message = message;
		if (eventTime !== undefined) updateData.eventTime = eventTime;
		return orm(c).update(providerMessage).set(updateData).where(eq(providerMessage.pmId, pmId)).returning().get();
	}
};

export default providerMessageService;
