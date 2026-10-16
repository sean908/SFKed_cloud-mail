import { describe, it, expect } from 'vitest';
import providerResolver from '../src/service/provider-resolver';
import { providerConst } from '../src/const/entity-const';

const base = { providerMap: {}, resendTokens: {}, brevoTokens: {}, useCloudflareEmail: false };

describe('providerResolver', () => {
	describe('explicit selection', () => {
		it('returns brevo when explicitly selected and key present', () => {
			const result = providerResolver.resolve('example.com', {
				...base,
				providerMap: { 'example.com': providerConst.BREVO },
				brevoTokens: { 'example.com': 'brevo-key' },
			});
			expect(result.provider).toBe(providerConst.BREVO);
			expect(result.apiKey).toBe('brevo-key');
		});

		it('throws a recognisable config error when brevo selected without key (no fallback)', () => {
			let err;
			try {
				providerResolver.resolve('example.com', {
					...base,
					useCloudflareEmail: true,
					providerMap: { 'example.com': providerConst.BREVO },
					resendTokens: { 'example.com': 'resend-key' },
					brevoTokens: {},
				});
			} catch (e) {
				err = e;
			}
			expect(err).toBeDefined();
			expect(err.name).toBe('BizError');
			expect(err.message).toContain('Brevo');
		});

		it('returns resend when explicitly selected and key present', () => {
			const result = providerResolver.resolve('example.com', {
				...base,
				providerMap: { 'example.com': providerConst.RESEND },
				resendTokens: { 'example.com': 'resend-key' },
			});
			expect(result.provider).toBe(providerConst.RESEND);
			expect(result.apiKey).toBe('resend-key');
		});

		it('throws when resend selected without key', () => {
			expect(() => providerResolver.resolve('example.com', {
				...base,
				providerMap: { 'example.com': providerConst.RESEND },
			})).toThrow();
		});

		it('returns cloudflare when explicitly selected and binding exists', () => {
			const result = providerResolver.resolve('example.com', {
				...base,
				useCloudflareEmail: true,
				providerMap: { 'example.com': providerConst.CLOUDFLARE },
			});
			expect(result.provider).toBe(providerConst.CLOUDFLARE);
		});

		it('throws when cloudflare explicitly selected but binding missing', () => {
			expect(() => providerResolver.resolve('example.com', {
				...base,
				useCloudflareEmail: false,
				providerMap: { 'example.com': providerConst.CLOUDFLARE },
			})).toThrow();
		});

		it('rejects unknown provider', () => {
			let err;
			try {
				providerResolver.resolve('example.com', {
					...base,
					providerMap: { 'example.com': 'sendgrid' },
				});
			} catch (e) { err = e; }
			expect(err).toBeDefined();
			expect(err.name).toBe('BizError');
		});
	});

	describe('default fallback (legacy rules)', () => {
		it('prefers cloudflare when available', () => {
			const result = providerResolver.resolve('example.com', {
				...base,
				useCloudflareEmail: true,
				resendTokens: { 'example.com': 'resend-key' },
			});
			expect(result.provider).toBe(providerConst.CLOUDFLARE);
		});

		it('falls back to resend when cloudflare unavailable', () => {
			const result = providerResolver.resolve('example.com', {
				...base,
				resendTokens: { 'example.com': 'resend-key' },
			});
			expect(result.provider).toBe(providerConst.RESEND);
		});

		it('returns null provider when nothing configured', () => {
			const result = providerResolver.resolve('example.com', { ...base });
			expect(result.provider).toBeNull();
		});

		it('never uses brevo in the default fallback even if a key exists', () => {
			const result = providerResolver.resolve('example.com', {
				...base,
				brevoTokens: { 'example.com': 'brevo-key' },
			});
			expect(result.provider).toBeNull();
		});

		it('treats explicit "default" the same as no selection', () => {
			const result = providerResolver.resolve('example.com', {
				...base,
				useCloudflareEmail: true,
				providerMap: { 'example.com': providerConst.DEFAULT },
			});
			expect(result.provider).toBe(providerConst.CLOUDFLARE);
		});
	});
});
