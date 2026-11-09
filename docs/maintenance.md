# 日常维护

本指南集中记录上架、下载、部署与恢复的常用步骤。每个命令的完整选项以对应 CLI 的 `--help` 和实现为准。

## 环境与本地验收

需要 Node.js 24+、npm 和 Git。Windows 日常命令使用 Git Bash；结构化数据处理优先 Python。百度等 Windows 原生工具的镜像流程不使用 WSL。

```bash
npm ci
npm run dev
npm run verify
```

`npm run verify` 依次执行 check、test、build 和 diff 空白检查。纯文档变更使用 `npm run verify -- --docs`，它只检查 Markdown 本地链接和 diff 空白。正式书目、封面已在 Git 中，本地浏览无需 EPUB 或云凭据。

电子书 EPUB 由维护者手动保存在 Calibre；本仓库不集成 Calibre，不管理原书备份。不要将 EPUB、`.env.local`、Wrangler 凭据或 `.local/` 维护数据提交到 Git。

## 维护代码边界

`src/lib/book.ts` 定义纯书目类型与核心校验；`src/lib/catalog.server.ts` 是站点与工具共用的原始书目读取层，`tools/catalog.ts` 提供 CAS 写入和统一摘要。站点的 `src/lib/books.ts` 只为渲染克隆并降级隐藏无效网盘镜像记录；maintenance health 读原始记录并报告 `unconfirmed`。镜像 provider 注册表在 `src/lib/mirrors.ts`，百度实现位于 `src/lib/baidu.ts`。计划由 `tools/book/plan.ts` 与 `workflow.ts` 共享；CLI 解析参数后调用 book、R2、Pages 或 maintenance 服务。R2 workflow 接收 root；Pages 目标按 `site.config.json` 中显式的 `cloudflareAccountId`、项目和区域配置确定，不从 R2 endpoint 推导账号。

## 新增或更新图书

每本图书使用 ISBN-13 作为 ID（13 位数字且校验位有效）；没有 ISBN 的作品先在 `catalog/no-isbn.json` 登记原文标题，再使用原文标题的 slug（保持原文语种，转写为小写 ASCII），不得根据中文书名自拟描述性 ID。`prepare` 会读取 EPUB OPF 的 ISBN 标识：metadata 缺失时给出警告，与 `--id` 不一致时也会警告；出现警告应回到刮削/书目流程核对，不能凭书名猜 ID。历史 ID 迁移只改变详情页地址；已上传的 R2/网盘对象路径保持不变，避免重复上传和分享失效，旧页面地址不再保留兼容跳转。AI 译本需填维护者提供的模型名；中文出版物转录用 `transcription`，不填模型。新增图书须选择 1–2 个 `src/lib/categories.ts` 中定义的分类。原始 EPUB subjects 会作为标签保留。

```bash
npm run book -- prepare --id 9787305231148 --epub 'D:/Books/example.epub' --model '模型名称' --category philosophy
npm run book -- prepare --id 9787305231148 --update --epub 'D:/Books/example-new.epub' --model '模型名称' --category philosophy
npm run book -- prepare --id 9787532182862 --epub 'D:/Books/chinese.epub' --kind transcription --category history
```

更新既有 ID 必须用 `--update`；同名但不同作者的书保留不同 ID。批量上架使用 JSON manifest：

```json
[
  {"id":"9787305231148","epub":"D:/Books/example.epub","model":"模型名称","categories":["philosophy"]},
  {"id":"9787532182862","epub":"D:/Books/chinese.epub","kind":"transcription","update":true}
]
```

保存后运行 `npm run book -- prepare --manifest FILE`。批量 manifest 放在 `.local/manifests/<date>-<batch>.json`，不要提交。更新条目省略 `categories` 时沿用正式书目中的现有分类；清单其他字段和规则见 `npm run book -- --help`。无 ISBN 的例外 ID 以 `catalog/no-isbn.json` 为准。网盘镜像由独立命令管理。

`prepare` 生成冻结的本地审核计划，不修改正式书目，也不上传云端：

