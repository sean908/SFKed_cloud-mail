import orm from '../entity/orm';
import { att } from '../entity/att';
import { and, eq, isNull, inArray, desc } from 'drizzle-orm';
import r2Service from './r2-service';
import constant from '../const/constant';
import fileUtils from '../utils/file-utils';
import { attConst } from '../const/entity-const';
import { parseHTML } from 'linkedom';
import domainUtils from '../utils/domain-uitls';
import settingService from "./setting-service";
import BizError from '../error/biz-error';
import { t } from '../i18n/i18n';
import { normalizeAttachment } from '../utils/attachment-utils';

const MIME_EXT = {
	jpeg: 'jpg',
};

function inlineFilename(mimeType, contentId) {
	const subtype = mimeType.split('/')[1] || 'bin';
	const ext = MIME_EXT[subtype] || subtype;
	return `inline-${contentId}.${ext}`;
}

export async function buildNormalizedAttachmentKey(attachment) {
	const contentHash = await fileUtils.getBuffHash(attachment.bytes);
	const metadataHash = await fileUtils.getBuffHash(
		new TextEncoder().encode(`${attachment.filename}\u0000${attachment.contentType || ''}`)
	);
	return constant.ATTACHMENT_PREFIX
		+ contentHash
		+ '-'
		+ metadataHash
		+ fileUtils.getExtFileName(attachment.filename);
}

