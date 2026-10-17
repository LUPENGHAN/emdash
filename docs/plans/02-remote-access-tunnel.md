# 02 远程访问要能从应用里传出去

先读 [README.md](README.md) 里的共用规则。

这个方案分两个阶段，**中间必须停下来等用户选方案**：

- **阶段一：调研**（只写文档，不改代码）。分支名：`docs/remote-access-tunnel-research`。
- **阶段二：实现**（用户选定方案之后）。下面预先写好了「Cloudflare Tunnel」的实现步骤，因为用户现在用的就是 Cloudflare。用户选了别的方案，就只做阶段一，阶段二的方案重新写。

## 背景

- Emdash 的「远程访问」在本机开一个 HTTP + WebSocket 服务器（默认 `127.0.0.1:7788`），浏览器或手机 App 连上来就能操作这台电脑上的 Emdash。代码在 `src/core/features/remote-access/`。
- 要从公网访问，现在靠应用外面的 `cloudflared`：用户自己装、自己建隧道、自己配 DNS、自己写 `~/Library/LaunchAgents/com.cloudflare.cloudflared.plist` 开机自启。步骤记在 `docs/remote-access-cloudflare.md`。
- 用户希望这些都能在应用的设置里完成。
- 用户的情况：两台电脑（家里一台 Mac mini，办公室一台），各用一个子域名（`home.catchtime.app`、`office.catchtime.app`），域名在 Cloudflare 上。还有一台 Windows 电脑。

---

## 阶段一：调研

### 要回答的问题

对每个候选方案，回答下面每一项。查不到的写「查不到」，不要猜。

1. 需不需要自己有一台公网服务器？
2. 安装：这台电脑上要装什么？macOS、Windows 各怎么装？Emdash 能不能检测到它装了没有、给出安装命令？
3. 登录 / 授权：要什么账号？授权信息是什么形式（一个 token、一个配置文件、浏览器登录）？Emdash 能不能只存一个字符串就完成配置？
4. 子域名：每台电脑一个固定的网址，怎么配？能不能在应用里配，还是必须去对方网站的控制台？
5. 运行：由 Emdash 启动一个子进程就行，还是必须装成系统服务？进程退出后怎么重连？
6. 开机自启：远程访问本来就要求 Emdash 开着，所以「Emdash 启动时跟着启动隧道」是否就够了？
7. HTTPS 和 WebSocket：是否自动有 HTTPS？WebSocket 能不能用（远程访问靠 WebSocket 传数据）？
8. 安全：除了 Emdash 自己的访问密钥，能不能再加一层（例如 Cloudflare Access）？流量经过谁的服务器？
9. 费用和限制：免费额度、带宽、连接数、长连接会不会被断。
10. 国内网络：用户在中国大陆，这个方案在国内能不能稳定连上？（只记录查到的资料和用户反馈，不做结论性判断。）
11. 许可证：如果要把它的程序打包进 Emdash，许可证允许吗？

### 候选方案

至少比较这四个：

1. **Cloudflare Tunnel，用控制台生成的 token**（「远程管理的隧道」）：在 Cloudflare 控制台建隧道、配公网主机名，得到一个 token；电脑上只需要运行 `cloudflared tunnel run`，token 用环境变量 `TUNNEL_TOKEN` 传入。
2. **Cloudflare Tunnel，用 API 在应用里自动建**：用户在应用里填 Cloudflare API token，Emdash 调 API 建隧道、配 DNS。
3. **Tailscale Funnel**：电脑装 Tailscale，`tailscale funnel` 把本机端口公开到 `*.ts.net`。
4. **frp**：需要一台公网服务器跑 `frps`，电脑上跑 `frpc`。

可以再加：ngrok、ZeroTier（用户现在在用，但它是内网，不是公网）。

### 资料来源

只用官方文档和官方 GitHub 仓库，每条结论后面附链接。例如：

- Cloudflare Tunnel：`developers.cloudflare.com/cloudflare-one/connections/connect-networks/`
- `cloudflared` 的命令行参数：`github.com/cloudflare/cloudflared`
- Tailscale Funnel：`tailscale.com/kb/1223/funnel`
- frp：`github.com/fatedier/frp`

