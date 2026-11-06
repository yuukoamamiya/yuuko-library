# 维护命令参考

本文只列已实现接口，以 package.json、各工具的 --help 和代码为准。操作流程见 [本地维护指南](local-development.md) 与 [部署指南](pages-deployment.md)。统一 book publish、resume 和 bundle 尚未实现；不得将它们作为可运行命令。

## book：本地审核

| 命令 | 作用 |
| --- | --- |
| npm run book -- prepare --id ID --epub FILE --model MODEL --category philosophy | 准备一份 AI 译本 |
| npm run book -- prepare --id ID --epub FILE --kind transcription --category history | 准备中文出版物转录 |
| npm run book -- prepare --manifest FILE | 批量生成一个审核计划 |
| npm run book -- preview --plan PLAN | 启动隔离的本地预览 |
| npm run book -- validate --plan PLAN | 核对输入和快照，重建并检查产物 |
| npm run book -- status --plan PLAN | 查看 prepared / stale 状态及阻塞项 |

prepare 的 --id 是最多 80 字符的小写英文、数字和连字符。--epub 为本地文件；AI 译本必须提供非空 --model，转录本不得提供模型。--update 只用于现有正式书目。

--baidu 只接受 off 或 optional，默认 off。当前实现只把该策略写入计划，没有自动百度分享能力。--manifest 不能与单书字段混用。清单条目支持 id、epub、model、kind、update、baidu、categories。新增须用 --category ID（最多指定两次）或 categories 数组指定 1–2 个有效分类；更新省略时沿用原分类。分类 ID：philosophy、politics-society、political-economy、history、culture-media、language-translation。

preview 可用 --port 调整端口。所有 book 命令支持 --json；脚本使用以下形式，避免 npm 横幅混入 JSON：

```bash
npm run --silent book -- status --plan PLAN --json
```

book 的 JSON 信封含 schemaVersion、command、planId、status、data、warnings、error；构建进度写 stderr。prepare、preview、validate、status 不执行云写入。

## r2：上传与校验

| 命令 | 作用 |
| --- | --- |
| npm run r2 -- check | 只读检查桶访问和列表权限 |
| npm run r2 -- upload --plan PLAN --book BOOK | 单本条件上传并完整下载校验 |
| npm run r2 -- upload --plan PLAN | 先校验首本，再上传整批 |
| npm run r2 -- verify --plan PLAN | 整批只读复核 |
| npm run r2 -- verify --plan PLAN --book BOOK | 单本只读复核 |

upload 缺失对象时写入，一致对象复用，冲突对象不覆盖。verify 不补传文件。使用当前有效计划中的冻结文件，不重新读取最初输入路径。

结果为 JSON，进度写 stderr；脚本可用 npm run --silent r2。上传和 verify 使用独立报告，保存在 .local/uploads/。检查 status=verified、verified=expected 且 failures 为空后才能报告全部通过。

## maintenance：线上体检、备份与本地清理

| 命令 | 作用 |
| --- | --- |
| `npm run maintenance -- health [--book ID] [--full-download] [--skip-baidu]` | 只读检查生产站点、索引、详情、封面、下载响应及百度匿名分享 |
| `npm run maintenance -- backup --output DIR [--source-root DIR]` | 创建 SHA-256 内容寻址、去重的本机备份 |
| `npm run maintenance -- backup-verify --backup DIR` | 校验 manifest sidecar、备份对象哈希、路径及未登记文件 |
| `npm run maintenance -- restore --backup DIR --target NEW_DIR [--apply]` | 默认 dry-run；加 `--apply` 才恢复到不存在的新目录 |
| `npm run maintenance -- cleanup-plan --backup DIR --output FILE` | 用完整备份与当前清理预览生成固定候选计划 |
| `npm run maintenance -- cleanup-apply --plan FILE --confirm DIGEST --quarantine DIR` | 校验计划摘要、备份、清单和文件哈希后移入独立隔离目录 |
| `npm run maintenance -- cleanup-undo --quarantine DIR` | 校验隔离内容后恢复原路径 |

`health` 默认对当前正式书目逐条匿名访问百度分享并验证提取码；`--skip-baidu` 仅跳过百度检查。默认下载检查为 HEAD 响应头，`--full-download` 才执行完整 GET 与 SHA-256；指定 `--book` 的结果是样本，不能称全馆通过。匿名检查证明提取码挑战可通过，不保证百度平台后续持续可用。

备份只收录工具允许的站点/维护文件和匹配源 EPUB；按 SHA-256 内容对象去重，并生成 manifest 校验摘要。未知/敏感/不支持文件会列为缺失，`complete=false` 的备份不能用于恢复或清理。执行恢复前先运行 `backup-verify`；恢复目标必须是新目录。该备份保存维护数据，不包含 Git 源码、依赖目录或登录凭据，也不是可直接运行的完整仓库。恢复应在 Git clone 目标版本并运行 `npm ci` 后，核对来源版本与清单，再把所需数据导入新 clone；凭据从仓库外单独配置。备份目录需由维护者另行保管。

