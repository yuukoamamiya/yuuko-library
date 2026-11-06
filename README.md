# 雨宫优子图书馆

一个个人维护的电子书分享网站，收录哲学、政治经济学等领域的 AI 翻译电子书和中文出版物转录。读者可以浏览封面、作者与简介，检索书籍，并下载 EPUB。

**访问：[library.amamiyayuuko.com](https://library.amamiyayuuko.com)**

## 这个项目做什么

每本书有独立的介绍页。书名、作者、简介、封面和主题词从已整理好的 EPUB 元数据中提取；AI 译本另外标注维护者提供的翻译模型，中文转录本单独标明来源。

网站提供书目浏览、主题筛选、书名与作者等资料的检索，以及 EPUB 下载。每本书只保留一个当前版本，不提供在线阅读和正文搜索。馆藏由维护者选择和更新，预计规模在 200 本以内。

本项目负责展示、整理和分发已有 EPUB。电子书的翻译、中文转录和元数据刮削由独立流程完成。

## 如何构成

| 部分 | 作用 |
| --- | --- |
| Astro + TypeScript | 生成首页、书籍详情页和检索索引 |
| 原生 JavaScript | 在浏览器中完成搜索、筛选和排序 |
| GitHub 仓库 | 保存源码、书目 JSON、封面和维护文档 |
| Cloudflare Pages | 托管静态网页，通过 Wrangler CLI 发布 |
| Cloudflare R2 | 存储 EPUB，通过下载域名提供文件 |

源码仓库是 [yuukoamamiya/yuuko-library](https://github.com/yuukoamamiya/yuuko-library)。网站使用 [library.amamiyayuuko.com](https://library.amamiyayuuko.com)，电子书文件使用 `book.amamiyayuuko.com`。

搜索在浏览器本地执行，服务端无需数据库。网页构建产物与 EPUB 分开保存，克隆仓库不需要下载整套电子书，也不需要 Git LFS。

## 内容与维护

维护者提供本地 EPUB、稳定的书籍 ID 和版本来源。工具提取元数据并生成本地审核快照；内容确认后，再上传文件、校验公开下载、构建正式网页并发布。

日常维护以命令行为主。主代理检查并明确方案后，由固定 GPT-6 Luna Codex 子代理实施、自测并选择性提交；主代理随后独立验收。只有主代理在用户明确要求 push 时才推送。若待推送改动影响前端，push 同时授权构建、生产部署和验证网站；R2 上传、分享、清理等仍按各自授权边界执行。细则见 [AGENTS.md](AGENTS.md#codex-维护流程)。

截至 2026-11-06，生产站点已发布百度备用下载和按需评论区。release `r-26a96f39-d704-4c26-98a8-956f8eec2094` 于 20:03（Asia/Shanghai）验证通过，来源为 clean commit `c9fdfcb`；全站 65 本、`changedBooks=0`。线上完整索引、65 个详情页及当前 65 个百度入口均已检查；真实浏览器确认直链下载、RAR 解压密码复制和评论按需加载，评论映射至既有 Issue #1。原始 EPUB 均独立保留，R2 主下载不变。细节见[评论区说明](docs/comments.md)与[百度备用下载调研](docs/baidu-downloads.md)。

## 本地查看

需要 Node.js 24 或更新版本。

```bash
npm ci
npm run dev
```

打开终端提示的本地地址，默认是 `http://127.0.0.1:4321/`。仓库已包含正式书目和封面，查看网站不需要本地 EPUB 或云服务凭据。

```bash
npm run verify
npm run verify -- --docs
npm run maintenance -- health
npm run maintenance -- health --book BOOK_ID --full-download
npm run maintenance -- cleanup-preview
npm run check
npm test
npm run build
```

`verify` 顺序运行检查、测试、构建和 Git 空白检查；`--docs` 只检查文档本地链接与空白。`health` 可在仅克隆仓库的机器上只读检查线上站点，默认以 HEAD 检查下载响应头；`--full-download` 才会核对完整文件哈希。`cleanup-preview` 仅列出本地快照和报告状态，不执行删除。详见 [维护命令说明](docs/publishing-cli.md)。

新增或替换电子书时才需要本地 EPUB，具体步骤见 [本地维护指南](docs/local-development.md)。

## 后续方向

页面已精简重复文案；分类与标签现已独立：六个稳定分类用于导航，EPUB 原始主题词作为标签保留，可与关键词组合筛选。首次迁移详见 [分类迁移对照](docs/category-migration.md)。

发布工具已区分本批变更与全站数量，支持仅更新站点的本地快照，并提供部署锁、查重与状态恢复检查；上述版本已随本次发布上线。百度新版 journal 跨 SHA 自动迁移和文件清理仍未实现，详见 [AGENTS.md](AGENTS.md#待办清单)。

完整待办及完成标准见 [AGENTS.md](AGENTS.md#待办清单)。

## 文档导航

| 文档 | 面向谁、解决什么问题 |
| --- | --- |
| [AGENTS.md](AGENTS.md) | AI 维护者：目标、工具、工作规则和待办 |
| [CONTEXT.md](CONTEXT.md) | 统一图书、版本、标签和分类等用词 |
| [DESIGN.md](DESIGN.md) | 前端视觉与文案约束 |
| [本地维护指南](docs/local-development.md) | 开发、EPUB 导入、预览和文件校验 |
| [命令参考](docs/publishing-cli.md) | 已实现命令、参数、输出和失败处理 |
| [部署指南](docs/pages-deployment.md) | Cloudflare 授权、代理、部署和域名检查 |
| [百度备用下载调研](docs/baidu-downloads.md) | Windows 原生候选、凭据边界和单本验证门槛 |
| [架构与数据说明](docs/project-plan.md) | 数据流、目录、存储方式和实现边界 |
