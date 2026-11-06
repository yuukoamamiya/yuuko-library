# 本地使用说明

## 已实现范围

本阶段可提取本地 EPUB 的 metadata 和封面，生成首页和每本书的详情页，并按书名、作者、简介和 subject 检索、筛选。模型名称按输入原样展示，不查询模型服务。支持无模型的中文出版物转录。

书籍工具提供 prepare、preview、validate、status；R2 工具提供连接检查、上传及公开下载校验；独立 pages 工具提供正式构建、部署、线上核验及书目同步，详见 [Pages 命令行部署](pages-deployment.md)。`--help` 显示的命令才可执行。百度分享和统一 book publish/resume 流程尚待实现。R2 上传不会自动部署网站。

## 准备环境

使用 Node.js 24+；在仓库根目录执行 `npm ci`。本地预览无需任何云服务凭据。Windows 的普通终端可用 Git Bash；EPUB 参数可传 `D:/Books/example.epub`，有空格的路径需加引号。

## 新增一本书

```bash
npm run book -- prepare --id example-book --epub 'D:/Books/example.epub' --model 'gemini 3.8 flash'
```

转录本使用显式类型，不填写 model：

```bash
npm run book -- prepare --id chinese-transcription --epub 'D:/Books/chinese.epub' --kind transcription
```

`id` 必须是最多 80 字符的小写英文、数字与连字符；选定后保持稳定。不同作者的同名书必须使用不同 ID。已存在于正式书目中的 ID 只有带 `--update` 才能准备替换；暂存计划不视为已发布书籍。

## 批量准备

在 `.local/import-manifest.json` 中维护 JSON 数组。所有条目一次生成一个审核计划、一次构建整站，无需逐书构建或手动 bundle。

```json
[
  {
    "id": "example-book",
    "epub": "D:/Books/example.epub",
    "model": "gemini 3.8 flash"
  },
  {
    "id": "chinese-transcription",
    "epub": "D:/Books/chinese.epub",
    "kind": "transcription"
  }
]
```

```bash
npm run book -- prepare --manifest .local/import-manifest.json
```

每条可设置 `update: true` 和 `baidu: "optional"`；后者当前只记录发布策略，不执行任何百度操作。默认 baidu 为 off。不能在 manifest 命令上混用单书字段。

本机初始清单共 65 本：gemini 3.1 pro preview 为 9 本（无声的强制、尾注 1–5、阶级矩阵、国家、权力与社会主义、资本主义的起源），gemini 2.5 pro 为少于无 1 本，中文出版物转录 1 本，其余 54 本为 gemini 3.8 flash。转录本使用维护者后续提供的含完整 metadata 的新文件。

书目、封面和输入 EPUB 都复制到本地计划。原文件不会被修改，不会写入 Git、正式书目或网站静态产物。清单含本机文件路径，因此置于被忽略的 `.local/`。

## 预览与校验

prepare 返回实际的 `p-<UUID>` 计划编号和 report.md 路径。下方用 `PLAN` 代表返回值，执行时替换为实际编号：

```bash
npm run book -- preview --plan PLAN
npm run book -- validate --plan PLAN
npm run book -- status --plan PLAN
```

preview 默认端口 4321，仅绑定 127.0.0.1；端口占用时明确报错，可用 `--port 4322`。终端需保持运行，Ctrl+C 停止。

- 首页：`http://127.0.0.1:4321/`
- 详情：`http://127.0.0.1:4321/books/<id>/`
- 本地审核报告：`.local/plans/<plan-id>/report.md`

预览下载区域显示“下载将在发布后开放”。预览服务器只开放生成的静态目录，不提供计划清单、EPUB 或本地输入路径。

validate 重读快照中的 EPUB，检查哈希及记录，重新构建，核对索引、页面与本地链接，确保产物不包含 EPUB。源码、依赖、配置、正式书目或审核快照发生变化，旧计划会被标记 stale；重新 prepare 后使用新计划预览。原始 EPUB 路径中的文件后续改变，不会改变已复制的快照。

