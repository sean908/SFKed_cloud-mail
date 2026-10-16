# Brevo 集成进度报告

> 生成时间：2026-10-16
> 基于计划：`.scratch/brevo-integration-plan/issues/01-06`

---

## 总览

| Issue | 状态 | 说明 |
|-------|------|------|
| 01 — Provider 配置与消息映射数据基础 | ✅ 后端完成 | 数据库迁移、实体、setting-service、provider-message-service 均已就位 |
| 02 — Brevo Adapter 与 Provider Resolver | ✅ 完成 | brevo-service.js + provider-resolver.js 已创建 |
| 03 — Brevo 外部发信主流程 | ✅ 后端完成 | email-service.send() 已接入 resolver + Brevo 通道 + provider message 映射 |
| 04 — 后台发信设置 UI | ❌ 未开始 | 前端 Vue 改造尚未动工 |
| 05 — 第一阶段集成回归与真实发信验收 | ❌ 未开始 | 依赖 03、04 完成 |
| 06 — Brevo Webhook 状态回写闭环 | ❌ 未开始 | 依赖 04、05 完成 |

**整体进度：3/6 issue 后端完成，前端及测试验收未开始。**

---

## Issue 01 — Provider 配置与消息映射数据基础（✅ 后端完成）

### 已完成项

1. **数据库迁移可重复执行** — `init.js` 新增 `v3_4DB` 方法：
   - `ALTER TABLE setting ADD COLUMN brevo_tokens TEXT NOT NULL DEFAULT '{}'`
   - `ALTER TABLE setting ADD COLUMN provider_map TEXT NOT NULL DEFAULT '{}'`
   - `CREATE TABLE IF NOT EXISTS provider_message (...)`
   - `CREATE UNIQUE INDEX idx_pm_provider_msg_recipient ON provider_message(provider, provider_message_id, recipient)`
   - 每条 ALTER 独立 try/catch，单字段已存在不影响其他字段

2. **D1 设置刷新 / KV 查询 / 设置读取流程解析两个 JSON map** — `setting-service.js`：
   - `refresh()`: 同时解析 `brevoTokens` 和 `providerMap` JSON
   - `query()`: 从 KV 读取后已含两个 map（序列化存储）
   - 旧 Resend token 未被迁移、删除或覆盖

3. **设置更新合并逻辑** — `setting-service.js` `set()`：
   - `resendTokens` / `brevoTokens` / `providerMap` 各自独立合并
   - 仅当请求包含对应 map 时才合并；普通设置更新不影响凭据
   - 空值 / null 表示删除对应 key

4. **管理端脱敏 + 公开端点安全** — `setting-service.js` `get()`：
   - `brevoTokens` 每个值脱敏为 `前12位 + ******`
   - `websiteConfig()` 返回白名单字段，不包含任何 token / provider map

5. **通用 provider message 记录** — `provider-message.js` 实体：
   - 字段：`pmId`, `emailId`, `provider`, `providerMessageId`, `recipient`, `status`, `message`, `eventTime`, `createTime`
   - 唯一组合：`(provider, provider_message_id, recipient)`
   - 允许同一 provider message ID 对应多个收件人

6. **按收件人保存映射** — `provider-message-service.js`：
   - `saveMappings()` 支持单个 ID（共享）和多个 ID（按顺序关联）
   - 多 ID 时数量不一致会抛错，不产生不完整记录

### 涉及文件

| 文件 | 变更 |
|------|------|
| `mail-worker/src/entity/setting.js` | 新增 `brevoTokens`, `providerMap` 列 |
| `mail-worker/src/entity/provider-message.js` | 新建，provider message 实体 |
| `mail-worker/src/const/entity-const.js` | 新增 `providerConst` 和 `providerMessageStatus` 常量 |
| `mail-worker/src/init/init.js` | 新增 `v3_4DB` 迁移方法 |
| `mail-worker/src/service/setting-service.js` | `refresh/get/set` 支持双 map |
| `mail-worker/src/service/provider-message-service.js` | 新建，CRUD + 映射保存 |
| `mail-worker/src/i18n/en.js` | 新增 Brevo 相关英文文案 |
| `mail-worker/src/i18n/zh.js` | 新增 Brevo 相关中文文案 |

### Issue 01 验收清单对照

- [x] 数据库迁移可重复执行，分别创建 Brevo token map、provider map、provider message 表
- [x] 设置刷新/查询/读取都能解析两个 JSON map；旧 Resend token 不被迁移
- [x] 设置更新只在请求包含对应 map 时合并 token；空值可删除
- [x] 管理端返回脱敏 Brevo/Resend 凭据；公开配置不含 token
- [x] provider message 记录支持所有字段，唯一组合为 (provider, messageId, recipient)
- [x] 支持按收件人保存单个或多个 provider message ID；重复写入不制造重复映射（唯一索引保证）
- [ ] 单元测试（未编写）

---

## Issue 02 — Brevo Adapter 与 Provider Resolver（✅ 完成）

### 已完成项

1. **Provider Resolver** — `provider-resolver.js`：
   - 显式按域选择 Brevo 时优先返回 Brevo
   - 无显式选择时按 Cloudflare Email 优先、Resend 次之的旧规则处理
   - Brevo 不参与默认 fallback
   - 显式选择 Brevo 但缺 key → 抛出 `BizError(t('brevoApiKey'))`，不降级
   - 未知 provider → 拒绝

