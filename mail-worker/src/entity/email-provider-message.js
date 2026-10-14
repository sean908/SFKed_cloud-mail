import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

// 一封发件邮件可对应多条 provider 消息记录（多收件人时逐条映射）。
export const emailProviderMessage = sqliteTable('email_provider_message', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	emailId: integer('email_id').notNull(),
	provider: text('provider').notNull(),
	providerMessageId: text('provider_message_id').notNull(),
	recipient: text('recipient').default('').notNull(),
	status: integer('status').default(0).notNull(),
	message: text('message'),
	lastEventAt: text('last_event_at'),
	createTime: text('create_time').default(sql`CURRENT_TIMESTAMP`).notNull(),
	updateTime: text('update_time').default(sql`CURRENT_TIMESTAMP`).notNull()
});

export default emailProviderMessage;
