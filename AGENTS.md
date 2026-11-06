# 项目维护指南

本文件供维护本仓库的 AI agent 使用。面向人的项目介绍见 [README.md](README.md)，术语见 [CONTEXT.md](CONTEXT.md)。执行任务前先读取本文件和相关操作文档，以代码、配置与实际检查结果判断状态。

## 维护目标

- 维护一个以书目浏览、检索和 EPUB 下载为核心的小型个人图书馆，预计不超过 200 本。
- 保持静态站架构与命令行维护方式，降低日常上架、更新和恢复的成本。
- 准确展示元数据、版本来源和维护者给出的翻译模型名称。
- 保持前端简洁、书名醒目、手机可用，避免功能自述和装饰性文案堆积。
- 明确区分已经实现、待实施和仅讨论的事项；待办不是自动执行授权。

## 项目定位与当前事实

- Astro 静态输出 + TypeScript + 少量原生 JavaScript；不运行站点业务后端或数据库。
- 网站：`https://library.amamiyayuuko.com`；Pages 默认地址：`https://yuuko-library.pages.dev`。
- 下载域名：`https://book.amamiyayuuko.com`；R2 桶：`yuuko-library-books`。
- GitHub：`https://github.com/yuukoamamiya/yuuko-library`，主分支 `main`。
- Pages 项目：`yuuko-library`，Direct Upload，生产分支参数 `main`。Git push 不触发网站部署。
- 正式书目位于 `catalog/books/`，封面位于 `public/covers/`。数量以目录和实际线上结果为准。
- 原始主题标签保存在 `subjects`，独立分类保存在 `categories`；每本 1–2 类，六个分类 ID 统一定义于 `src/lib/categories.ts`。首次迁移对照见 `docs/category-migration.md`。
- 百度网盘未接入；评论区已在本地接入 utterances，尚未部署。不得把 `--baidu optional` 当作已实现自动分享。

## 工具与环境

| 工具 | 用途 |
| --- | --- |
| Node.js 24+、npm | 安装锁定依赖、运行维护工具和构建 |
| Astro、TypeScript | 页面开发及静态检查 |
| Git、GitHub CLI（gh） | 源码、书目和封面的版本管理 |
| Wrangler（使用项目锁定版本） | Cloudflare 登录、Pages 创建、部署和状态检查 |
| AWS S3 SDK | R2 访问、条件上传、对象核对 |
| curl、浏览器工具 | HTTP、页面、交互及移动布局验证 |
| Python | 非平凡文本处理、清单转换和数据核对 |
| DeepSec Shield（环境可用时） | 代码改动后的本地安全扫描；使用离线层，不主动运行渗透测试 |

Windows 下普通 shell 操作优先 Git Bash；工具支持选择 shell 时明确选择 Git Bash 的 bash.exe，路径按当前环境确定。PowerShell 用于 Windows 进程、网络连接等系统管理，不向它传入 Bash 语法。结构化数据和复杂文本处理优先 Python。

网络不通时检查本机 HTTP 代理 `http://127.0.0.1:10809`。通过单条命令的 `HTTP_PROXY` / `HTTPS_PROXY` 使用代理；Node 原生 fetch 的命令同时设置 `NODE_USE_ENV_PROXY=1`。不要直接修改系统全局代理；代理不一定在每台机器上可用。

**百度方案不使用 WSL，不为它安装或调用 WSL。前端只使用可能预装的字体，不安装字体包，不引入外部字体服务。**

## 常用入口

```bash
npm ci
npm run dev
npm run check
npm test
npm run build
npm run book -- --help
npm run r2 -- --help
npm run pages -- --help
```

操作详情分别见 [本地维护指南](docs/local-development.md)、[命令参考](docs/publishing-cli.md) 和 [部署指南](docs/pages-deployment.md)。目前使用 book / r2 / pages 三组独立命令；统一的 `book publish`、`resume`、`bundle` 尚未实现，不要推荐执行。

## 内容规则

- 使用外部流程整理好的 EPUB，不新增元数据刮削或人工覆盖系统。
- EPUB 的 subject 是标签来源，不能再把全部主题词视为网站的大类。当前兼容字段和待迁移部分见架构说明。
- 新增图书需明确稳定 ID；更新同一本书保持原 ID，并显式使用 `--update`。同名、不同作者的书不能合并。
- AI 译本使用 `edition.kind=ai-translation` 与用户给出的模型名；中文出版物转录使用 `transcription`，模型为 null。
- 每本书只提供一个当前 EPUB；书名、模型或来源不凭空补写，不擅自纠正用户提供的模型名称。
- 任何新版 EPUB 都不能沿用指向旧文件的百度分享链接。

