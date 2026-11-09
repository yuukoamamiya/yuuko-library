# 雨宫优子图书馆

个人维护的电子书目录，提供书目信息、检索与 EPUB 下载。馆藏内容由维护者整理；站点不提供在线阅读或正文搜索。

[访问图书馆](https://library.amamiyayuuko.com) · [当前发布](https://library.amamiyayuuko.com/release.json)

## 架构

- Astro 静态站点与 TypeScript 维护工具
- Git 保存源码、正式书目与封面；EPUB 不进入 Git
- Cloudflare Pages 托管网页，Cloudflare R2 提供主要下载
- 网盘镜像作为可选扩展下载，百度是已注册 provider 之一；评论使用公开 GitHub Issues

站点与服务地址以 [`site.config.json`](site.config.json) 和线上 `release.json` 为准。

## 本地运行

需要 Node.js 24+：

```bash
npm ci
npm run dev
```

打开 `http://127.0.0.1:4321/`。常用检查：`npm run verify`；纯文档检查：`npm run verify -- --docs`。

## 维护

上架、R2、网盘镜像、Pages 部署、线上体检和恢复步骤见唯一的[日常维护指南](docs/maintenance.md)。
