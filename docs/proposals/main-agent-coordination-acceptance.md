# 主 Agent 协作验收核对

日期：2026-11-17。对应[产品方案](main-agent-coordination.md)与[执行方案](main-agent-coordination-execution.md)，不替代其中的完成条件。

当前判定：P1–P8 已按方案完成实现和约定的隔离模拟验收。最终根目录 `pnpm run check` 退出 0，format、lint、typecheck、test 全部通过（E11）。E10 在同一个真实 Electron profile 中完成默认配置、独立文档、两个仓库的依赖任务、重启、PR 恢复、上游同步、检查清理及用量恢复；E9 验证实际 SSH 目标的工作路径、文档内容和重连。真实付费模型、真实组织 PR 和远程桌面 loopback 网关不属于已验证支持组合。

## 完成条件与证据

| 条件 | 已核对的证据 | 范围与边界 |
| --- | --- | --- |
| P1：默认模型及强度保存、清除、重启，旧空值保持默认 | 默认设置启动验收；E2 核对普通会话、主 Agent 派活默认与显式覆盖；设置及 SQLite 测试 | E10 已在同一场景复用并验证重启后的冻结值 |
| P2：指定供应商／模型／effort，任务间及公共别名隔离 | E2 的两个供应商、默认变化、缺凭据后原任务重试、协议转换、账本与统计；E5 的真实 CLI／ACP | 真实付费模型和官方账号未调用；远程不能使用桌面 loopback 网关 |
| P3：后台派活、持久请求、稳定资源和配置 | 无 renderer 派活启动验收；派发服务及实际 SQLite 的创建、激活失败和服务重建测试；E1 关闭 renderer、跨重启重试 | 不能把服务故障注入等同于每个阶段都做过进程强杀 |
| P4：固定主 Agent、结果版本、用户消息优先、待处理入口 | E1 的主会话切换、修改意见与下一版结果、PTY 待处理；E4 的双窗口决定竞争和实际强杀恢复 | 任意用户消息及命令没有自动重放承诺 |
| P5：跨仓库权限、唯一负责人、接管、依赖和取消 | E1 的 55 项检查；E4 的真实双窗口接管竞争及旧负责人失权 | E9 实际远程派活通过；远程自动 MCP 回传未支持 |
| P6：独立文档历史、受控读写、冻结输入、迁移和恢复 | E1 的 Monaco 编辑、提交、显式个人 fork 推送、空仓库、目录项目、关联存储、迁移及删除保护；E4 文档版本竞争；E6 真实远程文件／Git | E9 已核对实际远程 Agent 收到冻结文本；E10 验证本地综合场景 |
| P7：PR 源／目标、幂等回执、明确权限 | E3 的主 Agent／任务 Agent／普通 UI、组织目标、固定提交、创建响应丢失恢复；相关服务及数据库测试 | E10 实际 HTTP Git 推送使用 source-git，PR 创建使用 target-api；未创建真实组织 PR |
| P7：安全同步、检查门禁、清理和恢复 | E3 的临时上游／个人 fork、快进、脏目录、历史改写、离线、检查结果、清理及实际强杀；原生 Git 在 fetch／merge 后强杀；E6 远程同步与安全清理 | 旧 Host 的缺失操作按能力报错；不能静默替换操作 |
| P8：统一场景、恢复覆盖及最终交付 | E1–E10 覆盖服务故障、原生强杀、真实窗口、远程与同一 profile 综合流程；本批修复 ACP 连接准备和 skills 发布顺序 | E11 最终门禁通过；恢复证明的具体层级见下表 |

## Agent 与 Host 验证范围

“通过”仅指这一行写明的路径，不表示所有协议、模型和恢复组合都已验证。

