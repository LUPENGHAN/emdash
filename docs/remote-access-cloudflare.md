# 用 Cloudflare 从公网打开远程访问

域名和访问密钥都在运行时填写。编译、打包 Emdash 时不用写进配置。

一台电脑对应一个子域名。两台电脑共用一个网址时，Cloudflare 会在它们之间轮流转发，打开后分不清连上的是哪一台。这台 Mac mini 用 `home.catchtime.app`，办公室那台用 `office.catchtime.app`。两台电脑的访问密钥填同一把。

`home.catchtime.app` 和 `office.catchtime.app` 的 DNS 还没有建好。本机 `~/.cloudflared/config.yml` 里仍是 `emdash.catchtime.app`，隧道名是 `emdash-mac`，转到 `127.0.0.1:7788`。

## 每台电脑的设置

打开 Emdash，进入 **设置 → 远程访问**。域名不填在这里。

* 打开「允许浏览器访问」。
* 「监听于」选「仅这台电脑」（`127.0.0.1`）。端口保持 `7788`。`cloudflared` 只连本机这个地址。若监听地址停在 ZeroTier 的 `10.126.126.3` 上，公网网址会得到 502。
* 「访问密钥」至少 12 位。两台电脑填同一把。

## 每台电脑自己的隧道

`cloudflared` 是开机自启的后台程序，把该电脑的子域名转到本机 `127.0.0.1:7788`。办公室那台的隧道要在办公室那台电脑上安装并运行，不能由这台 Mac 代跑。

这台 Mac 的配置文件是 `~/.cloudflared/config.yml`，由 `~/Library/LaunchAgents/com.cloudflare.cloudflared.plist` 启动。改域名时把 `ingress` 里的 `hostname` 换成这台电脑的子域名，服务地址保持 `http://127.0.0.1:7788`，然后重新加载这个 LaunchAgent。

办公室那台需要自己的隧道和 DNS，例如：

```bash
cloudflared tunnel create emdash-office
cloudflared tunnel route dns emdash-office office.catchtime.app
```

它的 `config.yml` 使用自己的隧道编号和凭证文件，`hostname` 为 `office.catchtime.app`，`service` 同样是 `http://127.0.0.1:7788`。凭证文件留在那台电脑的 `~/.cloudflared/`，不要放进仓库。

## 手机

在 App 里点「添加电脑」。地址填 `home.catchtime.app` 或 `office.catchtime.app`，不要写 `https://`，也不要写端口。再填访问密钥。密钥会记住，下一台电脑只填地址。
