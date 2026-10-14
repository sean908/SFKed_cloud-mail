import { describe, it, expect } from 'vitest';
import { resolveSendProvider, providerHasCredentials } from '../src/lib/send-provider.js';

// 纯逻辑接缝：给定域与各 provider 凭据，决定用哪个 provider 发信。
const base = () => ({
	sendProviders: {},
	sendkitTokens: {},
	resendTokens: {},
	hasCloudflareEmail: false
});

describe('resolveSendProvider', () => {
	it('未配置任何凭据时返回 null', () => {
		expect(resolveSendProvider(base(), 'example.com')).toBe(null);
	});

	it('存在 Cloudflare Email binding 时默认使用 cloudflare', () => {
		const ctx = { ...base(), hasCloudflareEmail: true, resendTokens: { 'example.com': 're_x' } };
		expect(resolveSendProvider(ctx, 'example.com')).toBe('cloudflare');
	});

	it('无 binding 但有 Resend token 时默认使用 resend', () => {
		const ctx = { ...base(), resendTokens: { 'example.com': 're_x' } };
		expect(resolveSendProvider(ctx, 'example.com')).toBe('resend');
	});

	it('只有 SendKit token 时默认使用 sendkit', () => {
		const ctx = { ...base(), sendkitTokens: { 'example.com': 'sk_x' } };
		expect(resolveSendProvider(ctx, 'example.com')).toBe('sendkit');
	});

	it('管理员显式配置的 sendProviders 优先于默认规则', () => {
		const ctx = {
			...base(),
			hasCloudflareEmail: true,
			resendTokens: { 'example.com': 're_x' },
			sendkitTokens: { 'example.com': 'sk_x' },
			sendProviders: { 'example.com': 'sendkit' }
		};
		expect(resolveSendProvider(ctx, 'example.com')).toBe('sendkit');
	});

	it('显式配置只作用于对应域', () => {
		const ctx = {
			...base(),
			resendTokens: { 'example.com': 're_x', 'other.com': 're_y' },
			sendProviders: { 'example.com': 'resend' }
		};
		expect(resolveSendProvider(ctx, 'other.com')).toBe('resend');
	});
});

describe('providerHasCredentials', () => {
	it('cloudflare 取决于 binding 是否存在', () => {
		expect(providerHasCredentials('cloudflare', base(), 'example.com')).toBe(false);
		expect(providerHasCredentials('cloudflare', { ...base(), hasCloudflareEmail: true }, 'example.com')).toBe(true);
	});

	it('resend / sendkit 取决于对应域是否有 token', () => {
		const ctx = { ...base(), resendTokens: { 'example.com': 're_x' }, sendkitTokens: { 'example.com': 'sk_x' } };
		expect(providerHasCredentials('resend', ctx, 'example.com')).toBe(true);
		expect(providerHasCredentials('sendkit', ctx, 'example.com')).toBe(true);
		expect(providerHasCredentials('resend', ctx, 'other.com')).toBe(false);
		expect(providerHasCredentials('sendkit', ctx, 'other.com')).toBe(false);
	});
});
