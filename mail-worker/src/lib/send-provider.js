// 发信 provider 的解析与凭据判定。
//
// 选择规则（见 .scratch/sendkit-integration/issues/03-*）：
//   1. 使用管理员显式配置的 sendProviders[domain]；
//   2. 未配置时，若存在 Cloudflare Email binding，默认 Cloudflare；
//   3. 否则若存在该域 Resend token，默认 Resend；
//   4. 否则若存在该域 SendKit token，默认 SendKit；
//   5. 都没有则返回 null（调用方抛 noSendProvider）。
// 注意：显式配置命中时不做凭据检查，由 providerHasCredentials 判定；
// 缺凭据时调用方直接报错，绝不自动切换到其它 provider（避免重复发送）。

export const SEND_PROVIDER = {
	CLOUDFLARE: 'cloudflare',
	RESEND: 'resend',
	SENDKIT: 'sendkit'
};

export function resolveSendProvider(context, domain) {
	const { sendProviders = {}, sendkitTokens = {}, resendTokens = {}, hasCloudflareEmail = false } = context || {};

	const configured = sendProviders?.[domain];
	if (configured) {
		return configured;
	}

	if (hasCloudflareEmail) {
		return SEND_PROVIDER.CLOUDFLARE;
	}

	if (resendTokens?.[domain]) {
		return SEND_PROVIDER.RESEND;
	}

	if (sendkitTokens?.[domain]) {
		return SEND_PROVIDER.SENDKIT;
	}

	return null;
}

export function providerHasCredentials(provider, context, domain) {
	const { sendkitTokens = {}, resendTokens = {}, hasCloudflareEmail = false } = context || {};

	if (provider === SEND_PROVIDER.CLOUDFLARE) {
		return !!hasCloudflareEmail;
	}
	if (provider === SEND_PROVIDER.RESEND) {
		return !!resendTokens?.[domain];
	}
	if (provider === SEND_PROVIDER.SENDKIT) {
		return !!sendkitTokens?.[domain];
	}

	return false;
}

export default { SEND_PROVIDER, resolveSendProvider, providerHasCredentials };
