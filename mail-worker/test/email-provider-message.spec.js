import { describe, it, expect } from 'vitest';
import emailProviderMessageService from '../src/service/email-provider-message-service.js';
import { emailConst } from '../src/const/entity-const.js';

const { SENT, DELIVERED, BOUNCED, COMPLAINED, DELAYED, FAILED } = emailConst.status;
const rows = (...statuses) => statuses.map(status => ({ status }));

describe('emailProviderMessageService.aggregateStatus', () => {
	it('无映射记录时返回 null', () => {
		expect(emailProviderMessageService.aggregateStatus([])).toBe(null);
	});

	it('全部 DELIVERED 才显示 DELIVERED', () => {
		expect(emailProviderMessageService.aggregateStatus(rows(DELIVERED, DELIVERED))).toBe(DELIVERED);
	});

	it('部分已投递其余为 SENT 时显示 SENT', () => {
		expect(emailProviderMessageService.aggregateStatus(rows(DELIVERED, SENT))).toBe(SENT);
	});

	it('任一 BOUNCED 优先显示 BOUNCED', () => {
		expect(emailProviderMessageService.aggregateStatus(rows(DELIVERED, BOUNCED, COMPLAINED))).toBe(BOUNCED);
	});

	it('无 BOUNCED 时 COMPLAINED 优先于 FAILED', () => {
		expect(emailProviderMessageService.aggregateStatus(rows(DELIVERED, COMPLAINED, FAILED))).toBe(COMPLAINED);
	});

	it('仅有 FAILED 时显示 FAILED', () => {
		expect(emailProviderMessageService.aggregateStatus(rows(SENT, FAILED))).toBe(FAILED);
	});

	it('无终态但有 DELAYED 时显示 DELAYED', () => {
		expect(emailProviderMessageService.aggregateStatus(rows(DELAYED, SENT))).toBe(DELAYED);
	});

	it('全部 SENT 显示 SENT', () => {
		expect(emailProviderMessageService.aggregateStatus(rows(SENT, SENT))).toBe(SENT);
	});
});