2. **Brevo HTTP Adapter** — `brevo-service.js`：
   - 使用 Worker 原生 `fetch()` 调用 `https://api.brevo.com/v3/smtp/email`
   - 请求体：`sender`, `to`, `subject`, `textContent`, `htmlContent`
   - 请求头：`api-key`, `Content-Type: application/json`, `Accept: application/json`
   - 仅接受未设置定时发送时的成功响应
   - 支持单个 `messageId`（字符串）和多个 `messageId`（数组）返回格式
   - 缺少 ID → 报告 `brevoResponseError`
   - 正确解析结构化错误、非 JSON 错误、网络异常
   - 不自动重试、不切换 provider
   - 错误信息不包含 API key

### 涉及文件

| 文件 | 变更 |
|------|------|
| `mail-worker/src/service/provider-resolver.js` | 新建 |
| `mail-worker/src/service/brevo-service.js` | 新建 |

### Issue 02 验收清单对照

- [x] 显式按域选择 Brevo 优先返回；无选择时按旧规则
- [x] 选 Brevo 缺 key → 配置错误；未知 provider 被拒绝
- [x] adapter 使用原生 HTTP 发送，设置认证和内容类型头
- [x] 支持单/多 messageId 格式；缺少 ID 报错
- [x] 正确解析结构化/非 JSON/网络异常错误；不重试不切换
- [x] 错误信息不含 API key
- [ ] 单元测试覆盖（未编写）

---

## Issue 03 — Brevo 外部发信主流程（✅ 后端完成）

### 已完成项

1. **Resolver 集成** — `email-service.js` `send()` 方法：
   - 含站外收件人时调用 `providerResolver.resolve()` 选择 provider
   - 全部站内收件人继续绕过外部 provider

2. **Brevo 调用 + 状态写入**：
   - Brevo 成功后主邮件状态写为 `SENT`（非 `DELIVERED`）
   - Cloudflare Email 成功后写为 `DELIVERED`（保持原有行为）
   - 站内邮件状态为 `SENT`（原有行为）

3. **Provider message 映射保存**：
   - 单个 ID → 所有收件人建立同一 ID 映射
   - 多个 ID → 按收件人顺序关联，数量不一致在落库前抛错

4. **Brevo 阶段限制提前拒绝**：
   - 附件 → `brevoNotSupportAtt`
   - 内嵌图片 → `brevoNotSupportInline`
   - 回复邮件 → `brevoNotSupportReply`
   - 不触发网络请求、不切换 provider、不静默丢失内容

5. **空正文校验**：
   - 选 Brevo 时至少需要 text 或 html，否则拒绝

6. **Cloudflare Email / Resend 行为不变**：
   - 回归逻辑保持原有 `sendByCloudflareEmail` / `sendByResend` 调用路径
   - Brevo 不自动重试或重复发信

### 涉及文件

| 文件 | 变更 |
|------|------|
| `mail-worker/src/service/email-service.js` | `send()` 方法接入 resolver + Brevo + 映射保存 |

### Issue 03 验收清单对照

- [x] 含站外收件人按 resolver 调用 Brevo；全站内绕过外部 provider
- [x] Brevo 成功写 `SENT`，保存 provider message 映射
- [x] 单 ID 共享 / 多 ID 按序关联；数量不一致拒绝
- [x] 附件/内嵌图片/回复/线程头 → 提前拒绝，不发网络请求
- [x] 空正文本地拒绝；有效请求至少含 text 或 html
- [x] Cloudflare Email / Resend 行为通过代码路径保持不变
- [ ] 测试覆盖（未编写）

---

## Issue 04 — 后台发信设置 UI（❌ 未开始）

需要改造 `mail-vue/src/views/sys-setting/index.vue`：
- 按域展示 provider 选择（默认/Cloudflare/Resend/Brevo）
- 选择 Brevo/Resend 时显示凭据输入框，已保存显示脱敏值
- 空凭据表示不修改；显式清除操作删除 key
- 缺 key 时显示配置错误提示
- 前端 i18n 文案
- 浏览器响应不出现完整 API key

**状态：未开始。**

---

## Issue 05 — 第一阶段集成回归与真实发信验收（❌ 未开始）

依赖 03、04 完成后进行。

**状态：未开始。**

---

## Issue 06 — Brevo Webhook 状态回写闭环（❌ 未开始）

需要新建 webhook 路由 + 状态映射 + 幂等处理 + 终态保护。

**状态：未开始。**

---

## 新增文件清单

```
mail-worker/src/entity/provider-message.js          (16 行)
mail-worker/src/service/brevo-service.js             (83 行)
mail-worker/src/service/provider-message-service.js (75 行)
mail-worker/src/service/provider-resolver.js         (56 行)
```

## 修改文件清单

```
mail-worker/src/const/entity-const.js        +17 行
mail-worker/src/entity/setting.js             +4 行
mail-worker/src/i18n/en.js                   +13 行
mail-worker/src/i18n/zh.js                   +13 行
mail-worker/src/init/init.js                 +39 行
mail-worker/src/service/email-service.js     +96/-38 行
mail-worker/src/service/setting-service.js  +41 行
```

---

## 未完成事项汇总

1. **Issue 04** — 前端 Vue 设置页面按域 provider 管理 UI
2. **Issue 05** — 自动化测试 + 真实 Brevo 发信验收
3. **Issue 06** — Brevo webhook 状态回写闭环
4. **测试** — Issue 01-03 的单元测试均未编写
5. **代码审查** — 尚未执行 `/code-review`
6. **提交** — 改动尚未 commit