## 操作边界与验证

1. 先完成本地改动和可审阅结果。上传 R2、创建分享、独立部署 Pages 或文件清理需要本次会话中的明确授权；用户明确要求 push 时，若本次待推送范围包含前端/站点产物变化，该要求同时授权按下方流程构建、部署并验证正式网站。已有授权覆盖的步骤不重复询问。
2. book prepare / preview / validate / status 是本地步骤；R2 upload 会公开文件；Pages deploy 会发布网页。分别说明结果，不能用前一步成功代替后一步完成。
3. 源码、依赖、配置或正式书目改变后，旧 plan 可能变 stale。需要时重新准备快照，不强行绕过校验。
4. R2 上传后核对公开 GET 的完整 SHA-256、大小、MIME 与中文文件名。不要把 multipart ETag 当作 SHA-256。
5. Pages deploy 返回成功后继续 verify，核对线上 release.json、首页、索引和详情页，成功后同步正式书目。
6. 重试前先查看日志与远端状态。R2 可以复用一致对象；Pages 当前不是自动幂等发布，不要在结果不明时重复部署。
7. `.env.local`、Wrangler 凭据、EPUB、`.local/` 和构建产物不进 Git。不得输出密钥、签名请求或原始凭据文件。
8. 子代理按下方维护流程选择性提交本任务改动；主代理独立验收。只有主代理在用户明确要求 push 时才可推送，子代理不得 push。推送前检查本次待推送提交的 diff、范围及敏感信息；纯文档变更无需部署网站。
9. 按改动运行相关检查。代码变更使用可用的 DeepSec 本地扫描并处理实际发现；仅改文档时检查链接、术语和命令，不机械重复全套运行测试。
10. 分类、评论或下载渠道等需求改变时，同步修正文档；完整待办只维护下方一份。

## Codex 维护流程

1. 开工时由主代理检查当前分支、`git status --short` 和已有修改，记录未跟踪文件；不清理、不覆盖、不纳入无关改动。主代理先诊断问题，明确方案、文件边界、风险与验收标准，再安排实施。
2. 代码或文档实施固定使用 GPT-6 Luna Codex 子代理（模型标识 `gpt-6-luna`），由其按明确范围修改并自测。完成后子代理自动只选择性暂存并提交本任务改动，再交接精确文件范围、commit hash、diff 摘要和检查证据。用户明确要求不提交时服从；没有改动时不创建空提交。不得使用 `git add .`；排除任务前既有修改，同文件须逐 hunk 核对暂存范围。Luna 不可用时如实说明，不得声称已调度，也不得擅自改用其他模型。
3. 主代理独立检查实际 diff（从任务开始基线到本任务提交）与证据，并运行适用检查。代码变更运行相关检查和可用的 DeepSec 离线扫描；文档变更检查链接、术语、命令和 `git diff --check`，不机械运行测试或构建。发现问题时交由 Luna 修复并追加选择性提交；未通过验收不得 push。
4. 子代理不得 push。只有主代理在用户明确要求 push 时才可推送；push 时先 fetch，核对本次所有未推送提交的范围和 diff，只推送本任务已验收改动，不夹带无关提交或敏感信息。前端变化以会影响网页产物的 `src/`、`public/`、`catalog/`、Astro/站点配置和依赖等未推送改动判断；纯文档不触发部署。
5. 用户明确要求 push，且待推送范围有前端变化时，该要求同时授权构建、生产部署和线上验证，无须再次询问。push 前用 `npm run pages -- prepare --site-only` 生成同版本固定快照并核验其产物；构建/准备失败就停止 push。推送成功后对该 RELEASE 执行 deploy 和 verify，核对线上 release、完整索引及全部详情页，并完成正式书目同步。新增或更新图书仍须遵循 book / R2 验证报告流程；push 联动不额外授权 R2 上传、创建分享、文件清理或 DNS 修改。
6. push 结果未知时先核对远端，不能盲目重试；部署结果未知时先运行 status 并核对线上状态，不能重复提交部署。push 成功但部署失败时分开报告并继续排障。按本仓库 `origin` 配置的远端推送。

只读调研不强迫产生文件或空提交。主代理验收和提交后的独立检查均不能夹带或覆盖任务前的既有改动。

## 前端约束

