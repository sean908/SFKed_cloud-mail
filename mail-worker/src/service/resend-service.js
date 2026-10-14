import emailProviderMessageService from './email-provider-message-service';
import { emailConst } from '../const/entity-const';
import BizError from '../error/biz-error';
import { SEND_PROVIDER } from '../lib/send-provider';

const resendService = {

	async webhooks(c, body) {

		const params = {
			status: emailConst.status.SENT
		}

		if (body.type === 'email.delivered') {
			params.status = emailConst.status.DELIVERED
			params.message = null
		}

		if (body.type === 'email.complained') {
			params.status = emailConst.status.COMPLAINED
			params.message = null
		}

		if (body.type === 'email.bounced') {
			let bounce = body.data.bounce
			bounce = JSON.stringify(bounce);
			params.status = emailConst.status.BOUNCED
			params.message = bounce
		}

		if (body.type === 'email.delivery_delayed') {
			params.status = emailConst.status.DELAYED
			params.message = null
		}

		if (body.type === 'email.failed') {
			params.status = emailConst.status.FAILED
			params.message = body.data.failed.reason
		}

		const providerMessageId = body.data.email_id;
		const mapping = await emailProviderMessageService.findByProviderMessageId(c, SEND_PROVIDER.RESEND, providerMessageId);

		if (!mapping) {
			throw new BizError('更新邮件状态记录失败');
		}

		await emailProviderMessageService.applyStatus(c, mapping, params.status, params.message ?? null, body.created_at);

	}
}

export default resendService
