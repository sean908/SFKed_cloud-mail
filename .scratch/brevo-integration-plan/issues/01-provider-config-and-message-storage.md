# 01 — Provider 配置与消息映射数据基础

**What to build:** 为发信配置和外部 provider 消息建立可迁移、可脱敏、可按收件人追踪的数据基础，同时保留现有 Resend 配置和行为。

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

- [ ] 数据库迁移可重复执行，并分别创建 Brevo token map、按域 provider map 和通用 provider message 记录；单个字段已存在时不会阻止同批次其他字段或表完成创建。
- [ ] D1 设置刷新到 KV、从 KV 查询以及设置读取流程都能正确解析两个 JSON map；旧 Resend token 不被迁移、删除或覆盖。
- [ ] 设置更新只在请求明确包含对应 map 时合并 token；普通设置更新不会清空既有 Brevo 或 Resend 凭据，显式空值可表达删除。
- [ ] 管理端设置查询返回脱敏后的 Brevo/Resend 凭据；公开网站配置不包含任何 token、provider map 或其他发信凭据。
- [ ] 通用 provider message 记录支持 provider、provider message ID、收件人、状态、消息和时间字段，并以 provider、message ID、收件人为唯一组合，允许同一 provider ID 对应多个收件人。
- [ ] 为第一阶段发送结果提供按收件人保存单个或多个 provider message ID 的持久化能力；本阶段不做状态聚合，但重复写入不会制造重复映射。

