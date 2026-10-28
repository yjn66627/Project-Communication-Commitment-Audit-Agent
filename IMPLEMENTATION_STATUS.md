# 源码展示与部署功能对应表

公开代码来自 R19 冻结 Source Authority。最新已验收本机安装版 Build 为 `X9GFOMJza7VdOASvVqMTB`，经过后续隔离修复与部署，不能由本仓库完整重建。

| 功能 / 机制 | 本仓库是否包含实现 | 证据与边界 |
| --- | --- | --- |
| Domain Schema、Evidence 引用、Trust Gate | 包含 R19 实现 | `src/domain/`、`src/providers/trust/`；Commitment / Conflict Domain 仍 PARTIAL |
| 隐私候选、脱敏映射、修订、确认与 egress gate | 包含 R19 基线 | `src/privacy/`；人工复核仍必需 |
| 中文发言人姓名识别增强、遗漏姓名人工补标 | 不包含后续增强 | APP_LOCAL_FINAL_DEFECT_REPAIR_01 / DEPLOYMENT_02 本机验收记录；不得据此声称 R19 已含增强 |
| DeepSeek / OpenAI-compatible 适配与结构化响应检查 | 包含 R19 实现 | `src/providers/runtime/`；2026-10-22 真实四阶段 E2E 为历史运行证据，非当前安装版全量复验 |
| 报告生成、预览、接受、SQLite 存储与历史 | 包含 R19 基线 | `src/application/reports/`、`src/db/`；最新 UI 另有后续改进 |
| 只读报告质量复核候选与后续首屏、卡片、证据导航 UX | 不包含后续实现 | APP_LOCAL_REPORT_QUALITY_CLOSURE_01、QUALITY_DEPLOYMENT_02、UX_FINAL_DEPLOYMENT_02 本机验收记录；只读候选不改写已接受报告，也不调用 AI |
| 历史 Windows ACL + 明文 JSON 配置机制 | 未包含完整辅助实现 | 属于 R19 历史机制，不能据此描述正式安装版凭证存储 |
| 正式版 Windows CurrentUser DPAPI + ACL 凭证存储 | 不包含辅助实现 | 正式版使用说明及本机凭证辅助代码只读核验；没有复制配置、密文或解密材料 |
| 完整 Windows 运行发行、依赖锁定与可复现构建链 | 不包含 | 没有 package-lock、完整迁移/构建辅助文件、Node Runtime、node_modules 或 .next；不作为开箱即用发行包 |

后续验收证据仅支持相应本机行为，不代表完整源码已经公开，也不代表企业客户、商业交付或生产规模。原始验收材料、截图、用户数据库与私有日志保持排除。项目使用 Codex 辅助开发，不声称作者逐行手写全部代码。完整二进制发行的 DEV08_A_LICENSE_GATE 仍为 BLOCKED。
