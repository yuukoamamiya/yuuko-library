# 本地维护指南

先读根目录 [AGENTS.md](../AGENTS.md)。本文件说明本地开发、内容准备和 R2 操作；参数约定见 [命令参考](publishing-cli.md)，发布网页见 [部署指南](pages-deployment.md)。

## 环境与启动

需要 Node.js 24+。Windows 普通命令使用 Git Bash，结构化数据处理优先 Python。

```bash
npm ci
npm run dev
```

默认地址为 http://127.0.0.1:4321/。正式书目和封面已保存在仓库中，本地浏览不需要 EPUB 原文件或云凭据。

```bash
npm run verify
npm run verify -- --docs
npm run check
npm test
npm run build
```

check 包含 Astro 与 TypeScript 检查；test 运行现有解析、检索、快照和上传／发布测试；build 将正式书目构建到 dist/。

常规本地验收可运行 `npm run verify`，依次执行 check、test、build、`git diff --check`，任一步失败立即停止。纯文档修改使用 `npm run verify -- --docs`，仅检查 Markdown 本地链接与 diff 空白，不调用测试、构建或云服务。

## 配置与凭据

[site.config.json](../site.config.json) 保存非敏感配置：站点 URL、下载域名、R2 桶及账号级 S3 终结点、Pages 项目与生产分支、Cloudflare Zone。

复制 [.env.example](../.env.example) 到本机 .env.local，填写 R2_ACCESS_KEY_ID 和 R2_SECRET_ACCESS_KEY。S3 客户端不使用另外的 Cloudflare“令牌值”，终结点中不包含桶名。

Wrangler OAuth 凭据由 Wrangler 自行保管。CLOUDFLARE_DNS_API_TOKEN 仅供将来使用 API 编辑 DNS，可留空；现有域名已配置完成。

不要输出、提交或复制凭据到网站产物。发现泄漏时在 Cloudflare 撤销重建，在本机替换后重新检查连接。

## 新增与更新

普通 AI 译本需稳定 ID、本地路径和模型名：

```bash
npm run book -- prepare --id example-book --epub 'D:/Books/example.epub' --model '模型名称' --category philosophy
```

中文出版物转录明确声明类型，不填 model：

```bash
npm run book -- prepare --id chinese-transcription --epub 'D:/Books/chinese.epub' --kind transcription --category history
```

更新正式书目中已存在的 ID：

```bash
npm run book -- prepare --id example-book --update --epub 'D:/Books/example-new.epub' --model '模型名称' --category philosophy
```

新增不能占用现有 ID，更新不能使用不存在的 ID。同名书按作者等身份区分，不根据标题自动合并。

批量操作使用自己创建的本地 JSON 清单：

```json
[
  {
    "id": "example-book",
    "epub": "D:/Books/example.epub",
    "model": "模型名称",
    "update": true
  },
  {
    "id": "another-book",
    "epub": "D:/Books/chinese.epub",
    "kind": "transcription",
    "categories": ["history"]
  }
]
```

```bash
npm run book -- prepare --manifest .local/my-books.json
```

首批清单在原维护机器的 .local/ 中，不随 Git 分发；新环境需自行准备路径和清单。旧版清单对已经上架的 ID 再次执行时，需要 update: true。

prepare 会复制 EPUB、提取资料与封面，并构建一个隔离计划。原文件不被修改，正式目录也不在这一步更新。原始主题词写入 subjects，独立分类写入 categories。新增必须提供 1–2 个有效分类 ID；单本使用可重复的 --category，批量使用 categories 数组。更新省略分类时保留原分类。分类 ID 见 src/lib/categories.ts；首次迁移对照见 [分类迁移记录](category-migration.md)。

## 审核计划

下方 PLAN、BOOK、RELEASE 均为占位，实际操作时替换为命令输出的编号或稳定书籍 ID。

```bash
npm run book -- preview --plan PLAN
npm run book -- validate --plan PLAN
npm run book -- status --plan PLAN
```

preview 仅绑定 127.0.0.1，默认端口 4321；端口占用时可设置 --port 4322。它只开放生成的网页，不提供输入 EPUB 或内部计划文件。validate 重读输入、核对快照、重新构建并检查索引和页面链接。

本机报告位于 .local/plans/PLAN/report.md。工作区源码、依赖、配置、正式书目或计划快照变化时，计划可能失效，应重新准备。原始文件在复制后变化不会自动进入已冻结的计划。

## 上传与公开下载核验

取得本次上传授权后执行：

```bash
npm run r2 -- check
npm run r2 -- upload --plan PLAN --book BOOK
npm run r2 -- upload --plan PLAN
```

check 只读；单本命令用于先验证一个样本；整批命令先验证首本再最多三路并发。计划中有 mute-compulsion 时优先使用它，否则使用计划第一本。

每本均核对 R2 对象及公开下载的完整哈希、大小、MIME 和中文文件名。一致对象可复用；冲突时停止该文件，不覆盖。单本失败不代表其余文件均失败，最终报告需检查 expected、verified 和 failures。

```bash
npm run r2 -- verify --plan PLAN
```