| Agent／运行时版本 | 接入与传输 | Host | 模型／强度 | 结果与边界 |
| --- | --- | --- | --- | --- |
| Claude Code 2.1.326 | 网关，CLI 及打包 ACP 适配器 | 本地 macOS arm64 | 本地模拟 Anthropic 上游，high | E5：真实进程发出请求并保留强度；不是付费模型推理或官方登录验收 |
| codex-cli 0.169.0 | 网关，CLI 及打包 ACP 适配器 | 本地 macOS arm64 | 本地模拟 Responses 上游，high | E5：CLI 恢复、供应商切换及 ACP 后续轮次通过；不据此扩大到所有崩溃恢复组合 |
| OpenCode 2.2.6 | 网关，原生 CLI 及原生 ACP | 本地 macOS arm64 | 公共模型 test → upstream；跟随适配器默认强度 | E5：两种真实进程都通过实际 Go 网关收到本地上游响应，账本排空后恢复一致；未宣称支持显式 effort |
| 模拟 OpenCode ACP／Claude CLI／Codex CLI | 认证 MCP、任务启动、协议与故障替身 | 隔离 Electron 本地 Host | 默认及显式供应商、模型和强度 | E1–E4：界面、后台、Git、SQLite 和网关为实际应用；模型执行器为可控替身 |
| workspace-server 0.1.14-dev.coordination.20261117.2，协议 12.2.0 | 真实 SSH 冷安装及 Wire | 隔离 Ubuntu 24.04 arm64；自带 Node 24.14.0 | 不使用模型账号；实际远程 PTY 脚本 | E6 验证 Host 文件／Git；E9 在实际 Electron 中派活，实际远程 worktree 的可控 Claude CLI 收到文档及 high effort，断连与应用重启后保持同一进程。结果由负责主 Agent 核对实际远程提交后记录，不是远程自动 MCP 回传 |
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
| E9 | `/var/folders/99/ncwqtb1n1hs0pgmgm_bpw7280000gn/T/emdash-remote-delegation-fiworL/result.json` | `passed: true`，7 项，真实 Electron 退出 0；保留个人 14 个 skills；截图 `remote-result-reviewed.png` 已检查 |
| E10 | `/var/folders/99/ncwqtb1n1hs0pgmgm_bpw7280000gn/T/emdash-complete-coordination-7MPJRX/result.json` | `passed: true`，17 项，真实 Electron 退出 0；同一 profile 内包含跨仓库、模型、文档、PR、基线、清理与用量；两张综合结果截图已检查 |
| E11 | `/tmp/emdash-coordination-delivery-check.log` | 实现基线 `aa4f5e7c5`，根目录 `pnpm run check` 退出 0，四项门禁全通过；桌面 849 文件、6459 项通过，另有 2 文件／8 项既有跳过；18 个测试相关任务中 17 个复用 Nx 缓存 |

## 本批修复与验证

`986d08fa5` 限制 Core 和桌面测试进程数，并用明确阻塞的真实推送调用证明创建 RPC 不等待后台发布。Core 全量 276 文件、2648 项通过，另有 3 项既有跳过。`31d489912` 固定机器表单测试的桌面视口，将 JSDOM 模块载入放入初始化，并为执行多次原生 Git 同步的固定提交集成测试设置独立时间预算。对应 3 文件 30 项通过；未删减断言或跳过失败用例。

`a49a42dd0` 修复远程冷启动误报：服务需要启动多项 Worker 后才开放 socket，原 5 秒窗口提前返回失败。默认就绪窗口改为 30 秒，桌面 SSH 的 start 调用为 60 秒，stop／status 仍保留原超时。测试验证超过 5 秒仍只启动一次，以及显式短超时仍会失败；5 项通过。实际 Linux 包随后完成 start、status、stop，SSH 冷安装与 E6 也通过。

初次构建因 Docker Hub 下载 EOF 失败。本次测试通过临时 Docker 包装器，使用公开镜像源中的官方 Node 24.14.0 bookworm 镜像和系统自带 Dockerfile frontend，已有 make／g++／Python 均已检查；未修改仓库的打包 Dockerfile。包内 Node 和 ripgrep 仍经原打包器校验，原打包器生成归档、校验文件及版本清单。测试产物仅在本机；未上传、发布或改写发行版本。

`b8353c695` 对 Host 缺少创建操作给出升级提示。`318ff3466` 为真实 OpenCode CLI／ACP 添加网关集成验证，并在比较恢复后的账本前等待所有已观察请求入账；非 JSON ACP 输出转换为有界测试失败。`a15e60924` 增加远程 Host 验收及自定义 SSH 端口的隔离标记检查，防止误重置其他服务。

本批没有新增依赖或 DDL，没有推送项目分支、发起真实平台 PR 或执行发布。

上一轮统一门禁 E8 的桌面测试为 849 文件、6457 项通过，另有 2 文件／8 项既有跳过；workspace-server 为 14 文件、123 项通过。Nx 按现有缓存机制复用其余未变化目标的成功输出（18 个任务中 16 个缓存命中），不声称每个包都在本次命令中重新执行。

## 综合场景与启动修复

`55a567751` 将 ACP live state 的观察与启动准备分开。回归测试先复现 7 个状态订阅重复准备 skills／模型路由，再验证观察不准备、显式连接仍保留配置。`0adc7e64b` 让连接阶段跳过 skills 的磁盘同步，显式启动仍完成同步，并保留连接描述中的 MCP 与环境，未延长前端连接超时或绕过系统安全存储。首次进入主 Agent、重连、真正启动及描述保留均由测试和 E10 核对。

