# Brevo HTTP 发信 PoC 计划

## 摘要

在 `byo-smtp-check` 分支先接入 Brevo Transactional Email HTTP API，验证外部邮件能否稳定发出，同时不改变现有 Cloudflare Email 和 Resend 行为。

已确认的 Brevo 能力：

- 发送接口：`POST https://api.brevo.com/v3/smtp/email`
- 鉴权：`api-key` 请求头
- 成功响应：HTTP `201`，返回 `messageId` 或 `messageIds`
- 请求支持：`sender`、`to`、`subject`、`htmlContent`、`textContent`
- Brevo 支持 transactional webhook；其回调支持自定义认证 Header，但不是 Resend 式 HMAC 签名

官方参考：

- <https://developers.brevo.com/reference/send-transac-email.md>
- <https://developers.brevo.com/docs/transactional-webhooks.md>
- <https://developers.brevo.com/reference/create-webhook.md>

## 第一阶段：最小发信闭环

### Provider 与配置

- 在现有 provider 选择逻辑中加入 `brevo`。
- 增加 `setting.sendProviders`，格式为：

  ```js
  {
    "example.com": "brevo"
  }
  ```

- 增加 `setting.brevoTokens`，格式为：

  ```js
  {
    "example.com": "xkeysib-..."
  }
  ```

- 保留现有 `resendTokens`，不迁移、不删除历史配置。
- Provider 选择规则固定为：
  1. `sendProviders[domain]` 有明确配置时优先使用它。
  2. 明确选择 Brevo 但没有对应 API key 时直接报错，不自动降级到 Resend 或 Cloudflare。
  3. 没有显式 provider 时，保持现有兼容行为：Cloudflare Email binding 优先，其次 Resend。
  4. Brevo 不参与默认自动回退，避免新增配置后意外切换发信通道。
- API key 只存储在 Worker 后端的 D1/KV 设置流程中；读取设置时仅返回脱敏值。
- `settingService.set()` 只在对应字段出现在请求中时合并 token map，普通设置更新不能清空 Brevo/Resend 凭据。

### 数据库迁移

在当前版本之后增加下一版幂等迁移：

- `setting.brevo_tokens TEXT NOT NULL DEFAULT '{}'`
- `setting.send_providers TEXT NOT NULL DEFAULT '{}'`

迁移要求：

- 每个字段单独执行，避免一个已存在字段导致同一批次后续字段未创建。
- 初始化完成后刷新 D1 设置到 KV。
- `settingService.query()` 和 `refresh()` 都要正确解析这两个 JSON map。
- `websiteConfig()` 不返回任何 API key 或 provider 凭据。

为避免继续使用语义错误的 `resend_email_id`，同时增加通用 provider 消息记录：

```text
email_provider_message
- id
- email_id
- provider
- provider_message_id
- recipient
- status
- message
- last_event_at
- create_time
- update_time
```

唯一约束使用 `(provider, provider_message_id, recipient)`，允许 Brevo 对多个收件人返回同一个 message ID。

第一阶段不实现状态聚合，但发送成功后保存 Brevo 返回的 message ID，为第二阶段 webhook 做准备。

### Brevo Adapter

新增独立的 Brevo HTTP adapter，使用原生 `fetch`，不引入 Brevo SDK。

统一输入：

```js
{
  name,
  accountEmail,
  receiveEmail,
  subject,
  text,
  html
}
```

映射为：

```json
{
  "sender": {
    "email": "sender@example.com",
    "name": "Sender"
  },
  "to": [
    { "email": "recipient@example.com" }
  ],
  "subject": "Subject",
  "textContent": "Plain text",
  "htmlContent": "<p>HTML</p>"
}
```

请求头：

```http
accept: application/json
api-key: <BREVO_API_KEY>
content-type: application/json
```

响应处理：

- 只接受未设置 `scheduledAt` 时的 HTTP `201`。
- 支持 `messageId` 和 `messageIds` 两种返回形式。
- 没有任何 message ID 时视为失败，不写入邮件记录。
- 解析 Brevo 的 `{ code, message }` 错误响应。
- 网络错误统一映射为可识别的 provider 错误。
- 错误信息不得包含 API key。
- 不自动重试、不切换其他 provider，避免重复发信。

### 第一阶段明确不支持的能力

当选择 Brevo 且请求包含以下能力时，在调用 Brevo 前直接返回本地化错误：

- 普通附件
- 内嵌图片
- 回复邮件 `sendType === 'reply'`
- 任何依赖 `In-Reply-To` 或 `References` 的线程头

原因：

- 本阶段只验证纯文本和 HTML。
- Brevo 文档不建议通过普通自定义 headers 发送标准邮件头。
- 不允许静默丢附件或破坏回复线程。

邮件正文至少需要有 `textContent` 或 `htmlContent` 之一；空正文在本地校验阶段拒绝。

### 发送主流程

修改 `email-service.send()`：

- 保留现有权限、额度、域名权限、站内邮件逻辑。
- 外部收件人且 provider 为 Brevo 时调用 Brevo adapter。
- Brevo API 接受成功后主邮件状态写为 `SENT`，不能直接写成 `DELIVERED`。
- 写入主 `email` 记录后，写入 Brevo provider message 映射。
- 如果 Brevo 返回一个 ID 但有多个收件人，为每个收件人建立同一个 provider ID 的映射。
- 如果返回多个 ID，按 Brevo 返回顺序与收件人顺序关联；数量不一致时记录为 provider 响应错误并拒绝落库。
- 现有 Cloudflare Email 和 Resend 的发送与状态行为保持不变。

