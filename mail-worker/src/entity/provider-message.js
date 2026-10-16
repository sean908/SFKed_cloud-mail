import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

export const providerMessage = sqliteTable('provider_message', {
	pmId: integer('pm_id').primaryKey({ autoIncrement: true }),
	emailId: integer('email_id').notNull(),
	provider: text('provider').notNull(),
	providerMessageId: text('provider_message_id').notNull(),
	recipient: text('recipient').notNull(),
	status: integer('status').default(0).notNull(),
	message: text('message'),
	eventTime: text('event_time'),
	createTime: text('create_time').notNull().default(sql`CURRENT_TIMESTAMP`)
});

export default providerMessage;
