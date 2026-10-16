# Brevo 集成进度报告

> 生成时间：2026-10-16
> 基于计划：`.scratch/brevo-integration-plan/issues/01-06`
> 分支：`byo-smtp-check`
> 说明：本文档描述截至当前工作区（未提交改动）的完成情况。首批后端工作（issue 01-03）已随上一个提交 `d723550` 落地，本文件同时覆盖那批工作与本轮新增的 04/05/06 与测试。

---

## 总览

| Issue | 状态 | 说明 |
|-------|------|------|
| 01 — Provider 配置与消息映射数据基础 | ✅ 完成 | 迁移、实体、setting-service、provider-message-service 就位，含单元测试 |
| 02 — Brevo Adapter 与 Provider Resolver | ✅ 完成 | `brevo-service.js` + `provider-resolver.js`，含单元测试 |
| 03 — Brevo 外部发信主流程 | ✅ 完成 | `email-service.send()` 接入 resolver + Brevo + 映射保存，含发送流程测试 |
| 04 — 后台发信设置 UI | ✅ 完成 | Vue 设置页改造为按域 provider 管理，含 i18n 与脱敏 |
| 05 — 第一阶段集成回归与真实发信验收 | ⚠️ 部分完成 | 自动化回归测试已完成；真实 Brevo 发信验收需真实 API key/已验域名，**未执行** |
| 06 — Brevo Webhook 状态回写闭环 | ✅ 完成 | 独立路由 + 状态映射 + 幂等 + 终态保护，含 25 个测试 |

**整体进度：01-04、06 完成；05 的自动化部分完成，真实发信人工验收待补。**

---

## 本轮相对上一提交（`d723550`）的关键变更

### 缺陷修复

1. **`init.js` 加载崩溃修复** — 上一提交的 `init.js` 混入了游离的 `} catch (e) {}` 垃圾行，导致 Worker 无法加载。已删除，并新增 `v3_5DB` 迁移（`setting.brevo_webhook_secret`）。
2. **按域 key 前缀不匹配** — 域列表项形如 `@example.com`，而 token/provider map 以裸域为 key。新增 `bareDomain()` 归一化，UI 读写统一使用裸域。
3. **切换开关误覆盖凭据** — `change()` 曾 spread 含**脱敏值**的 `setting`，任意开关切换都会用脱敏值覆盖真实 secret。已剔除 `brevoTokens`/`brevoWebhookSecret`/`providerMap`。
4. **Brevo 多 ID 数量校验前移** — ID 数量不一致的校验移到邮件行插入**之前**，避免落库后再抛错。
5. **`resendEmailId` 仅接受字符串** — 避免把 Brevo 返回的数组写进 `resendEmailId`。

### 结构性整理

- `setting-service.js`：抽取模块级 `mergeDomainMap(params, key, stored)`，统一 `resendTokens`/`brevoTokens`/`providerMap` 合并，保留原有 falsy 删除语义。
- `provider-message-service.js`：重写为 `saveMappings` / `findByProviderAndRecipient` / `findByEmailId` / `updateStatus`，去重、使用 `emailConst.status` 与 `BizError`。
- `brevo-webhook-service.js`：改用 `providerMessageService` 方法，降低 Feature Envy；`handle(c, body)` 去掉未用参数。
- `entity-const.js`：删除与 `emailConst.status` 重复的 `providerMessageStatus`。
- 清理死 i18n key：worker `noBrevoToken`/`providerMessageNotFound`/`webhookAuthFail`/`webhookEventIgnored`；vue `resendToken`/`resendTokenList`/`addResendTokenDesc`/`cloudflareEmailSending`/`clearCredentialConfirm`。

### 测试基础设施

- 修复 `vitest.config.js` 指向了**不存在**的 `wrangler.jsonc` 导致测试从不执行的问题；新增 `mail-worker/wrangler.test.toml` 并在配置中引用。
- 新增 `test/helpers/db.js`（`makeContext`/`setupSchema`，重放全部迁移）。
- 删除损坏的默认 `test/index.spec.js`。
- 注意：`[[send_email]]` binding 不被 pool 支持（`env.email` 为 undefined），Cloudflare 发送路径用克隆的 stub `env` 测试。

