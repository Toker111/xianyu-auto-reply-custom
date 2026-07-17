# Codex 新会话项目说明

> 快照日期：2026-07-17
> 项目目录：`D:\咸鱼自动化\zzzzzz`
> 当前开发分支：`feature/custom-version`

## 给新会话的使用要求

请先完整阅读本文件，再根据用户的问题查看相关源码和运行状态。本文件只是快照，回答当前状态问题前，应优先执行只读检查，例如 `git status`、端口健康检查和查看相关文件。

安全边界：

- 不要读取、显示、复制或提交密码、Cookie、Token、API Key、密钥等敏感内容。
- 未经用户明确要求，不要修改业务代码，不要登录或操作真实闲鱼账号，不要发送真实消息或执行自动发货、订单操作。
- 不要删除数据库、Docker 数据卷或项目文件；禁止执行 `docker compose down -v`、`git reset --hard` 等破坏性操作。
- 当前工作区有尚未提交的开发修改，必须保留，不能覆盖或回退。
- 如需验证 AI，要求用户在网页配置界面自行输入 API Key，不要让用户把 Key 发到聊天中。

## 项目基本情况

- 原项目：`https://github.com/zhinianboke/xianyu-auto-reply`
- 本地路径：`D:\咸鱼自动化\zzzzzz`
- 开发分支：`feature/custom-version`
- 当前有未提交修改，主要是新增“AI 建议模式”及本地开发配置。
- 原有自动回复功能仍然保留；新功能没有删除原有业务代码。

## 项目结构

- `frontend`：React + TypeScript + Vite 前端，开发地址通常为 `http://localhost:9000`。
- `backend-web`：FastAPI 普通后端，通常监听 `127.0.0.1:8089`。
- `websocket`：连接闲鱼消息、在线聊天和原自动回复相关的 Python 服务，通常监听 `8090`。
- `scheduler`：定时任务、自动发货等相关 Python 服务，通常监听 `8091`。
- `common`：各 Python 服务共用的数据库模型、Schema 和服务代码。
- `docker-compose.dev.yml`：本地开发专用，只运行 MySQL 和 Redis，并开放开发端口。
- `start-dev.ps1` / `stop-dev.ps1`：本地开发环境启动和停止脚本。

本地基础设施开发配置：

- MySQL：Docker 容器 `xianyu-dev-mysql`，宿主机端口 `13306`。
- Redis：Docker 容器 `xianyu-dev-redis`，宿主机端口 `6379`。

MySQL、Redis 此前已经创建并运行过，但新会话应重新以只读命令核对容器当前是否仍在运行。

## 当前运行状态快照

2026-07-17 最后一次检查：

- 前端 `http://localhost:9000` 返回 HTTP 200。
- 后端健康地址 `http://127.0.0.1:8089/health` 返回 HTTP 200。
- 数据库新增表此前已成功创建。
- 为避免真实闲鱼副作用，最近一次 AI 功能开发验证没有主动重启 `websocket` 和 `scheduler`；它们的当前状态需要重新检查。

## 原有主要功能位置

- 账号管理、在线聊天、商品、订单、卡券、自动回复等页面：`frontend/src/pages`。
- 普通后端 API：`backend-web/app/api/routes`。
- 闲鱼消息连接与原自动回复：`websocket/app/services/xianyu`。
- 定时任务与自动发货：`scheduler` 服务及相应公共服务代码。
- 原 AI 自动回复接口：`backend-web/app/api/routes/ai.py`。
- 原 AI 服务配置逻辑：`common/services/ai_provider_service.py`。
- 原 AI 回复引擎：`websocket/app/services/xianyu/ai_reply_engine.py`。

不要把原有“AI 自动回复”与新开发的“AI 建议模式”混为一谈。

## 新增的 AI 建议模式

### 产品目标

账号可以选择三种工作模式：

1. 人工模式：人工处理消息。
2. AI 建议模式：买家消息先经过人工决定是否可以发给 AI；AI 只生成建议回复，必须由人工确认、修改或忽略，不能自动发给买家。
3. AI 自动模式：保留原项目已有能力和入口；本轮开发重点不是重新实现或启用它。

### 买家消息发给 AI 前的交互

- 连续买家消息合并为一个带大边框的消息组。
- 消息组底部统一显示约 4 秒倒计时和三个操作：允许发送给 AI、拒绝、修改后发送给 AI。
- 新买家消息到达同一组时，倒计时重新开始。
- 只有用户打开当前会话时才倒计时；离开会话暂停，再次进入该会话时重置倒计时。
- 进入编辑状态后停止倒计时；编辑期间的新消息进入下一组。
- 倒计时结束表示把该组内容发送给 AI 分析，不表示直接向买家发送消息。
- 用户人工回复后，当前尚未提交 AI 分析的消息组会被取消，但人工回复可以作为后续 AI 上下文。

