# Pages 命令行部署

## 当前部署

- 项目：yuuko-library，Direct Upload，生产分支 main。
- 默认站点：https://yuuko-library.pages.dev
- 自定义网站域名：https://library.amamiyayuuko.com（DNS、域名验证及 HTTPS 已激活）。
- 文件下载域名：https://book.amamiyayuuko.com
- 首次发布：65 本；线上首页、搜索索引及每本书的 R2 链接均已核验。
- 本机发布快照：`.local/releases/r-13fc57eb-fd5b-4865-aaf3-3bc2c6ac9e86/`。

源码和封面可以存 GitHub；生产文件由 Wrangler Direct Upload 发布。Git 提交或推送不会自动部署。

## 代理与授权

需要 Node.js 24+，依赖随 npm ci 安装。Git Bash 下可以给单条命令设置代理，不修改 Windows 全局代理：

```bash
HTTPS_PROXY=http://127.0.0.1:10809 HTTP_PROXY=http://127.0.0.1:10809 npx wrangler whoami
```

首次使用或授权过期后，执行：

```bash
HTTPS_PROXY=http://127.0.0.1:10809 HTTP_PROXY=http://127.0.0.1:10809 npx wrangler login --device --scopes account:read user:read pages:write zone:read
```

按 Wrangler 显示的设备代码在浏览器完成授权。OAuth 凭据由 Wrangler 保存在用户配置目录，不写入本仓库；不在聊天或日志中输出 auth token。R2 的 S3 凭据不用于 Pages。

当前锁定的 Wrangler 4.158.0 会对由代理创建的新 Pages 项目尝试转交 Workers。首建本项目时使用 pages project create 的 --force 选项明确选择 Pages；本项目现已存在，后续直接 pages deploy 即可。此行为已根据安装包实现及首次执行结果核实，不代表生产页面需要 Workers。

## 发布已有上传计划

先使用 book prepare / validate 及 r2 upload 获得本次审核计划与已验证上传报告。正式构建会校对上传报告中的 ID、哈希、大小、对象键和下载地址，移除本地预览标记，启用下载按钮并生成 release.json。

```bash
npm run pages -- prepare --plan PLAN --report .local/uploads/PLAN-upload.json
```

记录返回的 RELEASE 发布编号。prepare 只生成本地正式产物，没有远程写入。确认本次发布内容后执行：

```bash
HTTPS_PROXY=http://127.0.0.1:10809 HTTP_PROXY=http://127.0.0.1:10809 npm run pages -- deploy --release RELEASE
```

deploy 只上传固定快照；上线后的书目同步由 verify 执行：

```bash
HTTPS_PROXY=http://127.0.0.1:10809 HTTP_PROXY=http://127.0.0.1:10809 NODE_USE_ENV_PROXY=1 npm run pages -- verify --release RELEASE --url https://yuuko-library.pages.dev
```

verify 检查线上 release.json、首页、检索索引及本次书籍详情的下载链接，成功后才把对应 JSON 和封面同步回正式目录。部署命令出错或超时时先核对 project-status 和线上标识，不盲目重复发布；若上线已成功、仅本地同步失败，可修复后重跑 verify。

本地书籍原文件、凭据、上传报告、发布日志和审核快照均不进入站点产物。部署后可以提交源码、正式书目 JSON 和封面到 GitHub；EPUB 留在 R2。

## 域名和 DNS

以下命令通过 Cloudflare API 完成操作，OAuth Token 在内存中从 Wrangler 获取，不回显。API 请求也使用同一 HTTP 代理：

```bash
HTTPS_PROXY=http://127.0.0.1:10809 HTTP_PROXY=http://127.0.0.1:10809 NODE_USE_ENV_PROXY=1 node --import tsx tools/pages/cloudflare.ts project-status
HTTPS_PROXY=http://127.0.0.1:10809 HTTP_PROXY=http://127.0.0.1:10809 NODE_USE_ENV_PROXY=1 node --import tsx tools/pages/cloudflare.ts domain-add
HTTPS_PROXY=http://127.0.0.1:10809 HTTP_PROXY=http://127.0.0.1:10809 NODE_USE_ENV_PROXY=1 node --import tsx tools/pages/cloudflare.ts domain-status
```

本项目域名已关联 Pages，维护者已手动配置 CNAME：library.amamiyayuuko.com → yuuko-library.pages.dev，域名与证书状态均为 active。2026-11-06 已从该域名核验发布标识、首页、索引和 65 本详情页，并通过浏览器核验搜索与 R2 下载入口。无需为此再创建 DNS Token。

Wrangler 的 pages:write / zone:read 不包含 DNS 读写。将来若需要由命令行设置其他域名，在本机 .env.local 填入 CLOUDFLARE_DNS_API_TOKEN，权限限制到相应 Zone 的 DNS Edit，再执行：

```bash
HTTPS_PROXY=http://127.0.0.1:10809 HTTP_PROXY=http://127.0.0.1:10809 NODE_USE_ENV_PROXY=1 node --import tsx tools/pages/cloudflare.ts dns-add
```

dns-add 会创建缺失的对应 CNAME；已有其他记录时停止，不自动覆盖。仅 DNS API 请求使用专用 DNS Token，其余 Pages 操作使用 Wrangler OAuth。也可由维护者自行在控制台添加同一 CNAME。等待域名验证及 TLS 激活后，再从自定义域名运行 verify。

参考：[Pages Direct Upload](https://developers.cloudflare.com/pages/get-started/direct-upload/) · [Pages 域名 API](https://developers.cloudflare.com/api/resources/pages/subresources/projects/subresources/domains/methods/create/)