---

## Issue 01 — Provider 配置与消息映射数据基础（✅ 完成）

### 已完成项

1. **数据库迁移可重复执行** — `init.js`：
   - `v3_4DB`：`ALTER TABLE setting ADD COLUMN brevo_tokens/provider_map`，`CREATE TABLE IF NOT EXISTS provider_message`，唯一索引 `idx_pm_provider_msg_recipient(provider, provider_message_id, recipient)`。
   - `v3_5DB`：`ALTER TABLE setting ADD COLUMN brevo_webhook_secret`。
   - 每条 ALTER 独立 try/catch，单字段冲突不影响其他字段。
2. **设置解析两个 JSON map** — `setting-service.js` `refresh()` / `query()` 同时解析 `brevoTokens` 与 `providerMap`；旧 Resend token 不被迁移/覆盖。
3. **设置更新合并逻辑** — `set()` 中三个 map 各自独立合并（`mergeDomainMap`）；仅当请求携带对应 map 时才合并；空值/null 删除对应 key。
4. **管理端脱敏 + 公开端点白名单** — `get()` 脱敏 Brevo/Resend 凭据与 `brevoWebhookSecret`（前 6 位 + `******`）；`websiteConfig()` 返回白名单，不含任何 token/provider map。
5. **通用 provider message 记录** — 实体 `provider-message.js`；唯一组合 `(provider, provider_message_id, recipient)`；同一 ID 可对应多个收件人。
6. **按收件人保存映射** — `saveMappings()` 支持单个 ID（共享）与多个 ID（按序一一对应）；数量不一致且非单个时抛错、不落库。

### 验收清单对照

- [x] 迁移可重复执行，分别创建 Brevo token map、provider map、provider message 表
- [x] 刷新/查询/读取解析两个 JSON map；旧 Resend token 不被迁移
- [x] 仅当请求包含对应 map 时合并 token；空值可删除
- [x] 管理端返回脱敏凭据；公开配置不含 token
- [x] provider message 唯一组合 `(provider, messageId, recipient)`
- [x] 单/多 ID 保存映射；重复写入被唯一索引拦截
- [x] 单元测试覆盖（`setting-token-map.spec.js` 14 / `provider-message.spec.js` 9）

---

## Issue 02 — Brevo Adapter 与 Provider Resolver（✅ 完成）

### 已完成项

1. **Provider Resolver** — 显式按域选 Brevo 优先；无显式选择时沿用 Cloudflare → Resend 旧规则；Brevo 不参与默认 fallback；显式选 Brevo 缺 key 抛 `BizError(t('brevoApiKey'))`（不降级）；未知 provider 拒绝。
2. **Brevo HTTP Adapter** — 原生 `fetch()` 调用 `https://api.brevo.com/v3/smtp/email`；请求体 `sender`/`to`/`subject`/`textContent`/`htmlContent`；请求头 `api-key`/`Content-Type`/`Accept`；支持单/多 `messageId`；缺 ID 报 `brevoResponseError`；结构化/非 JSON/网络错误分别解析；不重试、不切 provider；错误不含 API key。

### 验收清单对照

- [x] 显式 Brevo 优先；无选择时旧规则；缺 key / 未知 provider 报错
- [x] adapter 原生 HTTP + 认证/内容类型头
- [x] 单/多 messageId；缺 ID 报错
- [x] 结构化/非 JSON/网络错误解析；不重试不切换
- [x] 错误信息不含 API key
- [x] 单元测试覆盖（`provider-resolver.spec.js` 12 / `brevo-service.spec.js` 11）

---

## Issue 03 — Brevo 外部发信主流程（✅ 完成）

### 已完成项

1. `email-service.send()` 含站外收件人时经 `providerResolver.resolve()` 选路；全站内收件人绕过外部 provider。
2. 状态写入：Brevo 成功 → `SENT`；Cloudflare Email 成功 → `DELIVERED`（保持原行为）；站内 → `SENT`。
3. Provider message 映射：单 ID 共享 / 多 ID 按序；数量不一致在**落库前**抛 `BizError(t('brevoIdCountMismatch'))`。
4. 阶段限制提前拒绝（不发网络请求、不切换 provider）：附件 `brevoNotSupportAtt`、内嵌图片 `brevoNotSupportInline`、回复 `brevoNotSupportReply`。
5. 空正文校验：选 Brevo 时至少需 text 或 html。
6. Cloudflare/Resend 路径行为保持不变。

