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

日常维护以命令行为主。源码推送到 GitHub 与网站发布是两项操作，推送不会自动部署网站。上传文件或发布网站前，应具备维护者对本次操作的授权。

截至 2026-11-06，首批 65 本书已上架。百度备用下载尚未接入，评论区仍在考虑中。

## 本地查看

需要 Node.js 24 或更新版本。

```bash
npm ci
npm run dev
```

打开终端提示的本地地址，默认是 `http://127.0.0.1:4321/`。仓库已包含正式书目和封面，查看网站不需要本地 EPUB 或云服务凭据。

```bash
npm run check
npm test
npm run build
```

新增或替换电子书时才需要本地 EPUB，具体步骤见 [本地维护指南](docs/local-development.md)。

## 后续方向

页面已精简重复文案；分类与标签现已独立：六个稳定分类用于导航，EPUB 原始主题词作为标签保留，可与关键词组合筛选。首次迁移详见 [分类迁移对照](docs/category-migration.md)。

发布工具已区分本批变更与全站数量，支持仅更新站点的本地快照，并提供部署锁、查重与状态恢复检查。这些改动已在本地实现；是否上线以线上发布标记为准。
另外会评估不依赖 WSL 的百度网盘上传与分享方案。每本书通过 GitHub Issues 关联评论区的想法仅处于讨论阶段，尚未决定接入。

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
| [架构与数据说明](docs/project-plan.md) | 数据流、目录、存储方式和实现边界 |
