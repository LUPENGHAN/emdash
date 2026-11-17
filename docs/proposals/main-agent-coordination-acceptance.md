# 主 Agent 协作验收核对

日期：2026-11-17。对应[产品方案](main-agent-coordination.md)与[执行方案](main-agent-coordination-execution.md)，不替代其中的完成条件。

当前判定：P1–P7 已有实现和本地启动证据，P8 仍在收尾。跨仓库完整回归、真实 OpenCode 请求及远程 Host 操作已通过；还需把模型、文档、跨仓库依赖、PR、基线和用量串入同一用户场景，补实际远程派活的文档内容交付及 PR 多账号核对。根目录 `pnpm run check` 已退出 0，format、lint、typecheck、test 全部通过；这不替代尚缺的综合场景。

## 完成条件与证据

| 条件 | 已核对的证据 | 尚缺的证明或限制 |
| --- | --- | --- |
| P1：默认模型及强度保存、清除、重启，旧空值保持默认 | 默认设置启动验收；E2 核对普通会话、主 Agent 派活默认与显式覆盖；设置及 SQLite 测试 | 统一场景继续复用这些设置 |
| P2：指定供应商／模型／effort，任务间及公共别名隔离 | E2 的两个供应商、默认变化、缺凭据后原任务重试、协议转换、账本与统计；E5 的真实 CLI／ACP | 真实付费模型和官方账号未调用；远程不能使用桌面 loopback 网关 |
| P3：后台派活、持久请求、稳定资源和配置 | 无 renderer 派活启动验收；派发服务及实际 SQLite 的创建、激活失败和服务重建测试；E1 关闭 renderer、跨重启重试 | 不能把服务故障注入等同于每个阶段都做过进程强杀 |
| P4：固定主 Agent、结果版本、用户消息优先、待处理入口 | E1 的主会话切换、修改意见与下一版结果、PTY 待处理；E4 的双窗口决定竞争和实际强杀恢复 | 任意用户消息及命令没有自动重放承诺 |
| P5：跨仓库权限、唯一负责人、接管、依赖和取消 | E1 的 55 项检查；E4 的真实双窗口接管竞争及旧负责人失权 | 实际远程目标的后台派活仍需单独核对 |
| P6：独立文档历史、受控读写、冻结输入、迁移和恢复 | E1 的 Monaco 编辑、提交、显式个人 fork 推送、空仓库、目录项目、关联存储、迁移及删除保护；E4 文档版本竞争；E6 真实远程文件／Git | E6 验证文档服务，尚未证明内容随一次实际远程派活交给 Agent |
| P7：PR 源／目标、幂等回执、明确权限 | E3 的主 Agent／任务 Agent／普通 UI、组织目标、固定提交、创建响应丢失恢复；相关服务及数据库测试 | 还需分别核对推送账号与目标平台 API 账号；未创建真实组织 PR |
| P7：安全同步、检查门禁、清理和恢复 | E3 的临时上游／个人 fork、快进、脏目录、历史改写、离线、检查结果、清理及实际强杀；原生 Git 在 fetch／merge 后强杀；E6 远程同步与安全清理 | 旧 Host 的缺失操作按能力报错；不能静默替换操作 |
| P8：统一场景、恢复覆盖及最终交付 | E1–E6 分别验证对应边界；本批修复测试竞态、视口及冷启动等待 | 同一 profile 的综合场景、远程派活、多账号及完成审计仍未结束 |

## Agent 与 Host 验证范围

“通过”仅指这一行写明的路径，不表示所有协议、模型和恢复组合都已验证。

| Agent／运行时版本 | 接入与传输 | Host | 模型／强度 | 结果与边界 |
| --- | --- | --- | --- | --- |
| Claude Code 2.1.326 | 网关，CLI 及打包 ACP 适配器 | 本地 macOS arm64 | 本地模拟 Anthropic 上游，high | E5：真实进程发出请求并保留强度；不是付费模型推理或官方登录验收 |
| codex-cli 0.169.0 | 网关，CLI 及打包 ACP 适配器 | 本地 macOS arm64 | 本地模拟 Responses 上游，high | E5：CLI 恢复、供应商切换及 ACP 后续轮次通过；不据此扩大到所有崩溃恢复组合 |
| OpenCode 2.2.6 | 网关，原生 CLI 及原生 ACP | 本地 macOS arm64 | 公共模型 test → upstream；跟随适配器默认强度 | E5：两种真实进程都通过实际 Go 网关收到本地上游响应，账本排空后恢复一致；未宣称支持显式 effort |
| 模拟 OpenCode ACP／Claude CLI／Codex CLI | 认证 MCP、任务启动、协议与故障替身 | 隔离 Electron 本地 Host | 默认及显式供应商、模型和强度 | E1–E4：界面、后台、Git、SQLite 和网关为实际应用；模型执行器为可控替身 |
| workspace-server 0.1.14-dev.coordination.20261117.2，协议 12.2.0 | 真实 SSH 冷安装及 Wire | 隔离 Ubuntu 24.04 arm64；自带 Node 24.14.0 | 不使用模型账号；实际远程 PTY 脚本 | E6：管理 worktree、版本化文档、固定提交工作区、基线快进、安全清理、SSH 断连重连通过；尚未声明远程自动任务结果回传通过 |
| 缺少管理 worktree RPC 的旧 Host 合约 | 真实 Wire 连接的旧控制器替身 | 无真实旧版服务二进制 | 不适用 | E7：明确返回能力不足和升级提示，未调用普通代码 worktree 作为替代；不等同于真实旧发行版验收 |

