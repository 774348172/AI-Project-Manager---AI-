# 白泽 Baize Local Hub

白泽是一个本地优先的 AI 工作中枢项目，包含 Node.js 服务端和 Windows Electron 桌面客户端。它把 Claude Code、本地记忆、逻辑断言、插件调用、Jira 操作确认、客户端更新等能力整合到一个可本地部署的工作台里。

本仓库是公开源码版本，不包含任何私有 API Key、Jira Token、聊天记录、上传文件、运行时记忆附件或打包产物。

## 核心能力

- 本地桌面聊天客户端
- 服务端控制面和同步接口
- Claude / Claude Code 接入
- 本地记忆区：浅层记忆与深层记忆
- 逻辑断言与规则上下文
- 插件系统：Jira、企业微信等
- Jira 创建确认卡与本地 Claude Code 执行流程
- 文件拖拽、附件上传和图片记忆流程
- Windows Electron 打包与客户端更新接口

## 技术栈

- Node.js / CommonJS
- Express
- Electron
- electron-builder
- Vitest
- Anthropic SDK / Claude Code npm package
- YAML 配置

## 目录结构

```text
.
├── baize/                 # 白泽知识、规则、配置、插件和运行目录
│   ├── config/            # 配置模板与本地配置文件位置
│   ├── logic/             # 逻辑断言、规则和角色说明
│   ├── memory/            # 浅层/深层记忆结构与策略
│   ├── runtime/           # 运行时目录，公开仓库不提交真实运行数据
│   └── skills/            # 插件/技能配置与说明
├── client/desktop/        # Electron 桌面客户端
├── docs/                  # 项目文档
├── src/                   # Node.js 服务端代码
├── tests/                 # Vitest 测试
├── package.json           # 依赖、脚本和 Electron 打包配置
└── README.md
```

## 环境要求

建议环境：

- Node.js 20 或更高版本
- npm
- Windows 10/11，用于桌面端打包和运行
- 可用的 Claude / Claude Code 配置
- 可选：Jira 账号和 API Token，用于 Jira 插件

## 安装依赖

```bash
npm install
```

## 配置

公开仓库不会提交真实配置。首次运行前，请根据示例文件创建本地配置。

### Claude Code 配置

复制示例：

```bash
cp baize/config/claude-code.example.yaml baize/config/claude-code.yaml
```

然后按需填写：

```yaml
enabled: true
command: claude
timeoutMs: 300000

# 可选：如果你需要让服务端下发 Claude Code 运行环境
# env:
#   ANTHROPIC_BASE_URL: ""
#   ANTHROPIC_API_KEY: ""
```

不要把真实 API Key 提交到 GitHub。

### Jira 配置

如果需要使用 Jira 插件，复制示例：

```bash
cp baize/config/jira.example.yaml baize/config/jira.yaml
```

然后填写你自己的 Jira 地址、认证方式、默认项目和默认问题类型。

### 客户端版本配置

客户端更新配置位于：

```text
baize/config/client-version.yaml
```

如果你要搭建自己的更新服务器，需要把更新地址改成你自己的服务地址，并重新打包客户端。

## 启动服务端

```bash
npm start
```

默认服务端地址：

```text
http://127.0.0.1:3000
```

可检查健康状态：

```bash
curl http://127.0.0.1:3000/health
```

## 启动桌面客户端

开发模式：

```bash
npm run desktop:dev
```

或：

```bash
npm run desktop
```

桌面客户端默认连接本机服务端。客户端运行后可以进行聊天、文件拖拽、Jira 操作确认、记忆写入等操作。

## 运行测试

```bash
npm test
```

也可以只运行部分测试：

```bash
npm test -- tests/desktop-api.test.js tests/desktop-local-runtime.test.js
```

## 打包 Windows 客户端

目录打包：

```bash
npm run desktop:pack
```

生成 NSIS 安装包：

```bash
npm run desktop:dist
```

打包产物默认输出到：

```text
dist/desktop
```

公开仓库不提交 `dist/`。

## 客户端更新发布

如果你要使用内置更新机制，需要：

1. 执行：

   ```bash
   npm run desktop:dist
   ```

2. 将以下产物复制到你配置的更新目录：

   ```text
   latest.yml
   白泽.exe
   白泽.exe.blockmap
   ```

3. 确认服务端 `/client/version` 返回新版本。

示例检查：

```bash
curl "http://127.0.0.1:3000/client/version?platform=windows&version=0.0.1"
```

## 插件说明

当前项目包含插件相关代码和配置结构，主要包括：

- Jira 插件：查询、导入草稿、确认卡、创建执行、失败恢复
- 企业微信插件：Webhook 接入结构
- 本地 Claude Code 插件桥：由客户端确认权限后执行本机插件操作

Jira 写操作不是直接静默执行，而是会先生成客户端确认卡。用户确认后，再由本机 Claude Code 根据 Jira 返回结果分步执行。

## 记忆系统说明

白泽的记忆系统分为：

- 浅层记忆：保存摘要、索引和快速回忆内容
- 深层记忆：保存完整分析、附件副本和详细材料

公开仓库只保留结构、策略和空索引，不包含真实运行记忆。

## 安全说明

请不要提交以下内容：

- API Key
- Jira Token / 密码
- 企业微信密钥
- 本机路径和个人目录
- 上传文件
- 聊天记录
- 运行时操作记录
- 打包产物
- `node_modules`

本仓库 `.gitignore` 已默认排除这些内容，但提交前仍建议自行搜索确认。

## 常见问题

### 为什么仓库体积很小？

因为公开仓库只包含源码、测试和文档，不包含依赖、安装包、运行数据和私有配置。依赖可以通过 `npm install` 恢复，安装包可以通过 `npm run desktop:dist` 重新生成。

### 下载后能直接运行吗？

可以运行基础服务，但完整 AI/Jira 能力需要你自己填写 Claude Code 和 Jira 配置。

### Claude Code 是否包含在仓库中？

仓库不会提交 Claude Code 可执行产物，但 `package.json` 已声明依赖。执行 `npm install` 后会安装对应 npm 包，Electron 打包时也会把依赖打进客户端。

## License

请根据你的发布计划补充 License 文件。
