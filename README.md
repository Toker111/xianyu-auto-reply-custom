# 闲鱼自动回复管理系统｜安全人工审核定制版

这是基于开源项目 [zhinianboke/xianyu-auto-reply](https://github.com/zhinianboke/xianyu-auto-reply) 二次开发的定制版本。

本版本重点不是让 AI 不受控制地代替卖家操作，而是在保留账号管理、在线聊天和原有自动化能力的基础上，增加一套可配置、可审核、可拒绝的 **AI 建议工作流**，并强化本地开发和敏感信息保护。

> 本仓库不是上游项目的官方版本。上游功能、部署方式和平台接口可能继续变化，本版本的定制功能以当前仓库代码和本文档为准。



学习交流群，问题反馈群
<img width="326" height="418" alt="image" src="https://github.com/user-attachments/assets/320a82a3-939d-4ab5-b5e3-ec8a9afe3f10" />


## 当前版本重点

### 1. 三种回复模式

每个闲鱼账号可以单独选择：

| 模式 | 行为 |
|------|------|
| 手动模式 | 完全由人工查看并回复，不调用 AI |
| AI 建议模式 | 买家消息先由人工审核是否可以发送给 AI；AI 只生成建议，不直接发送给买家 |
| AI 自动模式 | 保留原项目自动回复能力，风险较高，默认不建议开启 |

AI 建议模式是本定制版本的主要工作方式。

### 2. 发送给 AI 之前先人工审核

买家发来的连续消息会合并成一组，并在会话中用一个整体边框显示。消息组下方提供：

- 倒计时进度条：默认约 4 秒，可在全局或账号设置中调整；
- `✓`：立即批准这一组消息发送给 AI；
- `×`：拒绝发送，这一组原文不会进入 AI 上下文；
- `○`：先修改副本，再将修改后的内容发送给 AI。

只有用户打开对应会话时倒计时才会运行；离开后暂停，再次进入会话时重新计时。

倒计时结束表示“把已审核消息提交给 AI”，不是把回复自动发送给买家。

### 3. AI 建议仍需人工决定

AI 生成结果后只显示为建议卡片，用户可以：

- 直接发送建议；
- 修改后发送；
- 忽略建议；
- 填写补充要求后重新生成。

系统不会因为 AI 已经生成文字就自动发送真实闲鱼消息。

### 4. 本机敏感信息检查

消息正式提交给 AI 之前，后端会在本机检查常见敏感内容，包括：

- 密码、口令；
- Cookie；
- Token、Authorization；
- API Key、Secret；
- 验证码、动态码。

命中后只返回风险类型和消息位置，不把命中的原文写进错误信息。用户可以拒绝发送，或修改副本后重新提交。

这套检查用于降低误传风险，但不能保证识别所有敏感内容。发送前仍应由用户人工确认。

### 5. AI 全局配置与账号局部配置

管理员可以设置全局默认配置，每个闲鱼账号也可以覆盖：

- 工作模式；
- AI 连接配置；
- 消息审核倒计时；
- 回复语气、称呼、长度、表情；
- 自定义提示词。

当前支持：

- DeepSeek 原生接口；
- OpenAI 兼容接口，可用于支持 `/chat/completions` 的中转站或其他服务。

API Key 加密保存，管理页面只显示是否已经配置，不回显完整密钥。

### 6. 更专业的商品问答

生成建议前，系统会从本地商品目录匹配当前会话对应的商品：

1. 优先按商品 ID 精确匹配；
2. 缺少商品 ID 时按商品标题匹配；
3. 匹配成功后，将公开的商品标题、描述和价格作为本次 AI 上下文；
4. 匹配不到时只使用会话已有标题，不猜测商品资料。

专业提示词要求模型使用自身知识解释问题，同时禁止编造商品规格、兼容性、库存、优惠、订单状态、售后政策和发货承诺。

### 7. 当前会话导出 Markdown

在“在线聊天”中打开一个买家会话后，可以点击右上角的 **导出 Markdown**：

- 只导出当前打开的单个买家会话；
- 自动继续读取更早的聊天分页；
- 按时间顺序输出文字和图片链接；
- 文件由浏览器在本机生成，不上传到额外的导出服务。

导出内容可能包含买卖双方主动发送的信息，请作为私人资料保管，不要提交到 Git。

### 8. 每个账号独立的人工滑块模式

账号编辑页面提供“人工滑块验证模式”开关：

- 每个账号独立开启或关闭；
- 开启后使用可见浏览器等待用户亲自完成官方验证；
- 人工模式不自动移动鼠标、不自动拖动滑块；
- 只有检测到官方页面真正放行后才算成功；
- 关闭后恢复原项目原有验证码流程。

该模式不能保证平台一定放行内置 Chromium，也不能用于绕过平台风控。

## 仍然保留的原项目能力

仓库仍包含原项目的大部分模块，例如：

- 多账号管理和 Cookie 维护；
- 在线聊天和消息收发；
- 关键词、图片和默认回复；
- 商品、订单、卡券和自动发货；
- 商品发布、采集、监控和分销；
- 定时任务、通知、日志和后台管理；
- `promotion` 返佣子系统。

其中部分功能会连接真实闲鱼账号、发送消息、操作订单或执行自动发货。没有充分测试前，请保持关闭。

## 安全边界

以下内容不应该提交到 Git：

- 各服务真实 `.env`；
- 闲鱼 Cookie、Token、账号密码；
- AI API Key 和中转站密钥；
- MySQL、Redis 数据和 Docker 数据卷；
- 浏览器用户目录、缓存和登录状态；
- 日志、聊天导出文件和本地备份。

项目 `.gitignore` 已覆盖上述常见路径，但提交前仍应检查：

```powershell
git status --short
git diff --cached
```

即使仓库是私有仓库，也不要提交真实凭据。如果密钥曾经意外提交，应立即在对应平台撤销并重新生成，单纯删除最新文件并不能清除 Git 历史。

## 本地开发环境

当前定制版推荐以下源码开发方式：

| 组件 | 运行方式 | 默认端口 |
|------|----------|----------|
| MySQL | Docker | 3306 |
| Redis | Docker | 6379 |
| Frontend | `npm run dev` | 9000 |
| Backend-Web | Python 虚拟环境 | 8089 |
| WebSocket | Python 虚拟环境 | 8090 |
| Scheduler | Python 虚拟环境 | 8091 |

### 环境要求

- Windows 10/11；
- WSL2 和 Ubuntu；
- Docker Desktop 与 Docker Compose；
- Git；
- Python 3.11+；
- Node.js 18+ 和 npm。

### 下载项目

```powershell
git clone <你的仓库地址>
cd xianyu-auto-reply-custom
git switch feature/custom-version
```

### 配置本地服务

三个 Python 服务分别使用自己的 `.env` 和虚拟环境：

```text
backend-web/.env
websocket/.env
scheduler/.env
```

真实配置文件来自对应 `.env.example`，不得提交到 Git。

前端依赖安装：

```powershell
Set-Location frontend
npm install
```

Python 服务依赖分别安装到：

```text
backend-web/.venv
websocket/.venv
scheduler/.venv
```

## 一键启动开发环境

在项目根目录执行：

```powershell
.\start-dev.ps1
```

启动脚本会：

1. 使用 `docker-compose.dev.yml` 启动 MySQL 和 Redis；
2. 等待 MySQL 健康；
3. 启动三个 Python 服务和 Vite 前端；
4. 强制设置 `AUTO_START_WEBSOCKET=false`，避免启动时自动连接闲鱼；
5. 将数据库内已启用的定时任务关闭。

启动后访问：

- 前端：[http://localhost:9000](http://localhost:9000)
- Backend 健康检查：[http://127.0.0.1:8089/health](http://127.0.0.1:8089/health)
- WebSocket 健康检查：[http://127.0.0.1:8090/health](http://127.0.0.1:8090/health)
- Scheduler 健康检查：[http://127.0.0.1:8091/health](http://127.0.0.1:8091/health)

停止开发环境：

```powershell
.\stop-dev.ps1
```

停止脚本会保留 MySQL、Redis 和 Docker 数据卷。

禁止使用下面的命令，除非你明确知道数据会被永久删除：

```powershell
docker compose down -v
```

## AI 建议配置流程

1. 使用管理员账号进入“AI 建议设置”；
2. 新建 DeepSeek 或 OpenAI 兼容连接；
3. 填写 Base URL、模型名称和 API Key；
4. 点击连接测试；
5. 设置全局默认审核时间和回复风格；
6. 打开“在线聊天”，选择账号；
7. 在聊天区顶部打开账号 AI 设置；
8. 将工作模式设为“AI 建议模式”；
9. 选择继承全局配置或指定账号专用连接；
10. 保存后，再由用户手动连接对应闲鱼账号。

不要使用真实敏感消息做首次测试。建议先用不涉及账号、密码、订单或发货的普通咨询验证流程。

## 项目结构

```text
xianyu-auto-reply-custom/
├── frontend/             # React 前端
├── backend-web/          # 主业务 API 与 AI 建议服务
├── websocket/            # 闲鱼实时连接与消息处理
├── scheduler/            # 定时任务
├── common/               # 共享模型、数据库和公共服务
├── promotion/            # 原项目返佣子系统
├── docs/                 # 定制功能说明
├── docker-compose.dev.yml
├── start-dev.ps1
├── stop-dev.ps1
└── README.md
```

## 开发验证

前端构建：

```powershell
Set-Location frontend
npm run build
```

Python 静态编译检查：

```powershell
Set-Location ..
python -m compileall -q common backend-web websocket scheduler
```

本版本开发过程中已验证前端构建、Python 编译、FastAPI 路由和四个本地健康地址。为保护真实账号，没有由开发助手自动执行真实 AI 调用、闲鱼消息发送、自动发货或订单操作。

## 详细文档

- [AI 建议模式](docs/AI_SUGGESTION_MODE.md)
- [当前会话导出与商品上下文](docs/CHAT_MARKDOWN_AND_PRODUCT_CONTEXT.md)
- [人工滑块验证模式](docs/MANUAL_CAPTCHA_MODE.md)
- [Codex 新会话项目说明](CODEX_PROJECT_CONTEXT.md)

## 常见问题

### Docker Desktop 明明打开了，脚本仍提示无权限

确认 Docker Desktop 左下角显示 `Engine running`。如果终端是在 Docker 启动前打开的，可以关闭终端后重新打开，再执行启动脚本。

### 滑块一直验证失败

在“账号管理 → 编辑 → 自动登录设置”中为该账号开启“人工滑块验证模式”，然后在可见浏览器中亲自完成官方验证。不要频繁重试或尝试绕过平台验证。

### AI 建议没有生成

依次检查：

1. 当前账号是否处于“AI 建议模式”；
2. 是否存在启用的 AI 连接配置；
3. API Key、Base URL 和模型名称是否正确；
4. 消息是否被本机敏感信息检查拦截；
5. Backend-Web 是否健康。

### Markdown 导出没有更早的聊天记录

完整历史需要当前闲鱼账号处于连接状态。如果 IM 服务临时限流，页面会停止导出并提示稍后重试，不会把不完整文件伪装成完整导出。

### 如何确认没有自动运行任务

除了检查账号连接状态，还应确认“定时任务”页面没有启用任务。开发启动脚本会尝试关闭任务，但不能代替人工检查。

## 上游项目与许可证

本项目基于：

- [zhinianboke/xianyu-auto-reply](https://github.com/zhinianboke/xianyu-auto-reply)

并参考了上游 README 中列出的其他开源项目。

本仓库继续遵循 [GNU Affero General Public License v3.0](LICENSE)。修改或对外提供网络服务时，请同时遵守 AGPL-3.0 和上游项目的版权声明。

## 免责声明

本项目仅用于学习、研究和在合法授权范围内管理自己的账号。使用者应自行遵守闲鱼平台规则、相关法律法规以及 AI 服务商条款。

- 不要登录或操作不属于自己的账号；
- 不要发送欺诈、骚扰或违法消息；
- 不要绕过验证码、平台风控或访问控制；
- 不要在未核实的情况下自动发货或修改订单；
- 自动化和第三方接口可能导致账号限制、数据错误或额外费用，风险由使用者自行承担。