### 交付

写一份文档 `docs/remote-access-tunnel-options.md`：

1. 一张表：方案 × 上面 11 个问题。
2. 每个方案在 Emdash 里集成要做的事，列成要点（检测安装、存什么、启动什么命令、显示什么状态）。
3. 推荐一个方案，写理由；同时写它的主要缺点。
4. 列出需要用户回答的问题（例如：愿不愿意每台电脑去 Cloudflare 控制台点一次；要不要支持 Windows）。

文档写完提交（`docs(remote-access): compare ways to reach this computer from the internet`），**然后停下，把文档给用户看，等用户选**。

### 阶段一的审查方案

- [ ] 11 个问题每个方案都答了；「查不到」的确实是查不到（审查的人抽查两条）。
- [ ] 每条结论有官方链接，链接打开是对应的内容。
- [ ] 没有改任何代码。
- [ ] 推荐的方案写了缺点。
- [ ] 第 10 条（国内网络）只写了资料，没有下没有依据的结论。

---

## 阶段二：实现 Cloudflare Tunnel（token 方式）

**只有用户选了方案 1 才做。** 分支名：`feat/remote-access-cloudflare-tunnel`。

### 要做的事

在「设置 → 远程访问」里加一块「Public access (Cloudflare Tunnel)」：

- 用户粘贴 Cloudflare 控制台给的隧道 token，打开开关；
- 远程访问开着时，Emdash 自己启动 `cloudflared`，退出时停掉，断了自动重连；
- 显示状态：没装 cloudflared / 连接中 / 已连接（几条连接）/ 出错（错误信息）；
- 没装 `cloudflared` 时给出安装命令。

用户仍然需要自己去 Cloudflare 控制台：建隧道、拿 token、把公网主机名（例如 `home.catchtime.app`）指到 `http://127.0.0.1:7788`。在界面上写清楚这一步。

### 不做的事

- 不用 Cloudflare API 自动建隧道和 DNS（方案 2）。
- 不下载、不打包 `cloudflared` 程序，只检测用户装的（自己下载可执行文件涉及校验和更新，风险大）。
- 不写 LaunchAgent / 系统服务。
- 不动用户已有的 `~/.cloudflared/` 配置和正在跑的 LaunchAgent。界面上提示：如果已经有一个应用外面的 `cloudflared` 在跑同一个隧道，要先停掉它（见步骤 6）。

### 已知代码位置

- `src/core/features/remote-access/api/index.ts`：`remoteAccessSettingsSchema`（`enabled`、`host`、`port`）、`RemoteAccessStatus`、`RemoteAccessService` 接口、`remoteAccessContract`。
- `src/core/features/remote-access/node/remote-access-service.ts`：`createRemoteAccessService(deps)`，`reconcile()` 根据设置启停服务器，`serialize()` 保证一次只做一件事，启动失败 30 秒后重试。**隧道的启停照这个模式写。**
- `src/core/features/remote-access/browser/remote-access-settings-page.tsx`：设置页面。
- `src/main/bootstrap/boot/phases/services.ts` 约 342–380 行：创建远程访问服务；密钥用 `encryptedAppSecretsStore.getSecret(key)` / `setSecret(key, secret(value, key))` / `deleteSecret(key)` 存取。
- 依赖检测：`src/main/core/dependencies/`（`registry.ts`、`host-dependency-store.ts`）。先看 agent 的 CLI 是怎么登记、检测、给安装命令的（`packages/plugins/src/agents/impl/cursor/index.ts` 里的 `hostDependency: { id, binaryNames, installCommands }` 是一个例子），看能不能用同样的方式登记 `cloudflared`。不能的话，用 `which cloudflared`（Windows 用 `where cloudflared`）检测，并在交付说明里写出来。

### 步骤

#### 步骤 1：设置和密钥