### AI 建议回复交互

- 同一会话一次只处理一条建议，避免多条建议同时待确认。
- 建议生成后可选择：发送、修改后发送、重新生成、忽略。
- 不论哪种情况，AI 建议都不能未经人工操作自动发送给买家。
- 图片和附件当前不会发给 AI。
- 当前前端提供给 AI 的公开商品信息主要是当前商品标题。

### 上下文和敏感信息

- 只有经过人工允许的买家消息才会作为 AI 可见消息保存。
- 被拒绝内容不会保存原文，只留下“已拒绝/不可见”的占位信息。
- 本地批准历史不设总存储上限。
- 单次 AI 请求使用最近约 5 万字符，并从最近 5000 条已批准历史中检索相关旧内容，相关旧内容最多约 1 万字符。
- 当前是本地关键词相关性检索，不是向量数据库，也没有自动生成长期摘要。
- 本地后端会检测并拦截常见密码、Cookie、Token、Authorization、API Key、Secret、验证码等敏感内容。
- 敏感检测接口只返回风险类型和位置，不应返回敏感原文。
- 可传给 AI 的业务上下文字段被限制为安全白名单，例如商品标题、描述、价格和订单状态。

## AI 连接配置

系统支持全局配置和账号局部配置：

- 全局配置：管理员设置默认 AI 服务和默认建议模式参数。
- 局部配置：单个闲鱼账号可以覆盖全局配置。
- 中转站及其他服务统一通过“OpenAI 兼容接口”接入。
- DeepSeek 使用原生接口，固定基础地址 `https://api.deepseek.com`，当前默认模型为 `deepseek-v4-flash`。
- 只有明确配置时才使用备用连接，不进行隐式切换。
- API Key 由用户在管理页面输入，后端加密保存。
- 查询配置的 API 只返回 `has_api_key` 等状态，不返回原始 API Key。
- 管理员可以新增、编辑和测试连接；测试使用固定安全提示词。

## 新增数据库表

以下表在 2026-07-16 已成功创建，没有删除原数据：

- `xy_ai_connection_profiles`
- `xy_ai_suggestion_account_settings`
- `xy_ai_visible_messages`
- `xy_ai_suggestion_records`

## 新增或主要修改文件

设计说明：

- `docs/AI_SUGGESTION_MODE.md`

后端：

- `backend-web/app/api/routes/ai_suggestion.py`
- `backend-web/app/services/ai_suggestion_service.py`
- `backend-web/app/api/routes/_exports.py`
- `common/models/ai_suggestion.py`
- `common/schemas/ai_suggestion.py`
- `common/models/_exports.py`
- `common/db/init_database.py`

前端：

- `frontend/src/api/aiSuggestion.ts`
- `frontend/src/pages/admin/AISuggestionSettings.tsx`
- `frontend/src/pages/ai-suggestion/`
- `frontend/src/pages/chat-new/ChatNew.tsx`
- `frontend/src/App.tsx`
- `frontend/src/config/navigation.ts`

开发环境：

- `docker-compose.dev.yml`
- `start-dev.ps1`
- `stop-dev.ps1`
- `.gitignore`

## AI 建议 API 概览

统一前缀下包括：

- `GET/POST /api/v1/ai-suggestion/profiles`
- `PUT /api/v1/ai-suggestion/profiles/{id}`
- `POST /api/v1/ai-suggestion/profiles/{id}/test`
- `GET/PUT /api/v1/ai-suggestion/global-settings`
- `GET/PUT /api/v1/ai-suggestion/accounts/{account_id}/settings`
- `POST /api/v1/ai-suggestion/groups/reject`
- `POST /api/v1/ai-suggestion/generate`
- `POST /api/v1/ai-suggestion/records/{id}/action`
- `GET /api/v1/ai-suggestion/records`
- `GET /api/v1/ai-suggestion/records/summary`

查看代码时以 FastAPI 实际 OpenAPI 和路由文件为准。

## 新增页面和入口

- 在线聊天：`/online-chat-new`，账号/会话顶部提供模式和局部设置入口。
- AI 建议记录：`/ai-suggestion-records`。
- 管理员 AI 建议设置：`/admin/ai-suggestion-settings`。

## 已完成验证

