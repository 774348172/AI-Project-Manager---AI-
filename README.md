# 白泽 Baize AI Project Manager

白泽是一个本地优先的 AI 项目管理与研发助手系统，包含 Node.js 服务端、Windows Electron 客户端和 Android 手机客户端。服务端统一承载 Claude / Claude Code、Jira、企业微信、语音识别、记忆系统、插件网关和客户端更新能力；Windows 与 Android 客户端作为轻量入口，负责登录、聊天、确认操作和移动端交互。

本仓库是用于 GitHub 上传的源码版本，不包含私有密钥、Jira Token、聊天记录、上传文件、运行时数据、客户端安装包或构建产物。

## 核心能力

- 统一账号体系：Windows 与 Android 共用用户名/密码登录和注册。
- AI 聊天入口：服务端统一处理 Claude / Claude Code 请求。
- 流式回复：支持 `/chat/stream` SSE 流式输出，并带有服务端活动状态和心跳。
- 移动端聊天：Android 支持文字输入、语音输入、微信风格聊天界面和断线 fallback。
- 账号级 Jira 默认配置：默认项目与 Jira 用户名跟随白泽账号保存在服务端。
- Jira 插件：支持查询、导入草稿、确认卡、创建执行和失败恢复流程。
- 工程级需求完成功能：服务端和桌面端具备需求完成执行链路基础能力。
- 插件网关：插件写操作经过 Claude Code、本地确认与审计流程。
- 本地记忆系统：包含浅层记忆、深层记忆、规则和逻辑断言结构。
- 附件与图片记忆：支持客户端上传附件并进入服务端分析/记忆流程。
- 客户端更新：支持 Windows 安装包更新和 Android APK 自动更新。
- 语音识别：Android 录音上传服务端，由服务端接入讯飞语音识别。
- 固定域名接入：客户端默认连接固定服务地址，可配合 Cloudflare Tunnel 暴露本地服务。

## 技术栈

- Node.js / CommonJS
- Express
- Electron
- Native Android Java
- Gradle / AndroidX
- Vitest
- Anthropic SDK / Claude Code npm package
- WebSocket / SSE
- YAML 配置

## 目录结构

```text
.
├── baize/                 # 白泽配置、规则、记忆、插件和运行目录
│   ├── config/            # 配置模板与本地配置文件位置
│   ├── logic/             # 逻辑断言、规则和角色说明
│   ├── memory/            # 浅层/深层记忆结构与策略
│   ├── runtime/           # 运行时目录，公开仓库不提交真实数据
│   └── skills/            # 插件/技能配置与说明
├── client/
│   ├── desktop/           # Windows Electron 客户端
│   └── android/           # Android 手机客户端
├── docs/                  # 项目文档
├── src/                   # Node.js 服务端代码
├── tests/                 # Vitest 测试
├── package.json           # 依赖、脚本和桌面端打包配置
└── README.md
```

## 环境要求

建议环境：

- Node.js 20 或更高版本
- npm
- Windows 10/11，用于桌面端运行和打包
- Android Studio / Android SDK，用于 Android 客户端构建
- JDK 17 或 Android Studio 自带 JBR
- 可用的 Claude / Claude Code 配置
- 可选：Jira 账号和 API Token
- 可选：讯飞开放平台语音识别配置
- 可选：Cloudflare Tunnel 或其他公网代理服务

## 安装依赖

```bash
npm install
```

## 配置说明

公开仓库不会提交真实配置。首次运行前，请根据示例文件创建本地配置。

### Claude Code 配置

```bash
cp baize/config/claude-code.example.yaml baize/config/claude-code.yaml
```

按需填写 Claude Code 启动命令、超时时间和环境变量。不要把真实 API Key 提交到 GitHub。

### Jira 配置

```bash
cp baize/config/jira.example.yaml baize/config/jira.yaml
```

填写 Jira 地址、认证方式、默认项目等信息。账号级 Jira 默认项目和 Jira 用户名会通过白泽账号接口保存，不需要写入客户端本地代码。

### 企业微信配置

```bash
cp baize/config/wecom.example.yaml baize/config/wecom.yaml
```

用于企业微信 Webhook 或相关集成。

### 语音识别配置

```bash
cp baize/config/speech.example.yaml baize/config/speech.yaml
```

如果使用讯飞语音识别，请只在本地 `speech.yaml` 或环境变量中填写 `appId`、`apiKey`、`apiSecret`。Android 客户端不会内置讯飞密钥，录音会上传到服务端由服务端识别。

### 客户端版本配置

```text
baize/config/client-version.yaml
```

用于控制 Windows 和 Android 客户端更新。公开仓库可以保留示例配置，但真实安装包、APK、`latest.yml`、blockmap 不应提交。

## 启动服务端

```bash
npm start
```

默认服务端地址：

```text
http://127.0.0.1:3000
```

健康检查：

```bash
curl http://127.0.0.1:3000/health
```

如果使用 Cloudflare Tunnel 或反向代理，需要把公网域名转发到本地 `http://localhost:3000`。

## 启动 Windows 客户端

开发模式：

```bash
npm run desktop:dev
```

普通启动：

```bash
npm run desktop
```

桌面客户端支持登录注册、聊天、附件上传、Jira 操作确认、插件权限确认、账号级 Jira 默认配置和客户端更新检查。

## 打包 Windows 客户端

目录打包：

```bash
npm run desktop:pack
```

