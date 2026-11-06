# 日常维护

本指南集中记录上架、下载、部署与恢复的常用步骤。每个命令的完整选项以对应 CLI 的 `--help` 和实现为准。

## 环境与本地验收

需要 Node.js 24+、npm 和 Git。Windows 日常命令使用 Git Bash；结构化数据处理优先 Python。百度流程不使用 WSL。

```bash
npm ci
npm run dev
npm run verify
```

`npm run verify` 依次执行 check、test、build 和 diff 空白检查。纯文档变更使用 `npm run verify -- --docs`，它只检查 Markdown 本地链接和 diff 空白。正式书目、封面已在 Git 中，本地浏览无需 EPUB 或云凭据。

电子书 EPUB 由维护者手动保存在 Calibre；本仓库不集成 Calibre，不管理原书备份。不要将 EPUB、`.env.local`、Wrangler 凭据或 `.local/` 维护数据提交到 Git。

## 新增或更新图书

每本图书使用稳定 ID。AI 译本需填维护者提供的模型名；中文出版物转录用 `transcription`，不填模型。新增图书须选择 1–2 个 `src/lib/categories.ts` 中定义的分类。原始 EPUB subjects 会作为标签保留。

```bash
npm run book -- prepare --id example-book --epub 'D:/Books/example.epub' --model '模型名称' --category philosophy
npm run book -- prepare --id example-book --update --epub 'D:/Books/example-new.epub' --model '模型名称' --category philosophy
npm run book -- prepare --id chinese-book --epub 'D:/Books/chinese.epub' --kind transcription --category history
```

更新既有 ID 必须用 `--update`；同名但不同作者的书保留不同 ID。批量上架使用 JSON manifest：

```json
[
  {"id":"example-book","epub":"D:/Books/example.epub","model":"模型名称","categories":["philosophy"]},
  {"id":"chinese-book","epub":"D:/Books/chinese.epub","kind":"transcription","update":true}
]
```

保存后运行 `npm run book -- prepare --manifest FILE`。更新条目省略 `categories` 时沿用正式书目中的现有分类；清单其他字段和规则见 `npm run book -- --help`。百度分享由独立命令管理。

`prepare` 生成冻结的本地审核计划，不修改正式书目，也不上传云端：

```bash
npm run book -- preview --plan PLAN
npm run book -- validate --plan PLAN
npm run book -- status --plan PLAN
```

工作区源码、依赖、配置、正式书目或计划快照变化可能使 plan stale；重新 prepare，不绕过检查。原始 EPUB 在冻结后变化不会自动进入计划。

## R2 上传与公开下载

复制 `.env.example` 为 `.env.local`，配置 `R2_ACCESS_KEY_ID` 和 `R2_SECRET_ACCESS_KEY`。桶、下载域名与账号级 S3 endpoint 来自 `site.config.json`。凭据仅留在本机。

```bash
npm run r2 -- check
npm run r2 -- upload --plan PLAN --book BOOK
npm run r2 -- upload --plan PLAN
npm run r2 -- verify --plan PLAN
```

`check` 只读。上传前先做单本样本；上传/验证报告保存在 `.local/uploads/`。只有报告 `status=verified`、`verified=expected` 且 `failures` 为空，才能报告整批通过。上传会公开文件；逐本核对公开 GET 的完整 SHA-256、字节数、MIME 和文件名。一致对象可复用，冲突对象不覆盖。`verify` 只读复核，不补传文件。R2 上传不会同步正式书目或部署网站。

## 百度备用下载

百度工具使用 Windows 原生 BaiduPCS-Go，不使用 WSL。当前可执行文件路径为 `%LOCALAPPDATA%/YuukoLibrary/tools/BaiduPCS-Go-v4.0.2/BaiduPCS-Go.exe`；RAR 需安装 WinRAR，程序路径为 `%ProgramFiles%/WinRAR/Rar.exe`。凭据 JSON 位于 `%LOCALAPPDATA%/YuukoLibrary/credentials/baidu.json`；CLI 配置位于 `%LOCALAPPDATA%/YuukoLibrary/credentials/baidupcs-config`，通过 `BAIDUPCS_GO_CONFIG_DIR` 使用。不得输出或提交凭据。

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

`health` 只读检查正式书目对应的网页、索引、详情、封面与下载，并默认逐条调用百度 PCS 匿名提取码 challenge endpoint。该挑战不下载文件，不等于完整内容 SHA 验证。下载默认用 HEAD 检查响应头；只有 `--full-download` 才读取完整文件并核对大小与 SHA。`--book ID` 是样本检查，不能称全馆通过；`--skip-baidu` 跳过百度检查。

`cleanup-preview` 只读盘点 `.local` 快照，不移动或删除文件；近期快照、活跃/不确定状态、依赖闭包和最近两份成功发布受保护。当前存在未知旧快照证据，需先人工核对来源与依赖；在核实前不清理。若未来需要实际清理，须逐项列出精确目标并获得本次明确授权。旧 EPUB 由维护者手动保存在 Calibre；本工具不清理旧 EPUB 或远端 R2 对象。

## 评论区管理

详情页按需加载 utterances，评论存放在公开仓库 [`yuukoamamiya/yuuko-library-comments`](https://github.com/yuukoamamiya/yuuko-library-comments)。固定匹配模式 `issue-term`，每本使用 `book:<稳定书籍 ID>` term；不要因书名或 URL 变化而改 ID。utterances GitHub App 仅需对评论仓库 metadata 只读、Issues 读写；关闭 Issues 会阻止新线程创建。浏览已有评论不需要站点保存 GitHub 凭据，发表评论需读者用 GitHub 登录。

## 参考配置

站点名、域名和前端文案约束见 [`DESIGN.md`](../DESIGN.md)；术语见 [`CONTEXT.md`](../CONTEXT.md)。类别 ID 以 `src/lib/categories.ts` 为准。完整 CLI 选项请分别运行 `book`、`r2`、`baidu`、`pages`、`maintenance` 的 `--help`。
