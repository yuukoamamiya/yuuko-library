# 雨宫优子图书馆

面向不超过 200 本电子书的公开静态目录，提供介绍、分类、检索和免登录 EPUB 直链下载。

## 当前状态

已实现 Astro 静态页面、EPUB 元数据及封面提取、浏览器本地检索和分类，以及本地 prepare / preview / validate / status 命令。支持单书或清单批量准备，区分 AI 翻译和中文出版物转录。

已实现 R2 连接检查、单本与批量上传、公开下载完整性校验，以及 Pages 正式构建、Wrangler 部署、线上核验和书目同步。百度网盘尚未接入；统一 book publish / resume / bundle 仍为后续规范，当前使用独立的 r2 和 pages 命令。

2026-11-06 首批 65 本已上传 R2，逐本公开下载校验通过，总大小 108,772,188 bytes。本机下载清单见 `.local/uploads/2026-11-06-upload-summary.md`。网站已通过 CLI 部署：[雨宫优子图书馆](https://library.amamiyayuuko.com)。自定义域名及 HTTPS 已激活，首页、检索及 65 个详情页的下载链接均已核验；默认地址 [yuuko-library.pages.dev](https://yuuko-library.pages.dev) 同样可用。

- [项目方案](docs/project-plan.md)：范围、技术选择、数据、部署和实施顺序。
- [上架命令规范](docs/publishing-cli.md)：本地准备、预览、人工确认、发布和失败恢复。
- [本地使用说明](docs/local-development.md)：已实现命令、清单格式、预览与检查。
- [视觉规范](DESIGN.md)：站名、固定文案、设计参考和响应式规则。
- [Pages 命令行部署](docs/pages-deployment.md)：代理、授权、正式构建、部署、核验和域名。

## 本地运行

需要 Node.js 24 或更新版本。

```bash
npm ci
npm run book -- prepare --manifest .local/import-manifest.json
npm run book -- preview --plan <prepare返回的计划编号>
```

本机初始 65 本书的导入清单已保存在被 Git 忽略的 `.local/import-manifest.json`；其中转录本使用后续提供的含完整 metadata 的文件。其他电脑需按本地使用说明创建自己的清单和文件路径。已上线书目的 JSON 与封面现已同步到 catalog/books 和 public/covers，可随源码一起保存。

预览监听 `127.0.0.1:4321`。尚未确认的新增书目只保存在 `.local/plans/`；直接运行 `npm run dev` 或 `npm run build` 读取已经上线并同步的正式书目。

```bash
npm run check
npm test
npm run book -- validate --plan <计划编号>
```

## 已确定的工作方式

Astro 生成静态页面，少量原生 JavaScript 完成浏览器本地搜索和分类筛选，部署到 Cloudflare Pages。GitHub 保存代码、书籍资料和封面，R2 Standard 保存 EPUB，百度网盘作为可选备用下载渠道。

日常上架时提供本地 EPUB、稳定书籍 ID 和翻译模型名称。AI 先提取资料、构建并展示本地预览；收到你对这一批内容的明确确认后，才上传文件、生成分享链接并部署网站。推送 Git 不触发网站发布。

不做登录、在线阅读、正文搜索、多译本选择、历史版本浏览或后台管理，不为这些功能预留接口。书籍元数据的刮削在本项目之外完成。