verify 只读复核，不执行上传。上传与校验报告保存在 .local/uploads/，同一有效计划重跑 upload 可复用已存在的正确对象。不要在进程仍运行时清除锁；异常锁需先确认 PID 对应的任务已停止。

R2 文件成功上传后，使用 [部署指南](pages-deployment.md) 中的独立 pages 命令发布网页。上传不会同步正式书目，也不会部署网站。百度备用分享使用独立 `npm run baidu` 流程，详情见[发布命令参考](publishing-cli.md#baidu-备用下载)；不会使用 WSL，也不影响 R2。异常书只有维护者指定 RAR 文件名后，才可用 `prepare-archive` 本地加密/核验，再用 `publish-archive --manifest FILE`：已有分享记录时复核并复用；没有既有记录时上传、回读并创建永久分享后导入书目。新版 EPUB/RAR 会进入独立版本历史；若分享结果未知，先使用对应 `recover` 命令核对，不得盲目重复创建分享或删除 journal。


## 维护数据备份与清理

先将本地维护数据备份到工作区之外的独立目录。备份会从正式书目匹配源 EPUB，并以 SHA-256 内容寻址存储，相同字节只保存一个对象：

```bash
npm run maintenance -- backup --output 'D:/LibraryBackups/book-share'
npm run maintenance -- backup-verify --backup 'D:/LibraryBackups/book-share'
npm run maintenance -- restore --backup 'D:/LibraryBackups/book-share' --target 'D:/Restore/book-share'
```

备份结果中的 `complete` 必须为 true 才能用于恢复或清理。备份清单记录缺失、未知或不支持文件；凭据、EPUB 以外的非允许类型和敏感文件不会被纳入。若正式书目所需 EPUB、百度 journal 或已发布 RAR 缺失，备份不完整。manifest sidecar 与每个对象均使用 SHA-256 校验，验证器也拒绝未登记文件、符号链接和路径冲突。默认恢复只做 dry-run；确认输出目标路径是新目录后才加 `--apply`。恢复保留文件路径并输出 RAR manifest 的 `.json.restored.json` 副本；原备份不会修改。备份保存维护数据，不包含 Git 源码、依赖目录或登录凭据。恢复目录不是可直接运行的完整仓库：先从 Git clone 目标版本并运行 `npm ci`，再核对备份来源版本与文件清单，将需要的维护数据导入该新 clone；凭据须从仓库外的凭据管理位置单独配置。

生成清理计划前确保备份完整有效：

```bash
npm run maintenance -- cleanup-plan --backup 'D:/LibraryBackups/book-share' --output '.local/cleanup-plan.json'
```

计划仅含当前预览识别为候选的 `.local/plans`、`.local/releases`、`.local/uploads` 目录，并逐文件确认内容已在同工作区备份中。查看计划中的路径、字节数及原因；只有这些候选都明确可清理时，才把计划摘要作为精确确认值执行隔离：

```bash
npm run maintenance -- cleanup-apply --plan '.local/cleanup-plan.json' --confirm PLAN_DIGEST --quarantine 'D:/LibraryBackups/quarantine-2026-11-06'
npm run maintenance -- cleanup-undo --quarantine 'D:/LibraryBackups/quarantine-2026-11-06'
```

`cleanup-apply` 会重新核对计划、备份、候选集合和当前内容，确认隔离目录位于工作区外，再将目录移入隔离区；它不会永久删除。2026-11-06 本机实际 preview 共 29 项（28 protected、1 unknown），候选字节数为 0；7 条 unknown 原因包括旧 plan/release 缺元数据及 markdown 摘要/remote inventory 状态未知，cleanup-plan 按工具规则预期因未知状态阻断，尚未实际执行该命令。没有执行 quarantine 或删除；需先人工整理未知快照并重跑预览。若要撤销，使用 `cleanup-undo`，且原路径必须空缺、隔离内容哈希必须吻合。隔离目录的最终删除属于独立文件清理，需先核对具体目标并取得本次明确授权。线上或本地状态未知、依赖关系不明及百度 journal、RAR manifest/对象均不作为清理候选。

`health` 默认对全馆逐条调用百度匿名提取码 challenge endpoint，验证分享 URL 与提取码能通过挑战；这不是文件完整下载/SHA 检查。`--skip-baidu` 可只查站点/R2；默认下载检查为 HEAD，`--full-download` 才读取全文件并核对 SHA-256。使用 `--book ID` 仅检查样本，报告须标为 sample。

主代理于 2026-11-06 完成本机备份演练：备份 `D:/Documents/book-share-backups/maintenance-20261106-2055` 为 `complete=true`、`missing=[]`，包含 5155 个逻辑文件（1,553,412,143 字节），CAS 去重后为 1178 个对象（137,887,900 字节）。`backup-verify` 与新目录 `restore-drill-20261106-2055` 恢复通过；主代理用独立 Python 对恢复的 5155 个文件逐一比较 SHA-256 和大小，全部匹配。恢复的 `archive-prepared.json.restored.json` 路径指向新目录内已发布 RAR；WinRAR 无密码列名为 11 项、正确密码测试/解包通过，内部 EPUB SHA 与源文件匹配。该演练不证明真实 quarantine/delete 已执行。