`--json` 可用于脚本。为避免 npm 自身输出命令横幅，使用 `npm run --silent book -- status --plan PLAN --json`，或 `node --import tsx tools/book/cli.ts status --plan PLAN --json`。构建日志写 stderr，JSON 结果写 stdout。

## 检查

```bash
npm run check
npm test
npm run build
```

check 包含 Astro 页面诊断和 TypeScript 检查。测试覆盖 EPUB 2/3 封面、元数据提取、DTD/越界路径拒绝、搜索语义、批量快照、转录本及快照篡改拒绝。build 只构建正式书目，尚无正式上架时为空书架；审核真实书籍请使用 plan 预览。

## R2 本地连接

`site.config.json` 的 `r2Endpoint` 为账号级 S3 HTTPS 终结点，不能包含桶名；`r2Bucket` 单独填写桶名，`downloadsUrl` 填公开下载域名。S3 API 终结点不是读者下载地址。

将 `.env.example` 复制为 `.env.local`，在本机填写 `R2_ACCESS_KEY_ID` 和 `R2_SECRET_ACCESS_KEY`。此文件被 Git 忽略，不复制进审核快照。S3 SDK 不需要另外的 Cloudflare“令牌值”，不要把该令牌当成机密访问密钥。

```bash
npm run r2 -- check
```

命令只执行 HeadBucket 和 ListObjectsV2（最多读取一个条目的存在性，不输出文件名），不会上传、删除文件或修改公开状态。输出能证明当前凭据的桶访问和列表读取权限，不能证明写入权限或公开下载已成功。错误输出不会打印 SDK 请求、凭据或服务端 XML。

若曾在聊天或其他公开位置粘贴凭据，应在 Cloudflare 撤销重建，再用本地编辑器替换 `.env.local` 中的两个值。无需把新密钥发到聊天中。之后重新运行连接检查即可。

## R2 单本与整批上传

维护者明确授权上传后，可执行以下命令。PLAN 为最新 prepare 返回的有效计划编号，BOOK 为计划中书籍的稳定 ID：

```bash
# 单本验证；完整读取公开下载，核对 SHA-256、大小、MIME 和中文文件名
npm run r2 -- upload --plan PLAN --book BOOK

# 整批上传；首本通过公开下载校验后，才以最多 3 路并发处理其余书籍
npm run r2 -- upload --plan PLAN

# 独立只读复核整批文件，不执行上传
npm run r2 -- verify --plan PLAN
```

整批优先以 mute-compulsion（无声的强制）为首本；计划没有该 ID 时使用计划中的第一本。操作从计划中冻结的 EPUB 读取，不在上传时重新读取原始文件。

对象键为 books/ID/SHA256.epub；上传设置 application/epub+zip、attachment、UTF-8 中文文件名及哈希元数据。上传前核对已有对象，只在对象缺失时条件写入，不覆盖冲突对象。对同一计划重跑即可恢复：已上传文件被复用，但仍重新下载校验。

进度与结果写入 `.local/uploads/PLAN-upload.json`（单本报告额外含 BOOK）；每本都记录公开 URL、大小、完整 SHA-256、响应头和校验时间。verify 使用独立的 PLAN-verify.json 报告。状态必须是 verified，且 verified 数量与 expected 一致，才能报告整批成功；failed 时查看 failures，修复网络或权限后重跑原命令。

同一桶的本地操作使用锁文件串行执行。异常退出遗留锁时先检查锁内 PID 与系统进程，确认任务已停止后才清理，不自动夺锁。失败时保留已上传对象和日志，不删除源文件或远端文件。

上传不修改正式书目或发布网站；公开直链在上传完成后即可访问。接入网站发布前，还需验证百度、实现 publish / resume、确认生产部署及失败恢复。
