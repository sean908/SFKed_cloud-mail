import { providerConst } from '../const/entity-const';
import { t } from '../i18n/i18n';
import BizError from '../error/biz-error';

const providerResolver = {

	// Resolve which provider to use for a given domain.
	// Priority: explicit providerMap[domain] > Cloudflare Email > Resend > none
	// Brevo is NEVER part of the default fallback — only used when explicitly selected.
	resolve(domain, { providerMap, resendTokens, brevoTokens, useCloudflareEmail }) {

		const explicit = providerMap[domain];

		if (explicit === providerConst.BREVO) {
			const apiKey = brevoTokens[domain];
			if (!apiKey) {
				throw new BizError(t('brevoApiKey'));
			}
			return { provider: providerConst.BREVO, apiKey };
		}

		if (explicit === providerConst.RESEND) {
			const apiKey = resendTokens[domain];
			if (!apiKey) {
				throw new BizError(t('noResendToken'));
			}
			return { provider: providerConst.RESEND, apiKey };
		}

		if (explicit === providerConst.CLOUDFLARE) {
			if (!useCloudflareEmail) {
				throw new BizError(t('providerConfigError'));
			}
			return { provider: providerConst.CLOUDFLARE, apiKey: null };
		}

		// Unknown explicit provider
		if (explicit && explicit !== providerConst.DEFAULT) {
			throw new BizError(t('unknownProvider'));
		}

		// Default fallback: Cloudflare Email first, then Resend
		if (useCloudflareEmail) {
			return { provider: providerConst.CLOUDFLARE, apiKey: null };
		}

		const resendToken = resendTokens[domain];
		if (resendToken) {
			return { provider: providerConst.RESEND, apiKey: resendToken };
		}

		return { provider: null, apiKey: null };
	}
};

export default providerResolver;
