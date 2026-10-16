# 04 — 后台发信设置

**What to build:** 将后台现有的 Resend Token 入口升级为按域管理发信 provider 的设置体验，并安全地管理 Brevo 与 Resend 凭据。

**Blocked by:** 01 — Provider 配置与消息映射数据基础

**Status:** ready-for-agent

- [ ] 系统设置按域展示 provider 选择，支持默认、Cloudflare、Resend 和 Brevo；Cloudflare 只显示 binding 是否存在，不显示凭据输入框。
- [ ] 选择 Resend 或 Brevo 时显示对应凭据输入框，已保存凭据只显示脱敏值；旧 Resend 配置可以继续读取和编辑。
- [ ] 凭据输入为空表示不修改现有 key；只有明确执行清除操作才会从对应 token map 删除 key，保存其他设置不会影响凭据。
- [ ] 显式选择 Brevo 但缺少 key 时在设置界面显示配置错误提示，不把 provider 静默切换到其他通道。
- [ ] 增加发信设置、Brevo API key、provider 未配置、凭据已设置/清除以及当前阶段不支持附件/回复等中英文 i18n 文案。
- [ ] 设置更新成功后页面状态、脱敏列表和按域选择保持一致；浏览器响应中不出现完整 API key。