生成安装包：

```bash
npm run desktop:dist
```

打包产物默认输出到：

```text
dist/desktop
```

公开仓库不提交 `dist/` 和 Windows 更新包。

## 构建 Android 客户端

Android 工程目录：

```text
client/android
```

使用 Android Studio 打开该目录，或使用 Gradle 构建：

```bash
JAVA_HOME="D:/Android/jbr" PATH="D:/Android/jbr/bin:$PATH" "D:/zenghaorang/Robot_BaiZe/client/android/gradlew" -p "D:/zenghaorang/Robot_BaiZe/client/android" assembleDebug
```

请按本机实际 JDK/JBR 路径调整 `JAVA_HOME`。

APK 输出通常在：

```text
client/android/app/build/outputs/apk/debug/app-debug.apk
```

公开仓库不提交 Android 构建目录和 APK。

## Android 自动更新

Android 客户端会请求：

```text
GET /client/version?platform=android&version=<当前版本>
```

当服务端返回新版 APK 地址后，客户端下载 APK 到缓存目录，并通过 Android `FileProvider` 发起安装。手机需要允许该应用安装未知来源应用。

服务端更新目录示例：

```yaml
android:
  updateDir: "baize/client-updates/android"
  apk: "baize-mobile-0.1.5.apk"
```

`baize/client-updates/` 是发布目录，不应提交到公开仓库。

## 运行测试

运行全部测试：

```bash
npm test
```

运行部分测试示例：

```bash
npm test -- tests/api.test.js tests/desktop-api.test.js
```

## 主要接口

- `GET /health`：服务健康检查。
- `POST /auth/register`：注册白泽账号。
- `POST /auth/login`：登录白泽账号。
- `GET /auth/me`：获取当前账号信息。
- `PATCH /auth/me/jira-defaults`：保存账号级 Jira 默认项目和 Jira 用户名。
- `POST /chat`：普通聊天请求。
- `POST /chat/stream`：SSE 流式聊天请求。
- `POST /speech/transcribe`：Android 录音上传识别。
- `GET /client/version`：客户端版本检查。
- `GET /client-updates/:platform/:fileName`：客户端下载更新文件。
- `POST /plugins/jira/search`：Jira 查询。
- `POST /plugins/jira/import-drafts`：Jira 草稿导入。
- `POST /plugins/engineering/requirement-completion/...`：工程级需求完成功能。

## 安全与提交说明

请不要提交以下内容：

- Claude / Anthropic API Key
- 讯飞 `appId`、`apiKey`、`apiSecret`
- Jira Token / 密码
- 企业微信密钥
- `.env` 文件
- 本机私有路径和个人配置
- 聊天记录
- 上传附件
- 运行时操作记录
- 客户端安装包、APK、blockmap、`latest.yml`
- `node_modules`
- `dist/`、`build/`、Android `build/` 目录

本仓库 `.gitignore` 已排除常见敏感文件和运行时目录，但上传 GitHub 前仍建议检查 `git status` 和提交 diff。

## 更新日志

### 2026-06-08

- 新增 Android 手机客户端，支持登录注册、聊天、文字输入、语音输入和自动更新。
- Android 客户端改为固定服务地址，默认连接 `https://baize.baizerobotai.site`。
- Android 聊天页改为微信风格 UI：灰色背景、左右气泡、底部输入栏、发送按钮和麦克风按钮。
- Android 语音输入改为录音上传服务端识别，讯飞密钥只保存在服务端配置中。
- 新增服务端 `/speech/transcribe`，支持讯飞开放平台 WebSocket 语音识别。
- 新增 Android 自动更新链路：版本检查、APK 下载、下载进度显示和安装跳转。
- 新增 Android 更新包发布配置，当前移动端版本为 `0.1.5`。
- 优化 Android 下载新版客户端时的进度提示。
- 隐藏 Android 聊天页空闲状态下的“已连接”提示。
- 将 Android 语音按钮移动到发送按钮旁边，并改为麦克风图标。
- Android 聊天请求改为优先使用 SSE 流式接口，断线时回退到普通 `/chat`。
- 服务端 `/chat/stream` 新增活动状态事件和心跳，降低移动网络/Cloudflare 断连概率。
- 新增账号级 Jira 默认配置：默认项目和 Jira 用户名跟随白泽账号存储在服务端。
- Windows 与 Android 客户端均可设置账号级 Jira 默认配置。
- 新增服务端认证接口和账号信息接口，支持 Windows/Android 共用登录体系。
- 新增工程级需求完成功能的服务端状态机、路由、桌面端 API 和测试。
- 客户端默认服务域名迁移到固定 Cloudflare Tunnel 域名。
- 客户端更新接口支持按平台返回 Windows/Android 更新信息。
- 清理 GitHub 输出目录中的运行时数据、聊天记录、上传附件、安装包和私有配置。

### 早期版本

- 搭建 Node.js 服务端和 Electron Windows 客户端基础结构。
- 接入 Claude / Claude Code 服务端聊天能力。
- 建立白泽本地记忆、逻辑断言、规则和插件目录结构。
- 接入 Jira 查询、草稿导入、确认卡和失败恢复流程。
- 接入企业微信 Webhook 相关结构。
- 支持 Windows 客户端打包和更新检查。
- 支持附件上传、图片分析和记忆写入流程。

## License

请根据你的发布计划补充 License 文件。