`221bc471c` 在复制生成的 Cursor skills 前写入 Git 忽略规则。先按标记区分托管副本和仓库自己的 skill，再发布文件，仓库自己的目录保持可见。测试在实际复制调用前运行原生 `git check-ignore`，修复前失败、修复后通过。E10 保留本机约 280 MB 的个人 skills，最终没有再次出现文件服务内存不足或 getHomeDir 超时；仍有本机 FSEvents 丢事件后重新扫描的警告，不把一次成功扩展为大库性能保证。

`c2a5485d7` 的远程脚本通过实际机器设置、Host readiness、后台派发和 SSH 服务执行。冻结的文档内容及 high effort 到达远程 worktree，未传桌面文档路径、loopback MCP 或网关环境。显式 SSH 断连重连以及完整 Electron 重启后，同一远程进程与任务路径保留；不支持的远程网关保存可重试失败，没有本地代跑或切换认证。负责主 Agent 核对实际远程 Git 提交及命令输出后记录和审核结果。

`aa4f5e7c5` 的综合脚本在三个临时仓库和同一应用配置中执行完整流程。普通会话使用 Agent 的 high，SDK 任务继承主 Agent 的 medium，额外覆盖使用 low；等待中的调用方任务固定供应商 B／custom-b／high 和文档 v1。修改默认与文档 v2 后重启，接受 SDK 的实际提交才释放调用方；凭据缺失先保留失败，界面重试复用原 worktree。实际 Node 导入两个任务分支的代码并得到 42，结果经过主 Agent 审核。额外 low 对照任务保持 assigned，没有把启动成功算作完成。

SDK 通过原生 HTTP Git 使用 source-git 身份推送个人 fork；两个不同的平台账号同时连接，应用默认账号不同于项目指定的 target-api。组织 PR 创建端点只接受 target-api；实际唯一 POST 使用该身份。创建响应丢失后重启、界面重试恢复原 PR，未出现第二次创建。临时上游合并后本地代码基线快进并验证；SDK 和调用方任务提交、管理文档提交及 fork main 均未改写或隐式推送。ignored 检查产物阻止清理，显式移除后重试成功；再重启仍保留检查输出、清理回执、完成状态、文档 v1 和 PR。实际 Go 网关完成 Responses → Chat，账本与统计保留供应商、用户模型及 17／5／3 token。

## 故障与恢复审计

| 边界 | 证据层级与结论 |
| --- | --- |
| 保存派发、创建资源、激活和启动确认之间失败 | 派发服务测试逐处注入异常并重建服务；SQLite 后台测试验证实际持久状态、固定基线、配置和激活失败后复用。E1、E4、E10 进一步验证真实应用重启和失败重试；不声称每个中间阶段都做过操作系统强杀 |
| 结果写入、投递和确认之间失败 | SQLite 及服务测试覆盖保存中断、幂等、版本和确认；E4 在实际窗口中确认 queued 且 Agent 已收到未确认事件后强杀 Electron，同一事件 ID 恢复和确认，无重复决定 |
| 并发接管、审核、文档及启动重试 | E4 的两个真实弹出窗口竞争；后台负责人／版本校验只接收有效决定，冲突窗口刷新。E1 补充等待接管、依赖取消及主会话切换 |
| Git fetch／快进中断与检查清理 | 原生 Git 子进程在 fetch 后和快进后实际 SIGKILL，重建运行时核对文件、引用和恢复；E3 在终态证据保存后强杀 Electron，E10 验证检查输出及清理证明跨重启保留 |
| 页面、Host 与服务版本 | E1 关闭 renderer 后派活／投递；E9 实际 SSH 重连及应用重启；E7 旧控制器明确拒绝缺失管理操作。其余旧发行版二进制、未列出的 Agent／Host 组合保持未验证，不做语义降级 |
| 平台与凭据 | E10 使用两个本地假账号，实际 HTTP Git 和 API 请求分别验证；模型使用本地上游。没有调用真实付费推理、生产账号或真实组织 PR |

最终门禁 E11 已通过，交付记录与实现直接提交到 `feat/multi-agent`。本批没有新依赖或 DDL；没有项目分支推送、真实平台 PR 或发布。用户不需要补做本方案约定的验收。未验证的付费推理、真实平台发布和未列出的 Agent／Host 组合不纳入完成声明。