```bash
npm run book -- preview --plan PLAN
npm run book -- validate --plan PLAN
npm run book -- status --plan PLAN
```

工作区源码、依赖、配置、正式书目或计划快照变化可能使 plan stale；重新 prepare，不绕过检查。原始 EPUB 在冻结后变化不会自动进入计划。

常规上架流程从 EPUB metadata 准备页面，完成 R2 上传并验证公开文件的完整 SHA-256 后，再用上传报告准备 Pages 快照、部署并验证线上页面。常规流程只写 R2；网盘镜像不属于常规上架流程，只有用户另行要求时才发布。ID、版本类型、模型和分类按 EPUB metadata 与既有规则确定，资料不足时再向维护者确认，不猜测。

首页默认按首次上架时间排序（最新上传）；切换到“最近更新”后按最近一次内容更新时间排序，更新旧书的元数据不会改变其首次上架位置。

## RSS 订阅

`/rss.xml` 由 `src/pages/rss.xml.ts` 从正式书目生成，按首次上架时间倒序列出书名、详情链接、作者、简介与上架时间，未发布记录不会进入 feed。新书完成 Pages 发布后自动出现在 feed；`public/_headers` 对 `/rss.xml` 使用 `max-age=0, must-revalidate`，避免边缘缓存延迟。页面 `<head>` 和页脚提供订阅入口。

## 封面与缓存

正式封面的原件在 `public/covers/<ID>/<SHA>.<ext>`，由书目中的 `cover` 字段引用；文件名带内容哈希，同名文件不得覆盖，更换封面只新增文件。构建时会按正式书目自动在 `dist` 生成 `<SHA>-180`、`<SHA>-360`、`<SHA>-540` 三档 WebP 和 AVIF 变体，不写入 Git；书架卡片和详情页通过 `<picture>` 依次尝试 AVIF、WebP，最后回退原图。书架卡片还会内联一张 24px 的高斯模糊 WebP 占位图（构建时由原图生成，不落盘），真实封面使用原生 `loading="lazy"`，未加载时显示模糊占位，加载完成后覆盖。缩略图生成逻辑在 `astro.config.mjs`，占位图在 `src/lib/cover-variants.ts`，均依赖 `sharp`。

`public/_headers` 对 `/covers/*` 和 `/_astro/*` 设置一年 `immutable` 缓存；因为路径由内容哈希决定，文件内容变化会得到新 URL。新增或更换封面后照常构建、部署即可，不需要单独运行生成命令；验证时确认构建日志出现 `generated N cover variants`，且线上封面响应带 `immutable`。

## R2 上传与公开下载

复制 `.env.example` 为 `.env.local`，配置 `R2_ACCESS_KEY_ID` 和 `R2_SECRET_ACCESS_KEY`。桶、下载域名与账号级 S3 endpoint 来自 `site.config.json`。凭据仅留在本机。

```bash
npm run r2 -- check
npm run r2 -- upload --plan PLAN --book BOOK
npm run r2 -- upload --plan PLAN
npm run r2 -- verify --plan PLAN
```

`check` 只读。上传前先做单本样本；上传/验证报告保存在 `.local/uploads/`。只有报告 `status=verified`、`verified=expected` 且 `failures` 为空，才能报告整批通过。上传会公开文件；逐本核对公开 GET 的完整 SHA-256、字节数、MIME 和文件名。一致对象可复用，冲突对象不覆盖。`verify` 只读复核，不补传文件。R2 上传不会同步正式书目或部署网站。

## 下载镜像（可选扩展）

常规上架只写 R2，`downloads.mirrors` 保持为空。需要额外网盘分享时，先取得本次明确授权，再使用镜像入口。provider 必须在 `src/lib/mirrors.ts` 注册校验与展示名，在 `tools/maintenance/mirror-health.ts` 注册公开可用性检查，在 `tools/mirrors/registry.ts` 注册 CLI；核心上架流程不因新增 provider 而改动。每个镜像记录 `provider`、`url`、`code`、`fileSha256`（必须等于当前 EPUB SHA-256）、`verifiedAt`，可选 `archive` 和 provider 私有 `meta`。未知 provider 不会在站点渲染，写入正式书目时会被拒绝。

