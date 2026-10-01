# Emdash Fork 使用指南

这个仓库是 Emdash 的个人分支。它会安装成一个单独的应用 **Emdash Fork**，可以和官方
Emdash 同时安装，互不影响：

- 应用：`/Applications/Emdash Fork.app`
- 数据：`~/Library/Application Support/emdash-fork`

本指南包括：

1. [在 Mac 上第一次安装](#一在-mac-上第一次安装)
2. [日常更新：`emdash-update`](#二日常更新emdash-update)
3. [Intel 和 Apple 芯片（M 系列）的区别](#三intel-和-apple-芯片m-系列的区别)
4. [个人设置：不改脚本也能调整](#四个人设置不改脚本也能调整)
5. [安卓 App](#五安卓-app)
6. [卸载](#六卸载)
7. [常见问题](#七常见问题)

---

## 一、在 Mac 上第一次安装

### 先准备好

| 需要 | 安装方法 |
| --- | --- |
| Xcode 命令行工具（git、签名工具） | `xcode-select --install` |
| pnpm | `brew install pnpm`，或者参考 <https://pnpm.io/installation> |

Node.js **不用自己装**：pnpm 会自动下载项目指定的版本。

### 三条命令装好

```bash
git clone https://github.com/LUPENGHAN/emdash.git ~/emdash-fork
cd ~/emdash-fork && git checkout feat/multi-agent
./apps/emdash-desktop/scripts/fork/setup.sh
```

`setup.sh` 会依次做这些事。重复运行也没关系，已经做过的步骤会跳过。

1. 检查上面两样工具，缺什么会直接告诉你安装命令。
2. 识别这台 Mac 是 Intel 还是 Apple 芯片。
3. 在 `~/.local/bin` 里建两个命令：`emdash-update` 和 `emdash-android`。它们链接到仓库里的脚本，所以拉取更新后，命令也跟着更新。
4. 如果 `~/.local/bin` 不在 PATH 里，自动写进 `~/.zshrc`。之后新开的终端都能直接用这两个命令。
5. 创建个人设置文件 `~/.config/emdash-fork/config`，里面全是注释，默认什么都不改。
6. 添加官方仓库作为 `upstream` 远程。版本号里的 `fork.N` 就是数比官方多出的提交数。
7. 问你要不要现在就编译安装（大约 5 分钟）。

参数：

- `setup.sh --yes`：不问，直接安装。
- `setup.sh --uninstall`：删除那两个命令。

---

## 二、日常更新：`emdash-update`

```bash
emdash-update       # 拉最新代码 → 安装依赖 → 编译 → 签名 → 装到 /Applications → 启动
emdash-update -y    # 同上；Emdash Fork 正在运行时也不再询问
```

它依次做这些事：

1. **检查工作区。** 仓库里有没提交的改动时会停下来，免得把改到一半的代码装进去。
2. **`git pull --ff-only`。** 拉取当前分支，并列出这次新增的提交。
3. **`pnpm install --frozen-lockfile`。** 安装依赖。
4. **检查 Emdash Fork 是否在运行。** 如果在运行，会先问你。安装时会退出应用，**正在跑的 agent 会被中断**。
5. **编译、签名、替换 `/Applications/Emdash Fork.app`，然后重新启动。**
6. **链接技能。** 把仓库自带的技能（比如 `emdash-split-pr`）链接进 `~/.agentskills`。如果你自己有同名技能，会保留你的，不覆盖。

> **在 Emdash 自己的终端里运行也可以。** 安装时会退出 Emdash，在它的终端里跑会被中途杀掉，所以脚本检测到这种情况时，会自动改到一个新的「终端」窗口里继续。

---

## 三、Intel 和 Apple 芯片（M 系列）的区别

**使用上没有区别：命令和步骤完全一样，脚本会自动识别。** 实际不同的地方只有这几点：

| | Apple 芯片（M1–M4…） | Intel |
| --- | --- | --- |
| 编译出的架构 | arm64 | x64 |
| 编译时的临时目录 | `release/mac-arm64` | `release/mac` |
| 安装位置 | `/Applications/Emdash Fork.app` | 相同 |
| 安卓 App | 相同 | 相同 |

注意：

- **每台 Mac 都要在本机编译。** 数据库等原生模块是 `pnpm install` 按本机架构编译的。在 M 系列上编出来的应用不能拷到 Intel Mac 上用，反过来也不行。
- **M 系列上不要用 Rosetta 打开「终端」。** 如果「终端」勾选了「使用 Rosetta 打开」，会编出 x64 版本：能用，但更慢。`setup.sh` 会提示这种情况。解决办法：退出「终端」，在访达里对「终端」点「显示简介」，取消勾选 Rosetta，然后在新开的终端里重新运行 `pnpm install` 和 `emdash-update`。
- 官方 Emdash 只发布 arm64 的 Mac 版。这个分支在 Intel 上能用，是因为它总是在本机编译。

---

## 四、个人设置：不改脚本也能调整

想改行为时，**先改设置文件，不要直接改脚本**。

`~/.config/emdash-fork/config` 是 shell 语法，`emdash-update` 和 `emdash-android` 每次运行都会读它：

```bash
# 用固定证书签名：每次更新后 macOS 不再重新要权限、要钥匙串访问
EMDASH_FORK_SIGN_IDENTITY="Emdash Fork Local"

# 安卓 SDK 和 JDK（默认用 Android Studio 的位置）
ANDROID_HOME="$HOME/Library/Android/sdk"
JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
```

### 签名证书：强烈建议配置

不配证书时，每次更新都会用临时签名。macOS 会把它当成一个新应用，于是：

- 访问「文稿」等文件夹的权限要重新授权；
- 钥匙串也会再次弹窗。

配一个固定证书就能解决，免费，一次就行：

1. 打开「钥匙串访问」，在菜单选「钥匙串访问 → 证书助理 → 创建证书…」。
2. 名称填 `Emdash Fork Local`，身份类型选「自签名根证书」，证书类型选「**代码签名**」，点创建。
3. 在「钥匙串访问」里双击这张证书，展开「信任」，把「代码签名」改成「**始终信任**」，关窗时输入密码。不设信任的话，脚本识别不到它，仍会用临时签名。
4. 证书叫这个名字时，脚本会自动使用，设置文件里都不用写。如果你已经有「Apple Development」证书，也可以把它的名字填进 `EMDASH_FORK_SIGN_IDENTITY`。查看本机有哪些证书：

   ```bash
   security find-identity -v -p codesigning
   ```

### 想改脚本本身

命令都是链接到仓库里的脚本，所以改完下次运行就生效。但 `emdash-update` 要求工作区干净，所以改完需要**提交**。推荐的做法：

```bash
git checkout -b my-changes   # 在自己的分支上改、提交
emdash-update                # 之后更新的就是这个分支
```

要合并上游的新改动时，在这个分支上执行 `git merge origin/feat/multi-agent`。

---

## 五、安卓 App

安卓 App 打开的是电脑上 Emdash 的「远程访问」页面，全屏运行，不需要浏览器。

和用浏览器相比：

- **不会掉登录。** 链接保存在 App 里，每次启动都会重新登录，手机浏览器清 cookie 也不影响。
- **多台电脑一个列表。** 有多台电脑时，打开 App 先看到电脑列表，每台显示在线、连不上或需要新链接，点一下就进入。长按可以重命名、重新加载或移除。
- **随时切回列表。** 页面上有一个小圆按钮，点它回到列表；按住可以拖到不挡视线的位置，松手后会贴到最近的一边。在 Emdash 首页按返回键也能回到列表。
- **切换不丢状态。** 进过的电脑页面都保留着，切回来接着看，不会重新加载。
- **断线后自动重连。** 连不上时，App 开着期间每 10 秒重试一次，手机网络切换时也会马上重试。
- **能直接走 HTTP。** 通过 EasyTier、Tailscale 或局域网的 `http://` 地址都能直接用，不需要证书。

### 1. 在电脑上编译 App（只要做一次）

先准备好：

- 安卓 SDK 和 JDK 17 以上。最简单的办法是装 [Android Studio](https://developer.android.com/studio)，两样都带。
- 如果 SDK 不在默认位置，把路径写进上面的设置文件。

然后选一种方式装到手机上：

```bash
emdash-android --serve     # 编译，并开一个下载地址给手机（推荐）
emdash-android --install   # 编译，并通过 USB 或无线调试直接装到手机
emdash-android             # 只编译，产物在 apps/emdash-android/Emdash.apk
```

用 `--serve` 时会打印出几个地址，比如 `http://10.126.126.3:7790/Emdash.apk`：

1. 用手机浏览器打开**手机能访问到**的那个地址（EasyTier 或 Tailscale 的 IP、同一 Wi-Fi 下的局域网 IP），下载后安装。
2. 安卓会让你允许「安装未知来源应用」，同意即可。
3. 装完回到电脑终端按 `Ctrl-C` 停止。

### 2. 在 App 里添加电脑

1. 在电脑上的 Emdash 打开 **设置 → 远程访问**，开启后复制连接链接（形如 `http://地址:端口/connect?token=…`）。
2. 把链接发到手机，用下面任意一种方式添加：
   - 打开 App 粘贴。剪贴板里已有链接时，会自动填好。
   - 在聊天软件里长按链接，**分享**给 Emdash。
   - 直接点链接，选用 **Emdash** 打开。

每台电脑只需要添加一次。只有在 Emdash 里**更换了链接**，才需要重新粘贴；App 会提示「已退出」。

### 3. 更新 App

重新运行 `emdash-android --serve`（或 `--install`），然后覆盖安装即可。

只要每次都在同一台电脑上编译，都能直接覆盖安装。换了电脑编译时，需要先卸载旧版本，因为签名不同。

---

## 六、卸载

```bash
~/emdash-fork/apps/emdash-desktop/scripts/fork/setup.sh --uninstall   # 删除两个命令
rm -rf "/Applications/Emdash Fork.app"                                # 删除应用
rm -rf ~/Library/Application\ Support/emdash-fork                     # 删除数据（不可恢复）
rm -rf ~/.config/emdash-fork                                          # 删除个人设置
```

安卓 App 在手机上像普通 App 一样卸载。

---

## 七、常见问题

**`command not found: emdash-update`**
新开一个终端窗口（PATH 只对新终端生效），或者重新运行 `setup.sh`。

**「The checkout … has uncommitted changes」**
仓库里有没提交的改动。先提交，或者用 `git stash` 暂存，再更新。

**每次更新后 macOS 又要授权、钥匙串又弹窗**
还没配签名证书，见[第四节](#签名证书强烈建议配置)。

**Intel Mac 上装好了打不开**
大概率用的是旧脚本：旧版只会编译 arm64。执行 `git pull` 后再运行 `emdash-update`。

**手机 App 显示「连不上」**
依次检查：

1. 电脑上的 Emdash 是否在运行，**远程访问**是否开启。
2. 手机和电脑是否在同一个网络里（EasyTier 或 Tailscale 是否都连上了）。
3. 链接里的地址，手机能不能访问到。

网络恢复后 App 会自己重连。

**手机提示「与已安装的应用签名不一致」**
这个 APK 是在另一台电脑上编译的。先卸载手机上的旧版本，再安装。
