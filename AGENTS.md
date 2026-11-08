# 维护约束

本文件只记录代理执行工作的边界与当前待办。操作步骤见唯一的[日常维护指南](docs/maintenance.md)。项目术语见 [CONTEXT.md](CONTEXT.md)，前端规范见 [DESIGN.md](DESIGN.md)。

## 项目与内容

- 维护 Astro 静态个人图书馆；不引入站点后端、数据库或未讨论的平台。
- 域名、R2/Pages 项目配置以 `site.config.json` 和线上 `release.json` 为准，不在此复制易过期的发布数字。
- 书目在 `catalog/books/`，封面在 `public/covers/`；分类 ID 以 `src/lib/categories.ts` 为准，EPUB `subjects` 作为标签保留。
- 图书 ID 使用 ISBN-13（13 位数字且校验位有效）；无 ISBN 的条目先在 `catalog/no-isbn.json` 登记原文标题，再使用原文标题的 slug。不得根据中文书名自拟描述性 ID。同名不同作者不合并；更新现有图书显式使用 `--update`。
- AI 译本用 `edition.kind=ai-translation` 和维护者提供的模型名；中文出版物转录用 `transcription`，模型为 null。不得补写或擅自改正来源信息。
- 一书只记录一个当前 EPUB。不得让旧 R2/百度下载地址指向新文件。
- 电子书原件由维护者手动保存在 Calibre；本仓库不集成 Calibre。
- 正式书目写入统一经 `tools/catalog.ts` 的 CAS writer；plan 校验与 inventory 复用 `tools/book/plan.ts` API，不在 CLI 或业务服务中另行实现。

## 操作边界

- 先完成本地改动并给出可审阅结果。上传 R2、创建分享、Pages 部署和文件清理都需要本次会话明确授权；已有授权不重复询问。
- 用户明确要求 push，且本次待推送内容影响站点产物时，该要求同时授权构建、部署和线上验证：push 前 `pages prepare --site-only` 并核对快照；push 后 deploy、verify 并同步正式书目。纯文档变更不触发部署。
- `book` prepare/preview/validate/status 是本地步骤；R2 upload 会公开文件；Pages deploy 会发布网页。每个阶段分别验证，不以本地成功代替线上完成。
- 正常上架从 EPUB metadata 生成页面，依次完成 R2 上传与公开文件完整校验，再经 Pages 发布与线上验证。百度分享不属于常规上架流程；仅在用户另行要求时执行。书籍 ID、版本类型、模型和分类依据 metadata 与既有规则确定；信息不足时向维护者确认，不捏造。
- R2 上传后核对公开 GET 的完整 SHA-256、大小、MIME 和文件名；multipart ETag 不是 SHA-256。
- plan 可能因源码、依赖、配置、书目或冻结输入变化而 stale；重新 prepare，不绕过校验。未知的云端/远端状态先查 status、日志和远端事实，不能盲目重试。
- `.env.local`、Wrangler/百度凭据、EPUB、`.local/` 和构建产物不进 Git；不得输出原始凭据、签名请求或密钥。
- 百度流程使用 Windows 原生工具，不使用或安装 WSL。前端只用可能预装的字体，不安装字体包或外部字体服务。
- 网站保留“雨宫优子图书馆”和首页小字“本网站仅供学习和交流用，请于下载后24小时内删除”；保持简洁，避免功能自述与宣传文案。

## 实施与验收

1. 主代理检查分支、`git status --short` 与已有修改，确定任务范围和验收标准；不覆盖、不清理或纳入无关修改。
2. 代码或文档实施使用 GPT-6 Luna Codex 子代理。实施者按任务范围修改、自测，并仅选择性暂存和提交本任务改动；不得 `git add .`，不得 push。用户明确要求不提交时照办。
3. 主代理独立审阅本任务实际 diff 和检查证据，再运行适用检查。代码改动运行相关检查与可用的 DeepSec 离线扫描；纯文档运行 `npm run verify -- --docs`，检查链接、命令、术语和 diff 空白。
4. 只有主代理在用户明确要求 push 时才可推送。push 前 fetch，核对全部未推送提交范围、diff 与敏感信息，只推已验收的本任务改动。push/deploy 结果不明时先查询，不重复提交。
5. 本地文件清理必须先核对精确目标并取得本次明确授权；只读 `cleanup-preview` 不构成清理授权。

## 待办

- [ ] 人工核查 `.local` 旧快照的未知状态和依赖。核实前不清理；若后续需要清理，先列出精确目标并另行取得授权。旧 EPUB 与远端 R2 对象清理不在现有只读预览范围。
