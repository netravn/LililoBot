# LililoBot

一个原创的轻量 QQ AI 机器人。项目借鉴成熟 Agent 项目的分层思想，但名称、人格、提示词和产品表达均独立设计。NapCat 负责登录 QQ，本项目通过 OneBot v11 反向 WebSocket 接收事件和发送消息。

## 已实现

- OneBot v11 反向 WebSocket 接入和 access token 鉴权
- 私聊白名单、群聊白名单
- 群聊 `@机器人` 和关键词触发
- 私聊、群聊、Bot 账号三级会话隔离
- 每个 QQ 用户拥有独立的一对一私聊上下文
- 同一会话串行、不同会话并行
- OpenAI Chat Completions 兼容接口
- 默认使用 OpenCode Zen 的限时免费 DeepSeek 模型
- JSON 文件持久化会话历史和历史窗口裁剪
- 引用回复和群聊 `@发送者`
- `/ping`、`/help`、`/reset`
- OneBot 数组消息及 CQ Code 字符串消息解析
- 内置 WebUI 控制台
- WebUI 本地对话、新建会话与历史续聊
- 终端 REPL 和一次性 `ask`
- OneBot/模型状态、连接账号和运行时间
- 会话查看与重置
- SSE 实时日志
- 脱敏配置查看
- WebUI 修改模型 API URL、模型和 API Key，保存后热更新
- 模型连接测试与 401、429、超时等错误提示
- 暗中观察模式：静默记录全部或指定群的普通消息
- 内置定时分析器，为每个群生成独立阶段摘要
- WebUI 管理观察范围、分析周期、原文保留期与手动分析

## 架构

```text
NapCat / QQ
  -> platform/onebot      协议、鉴权、API echo、发送消息
  -> core/trigger         白名单和触发判断
  -> core/bot             命令及 Agent 编排
  -> services/openai      模型适配器
  -> store                会话持久化
  -> services/group-observer + observation-store
                          群消息静默归档、定时摘要（与 Agent 记忆隔离）
  -> webui + web          本地控制台和管理 API
```

## 启动

要求 Node.js 20 或更新版本。

```bash
npm install
cp config.example.json config.json
```

编辑 `config.json`：

- 把 `adminUsers`、`privateAllowlist` 和 `allowedGroups` 换成真实 QQ 号/群号
- 设置 `onebot.accessToken`
- 默认配置可以直接使用；如需更稳定的服务，可替换 `llm.baseUrl`、`llm.apiKey` 和 `llm.model`

密钥也可以只放环境变量：

```bash
export ONEBOT_ACCESS_TOKEN='...'
export OPENAI_API_KEY='public'
export OPENAI_BASE_URL='https://opencode.ai/zen/v1'
export OPENAI_MODEL='deepseek-v4-flash-free'
npm start
```

默认模型通过 OpenCode Zen 的 OpenAI 兼容接口提供，无需申请 DeepSeek 官方 API Key。免费模型属于第三方限时公共服务，可能调整、限流或下线；生产部署建议在 `config.json` 或上述环境变量中配置自己的模型服务。

启动后打开：

```text
http://127.0.0.1:8400
```

WebUI 默认只监听本机。如果把 `webui.host` 改成 `0.0.0.0`，必须同时设置长随机的 `webui.accessToken` 或环境变量 `WEBUI_ACCESS_TOKEN`。控制台不会返回模型 API Key 或 OneBot Token 明文。

“模型设置”可以修改 OpenAI 兼容 API URL、模型、API Key、Temperature 和超时，并在保存前测试连接。API Key 只可写入，不会从服务端回显；留空会保留当前 Key。保存内容立即用于后续对话，同时写入已被 Git 忽略的 `config.json`。如果某项由 `OPENAI_*` 环境变量控制，页面会将其标记为只读。

控制台首页可以直接和莉莉洛对话。网页使用独立的 `local:web:<会话ID>` 上下文，不会读取或写入 QQ 会话。点击“新对话”会创建新的网页会话，旧会话仍可在会话管理中查看或重置。

## 暗中观察

观察模式在 OneBot 消息进入后、触发词判断前运行，因此无需 `@机器人` 就能记录群内普通消息，但全程不会向 QQ 发送回复。原始记录按群号和日期写入 `data/observations/messages/`，模型摘要写入 `data/observations/summaries/`；它们不会进入莉莉洛的聊天上下文。

示例配置默认启用并观察 Bot 已加入的全部群：

```json
"observation": {
  "enabled": true,
  "allGroups": true,
  "groups": [],
  "analysisIntervalMinutes": 360,
  "retentionDays": 30,
  "minMessages": 10,
  "maxMessagesPerAnalysis": 500
}
```

如只观察指定群，把 `allGroups` 改为 `false` 并在 `groups` 中填写群号。所有配置均可在 WebUI 的“暗中观察”区域热更新，也可手动对全部或单个群立即生成摘要。自动分析不足 `minMessages` 时会跳过；手动分析只要存在消息就会执行。模型失败只写后台日志，不会把错误发进 QQ。

群聊记录可能包含个人信息。部署前应取得群成员知情同意，限制 WebUI 访问，并根据用途设置尽可能短的 `retentionDays`；不要用摘要做敏感属性推断或自动化处罚决定。

## 终端对话

需要先保持机器人服务运行，然后打开另一个终端：

```bash
npm run chat
```

REPL 支持 `/new`、`/reset` 和 `/exit`。终端上下文使用 `local:cli:*`，与网页及 QQ 隔离。

一次性提问不会保存历史：

```bash
npm run ask -- "介绍一下你自己"
```

## NapCat 配置

在 NapCat 中添加 OneBot 11 **反向 WebSocket客户端**：

```text
URL: ws://运行本项目的主机:8300/ws
Token: 与 onebot.accessToken 相同
消息格式: Array
```

默认只接受同一台机器上的 NapCat 连接。如果 NapCat 与机器人不在同一台机器，需要把 `onebot.host` 改成可访问的监听地址；同时确认防火墙只允许可信来源访问 8300 端口，并且一定要设置长随机 token。

### Arch Linux 部署

项目提供了 Arch Linux 原生部署方案，包括 Xvfb 无头 QQ、NapCat 与机器人两个 systemd 服务、安装脚本、SSH 隧道登录和开机自启说明：

```bash
sudo ./deploy/arch/install.sh --user "$USER" --qq 123456789
```

NapCat 仍是单独安装和升级的组件，但会由 `napcat.service` 与 `lililo-bot.service` 统一编排。完整步骤见 [deploy/arch/README.md](deploy/arch/README.md)。

## 私聊

`qq.allowPrivate` 为 `true` 时支持单独对话。`privateAllowlist` 非空时，只有名单中的 QQ 用户可以私聊机器人；设为空数组则允许所有私聊用户。每个用户、群聊和 Bot 账号使用不同的会话键，因此上下文不会互相混用。

## 测试

```bash
npm test
```

## 下一阶段

这个版本先保持小而可运行。后续适合按顺序增加：

1. 流式模型输出和长消息切分
2. 图片输入及引用图片读取
3. Tool Registry 和安全权限层
4. SQLite 存储、限流和审计日志
5. 可写配置表单、消息历史插件、主动回复判断和群管理工具
