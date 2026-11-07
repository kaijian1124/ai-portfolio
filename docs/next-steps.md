# 接下来：完成配置与上线

代码在 `C:\Users\User\OneDrive\Desktop\Project\Online_Resume`。这一轮已经实现公开网站、完整内容后台、文件管理、AI 问答、持久化处理队列、监控、评估工具和部署配置。还没有创建 GitHub remote、推送、部署或替你执行新的线上 SQL；付费 OpenAI 调用也没有执行。

## 1. 先执行剩余 SQL，一次即可

你已经执行了 `202611060001_public_content.sql` 和 `202611060002_profile_editing.sql`，管理员也已经加入。**不要重跑这两个文件，也不要再创建管理员。**

在 Supabase SQL Editor 新建 query，把 `supabase/setup-remaining.local.sql` 全文复制进去执行。这个本地汇总文件把新的三个 migration 放在同一个 transaction 中：

1. `202611070001_catalog.sql`：项目、技能、经历、学历、Resume、知识库、图片、审计和版本控制。
2. `202611070002_ai_storage.sql`：文档版本、任务租约、pgvector、聊天预算/会话/反馈、监控和评估报告。
3. `202611070003_buckets.sql`：两个私有文件桶与一个公开图片桶。

成功后刷新后台。Profile 原有内容和原有审计不会被覆盖。若失败，整个汇总事务回滚；保留错误信息再排查，不要连续重复执行成功过的脚本。以后新增 migration 用新文件，已上线的 migration 不再修改。

## 2. 本地填好服务端配置

修改 `backend/.env`：保留已有 URL、publishable key、ADMIN_USER_ID，补 `SUPABASE_SECRET_KEY` 和 `OPENAI_API_KEY`。Supabase secret key 在项目 API Keys 页获取，OpenAI key 在你自己的 API 项目创建。不要把密钥贴进聊天。

修改 `frontend/.env.local`：补 `SUPABASE_SECRET_KEY`，用于公开 Resume 下载的短期链接签名。**变量名不能加 NEXT_PUBLIC_**。Next.js 服务端需要这个 key，浏览器不会收到它。publishable key 可以在浏览器出现，它只配合 RLS 读取公开内容；secret key 绝不能这样使用。

本地已生成随机 `CHAT_PROXY_SECRET` 和 `CHAT_SESSION_SECRET`，没有输出值。前后端的 `CHAT_PROXY_SECRET` 必须相同。会话密钥只给后端，修改会使既有聊天 cookie 失效。

AI 预算默认都是 0，表示关闭收费操作。你决定开销后才设置：

```dotenv
CHAT_DAILY_BUDGET_USD=0.50
INGESTION_DAILY_BUDGET_USD=0.10
```

上面只是配置示例，代码没有自动替你开启这个金额。两个预算独立，以 UTC 日为边界；它们是本应用的估算保护，不是供应商账户总账限额。OpenAI 项目也应单独设预算提醒。更换模型时必须同时更新价格配置，不能继续沿用旧单价。

## 3. 重启本地服务并验证

终端一：

```powershell
cd C:\Users\User\OneDrive\Desktop\Project\Online_Resume\backend
uv run uvicorn app.main:app --reload --env-file .env --host 127.0.0.1 --port 8000
```

终端二：

```powershell
cd C:\Users\User\OneDrive\Desktop\Project\Online_Resume\frontend
npm run dev
```

在 `/admin` 依次新增技能、项目、学历和经历。草稿只在后台显示；发布后公共页面即时读取，无需 redeploy。保存失败且结果不确定时，表单保留输入，用同一 request ID 重试；版本冲突需要重新读取，避免覆盖另一个编辑结果。

上传 Resume PDF 后，在 Resume 列表选择 Activate Resume。旧版本保留，可重新激活。知识文档上传后仅进入队列，**不会自动获得公开 AI 使用权限**。当前网页上传统一最多 **4 MB**，PDF 最多 300 页；这是为了留在 Vercel Functions 请求体上限之内。超过限制先压缩/拆分，未来可加入直传 Storage 以支持更大文件。

本地先手动运行处理器：

```powershell
cd C:\Users\User\OneDrive\Desktop\Project\Online_Resume\backend
uv run --env-file .env python -m app.worker --max-jobs 3
```

处理完成后打开文档编辑页，确认内容可公开，再勾选 Approved for public AI answers。替换文件会撤销批准；再次处理并审核后才能公开。相关项目未发布时，其文档不会进入检索。扫描 PDF 不支持内置 OCR；先自行 OCR 后再上传。文档提取文本会发给 OpenAI 做 embeddings，原始知识文件保留私有。

在 `/chat` 测试英语、中文、追问、缺资料拒答和来源链接，再看 `/admin/monitoring`。先测一个小文档即可，避免一次性导入大量资料。health ready 只表示 API 已启动，不等于密钥、数据库 migration 或 AI 已配置正确。

## 4. GitHub 仓库与后台处理

创建 GitHub repo 后再填 remote。先检查待提交文件，确认 `.env`、`.env.local`、本地 SQL 与测试输出均被忽略。仓库目前没有远程地址，也没有自动替你提交或推送。

GitHub Settings → Secrets and variables → Actions：

| 类型 | 名称 | 内容 |
|---|---|---|
| Secret | SUPABASE_URL | 项目 URL |
| Secret | SUPABASE_SECRET_KEY | 服务端 secret key |
| Secret | OPENAI_API_KEY | 你的 API key |
| Variable | INGESTION_DAILY_BUDGET_USD | 你决定的每日索引预算；缺省 0 |

