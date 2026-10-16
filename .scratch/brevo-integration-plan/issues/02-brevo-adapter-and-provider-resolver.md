# 02 — Brevo Adapter 与 Provider Resolver

**What to build:** 新增不依赖 SDK 的 Brevo HTTP 发信通道，并把按域 provider 选择规则统一为可测试的解析行为。

**Blocked by:** 01 — Provider 配置与消息映射数据基础

**Status:** ready-for-agent

- [ ] 显式按域选择 Brevo 时，resolver 优先返回 Brevo；没有显式选择时仍按 Cloudflare Email 优先、Resend 次之的旧规则处理，Brevo 不参与默认 fallback。
- [ ] 显式选择 Brevo 但缺少对应 API key 时直接返回可识别配置错误，不降级到 Resend 或 Cloudflare；未知 provider 也会被拒绝。
- [ ] adapter 使用 Worker 原生 HTTP 请求发送 sender、收件人、subject、纯文本和 HTML，并设置 Brevo 要求的认证及内容类型请求头。
- [ ] 仅接受未设置定时发送时的成功响应；同时支持单个 message ID 和多个 message ID 的返回格式，并在缺少任何 ID 时报告 provider 响应错误。
- [ ] 正确解析 Brevo 的结构化错误、非 JSON 错误和网络异常；不自动重试、不切换 provider，且任何错误信息都不包含 API key。
- [ ] 单元测试覆盖成功响应、错误状态、非 JSON 响应、网络异常、认证 Header、请求体映射和敏感信息脱漏检查。