### 验收清单对照

- [x] 站外按 resolver 调 Brevo；全站内绕过
- [x] Brevo 成功写 `SENT` 并保存映射
- [x] 单 ID 共享 / 多 ID 按序；数量不一致拒绝
- [x] 附件/内嵌图片/回复提前拒绝
- [x] 空正文本地拒绝
- [x] Cloudflare/Resend 代码路径保持
- [x] 单元测试覆盖（`brevo-send-flow.spec.js` 10 / `regression.spec.js` 7）

---

## Issue 04 — 后台发信设置 UI（✅ 完成）

### 已完成项（`mail-vue/src/views/sys-setting/index.vue`）

- 以**按域 provider 对话框**（`openSendSetting`/`sendForm`/`sendDomains`/`saveSendSetting`/`clearCredential`/`resetSendForm`/`bareDomain`）替换旧的 Resend Token 入口与对话框。
- 按域展示 provider 选择：默认 / Cloudflare / Resend / Brevo；Cloudflare 仅显示 binding 是否就绪，不显示凭据输入。
- Resend/Brevo 显示凭据输入框，已保存只显示脱敏值；输入为空表示不修改；显式“清除”按钮才删除 key。
- 全局 Brevo webhook secret 区块（含自定义 Header 提示）。
- 选择 Brevo 缺 key 时展示配置错误提示（`brevoKeyMissing`），不静默切通道。
- i18n 新增中英文文案（`sendSetting`、`providerDefault/Cloudflare/Resend/Brevo`、`cloudflareBindingReady/Missing`、`credentialSet/NotSet`、`tokenLeaveEmpty`、`brevoKeyMissing`、`brevoPhaseOneHint`、`brevoWebhookSecret`、`brevoWebhookHeaderHint`）。
- CSS 新增 `.send-setting-list/.send-domain/...`，移除已废弃的 `.resend-table`。

### 验收清单对照

- [x] 按域 provider 选择（默认/Cloudflare/Resend/Brevo）；Cloudflare 无凭据输入
- [x] Resend/Brevo 凭据输入 + 脱敏显示；旧 Resend 配置可读可编辑
- [x] 空输入不修改；显式清除才删除；保存其他设置不影响凭据
- [x] 选 Brevo 缺 key 显示错误提示，不静默切换
- [x] 新增中英文 i18n 文案
- [x] 保存后状态/脱敏列表/按域选择保持一致；响应不含完整 API key

> 注：本 issue 相对旧入口“升级”为按域管理，移除了独立的 Resend token 列表对话框（原列表功能并入按域设置）。

---

## Issue 05 — 第一阶段集成回归与真实发信验收（⚠️ 部分完成）

### 已完成项

- [x] 自动化测试覆盖 adapter、provider resolver、发送主流程、设置迁移与 token map 合并，并断言错误信息不泄露 API key。
- [x] 回归测试确认站内邮件、Cloudflare Email、Resend、附件/回复路径与旧设置读取不受 Brevo 接入影响。

### 未完成（需真实环境，人工验收）

- [ ] 使用**已在 Brevo 验证的发件域与 API key**，后台选 Brevo 发送一封纯文本+HTML 站外邮件，确认 API 返回成功。
- [ ] 真实环境确认系统状态为 `SENT`、provider message ID 按收件人保存且可查询。
- [ ] 真实环境确认 API key 不出现在浏览器响应/Worker 日志/错误信息，并再次验证 Resend/Cloudflare 仍可发信。

> 上述 3 项依赖真实 Brevo 凭据与已验证域名，无法在本地沙箱内完成，**保留为人工验收项**。本阶段范围明确不含 webhook 状态回写。

---

## Issue 06 — Brevo Webhook 状态回写闭环（✅ 完成）

### 已完成项

