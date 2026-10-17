import BizError from '../error/biz-error';
import { t } from '../i18n/i18n';

const MIME_TOKEN = /^(application|audio|example|font|image|message|model|multipart|text|video)\/[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

function normalizeMimeType(value) {
	if (!value) {
		return 'application/octet-stream';
	}

	const essence = value.split(';', 1)[0].trim().toLowerCase();
	if (!MIME_TOKEN.test(essence) || essence.includes('*')) {
		throw new BizError(t('brevoAttachmentType'));
	}

	return essence;
}

function parseDataUrl(content) {
	if (!content.startsWith('data:')) {
		return { base64: content, mimeType: null };
	}

	const commaIndex = content.indexOf(',');
	if (commaIndex === -1) {
		throw new BizError(t('brevoAttachmentType'));
	}

	const metadata = content.slice(5, commaIndex).split(';');
	const isBase64 = metadata.slice(1).some(item => item.toLowerCase() === 'base64');
	if (!isBase64) {
		throw new BizError(t('brevoAttachmentType'));
	}

	return {
		base64: content.slice(commaIndex + 1),
		mimeType: metadata[0] || null,
	};
}

function decodeBase64(content) {
	const compact = content.replace(/\s+/g, '');
	if (!compact) {
		throw new BizError(t('brevoAttachmentEmpty'));
	}

	if (!/^[A-Za-z0-9+/]*={0,2}$/.test(compact) || compact.length % 4 === 1) {
		throw new BizError(t('brevoAttachmentInvalidBase64'));
	}

	const padded = compact.padEnd(compact.length + ((4 - compact.length % 4) % 4), '=');
	let binary;
	try {
		binary = atob(padded);
	} catch (e) {
		throw new BizError(t('brevoAttachmentInvalidBase64'));
	}

	const bytes = new Uint8Array(binary.length);

	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}

	if (bytes.length === 0) {
		throw new BizError(t('brevoAttachmentEmpty'));
	}

	return bytes;
}

function encodeBase64(bytes) {
	let binary = '';
	for (let i = 0; i < bytes.length; i += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	}
	return btoa(binary);
}

export function normalizeAttachment(attachment) {
	attachment ??= {};
	const filename = typeof attachment.filename === 'string'
		? attachment.filename.trim()
		: '';
	if (!filename || /[\u0000-\u001f\u007f]/.test(filename)) {
		throw new BizError(t('brevoAttachmentFilename'));
	}

	let bytes;
	let dataUrlMimeType = null;
	if (attachment.content instanceof ArrayBuffer) {
		bytes = new Uint8Array(attachment.content);
	} else if (attachment.content instanceof Uint8Array) {
		bytes = new Uint8Array(attachment.content);
	} else if (typeof attachment.content === 'string') {
		const parsed = parseDataUrl(attachment.content);
		dataUrlMimeType = parsed.mimeType;
		bytes = decodeBase64(parsed.base64);
	} else {
		throw new BizError(t('brevoAttachmentEmpty'));
	}

	if (bytes.length === 0) {
		throw new BizError(t('brevoAttachmentEmpty'));
	}

	const requestMimeType = [attachment.contentType, attachment.mimeType, attachment.type]
		.find(value => typeof value === 'string' && value.trim());
	const contentType = normalizeMimeType(requestMimeType || dataUrlMimeType);

	return {
		filename,
		contentType,
		content: encodeBase64(bytes),
		bytes,
		size: bytes.length,
		normalized: true,
	};
}

export function normalizeAttachments(attachments = []) {
	return attachments.map(normalizeAttachment);
}