```bash
npm run mirror -- status --id ID --provider baidu
npm run mirror -- prepare --id ID --provider baidu
npm run mirror -- publish --id ID --provider baidu
npm run mirror -- recover --id ID --provider baidu
```

`--provider` 默认为 `baidu`，其余参数原样转发给对应 provider 的 CLI；百度实现也可直接运行 `npm run baidu -- ...`。镜像发布发生在常规 R2/Pages 发布之后：provider 需要正式书目中已有匹配的当前 EPUB。镜像写入正式书目后，需要重新执行一次 `npm run pages -- prepare --site-only` 并 deploy/verify，让详情页和线上书目同步；同一批多个 provider 只需在全部发布完成后重建一次。

以下为百度 provider 的操作细节。百度工具使用 Windows 原生 BaiduPCS-Go，不使用 WSL。当前可执行文件路径为 `%LOCALAPPDATA%/YuukoLibrary/tools/BaiduPCS-Go-v4.0.2/BaiduPCS-Go.exe`；RAR 需安装 WinRAR，程序路径为 `%ProgramFiles%/WinRAR/Rar.exe`。凭据 JSON 位于 `%LOCALAPPDATA%/YuukoLibrary/credentials/baidu.json`；CLI 配置位于 `%LOCALAPPDATA%/YuukoLibrary/credentials/baidupcs-config`，通过 `BAIDUPCS_GO_CONFIG_DIR` 使用。不得输出或提交凭据。

```bash
npm run baidu -- status --id ID
npm run baidu -- prepare --id ID
npm run baidu -- publish --id ID
npm run baidu -- recover --id ID
```

`status` / `prepare` 只读；`publish` 是显式云写入，需有与正式书目当前 SHA 和大小匹配的本地 EPUB。完整选项见 `npm run baidu -- --help`。

百度 journal 按书籍 ID 与 EPUB SHA 保存版本历史。同字节的元数据更新可复用已验证分享；文件 SHA 改变时新版本使用独立目录，不沿用旧链接。上传和回读检查点可续跑。若分享操作结果未知，先检查 `status` 和百度 `share list`，再使用 `recover` 精确确认既有 share ID 与提取码；不能盲目重建分享。旧版本未知状态会阻断新版本发布，直到人工核实并恢复。RAR 只在维护者指定文件名和密码后准备：`prepare-archive` 生成本地 manifest，`publish-archive --manifest FILE` 发布或复核；RAR 未知分享通过 `recover --manifest FILE --share-id ID --code CODE` 恢复。raw EPUB 历史版本需显式指定原 SHA 并确认已有分享：

```bash
npm run baidu -- recover --id ID --source-sha SHA --share-id SHARE_ID --code CODE
```

保持旧 journal、`.schema1.bak` 和 migration 记录，不手工删除或改写以绕过保护。

## Pages 部署

Pages 是 Direct Upload；Git push 不会自动部署。项目、域名、R2 地址等以 `site.config.json` 和线上 `release.json` 为准。网络需要本机代理时，在 Git Bash 单条命令设置 `HTTP_PROXY`、`HTTPS_PROXY` 为 `http://127.0.0.1:10809`；Node 原生 fetch 同时设置 `NODE_USE_ENV_PROXY=1`。不要改系统全局代理。

Wrangler 登录失效时先检查身份，需要时重新登录：

```bash
HTTPS_PROXY=http://127.0.0.1:10809 HTTP_PROXY=http://127.0.0.1:10809 npx wrangler whoami
HTTPS_PROXY=http://127.0.0.1:10809 HTTP_PROXY=http://127.0.0.1:10809 npx wrangler login --device --scopes account:read user:read pages:write zone:read
```

OAuth 凭据由 Wrangler 保存在仓库外。

准备全站发布快照：