遵循 [DESIGN.md](DESIGN.md)。保留“雨宫优子图书馆”站名和用户指定的首页小字：

> 本网站仅供学习和交流用，请于下载后24小时内删除

正文优先承载书籍信息，按钮直接表达动作。删除“公开下载，无需登录。”“开放阅读，自由探索”等冗余功能自述，不扩写同义宣传句。必要的加载、预览、错误和空结果状态要保留。

## 待办清单

### 优先处理

- [x] **精简前端文案（本地实现）。** 移除页眉、详情、侧栏和页尾的重复口号及无用布局，保留站名、指定小字及必要状态。
- [x] **拆分分类和标签（本地实现）。** 65 本迁移至六个独立分类，每本 1–2 类，完整保留 152 个原始标签；支持分类、标签和关键词交集筛选，兼容旧 subject 链接。
- [x] **确认增量发布的全站统计（本地实现）。** release.json schemaVersion=2，books 为全站数量，changedBooks 为本批变更；验证完整索引及全部详情，测试覆盖新增、更新和旧书缺失。

### 维护能力

- [x] **整理上架与恢复步骤（本地实现）。** 现有三组命令的检查点见部署指南；Pages 支持项目锁、远端查重、status 与 verify 恢复，未知结果停止。跨三组工具的统一自动发布命令仍未实现。
- [x] **区分书籍更新与站点部署时间（本地实现）。** 内容变化才刷新 updatedAt；prepare --site-only 保留全部书籍时间，部署快照时间为 createdAt。
- [x] **统一本地验收与发布溯源（本地实现）。** npm run verify 顺序运行检查、测试、构建及 Git 空白检查，支持文档模式；固定快照记录 Git 提交、dirty 状态、来源和冻结站点输入摘要，快照源或 build 期间变化时停止，部署要求 clean 提交。新来源标记需下一次 Pages 发布后才在线可见。
- [x] **增加独立线上体检（本地实现）。** 可在任意克隆仓库机器只读检查正式书目对应的完整索引、详情、封面和下载；默认 HEAD 与完整 GET/SHA 校验区分，样本结果不冒称全站通过。
- [ ] **完善文件清理流程。** 旧 EPUB 与失败/旧 R2 对象尚无清理工具或保留策略；实际清理需列出目标并获得本次授权，不默认自动删除。
  - [x] 本地 `.local` 快照只读预览：`npm run maintenance -- cleanup-preview` 扫描 plans / releases / uploads；30 天内快照、prepared / active / submitted / uncertain 状态、依赖闭包以及最近两份成功发布均保护；线上或本地状态未知时保守保护。预览不删除任何内容，候选仍须人工核对并另获授权。

### 百度备用下载

- [x] 调研 Windows 原生工具和 API，排除 WSL。候选 BaiduPCS-Go v4.0.2 Windows x64 已下载并校验 SHA-256；CLI 登录、quota、`ls /ebook` 和 `share list` 只读检查通过。证据、凭据边界和已知限制见 [docs/baidu-downloads.md](docs/baidu-downloads.md)。
- [ ] 等待本次对单本上传和 7 天分享的明确授权；上传、新分享、重新下载哈希校验、登录续期和费用条件尚未验证。未授权前不上传、不创建分享。
- [ ] 单本验证通过并另行批准接入后，再实现备用下载与失败降级；R2 主下载可以独立运行。

### 图书评论区

- [x] 本地接入并验证 utterances：每本书使用独立评论线程，Issue 标题映射固定为 `book:<stable ID>`；详情页按需加载，预览不接入评论。通过本地页面完成 GitHub OAuth 并发布验证评论，utterances bot 自动创建 `book:endnotes-2` Issue，刷新后仍映射到同一 Issue；320px 窄屏加载后无横向溢出。公开仓库和 App 权限、验证细节见 [docs/comments.md](docs/comments.md)。
- [ ] push/deploy 后验证生产评论区。App 仅授权公开仓库 `yuukoamamiya/yuuko-library-comments`（metadata 只读、Issues 读写）；本地验证评论保留，生产页面仍未验。

## 完成记录

- [x] Astro 书目页、EPUB 提取、浏览器检索及本地审核流程。
- [x] AI 译本与中文出版物转录的区分。
- [x] 首批 65 本 R2 上传及公开下载完整性校验。
- [x] Pages CLI 部署、自定义域名和 HTTPS 验证。
- [x] 公开 GitHub 源码仓库；源码与 EPUB 分开管理。
