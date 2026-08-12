# Arch Linux 原生部署

这套方案把莉莉洛和 NapCat 作为两个独立的 systemd 服务运行：

```text
napcat.service (Linux QQ + Xvfb + NapCat)
        │ OneBot v11 反向 WebSocket
        ▼
lililo-bot.service (莉莉洛，监听 127.0.0.1:8300)
        ├── 模型 API
        └── WebUI 127.0.0.1:8400
```

NapCat 不是本项目的 Node.js 依赖，仍需单独安装。systemd 只负责统一启动顺序、重启和日志管理。

## 1. 准备 Linux QQ 和 NapCat

先安装 Linux QQ 28060 或更新版本，再按 NapCat 官方 Linux 方式完成安装。Arch 的无头依赖是：

```bash
sudo pacman -S xorg-server-xvfb
```

本项目安装脚本会再次检查并补齐这个包、Node.js 和 npm，但不会下载或修改 QQ/NapCat。这样可避免自动脚本在 QQ 更新后静默改坏 `/opt/QQ`。

确认以下命令/文件存在：

```bash
command -v qq
command -v xvfb-run
test -f /opt/QQ/resources/app/napcat/napcat.mjs
```

如果使用 NapCat Linux Launcher 等非标准安装方式，`napcat.mjs` 的路径检查可能报警，但不影响安装；此时需要按实际启动命令调整 `napcat.service`。

## 2. 安装服务

在项目目录运行，把用户和 QQ 号换成真实值：

```bash
sudo ./deploy/arch/install.sh --user "$USER" --qq 123456789
```

脚本会：

- 用 pacman 安装 `nodejs`、`npm`、`xorg-server-xvfb`
- 执行 `npm ci --omit=dev`
- 首次创建 `config.json` 和 `/etc/lililo-bot.env`
- 安装 `lililo-bot.service` 与 `napcat.service`
- 保留已经存在的配置和密钥，不自动启动服务

编辑配置：

```bash
sudoedit /etc/lililo-bot.env
nano config.json
```

至少替换 OneBot token、模型 API key、QQ 管理员/白名单/群号。`/etc/lililo-bot.env` 权限为 `0600`，其中的 `ONEBOT_ACCESS_TOKEN` 会覆盖 `config.json` 的同名配置。

## 3. 配置 NapCat

先启动机器人，让反向 WebSocket 有可连接的服务端：

```bash
sudo systemctl start lililo-bot
```

再启动 NapCat 并看登录日志：

```bash
sudo systemctl start napcat
journalctl -u napcat -f
```

NapCat WebUI 默认端口通常为 `6099`，启动日志会输出带 token 的地址。服务器没有桌面时，在本机建立 SSH 隧道：

```bash
ssh -L 6099:127.0.0.1:6099 -L 8400:127.0.0.1:8400 user@server
```

然后在本机浏览器打开 `http://127.0.0.1:6099`，扫码登录 QQ，并在 NapCat 的“网络配置”中新建 **WebSocket 客户端**：

```text
URL: ws://127.0.0.1:8300/ws
Token: 与 /etc/lililo-bot.env 的 ONEBOT_ACCESS_TOKEN 完全一致
消息格式: Array
```

这是反向 WebSocket：NapCat 主动连接莉莉洛，无需再开启 NapCat 的 WebSocket 服务端。

## 4. 开机自启与检查

首次登录及网络配置完成后：

```bash
sudo systemctl enable --now lililo-bot napcat
systemctl status lililo-bot napcat
journalctl -u lililo-bot -f
```

莉莉洛 WebUI 默认只监听服务器本机的 `127.0.0.1:8400`。保持上述 SSH 隧道后，打开 `http://127.0.0.1:8400` 即可本地对话和查看状态。

常用操作：

```bash
sudo systemctl restart lililo-bot napcat
journalctl -u lililo-bot -u napcat --since today
sudo systemctl disable --now lililo-bot napcat
```

## 安全提示

- 不要把 NapCat WebUI、莉莉洛 WebUI 或 8300 端口直接暴露到公网。
- OneBot token 和 WebUI token 使用不同的长随机值。
- 建议先用测试 QQ 号运行；非官方机器人接入存在账号风控风险。
- QQ 更新可能使 NapCat 注入失效，更新后先检查 `napcat.service` 日志。

官方参考：

- [NapCat Linux 半自动安装（含 Arch/Xvfb 与 systemd 示例）](https://napneko.github.io/guide/boot/Shell-Linux-SemiAuto)
- [NapCat Shell/Linux 安装方式](https://napneko.github.io/guide/boot/Shell)
- [NapCat WebUI 配置](https://napneko.github.io/config/basic)
- [OneBot 网络模式](https://napneko.github.io/onebot/network)