```bash
npm run pages -- prepare --plan PLAN --report UPLOAD_REPORT
```

仅修改站点页面或分类导航时，不需要 EPUB/R2 上传：

```bash
npm run pages -- prepare --site-only
```

prepare 返回本机固定 `RELEASE`。部署前确认本次有发布授权；部署后必须 verify：

```bash
HTTPS_PROXY=http://127.0.0.1:10809 HTTP_PROXY=http://127.0.0.1:10809 NODE_USE_ENV_PROXY=1 npm run pages -- deploy --release RELEASE
HTTPS_PROXY=http://127.0.0.1:10809 HTTP_PROXY=http://127.0.0.1:10809 NODE_USE_ENV_PROXY=1 npm run pages -- verify --release RELEASE --url https://library.amamiyayuuko.com
```

| 中断位置 | 下一步 |
| --- | --- |
| 本地审核 | `book status` / `validate`；stale 时重新 prepare |
| R2 上传中断 | 查看报告；确认计划仍有效后重跑 upload，核对公开 GET 完整 SHA |
| Pages 提交中断或结果未知 | `pages status --release RELEASE` 并查线上 release；未知时不要重试 |
| Pages 已发布 | 对同一 RELEASE 执行 verify，完成索引、详情与书目同步 |
| 远端明确 failure / canceled | 查明原因后才用 `deploy --retry` |
| 本地书目同步中断 | 对同一 RELEASE 重跑 verify；源码或书目改动可能阻止覆盖 |

Pages deploy 成功不等于线上验证完成。若用户明确要求 push，且待推送内容影响网页产物，主代理先 `prepare --site-only`，验收后 push，再 deploy 与 verify；纯文档不触发部署。此授权不包括 R2 上传、分享或文件清理。部署结果未知时先查 status 和线上状态，不重复提交。

## 线上体检与本地清理盘点

```bash
npm run maintenance -- health
npm run maintenance -- health --book ID
npm run maintenance -- health --full-download
npm run maintenance -- cleanup-preview
```

`health` 只读检查正式书目对应的网页、索引、详情、封面与下载，并默认逐条调用已注册 provider 的匿名检查（百度为 PCS 提取码 challenge endpoint）。该挑战不下载文件，不等于完整内容 SHA 验证。下载默认用 HEAD 检查响应头；只有 `--full-download` 才读取完整文件并核对大小与 SHA。`--book ID` 是样本检查，不能称全馆通过；`--skip-provider PROVIDER` 跳过指定 provider，`--skip-baidu` 是 `--skip-provider baidu` 的别名。未知 provider 只计为未配置并给出警告。

`cleanup-preview` 只读盘点 `.local` 快照，不移动或删除文件；近期快照、活跃/不确定状态、依赖闭包和最近两份成功发布受保护。当前存在未知旧快照证据，需先人工核对来源与依赖；在核实前不清理。若未来需要实际清理，须逐项列出精确目标并获得本次明确授权。旧 EPUB 由维护者手动保存在 Calibre；本工具不清理旧 EPUB 或远端 R2 对象。

## 评论区管理

详情页按需加载 utterances，评论存放在公开仓库 [`yuukoamamiya/yuuko-library-comments`](https://github.com/yuukoamamiya/yuuko-library-comments)。固定匹配模式 `issue-term`，每本使用 `book:<稳定书籍 ID>` term；不要因书名或 URL 变化而改 ID。utterances GitHub App 仅需对评论仓库 metadata 只读、Issues 读写；关闭 Issues 会阻止新线程创建。浏览已有评论不需要站点保存 GitHub 凭据，发表评论需读者用 GitHub 登录。

## 参考配置

站点名、域名和前端文案约束见 [`DESIGN.md`](../DESIGN.md)；术语见 [`CONTEXT.md`](../CONTEXT.md)。类别 ID 以 `src/lib/categories.ts` 为准。完整 CLI 选项请分别运行 `book`、`r2`、`mirror`、`baidu`、`pages`、`maintenance` 的 `--help`。
