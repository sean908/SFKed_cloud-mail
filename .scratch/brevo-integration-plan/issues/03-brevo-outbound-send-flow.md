# 03 — Brevo 外部发信主流程

**What to build:** 将 Brevo 接入现有邮件发送链路，让站外纯文本/HTML 邮件可以按域稳定发送并留下可供后续 webhook 使用的记录，同时不改变站内、Cloudflare 和 Resend 行为。

**Blocked by:** 01 — Provider 配置与消息映射数据基础；02 — Brevo Adapter 与 Provider Resolver

**Status:** ready-for-agent

- [ ] 含站外收件人的邮件按 resolver 结果调用 Brevo；全部站内收件人继续绕过外部 provider 并走原有站内投递流程。
- [ ] Brevo 成功发送后主邮件状态写为 `SENT`，不会直接写成 `DELIVERED`；发送结果和每个收件人之间的 provider message 映射会一起保存。
- [ ] Brevo 返回单个 ID 时为所有收件人建立同一 ID 的映射；返回多个 ID 时按收件人顺序关联，数量不一致会在落库前报告错误并拒绝产生不完整记录。
- [ ] 当请求包含普通附件、内嵌图片、回复类型或线程头依赖时，在调用 Brevo 前返回中英文可识别错误，且不会触发网络请求、切换 provider 或静默丢失内容。
- [ ] 空正文在本地校验阶段被拒绝；有效请求至少包含纯文本或 HTML，且两种内容都能按方案传递给 Brevo。
- [ ] Cloudflare Email 和 Resend 的发送、附件、回复及状态行为通过回归测试保持不变；Brevo 不会自动重试或重复发信。
- [ ] 发送流程测试覆盖 resolver 选择、缺 key、站内收件人、成功落库、ID 数量不一致和所有 Brevo 不支持能力的提前拒绝。

