# 05 — 第一阶段集成回归与真实发信验收

**What to build:** 用自动化回归和一次真实 Brevo 发信验收锁定第一阶段行为，证明新通道可用且不会破坏现有发信能力。

**Blocked by:** 03 — Brevo 外部发信主流程；04 — 后台发信设置

**Status:** ready-for-agent

- [ ] 自动化测试覆盖 adapter、provider resolver、发送主流程、设置迁移与 token map 合并，并验证错误信息不泄露 API key。
- [ ] 回归测试确认站内邮件、Cloudflare Email、Resend、附件/回复原有路径和旧设置读取不受 Brevo 接入影响。
- [ ] 使用已在 Brevo 验证的发件域和 API key，通过后台选择 Brevo、发送一封纯文本加 HTML 的站外邮件，并确认 Brevo API 返回成功。
- [ ] 真实验收确认系统邮件状态为 `SENT`，provider message ID 已按收件人保存，且主邮件与 provider 映射可查询。
- [ ] 真实验收确认 API key 不出现在浏览器响应、Worker 日志或错误信息中，并再次验证原有 Resend/Cloudflare 配置仍可发送。
- [ ] 第一阶段验收记录明确不包含 webhook 状态回写；只有本票通过后才进入第二阶段 webhook 实现。