`.github/workflows/ingestion.yml` 每小时 UTC 第 17 分钟检查队列，并支持 Actions 页面手动 Run workflow。每轮最多处理三个任务，任务在 PostgreSQL 中持久保存。**它用于文档处理与保留期清理，不是定时唤醒 Render。**

需要上传后立即触发时，给 Render 配置 `GITHUB_REPOSITORY=owner/repo` 和 `GITHUB_ACTIONS_TOKEN`。PAT 只授权此仓库、Actions write，默认分支用 `GITHUB_DEFAULT_BRANCH=main`；不要给浏览器。未配置时上传依然排队，等待下一次定时或手动处理。GitHub schedule 可能延迟或跳过，公开仓库长期不活跃还可能停用；私有仓库需要留意 Actions minutes。它是低成本初期方案，不是实时 worker SLA。[GitHub schedule 文档](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)

## 5. Render

连接同一个 GitHub repo，用根目录 `render.yaml` 创建 Blueprint（也可手动 Web Service → Docker，Root Directory=`backend`，Dockerfile=`./Dockerfile`）。Free，health path `/health/live`。不需要你电脑保持开机。

填入 `backend/.env.example` 所列生产环境变量，`APP_ENV=production`。Render 的 `CHAT_PROXY_SECRET` 要复制同一值给 Vercel；`CHAT_SESSION_SECRET` Blueprint 会生成。`ALLOWED_ORIGINS` 填精确 Vercel 正式域名，多个用英文逗号，不用 `*`。预算起初保留 0，完成验证再自行开启。

只在 Render 中配置预算无法改变 GitHub worker 的环境；索引预算还需要设置前面提到的 GitHub Variable。Render 暂存磁盘不保存任务或文件，重启不会丢失数据库队列。Free 会休眠、冷启动且无独立免费 worker，公开页面不依赖 Render；聊天会显示连接状态并有限重试，访客不会被 redirect。[Render Free 限制](https://render.com/docs/free) · [Blueprint 字段](https://render.com/docs/blueprint-spec)

## 6. Vercel

Import 同一个仓库，Framework=Next.js，Root Directory=`frontend`。将 `frontend/.env.example` 的变量逐个放入 Environment Variables：

- NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY：沿用已有配置。
- NEXT_PUBLIC_API_BASE_URL：Render 的 `https://...onrender.com`，不要结尾加 `/api`。
- NEXT_PUBLIC_SITE_URL：正式 Vercel 域名，用于 sitemap/robots。
- ADMIN_USER_ID：现有管理员 UID。
- SUPABASE_SECRET_KEY：仅服务端，给私有 Resume 的公开活动版本生成 60 秒链接。
- CHAT_PROXY_SECRET：与 Render 相同。

更新 NEXT_PUBLIC_ 变量需要重新部署。Supabase Auth 的 Site URL 配置成正式网站地址，保持关闭公开 signup 和匿名 Auth。Preview 环境使用独立变量；不需要给每一个临时域名增加 CORS，因为只有 health 从浏览器直连 API。正式域名变更时更新站点 URL/CORS 再 redeploy。

Vercel 上载荷限制按请求整体计算，所以文件限 4 MB，前端还会预先校验；这不是通过增加 maxDuration 就能解决的限制。[Vercel Functions 限制](https://vercel.com/docs/functions/limitations)

## 7. 上线后的验收

确认所有内容发布/撤回、删除/还原、Resume 下载、私有文件登录保护、上传/处理/批准、替换后重新审批、中文追问、缺资料拒答、来源撤回、预算 0 拒绝 AI 调用、监控与反馈均工作。观察 GitHub worker/retention 至少成功一轮，再认定定时任务已接通。

当前 AI 回答通过 SSE 传输状态与最终答案；答案在完整生成并验证引用 ID 后一次显示，**没有逐 token 输出**。引用存在不等于内容事实正确，必须用真实资料评估。当前实现不含 OCR、重排序模型、Langfuse、外部 MCP server 或无限自主 Agent；这些不是基本功能的必要依赖，后续应根据实测效果决定。

浏览器自动测试代码已加入 CI。本机 Chromium 进程无法启动（spawn UNKNOWN），因此本机没有完整 E2E 通过记录；内置浏览器检查和组件测试是补充验证，不能替代上线验收。Docker daemon 本机未运行，镜像尚未实际 build；Render 首次 build 也需要验收。

## Resume 只新增导入（新增 migration）

已有项目执行一次 `supabase/migrations/202611070004_resume_import.sql`。这是新 migration，不要重跑前面已经成功执行的脚本或旧汇总。

上传 Resume 后会进入 AI 分析与候选预览；旧 Resume 可从其编辑页点击 Analyze Resume and preview additions。分析会把提取的 Resume 文本发送到 OpenAI，计入 `CHAT_DAILY_BUDGET_USD`，默认关闭的线上预算必须由你自行配置。最多处理 25,000 UTF-8 字节的 Resume 文本；过长时保留上传文件，但不给出不完整导入。

勾选候选，再勾选确认，保存为草稿。现有记录保持不变；按技能名称、项目标题/slug、经历公司/职位/开始日期、学历学校/资格/开始日期识别重复项并跳过。不保证识别语义相同但命名不同的条目，需要人工核对。Profile 不会被覆盖；缺少必填字段或明确起始日期的条目会被省略，可手动添加。草稿需要逐条打开编辑页再发布。取消预览不会删除 Resume 或改变网站内容。分析和确认使用幂等记录，网络不确定时重试同一请求。

PDF 页数上限统一为 300，网页文件上限仍为 4 MB。RAG 路由、向量模型、分块与检索规则维持当前基础版本。
