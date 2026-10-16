# 06 — Brevo Webhook 状态回写闭环

**What to build:** 为 Brevo 建立受保护、幂等且能抵抗乱序事件的 webhook 回写链路，把 provider message 状态同步到主邮件记录。

**Blocked by:** 04 — 后台发信设置；05 — 第一阶段集成回归与真实发信验收

**Status:** ready-for-agent

- [ ] 系统设置支持保存和脱敏展示 Brevo webhook secret，并能指导管理员在 Brevo webhook 配置中使用对应自定义 Header。
- [ ] 独立 webhook 路由校验自定义 Header，使用常量时间比较；缺少或错误 secret 返回 `401`，不会处理事件。
- [ ] 根据 provider、message ID 和收件人匹配已保存的 provider message；未知消息返回非 `2xx` 以便 Brevo 重试，重复事件处理保持幂等。
- [ ] 完成 Brevo 事件到系统状态的映射：request/sent 为 `SENT`，delivered 为 `DELIVERED`，deferred/soft_bounce 为 `DELAYED`，hard_bounce/blocked/invalid 为 `BOUNCED`，error 为 `FAILED`，spam/unsubscribed 为 `COMPLAINED`。
- [ ] click、opened 等行为事件被忽略并返回 `200`；事件时间优先使用事件时间字段，其次使用 epoch 字段。
- [ ] provider message 状态和主邮件状态同步时具备终态保护与事件时间判断，乱序事件不会将已达到的终态回退；重复事件不会重复写入或改变结果。
- [ ] 测试覆盖认证失败、未知 ID、重复事件、所有状态映射、行为事件、乱序事件、终态保护及多收件人相同 message ID。