1. `remoteAccessSettingsSchema` 加：`tunnel: z.object({ enabled: z.boolean() }).default({ enabled: false })`，默认值同步加上。
2. token 不放设置里，放加密存储，key 为 `remote-access-tunnel-token`。
3. `RemoteAccessService` 接口加：
   - `tunnelToken(): Promise<{ set: boolean }>`
   - `setTunnelToken(token: string | null): Promise<void>`
   - 合约里加对应的 procedure，**输出里永远不包含 token 本身**。
4. 校验 token：去掉首尾空格；是一段 base64（Cloudflare 的隧道 token 是 base64 编码的 JSON，解开后有 `a`、`t`、`s` 字段）。解不开就报错 `That does not look like a Cloudflare tunnel token.`。先查 Cloudflare 文档确认 token 格式，查不到就只检查非空、不含空白。

#### 步骤 2：隧道进程管理

新建 `src/core/features/remote-access/node/tunnel-process.ts`：

```ts
export type TunnelState =
  | { state: 'off' }
  | { state: 'missing'; installHint: string }
  | { state: 'connecting' }
  | { state: 'connected'; connections: number }
  | { state: 'error'; error: string };

export type TunnelProcessDeps = {
  /** Path to cloudflared, or null when it is not installed. */
  findBinary: () => Promise<string | null>;
  spawn: (command: string, args: string[], env: Record<string, string>) => ChildLike;
  setTimer?: (callback: () => void, ms: number) => () => void;
  warn?: (message: string, details: Record<string, unknown>) => void;
};
```

要求：

1. 启动命令：`cloudflared tunnel --no-autoupdate run`，**token 用环境变量 `TUNNEL_TOKEN` 传，不放在参数里**（参数会出现在 `ps` 里，别的用户能看到）。启动前查 `cloudflared` 文档确认 `TUNNEL_TOKEN` 这个环境变量名。
2. 子进程的环境：只传必要的（`PATH`、`HOME` / `USERPROFILE`、`TUNNEL_TOKEN`），不要把 Emdash 的整个环境传进去。
3. 读 `cloudflared` 的 stderr 判断状态：出现 `Registered tunnel connection` 就算一条连接（最多 4 条）；进程退出就回到 `connecting` 并重启。先在本机跑一次 `cloudflared tunnel --help` 和文档确认日志的原文，测试里用真实的日志行。
4. 重启退避：1 秒、2 秒、4 秒……最长 60 秒；连上之后清零。
5. stderr 里的内容写进日志前，**把 token 替换成 `[redacted]`**（token 有可能出现在错误信息里）。
6. `stop()`：先发 SIGTERM，5 秒后还没退出就 SIGKILL。Windows 上用 `child.kill()`。
7. `findBinary` 返回 null 时状态是 `missing`，`installHint`：macOS `brew install cloudflared`，Windows `winget install --id Cloudflare.cloudflared`，Linux 指向官方下载页。

完成标志：`tunnel-process.test.ts` 用假的 `spawn`（一个 EventEmitter，能模拟 stderr 输出和退出）覆盖：正常连上；进程退出后按退避重启；`stop()` 后不再重启；没装时是 `missing`；日志里 token 被替换；`spawn` 收到的参数里没有 token、环境变量里有。

#### 步骤 3：和远程访问服务接上

文件：`remote-access-service.ts`。

1. `reconcile()` 里：远程访问开着、`tunnel.enabled` 为真、存了 token → 启动隧道；任一条件不满足 → 停掉隧道。token 变了要重启。
2. 隧道指向的是用户在 Cloudflare 控制台配的地址，Emdash 管不了。但如果远程访问的监听地址不是 `127.0.0.1` 也不是全部地址（`0.0.0.0`），隧道很可能连不上本机服务：`status()` 里加一条警告 `The tunnel reaches this computer at 127.0.0.1; listen on “This computer only” or all addresses.`。
3. `RemoteAccessStatus` 加 `tunnel: TunnelState` 和 `warnings: string[]`。
4. `dispose()` 时停掉隧道。应用退出时 `appScope` 会调用 `dispose()`，确认这一点（看 `services.ts`）。

完成标志：`remote-access-service.test.ts` 加测试：开关隧道、改 token 重启、远程访问关掉时隧道也停。

