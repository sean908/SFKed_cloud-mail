import orm from '../entity/orm';
import email from '../entity/email';
import { emailProviderMessage } from '../entity/email-provider-message';
import { and, eq } from 'drizzle-orm';
import { emailConst } from '../const/entity-const';

// 终态：到达后不再被后续（更晚到达但语义更早的）事件回退。
const TERMINAL_STATUS = new Set([
	emailConst.status.DELIVERED,
	emailConst.status.BOUNCED,
	emailConst.status.COMPLAINED,
	emailConst.status.FAILED
]);

const emailProviderMessageService = {

	TERMINAL_STATUS,

	async saveMappings(c, { emailId, provider, ids, recipients = [], status }) {
		if (!ids || ids.length === 0) {
			return;
		}

		const initialStatus = status ?? emailConst.status.SENT;

		const rows = ids.map((id, index) => ({
			emailId,
			provider,
			providerMessageId: id,
			recipient: recipients[index] || '',
			status: initialStatus
		}));

		await orm(c).insert(emailProviderMessage).values(rows).run();
	},

	findByProviderMessageId(c, provider, providerMessageId) {
		return orm(c).select().from(emailProviderMessage).where(
			and(
				eq(emailProviderMessage.provider, provider),
				eq(emailProviderMessage.providerMessageId, providerMessageId)
			)
		).get();
	},

	listByEmailId(c, emailId) {
		return orm(c).select().from(emailProviderMessage)
			.where(eq(emailProviderMessage.emailId, emailId))
			.all();
	},

	// 幂等 + 防乱序：终态不再变更；比已有 last_event_at 更早的事件忽略。
	async applyStatus(c, mappingRow, status, message, eventAt) {
		if (TERMINAL_STATUS.has(mappingRow.status)) {
			return;
		}

		if (eventAt && mappingRow.lastEventAt && eventAt < mappingRow.lastEventAt) {
			return;
		}

		const now = new Date().toISOString();

		await orm(c).update(emailProviderMessage).set({
			status,
			message: message ?? null,
			lastEventAt: eventAt || now,
			updateTime: now
		}).where(eq(emailProviderMessage.id, mappingRow.id)).run();

		await this.refreshEmailStatus(c, mappingRow.emailId);
	},

	async refreshEmailStatus(c, emailId) {
		const rows = await this.listByEmailId(c, emailId);
		const status = this.aggregateStatus(rows);
		if (status == null) {
			return;
		}
		await orm(c).update(email).set({ status }).where(eq(email.emailId, emailId)).run();
	},

	// 主邮件状态按映射记录聚合（见 .scratch/sendkit-integration/issues/02-*）。
	aggregateStatus(rows) {
		if (!rows || rows.length === 0) {
			return null;
		}

		const statuses = rows.map(row => row.status);

		if (statuses.every(status => status === emailConst.status.DELIVERED)) {
			return emailConst.status.DELIVERED;
		}
		if (statuses.includes(emailConst.status.BOUNCED)) {
			return emailConst.status.BOUNCED;
		}
		if (statuses.includes(emailConst.status.COMPLAINED)) {
			return emailConst.status.COMPLAINED;
		}
		if (statuses.includes(emailConst.status.FAILED)) {
			return emailConst.status.FAILED;
		}
		if (statuses.includes(emailConst.status.DELAYED)) {
			return emailConst.status.DELAYED;
		}

		return emailConst.status.SENT;
	}

};

export default emailProviderMessageService;