远程 Agent 当前不接收桌面的 loopback MCP 服务。远程网关、远程自动 MCP 结果回传及其他未列出的 Agent／Host 组合不在本表的已验证支持范围内。既有能力不足时应保存可重试状态并报出具体原因，不切换认证或在本地代跑。

## 本机证据索引

以下 JSON、日志和截图保存在隔离测试的临时目录；没有提交原始请求、凭据、数据库或构建产物。

| 编号 | 证据 | 核对结果 |
| --- | --- | --- |
| E1 | `/var/folders/99/ncwqtb1n1hs0pgmgm_bpw7280000gn/T/emdash-cross-coordination-foHldi/result.json` | `passed: true`，55 项；日志 `/tmp/emdash-coordination-cross-regression.log`，进程退出 0 |
| E2 | `/var/folders/99/ncwqtb1n1hs0pgmgm_bpw7280000gn/T/emdash-selection-coordination-MBUlaZ/result.json` | `passed: true`，9 项；等待配置、失败重试和用量界面截图已检查 |
| E3 | `/var/folders/99/ncwqtb1n1hs0pgmgm_bpw7280000gn/T/emdash-task-pr-smoke-nhUkKZ/result.json` | `passed: true`，20 项；实际 Electron SIGKILL 后恢复已保存的终态和证明 |
| E4 | `/var/folders/99/ncwqtb1n1hs0pgmgm_bpw7280000gn/T/emdash-multiwindow-coordination-cRZ0OZ/result.json` | `passed: true`，7 项；结果已通知、未确认时实际强杀；同一事件 ID 恢复和确认 |
| E5 | `/tmp/emdash-selection-native-gateway-tests.log`、`/tmp/emdash-coordination-native-opencode-gateway.log` | 前者 4 文件 12 项；后者启用真实 Codex／OpenCode，1 文件通过；均为本地模拟上游 |
| E6 | `/tmp/emdash-coordination-remote-result.json`、`/tmp/emdash-coordination-remote-host-test.log` | 实际 SSH 集成测试退出 0，JSON 为 `passed: true`，6 项；裸 Debian 包验证日志 `/tmp/emdash-coordination-remote-package-startup-fix.log` |
| E7 | `/tmp/emdash-coordination-old-host-capability-tests.log` | 1 文件 4 项，包含旧控制器缺失管理操作时不降级的断言 |
| E8 | `/tmp/emdash-coordination-final-check.log` | 根目录 `pnpm run check` 退出 0；format、lint、typecheck、test 全部通过 |

## 本批修复与验证

`986d08fa5` 限制 Core 和桌面测试进程数，并用明确阻塞的真实推送调用证明创建 RPC 不等待后台发布。Core 全量 276 文件、2648 项通过，另有 3 项既有跳过。`31d489912` 固定机器表单测试的桌面视口，将 JSDOM 模块载入放入初始化，并为执行多次原生 Git 同步的固定提交集成测试设置独立时间预算。对应 3 文件 30 项通过；未删减断言或跳过失败用例。

`a49a42dd0` 修复远程冷启动误报：服务需要启动多项 Worker 后才开放 socket，原 5 秒窗口提前返回失败。默认就绪窗口改为 30 秒，桌面 SSH 的 start 调用为 60 秒，stop／status 仍保留原超时。测试验证超过 5 秒仍只启动一次，以及显式短超时仍会失败；5 项通过。实际 Linux 包随后完成 start、status、stop，SSH 冷安装与 E6 也通过。

初次构建因 Docker Hub 下载 EOF 失败。本次测试通过临时 Docker 包装器，使用公开镜像源中的官方 Node 24.14.0 bookworm 镜像和系统自带 Dockerfile frontend，已有 make／g++／Python 均已检查；未修改仓库的打包 Dockerfile。包内 Node 和 ripgrep 仍经原打包器校验，原打包器生成归档、校验文件及版本清单。测试产物仅在本机；未上传、发布或改写发行版本。

`b8353c695` 对 Host 缺少创建操作给出升级提示。`318ff3466` 为真实 OpenCode CLI／ACP 添加网关集成验证，并在比较恢复后的账本前等待所有已观察请求入账；非 JSON ACP 输出转换为有界测试失败。`a15e60924` 增加远程 Host 验收及自定义 SSH 端口的隔离标记检查，防止误重置其他服务。

本批没有新增依赖或 DDL，没有推送项目分支、发起真实平台 PR 或执行发布。

统一门禁的桌面测试为 849 文件、6457 项通过，另有 2 文件／8 项既有跳过；workspace-server 为 14 文件、123 项通过。Nx 按现有缓存机制复用其余未变化目标的成功输出（18 个任务中 16 个缓存命中），不声称每个包都在本次命令中重新执行。

## 接续验收

1. 在同一个隔离 profile 中完成默认配置、管理文档、两个仓库的依赖任务、重启和冻结输入、PR 回执、上游同步、检查清理与用量恢复。现有分别通过的脚本作为组件依据，不能替代这次综合场景。
2. 使用已有隔离 SSH Host 验证后台派活的实际工作路径及交给 Agent 的文档内容；远程不支持的网关／MCP 组合记录限制并验证错误，不假装支持。
3. 用两个不同的模拟账号核对源仓库 Git 推送凭据和目标仓库 API 账号，保留实际请求断言。
4. 保留已通过的统一门禁证据，对后续变更运行相应检查；核对剩余故障点、版本兼容和交付物，再决定 P1–P8 是否全部完成。