1. **独立路由** — `api/brevo-webhook-api.js`：`POST /webhooks/brevo`，校验自定义 Header `x-brevo-webhook-secret`（常量时间比较），缺失/错误返回 `401` 且不处理事件；坏 payload 返回 `400`；未知消息返回非 2xx 以便 Brevo 重试。已注册到 `hono/webs.js`，`/webhooks` 已在 `security.js` 排除列表中。
2. **设置支持** — 保存/脱敏展示 `brevoWebhookSecret`，并在 UI 提示 Brevo 端配置对应自定义 Header。
3. **状态映射** — request/sent → `SENT`，delivered → `DELIVERED`，deferred/soft_bounce → `DELAYED`，hard_bounce/blocked/invalid → `BOUNCED`，error → `FAILED`，spam/unsubscribed → `COMPLAINED`。
4. **行为事件忽略** — opened/click/unique_opened/unique_click/proxy_open 等返回 `200` 不处理。
5. **时间与幂等** — 事件时间优先 `date`、其次 `ts_event`/`ts`；支持批量与单事件 payload；message-id 归一化（去 `<>`）。
6. **终态保护 + 乱序保护** — `statusRank`（TERMINAL_RANK=3）保证终态不回退；早于已记录事件时间的事件被忽略；相同状态不重复写入。
7. **主邮件同步** — `syncEmailStatus` 按最高 rank 推进主邮件状态，只前进不回退。

### 验收清单对照

- [x] 设置保存/脱敏展示 webhook secret + Header 指引
- [x] 独立路由 + 常量时间 Header 校验；缺失/错误 `401`
- [x] 按 provider/message ID/收件人匹配；未知非 2xx；重复幂等
- [x] 完整状态映射
- [x] 行为事件忽略返回 200；事件时间优先级
- [x] 终态保护 + 事件时间判断，乱序不回退
- [x] 测试覆盖（`brevo-webhook.spec.js` 25：认证失败/未知 ID/重复/全状态映射/行为事件/乱序/终态/多收件人同 ID）

---

## 测试与构建

| 项目 | 命令 | 结果 |
|------|------|------|
| Worker 单元/集成测试 | `cd mail-worker && npx vitest run` | ✅ 7 文件 / 88 测试通过 |
| 前端构建 | `cd mail-vue && npm run build` | ✅ 构建成功 |

新增测试文件：`provider-resolver.spec.js`(12)、`brevo-service.spec.js`(11)、`setting-token-map.spec.js`(14)、`provider-message.spec.js`(9)、`brevo-webhook.spec.js`(25)、`brevo-send-flow.spec.js`(10)、`regression.spec.js`(7)，及 `helpers/db.js`。

---

## 新增 / 修改文件清单（本轮）

新增：
```
mail-worker/src/api/brevo-webhook-api.js
mail-worker/src/service/brevo-webhook-service.js
mail-worker/test/helpers/db.js
mail-worker/test/*.spec.js  (7 个)
mail-worker/wrangler.test.toml
```

修改：
```
mail-worker/src/init/init.js                 (+v3_5DB, 修复加载崩溃)
mail-worker/src/hono/webs.js                 (注册 webhook api)
mail-worker/src/service/setting-service.js   (mergeDomainMap + webhook secret 脱敏)
mail-worker/src/service/provider-message-service.js (重写)
mail-worker/src/service/email-service.js     (校验前移 / resendEmailId 收紧)
mail-worker/src/const/entity-const.js        (移除重复枚举)
mail-worker/src/entity/setting.js            (default('{}'))
mail-worker/src/i18n/{en,zh}.js              (清理死 key)
mail-worker/vitest.config.js                 (指向 wrangler.test.toml)
mail-vue/src/views/sys-setting/index.vue     (按域 provider UI)
mail-vue/src/i18n/{en,zh}.js                 (发信设置文案)
```

---

## 未完成事项汇总

1. **Issue 05 真实发信验收**：3 项依赖真实 Brevo 凭据/已验域名的人工验收项。
2. **端到端联调**：Vue 设置页与 Worker 的真实浏览器联调（无自动化 E2E）。
3. **提交**：本文件描述的全部改动待 commit（见下）。