## 管理后台调整

将当前只显示 `Resend Token` 的设置入口改为“发信设置”。

设置对话框按域显示：

- 域名
- Provider 选择：默认、Cloudflare、Resend、Brevo
- 对应凭据输入框：
  - Resend 显示 Resend API key
  - Brevo 显示 Brevo API key
  - Cloudflare 显示 binding 是否存在，不显示凭据输入
- 当前凭据仅显示脱敏值

交互规则：

- 输入框为空时表示“不修改”，不能覆盖已有 key。
- 提供明确的“清除凭据”操作，清除时才从 map 删除。
- 显式选择 Brevo 后，没有 key 时显示配置错误，不自动切换 provider。
- 保留旧 Resend 设置数据和兼容读取。
- 增加中英文 i18n 文案，包括发信设置、Brevo API key、Provider 未配置、Brevo 当前阶段不支持附件/回复、凭据已设置/清除。

## 第二阶段：Brevo Webhook 闭环

第一阶段验证 API 发信成功后，再实现状态回写。

### Webhook 路由与安全

新增独立路由：

```text
POST /webhooks/brevo
```

Brevo 官方支持 webhook 自定义认证，因此第二阶段采用自定义 Header：

```http
X-Cloud-Mail-Webhook-Secret: <configured-secret>
```

要求：

- 在系统设置中增加脱敏的 `brevoWebhookSecret`。
- 在 Brevo webhook 配置中使用同名自定义 Header。
- Worker 使用常量时间比较校验 Header。
- 不假设 Brevo 提供 Resend 式 HMAC 签名。
- 缺少或错误 secret 返回 `401`。
- 未知 provider message ID 返回非 `2xx`，允许 Brevo 重试。
- 重复事件必须幂等处理。

### Brevo 事件映射

| Brevo event | 系统状态 |
|---|---|
| `request` / `sent` | `SENT` |
| `delivered` | `DELIVERED` |
| `deferred` | `DELAYED` |
| `soft_bounce` | `DELAYED` |
| `hard_bounce` | `BOUNCED` |
| `blocked` / `invalid` | `BOUNCED` |
| `error` | `FAILED` |
| `spam` / `unsubscribed` | `COMPLAINED` |
| `click` / `opened` 等行为事件 | 忽略并返回 `200` |

匹配字段：

- Brevo webhook 的 `message-id`
- 收件人字段 `email`
- 事件时间优先使用 `ts_event`，其次 `ts_epoch`

第二阶段需要把 provider message 状态同步到主邮件记录，并使用事件时间与终态保护避免乱序事件回退状态。

## 测试与验收

### 单元测试

新增 Brevo adapter 测试：

- 正确使用 `api-key` Header。
- 正确构造 `sender`、`to`、`subject`、`textContent`、`htmlContent`。
- `201 + messageId`。
- `201 + messageIds`。
- 缺少 message ID。
- 400/401/403/429/500 错误响应。
- 非 JSON 错误响应。
- 网络异常。
- 错误信息中不包含 API key。

Provider resolver 测试：

- 显式选择 Brevo。
- Brevo 缺 key 时不自动 fallback。
- 无显式 provider 时保留 Cloudflare/Resend 旧规则。
- 未知 provider 被拒绝。

发送流程测试：

- Brevo 成功发送并写入 `SENT`。
- Brevo 发送请求包含纯文本和 HTML。
- 附件存在时发送前拒绝，且不会调用 `fetch`。
- 内嵌图片存在时发送前拒绝，且不会调用 `fetch`。
- 回复邮件发送前拒绝，且不会调用 `fetch`。
- 全部站内收件人继续绕过外部 provider。
- Resend 和 Cloudflare 回归测试不受影响。

配置测试：

- D1 migration 能创建新字段。
- token map 合并不会清除未提交的 key。
- 空输入不会覆盖已有 key。
- 清除操作会删除对应域 key。
- API 返回只包含脱敏凭据。

### 第一阶段真实验收

使用一个已在 Brevo 验证的发件域和 API key：

1. 在系统设置中选择目标域的 Brevo provider。
2. 保存 Brevo API key。
3. 发送一封纯文本 + HTML 的站外邮件。
4. 确认 Brevo API 返回成功。
5. 确认系统邮件记录状态为 `SENT`。
6. 确认 provider message ID 已保存。
7. 确认 API key 不出现在浏览器响应、Worker 日志和错误信息中。
8. 再验证原有 Resend/Cloudflare 配置仍能正常发送。

第二阶段完成后，再验收 delivered、deferred、bounce、blocked、error webhook 状态回写。

## 范围与默认假设

- 本轮只实现 Brevo HTTP API，不实现 Mailgun、通用 SMTP 或 SMTP socket。
- 本轮只支持纯文本和 HTML，不支持附件、内嵌图片和回复线程。
- Brevo 只通过按域显式选择启用，不自动参与 provider fallback。
- 不引入 Brevo SDK，使用 Worker 原生 `fetch`。
- 不在本轮加入 Queue、Workflow、自动重试或发送批处理。
- Brevo 域名和发件人验证由管理员在 Brevo 控制台完成，系统不自动完成域名验证。
- 第一阶段 webhook 只做计划和数据基础；第二阶段再实现 `/webhooks/brevo` 与状态聚合。