- 前端 `npm run build` 已通过，包括 TypeScript 检查和 Vite 构建。
- Python 后端 `compileall` 已通过。
- FastAPI 路由已出现在 OpenAPI 中，未登录访问受保护接口会返回 401。
- 敏感信息检测的 5 类样例均通过拦截测试。
- API Key 加密、解密往返测试通过，测试没有显示密钥内容。
- 数据库新增表创建成功。
- 最后一次检查时前端和后端健康地址均返回 HTTP 200。

未执行的高风险验证：

- 没有使用或读取真实 API Key，因此尚未完成真实 AI 服务端到端调用。
- 没有用真实买家消息验证，也没有发送真实闲鱼消息。
- 没有执行真实登录、自动发货或订单操作。
- 登录后的完整浏览器视觉验收尚未全部完成；当前主要依据构建、接口和代码检查。

## 已知限制和待确认事项

- 用户必须在网页管理界面自行配置 AI 连接和 API Key，才能进行真实建议生成测试。
- 人工卖家回复的待用上下文目前主要保存在前端内存中；刷新页面可能丢失尚未批准并持久化的局部状态。
- 历史上下文检索目前是本地关键词检索，不是语义向量检索。
- AI 自动模式只是保留原有能力，并未在本轮重新实现或主动开启。
- 可选依赖 `DrissionPage` 的警告与本次 AI 建议功能通常无直接关系。
- 所有上述修改目前仍未提交 Git。

## 账号级人工滑块验证模式（2026-07-17 新增）

- 每个闲鱼账号都有独立的 `captcha_manual_mode` 开关，默认关闭。
- UI 位置：`账号管理 → 编辑 → 自动登录设置 → 人工滑块验证模式`。
- 开启后只打开一个可见浏览器，等待用户约3分钟亲自完成官方验证。
- 人工模式不会移动鼠标、滚动页面或自动拖动，并跳过远程、真实鼠标、Playwright 自动拖动和 DrissionPage 兜底。
- 同账号通过原有互斥锁避免多个验证窗口并发。
- 必须检测到官方页面真正放行并产生 `x5sec` 才算成功。
- 关闭后恢复原有验证码流程，不删除账号或浏览器数据。
- 详细说明见 `docs/MANUAL_CAPTCHA_MODE.md`。
- 该模式不能保证平台放行内置 Chromium，也不能用于绕过平台风控。

## 当前会话导出与专业商品上下文（2026-07-17 新增）

- 在线聊天选中买家会话后，聊天区右上角有`导出 Markdown`。
- 导出范围只包含当前打开的单个会话，会继续按游标加载更早历史，完成后按时间顺序生成本机 `.md` 文件。
- AI 建议生成前会读取本地商品目录，优先按商品 ID、其次按标题匹配当前商品。
- 经用户明确同意，本次 AI 请求可以包含当前商品公开的标题、描述和价格；不会包含 Cookie、Token、密码、API Key 或订单隐私。
- 商品目录读取是本地数据库查询，不会为补充 AI 上下文再次抓取闲鱼。
- 专业提示词要求模型用自身知识解释专业问题，但以商品资料为事实，不得编造规格、兼容性、库存、优惠、售后或发货承诺。
- 详细说明见 `docs/CHAT_MARKDOWN_AND_PRODUCT_CONTEXT.md`。
- 开发期使用假数据的`模拟聊天`页面、菜单和路由已按用户要求移除；正式`在线聊天`不受影响。

## 安全启动和停止

在项目根目录执行：

```powershell
.\start-dev.ps1
```

停止本地开发服务：

```powershell
.\stop-dev.ps1
```

启动脚本会启动 MySQL、Redis、后端、WebSocket、Scheduler 和前端。启动前必须再次确认本地配置没有启用真实账号自动连接、自动回复、自动发货、订单操作和定时任务。脚本会尝试禁用数据库中的定时任务，但不能把这一点当作唯一安全保障。

禁止使用：

```powershell
docker compose down -v
```

## 建议新会话先做的只读检查

```powershell
Set-Location 'D:\咸鱼自动化\zzzzzz'
git branch --show-current
git status --short
docker ps
Invoke-WebRequest http://127.0.0.1:8089/health -UseBasicParsing
Invoke-WebRequest http://localhost:9000 -UseBasicParsing
```

如果服务未运行，不要直接启动真实闲鱼相关服务；先检查安全配置和用户本次问题是否确实需要启动。

## 可以复制给新 Codex 会话的话

```text
请先完整阅读 D:\咸鱼自动化\zzzzzz\CODEX_PROJECT_CONTEXT.md 和项目里的 AGENTS.md。先以只读方式核对当前状态，再回答我的问题。不要读取或显示 Cookie、Token、密码、API Key；没有明确要求不要修改代码，也不要启动真实闲鱼自动化。
```