const attService = {

	async addAtt(c, attachments) {

		for (let attachment of attachments) {

			let metadate = {
				contentType: attachment.mimeType,
			}

			if (!attachment.contentId) {
				metadate.contentDisposition = `attachment;filename=${attachment.filename}`
			} else {
				metadate.contentDisposition = `inline;filename=${attachment.filename}`
				metadate.cacheControl = `max-age=259200`
			}

			await r2Service.putObj(c, attachment.key, attachment.content, metadate);

		}

		await orm(c).insert(att).values(attachments).run();
	},

	list(c, params, userId) {
		const { emailId } = params;

		return orm(c).select().from(att).where(
			and(
				eq(att.emailId, emailId),
				eq(att.userId, userId),
				eq(att.type, attConst.type.ATT),
				isNull(att.contentId)
			)
		).all();
	},

	async toImageUrlHtml(c, content, { strict = false } = {}) {

		const { r2Domain } = await settingService.query(c);

		const { document } = parseHTML(content);

		const images = Array.from(document.querySelectorAll('img'));

		let imageDataList = [];

		//内嵌图片必须与 HTML 的 cid: 引用一一对应，Brevo 的 contentId 才能与引用完全一致
		//重复 CID 由 brevoService 在发请求前统一校验
		const resolveCid = () => crypto.randomUUID().replace(/-/g, '');

		for (const img of images) {

			//邮件正文base64图片转cid附件
			const src = img.getAttribute('src');
			if (src && src.startsWith('data:image')) {
				const cid = resolveCid();
				let attData;

				if (strict) {
					let normalized;
					try {
						//先复用 P1 的规范化逻辑，再用规范化后的 MIME 生成文件名
						normalized = normalizeAttachment({
							filename: `inline-${cid}`,
							content: src,
							contentId: cid,
						});
						normalized.filename = inlineFilename(normalized.contentType, cid);
					} catch (e) {
						if (e instanceof BizError) {
							throw e;
						}
						throw new BizError(t('brevoInlineInvalid'));
					}

					attData = {
						filename: normalized.filename,
						mimeType: normalized.contentType,
						size: normalized.size,
						buff: normalized.bytes,
						content: normalized.content,
						contentId: cid,
						//与 buildNormalizedAttachmentKey 保持一致，避免 imgReplace 和落库 key 不一致
						key: await buildNormalizedAttachmentKey(normalized),
					};
				} else {
					const file = fileUtils.base64ToFile(src);
					const buff = await file.arrayBuffer();
					attData = {};
					attData.filename = file.name;
					attData.mimeType = file.type;
					attData.size = file.size;
					attData.buff = buff;
					attData.content = fileUtils.base64ToDataStr(src);
					attData.contentId = cid;
					attData.key = constant.ATTACHMENT_PREFIX
						+ await fileUtils.getBuffHash(attData.buff)
						+ fileUtils.getExtFileName(attData.filename);
				}

				img.setAttribute('src', 'cid:' + cid);
				imageDataList.push(attData);
			}

			//邮件正文站内图片转cid附件
			if (src && (src.startsWith(domainUtils.toOssDomain(r2Domain)) || src.startsWith('attachments/'))) {

				const cid = resolveCid()
				img.setAttribute('src', 'cid:' + cid);

				const attData = {};

				if (src.startsWith(domainUtils.toOssDomain(r2Domain))) {
					attData.key = src.replace(domainUtils.toOssDomain(r2Domain) + '/','');
				}

				if (src.startsWith('attachments/')) {
					attData.key = src;
				}

				attData.contentId = cid;
				attData.type = attConst.type.EMBED;
				imageDataList.push(attData);

			}

			const hasInlineWidth = img.hasAttribute('width');
			const style = img.getAttribute('style') || '';
			const hasStyleWidth = /(^|\s)width\s*:\s*[^;]+/.test(style);

			if (!hasInlineWidth && !hasStyleWidth) {
				const newStyle = (style ? style.trim().replace(/;$/, '') + '; ' : '') + 'max-width: 100%;';
				img.setAttribute('style', newStyle);
			}
		}

		//查询已有内嵌url图片信息
		const keys = [...new Set(imageDataList.filter(item => !item.content).map(item => item.key))];
		const dbImageList  = await this.selectOneByKeys(c, keys);

		//设置给当前附件
		await Promise.all(imageDataList.map(async image => {
			if (image.content) {
				return;
			}

			const dbImage = dbImageList.find(dbImage => image.key === dbImage.key);
			if (!dbImage) {
				if (strict) {
					throw new BizError(t('brevoInlineMissing'));
				}
				return;
			}

			image.size = dbImage.size;
			image.filename = dbImage.filename;
			image.mimeType = dbImage.mimeType;
			image.contentType = dbImage.mimeType;

			let obj;
			try {
				obj = await r2Service.getObj(c, image.key);
			} catch (e) {
				if (strict) {
					throw new BizError(t('brevoInlineReadError'));
				}
				throw e;
			}

			if (!obj) {
				if (strict) {
					throw new BizError(t('brevoInlineMissing'));
				}
				return;
			}

			image.content = obj instanceof ArrayBuffer ? obj : await obj.arrayBuffer();
		}))

		imageDataList = imageDataList.filter(image => image.content);

		return { imageDataList, html: document.toString() };
	},

	async saveSendAtt(c, attList, userId, accountId, emailId) {

		const attDataList = [];
		const pendingObjects = [];
		const normalizedKeys = new Set();

		for (let att of attList) {
			const isNormalized = att.normalized === true && att.bytes instanceof Uint8Array;
			att.buff = isNormalized ? att.bytes : fileUtils.base64ToUint8Array(att.content);
			att.key = isNormalized
				? await buildNormalizedAttachmentKey(att)
				: constant.ATTACHMENT_PREFIX + await fileUtils.getBuffHash(att.buff) + fileUtils.getExtFileName(att.filename);
			const attData = { userId, accountId, emailId };
			attData.key = att.key;
			attData.size = att.buff.length;
			attData.filename = att.filename;
			attData.mimeType = isNormalized
				? att.contentType || 'application/octet-stream'
				: att.type;
			attData.type = attConst.type.ATT;
			attDataList.push(attData);
			if (!isNormalized || !normalizedKeys.has(att.key)) {
				pendingObjects.push({
					key: att.key,
					content: att.buff,
					mimeType: attData.mimeType,
					filename: att.filename,
				});
				normalizedKeys.add(att.key);
			}
		}

		await orm(c).insert(att).values(attDataList).run();

		for (const object of pendingObjects) {
			await r2Service.putObj(c, object.key, object.content, {
				contentType: object.mimeType,
				contentDisposition: `attachment;filename=${object.filename}`
			});
		}

	},

	async saveArticleAtt(c, attDataList, userId, accountId, emailId) {

		for (let attData of attDataList) {
			attData.userId = userId;
			attData.emailId = emailId;
			attData.accountId = accountId;
			attData.type = attConst.type.EMBED;
			attData.mimeType = attData.mimeType || attData.contentType || 'application/octet-stream';
			//站内图片的对象已存在于对象存储，只落库不重复写入
			if (attData.buff) {
				attData.size = attData.size ?? attData.buff.length;
				await r2Service.putObj(c, attData.key, attData.buff, {
					contentType: attData.mimeType,
					cacheControl: `max-age=259200`,
					contentDisposition: `inline;filename=${attData.filename}`
				});
			}
			delete attData.buff;
			delete attData.content;
		}

		await orm(c).insert(att).values(attDataList).run();

	},

	async removeByUserIds(c, userIds) {
		await this.removeAttByField(c, 'user_id', userIds);
	},

	async removeByEmailIds(c, emailIds) {
		await this.removeAttByField(c, 'email_id', emailIds);
	},

	async removeByEmailIdWithExclusiveKeys(c, emailId, extraKeys = []) {
		const rows = await orm(c)
			.select({ key: att.key })
			.from(att)
			.where(eq(att.emailId, emailId))
			.all();
		const keys = [...new Set([...rows.map(row => row.key), ...extraKeys].filter(Boolean))];

		await orm(c).delete(att).where(eq(att.emailId, emailId)).run();

		if (keys.length === 0) {
			return;
		}

		const remaining = await orm(c)
			.select({ key: att.key })
			.from(att)
			.where(inArray(att.key, keys))
			.all();
		const remainingKeys = new Set(remaining.map(row => row.key));
		const exclusiveKeys = keys.filter(key => !remainingKeys.has(key));

		await this.batchDelete(c, exclusiveKeys);
	},

	selectByEmailIds(c, emailIds) {
		return orm(c).select().from(att).where(
			and(
				inArray(att.emailId, emailIds),
				eq(att.type, attConst.type.ATT)
			))
			.all();
	},

	async removeAttByField(c, fieldName, fieldValues) {

		const sqlList = [];

		fieldValues.forEach(value => {

			sqlList.push(

				c.env.db.prepare(
					`SELECT a.key, a.att_id
						FROM attachments a
							   JOIN (SELECT key
									 FROM attachments
									 GROUP BY key
									 HAVING COUNT (*) = 1) t
									ON a.key = t.key
						WHERE a.${fieldName} = ?;`
					).bind(value)
			)

			sqlList.push(c.env.db.prepare(`DELETE FROM attachments WHERE ${fieldName} = ?`).bind(value))

		});

		const attListResult = await c.env.db.batch(sqlList);

		const delKeyList = attListResult.flatMap(r => r.results ? r.results.map(row => row.key) : []);

		if (delKeyList.length > 0) {
			try {
				await this.batchDelete(c, delKeyList);
			} catch (e) {
				console.error('删除附件文件失败：', e);
			}
		}

	},

	async batchDelete(c, keys) {
		if (!keys.length) return;

		const BATCH_SIZE = 1000;

		for (let i = 0; i < keys.length; i += BATCH_SIZE) {
			const batch = keys.slice(i, i + BATCH_SIZE);
			await r2Service.delete(c, batch);
		}

	},

	async removeByAccountId(c, accountId) {
		await this.removeAttByField(c, "account_id", [accountId])
	},

	selectOneByKeys(c, keys) {
		if (!keys || keys.length === 0) {
			return []
		}
		return orm(c).select().from(att).where(inArray(att.key, keys)).orderBy(desc(att.attId)).groupBy(att.key).all();
	}
};

export default attService;