清理计划只覆盖识别的 `.local/plans`、`.local/releases`、`.local/uploads` 候选，并要求备份来源工作区一致、每个候选文件都在完整备份中且哈希相同。apply 的 digest 是精确确认值；操作仅将候选 rename 到工作区之外的 quarantine，不永久删除。需要清除 quarantine 时须先人工核对具体路径和内容，并在本次会话取得明确授权；不得把预览或计划当作删除授权。具体恢复、限制和示例见 [本地维护指南](local-development.md#维护数据备份与清理)。百度 journal、RAR/manifest 与归档文件是受保护依赖，不在清理候选中。

## baidu 备用下载

| 命令 | 作用 |
| --- | --- |
| `npm run baidu -- status [--id ID|--all]` | 本地只读查看书目、SHA 匹配的源 EPUB 和 journal 状态 |
| `npm run baidu -- prepare [--id ID|--all]` | 本地核验源 EPUB 的完整 SHA-256 和字节数，不写云端 |
| `npm run baidu -- publish --id ID` | 显式发布单本百度分享并更新该书正式书目 |
| `npm run baidu -- publish --all` | 显式批量发布当前全馆并更新书目 |
| `npm run baidu -- prepare-archive --id ID --name FILE.rar [--archive-password CODE]` | 根据当前正式 EPUB 在本机生成、验证隐藏文件名的单文件 RAR，并写 manifest |
| `npm run baidu -- publish-archive --manifest FILE` | 显式核对/上传归档并将确认的分享记录导入该书目 |
| `npm run baidu -- recover --id ID [--source-sha SHA] [--share-id ID --code CODE]` | 诊断或认领指定 EPUB 版本的未知分享，不重复创建分享 |
| `npm run baidu -- recover --manifest FILE --share-id ID --code CODE` | 精确恢复 manifest 对应 RAR 版本的未知分享 |

status / prepare 默认覆盖全部正式书目；可传 `--id` 或 `--all` 明确选择。publish 必须明确指定 `--id` 或 `--all`。执行前需要在 `.local/plans/` 有与书目 EPUB 完整 SHA-256 和大小匹配的源文件。

publish 在 `.local/baidu/journal.json` 记逐书检查点并使用互斥锁。每本创建 ID/SHA 独立目录，按 skip 策略上传，回读 `meta`，PCS 下载到本地并重新校验完整 SHA-256，创建 `--period 0` 密码分享，再通过 `share list` 核对分享记录后更新该书 `downloads.baidu`。`--period 0` 表示永久设置，不保证链接永不失效。提取码保存在本机 journal 和公开书目，站点访客可以看到并使用；账号凭据只留在仓库外的本机配置中。

新增书籍在完成正式书目准备并放入匹配 EPUB 后可用 `publish --id ID`。更新同一书籍若 SHA 变化，journal 按书籍 ID 与 EPUB SHA 保存版本历史；SHA 改变时新版本独立执行上传、回读与分享，旧版记录保留。若某次分享结果未知，先用 `recover --id ID` 查看待核对版本；人工核对百度 `share list` 后，使用 `recover --id ID --source-sha SHA --share-id SHARE_ID --code CODE` 精确认领既有分享，不会再次创建分享。仅同一文件字节未变、书目元数据变化时可复用该版本已验证分享；仍会检查书目变更守卫。RAR 使用独立 archive journal 按源 EPUB SHA、RAR SHA 和文件名记录历史；新版本需新的 manifest。RAR 未知分享用 `recover --manifest FILE --share-id SHARE_ID --code CODE` 精确恢复。恢复只在完整核对远端对象、回读 SHA 与分享列表后认领记录，不会重复创建分享；历史 RAR 不会自动覆盖当前书目。状态查询保持只读，并显示当前与历史版本及 migration pending。journal schema 1 会在首次写入时先备份原文件再迁移；请勿手工删除备份或 migration 记录。恢复时保留 journal，不手工删除或改写。旧版分享不得作为当前版本链接。R2 上传和下载地址完全独立。当前全馆批量运行状态及完成计数见 [百度调研与运行记录](baidu-downloads.md)。

`prepare-archive` 是本地操作，需要 WinRAR `Rar.exe` 和与当前书目 SHA 匹配的 `.local/plans` EPUB。维护者必须给定 `--name FILE.rar`；工具仅将当前正式 EPUB 放入压缩包，使用 WinRAR `-hp` 隐藏文件名，并检查无密码无法列名、RAR 自身哈希以及解包后的 EPUB 完整 SHA。当前指定包名为 `普兰查斯著作01.rar`，默认解压密码为 `114514`，也可用 `--archive-password CODE` 指定。密码写入公开书目供详情弹窗展示，不是私密凭据。

`publish-archive` 接受本地 manifest。若 manifest 带有已准备的分享记录，工具会核对本地 RAR/内部 EPUB、远端 meta、完整回读 SHA 和 `share list`，再将记录导入 `downloads.baidu.archive`。已有已验证分享时只复核并复用；没有既有记录时会上传、回读并创建永久分享。已发布 RAR 禁止由 `prepare-archive` 重制，应复用原 manifest；若无原 manifest，先人工核对版本记录再处理。命令成功不替代匿名 URL/提取码可访问检查。

## pages：正式发布

| 命令 | 作用 |
| --- | --- |
| npm run pages -- prepare --plan PLAN --report UPLOAD_REPORT | 本地生成固定正式产物，返回 RELEASE |
| npm run pages -- prepare --site-only | 从正式书目生成仅站点更新快照，保留全部书籍时间 |
| npm run pages -- status --release RELEASE | 只读查询本地状态和匹配的远端部署 |
| npm run pages -- deploy --release RELEASE | 用 Wrangler 上传并部署 |
| npm run pages -- verify --release RELEASE --url HTTPS_URL | 核对线上版本与链接，再同步正式书目 |

prepare 核对上传报告与本次书籍记录，启用下载按钮并生成 release.json。线上标记 schemaVersion=2，books 为全站数量、changedBooks 为本批变更数量，catalogDigest 是稳定排序后完整书目的摘要；createdAt 为部署快照时间。仅站点更新使用 prepare --site-only，不需要 EPUB 或上传报告，不修改书籍时间。deploy 在执行前核对产物清单及摘要；它不自动创建 Pages 项目，也不验证上线内容或同步正式书目。

deploy 的成功状态为 submitted；仍需 verify 确认 published。若输出 uncertain，先查看部署状态及线上 release.json，再判断是否需要重试。verify 成功后更新 catalog/books 和 public/covers。需要恢复本地同步时，可对同一发布快照重新运行 verify。

pages 工具按项目加锁，并通过发布编号、分支和提交说明查重。已成功提交的快照只提示 verify；进行中或结果未知时停止。远端确认失败后，可使用 deploy --release RELEASE --retry 显式重试。status 不上传、不部署、不同步书目。恢复步骤见 [部署指南](pages-deployment.md#中断与恢复)。尚未提供跨 book / r2 / pages 的统一自动发布命令。计划编号使用 p-UUID，发布编号使用 r-UUID，均为本机资料，不能在其他环境凭编号自动恢复。

## 本地统一验收与独立线上体检

```bash
npm run verify
npm run verify -- --docs
npm run maintenance -- health
npm run maintenance -- health --book BOOK_ID --full-download
npm run maintenance -- cleanup-preview
```

`verify` 顺序运行 check、test、build，再检查已暂存和未暂存 diff 空白；首个命令失败、被信号终止或无法启动时立即返回失败步骤。`--docs` 只扫描 Markdown 本地链接及 diff 空白，不运行测试、构建或云服务。

`health` 仅从正式书目与 site.config.json 读取期望值，以只读 HTTP 检查首页、全量索引、详情页、封面和公开下载；不需要 .local、EPUB 原件或云凭据，也不修改书目。`--book` 限定样本，结果明确标记为 sample。默认 HEAD 只核对下载状态和响应头，不能证明文件内容正确；`--full-download` 流式 GET 并校验完整字节数及 SHA-256。进度写 stderr，结果 JSON 写 stdout，任一失败返回非零。

`cleanup-preview` 仅生成本地清单，报告路径、类型、大小、时间、保护理由、候选和未知项；命令没有 apply/delete。需要实际清理时使用上文的 backup、cleanup-plan、cleanup-apply 和 cleanup-undo 流程，apply 仅隔离不永久删除。30 天内快照、prepared / active / submitting / submitted / uncertain 状态、沿 release/plan/report 的依赖关系和最近两份成功发布会保留；线上状态、符号链接边界或报告格式未知时保守保护。候选仍需人工逐项确认并另行明确授权。此命令不清理旧 EPUB 或 R2 对象。

## Cloudflare 域名工具

入口为：

```bash
NODE_USE_ENV_PROXY=1 node --import tsx tools/pages/cloudflare.ts project-status
```

支持 project-status、domain-status、domain-add、dns-status、dns-add。前两项及 dns-status 读取状态；domain-add 会关联网站域名；dns-add 仅在无记录时创建对应 CNAME，遇到其他记录停止。

Wrangler OAuth 提供 Pages 权限；DNS API 单独使用可选的 CLOUDFLARE_DNS_API_TOKEN。代理与登录方式见部署指南。不要直接运行并回显 wrangler auth token。

## 退出状态与故障处理

| 工具 | 当前约定 |
| --- | --- |
| book | 0 成功；2 输入错误；3 计划过期或冲突；4 本地验证／构建或未分类错误 |
| r2 | 0 成功；操作失败为 5 |
| pages | 0 成功；错误为 1 |

book 文案或历史设计中更细的云错误码并不代表当前统一发布命令已存在。恢复以实际工具的状态、报告和远端事实为准。任何上传成功都不代表网页已经上线。