#### 步骤 4：设置页面

文件：`remote-access-settings-page.tsx`。

在现有内容下面加一节 `Public access (Cloudflare Tunnel)`：

1. 说明文字：`Reach this computer from anywhere through a Cloudflare Tunnel. In the Cloudflare dashboard, create a tunnel, point its public hostname at http://127.0.0.1:<端口>, and paste its token here. One hostname per computer.`（端口用当前设置的值。）
2. token 输入框：`type="password"`；已经存了 token 时显示占位文字 `Token saved`，旁边一个 `Remove` 按钮。保存时调 `setTunnelToken`。
3. 开关 `Use the tunnel`。
4. 状态一行：
   - `missing`：`cloudflared is not installed.` 加安装命令（可复制）；
   - `connecting`：`Connecting…`；
   - `connected`：`Connected (N connections)`；
   - `error`：错误信息；
   - 有 `warnings` 时逐条显示。
5. 状态每 5 秒刷新一次（看页面里现有的状态是怎么刷新的，照着做）。
6. 翻译全部加进 `zh-CN.json`，跑 `extract-ui-strings.mjs --missing`。

#### 步骤 5：文档

更新 `docs/remote-access-cloudflare.md`：把「每台电脑自己的隧道」一节改成在应用里配置的步骤（控制台建隧道 → 配公网主机名 → 复制 token → 粘贴到 Emdash）。原来手动配 LaunchAgent 的内容挪到最后，标题写「不用应用内隧道时」。

#### 步骤 6：手动验证

**这一步会影响用户正在用的公网访问，必须先问用户**：

- 用户现在有一个应用外面的 `cloudflared`（LaunchAgent `com.cloudflare.cloudflared`，隧道 `emdash-mac`）在跑。同一个隧道开两个连接器不会冲突，但会让排查变复杂。
- 问用户：用哪个隧道测试（建议在 Cloudflare 控制台新建一个测试隧道，配一个测试子域名，例如 `test.catchtime.app`），要不要暂时停掉外面那个。
- 用户同意并给了测试隧道的 token 之后：在测试实例里打开远程访问、粘贴 token、打开隧道，确认状态变成「已连接」，用手机或另一台设备打开测试子域名能看到登录页。关掉开关后状态变成「关」，`ps aux | grep cloudflared` 里测试实例启动的那个进程没了。
- 用户不同意就只做单元测试，在交付说明里写「未实测」。

#### 阶段二的审查方案

##### A. 范围

- [ ] 改动在 `src/core/features/remote-access/`、`services.ts`、`zh-CN.json`、`docs/remote-access-cloudflare.md`。
- [ ] 没有下载或打包 `cloudflared`；没有写 LaunchAgent；没有碰 `~/.cloudflared/`。

##### B. token 安全（最重要）

- [ ] token 只存在加密存储里，设置里没有。
- [ ] 合约的任何输出都不含 token（逐个看新增 procedure 的 output）。
- [ ] token 通过环境变量传给子进程，不在参数里。自己启动后用 `ps -o args= -p <pid>` 确认看不到 token。
- [ ] 日志里的 token 被替换（有测试，自己也看一眼测试实例的日志）。
- [ ] 子进程的环境变量是白名单，不是整个 `process.env`。

##### C. 进程管理

- [ ] 退避有上限；`stop()` 之后不会再被重启（有测试）。
- [ ] 应用退出时隧道进程被停掉：自己退出测试实例后 `ps aux | grep cloudflared` 确认。
- [ ] 远程访问关掉时隧道也停。

##### D. 界面

- [ ] 没装 `cloudflared` 时有安装命令，命令和平台对应。
- [ ] 监听地址不对时有警告。
- [ ] 翻译齐全。

##### E. 检查和实测

- [ ] 检查命令通过。
- [ ] 交付说明写明有没有做真实隧道的实测，没做的原因。

##### 不通过的典型情况

- `--token <token>` 放在命令行参数里。
- 把整个 `process.env` 传给 `cloudflared`（里面可能有 API 密钥）。
- 进程退出后立刻无限重启，没有退避。
