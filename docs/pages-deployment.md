# Pages 部署指南

当前网站为 [library.amamiyayuuko.com](https://library.amamiyayuuko.com)，默认地址为 [yuuko-library.pages.dev](https://yuuko-library.pages.dev)。Pages 项目 yuuko-library 使用 Direct Upload，生产分支参数为 main。源码 GitHub 仓库的 main 与该参数同名，但 Git push 不自动部署。

维护约束见 [AGENTS.md](../AGENTS.md)，命令语义见 [命令参考](publishing-cli.md)。

## 网络与登录

使用项目锁定的 Wrangler。若网络需要本机 10809 HTTP 代理，Git Bash 下给单条命令设置环境变量：

```bash
HTTPS_PROXY=http://127.0.0.1:10809 HTTP_PROXY=http://127.0.0.1:10809 npx wrangler whoami
```

首次或授权失效后：

```bash
HTTPS_PROXY=http://127.0.0.1:10809 HTTP_PROXY=http://127.0.0.1:10809 npx wrangler login --device --scopes account:read user:read pages:write zone:read
```

按提示完成浏览器设备授权。Wrangler 保存 OAuth 凭据，不把它们写进项目或聊天。上述权限用于现有 Pages 操作；DNS 写入另需权限。只涉及 Pages 时，不必为其他 Workers 服务的缺失权限提示重复扩权。

Node 原生 fetch 的代理命令同时需要 NODE_USE_ENV_PROXY=1；代理不可用时先检查本机服务，不修改全局网络配置。

## 创建项目

本项目已经创建，日常更新无需重建。切换新账号或复制为另一个项目时，先确认 site.config.json 中的目标配置，再创建新项目。

```bash
npx wrangler pages project create PROJECT --production-branch main
```

锁定的 Wrangler 4.158.0 在首次创建新项目时曾尝试把 Pages 命令转交 Workers；本项目当时用 --force 显式创建 Pages。现有项目使用正常 pages deploy。将来遇到类似行为应先核对当前 CLI 帮助和实际状态，不盲目重跑或把项目迁到 Workers。

## 正式构建与发布

PLAN、RELEASE 和 UPLOAD_REPORT 是占位，需替换为实际本地编号和报告路径。先通过 book 准备、预览、校验，再通过 r2 上传或只读复核取得匹配的验证报告。

```bash
npm run pages -- prepare --plan PLAN --report UPLOAD_REPORT
```

prepare 只生成本地正式快照，返回发布编号 RELEASE。书目与报告的 ID、哈希、大小、对象键和 URL 必须一致。正式页面移除预览标记，提供真实下载入口。

取得本次发布授权后：

```bash
HTTPS_PROXY=http://127.0.0.1:10809 HTTP_PROXY=http://127.0.0.1:10809 NODE_USE_ENV_PROXY=1 npm run pages -- deploy --release RELEASE
```

部署后继续验证：

```bash
HTTPS_PROXY=http://127.0.0.1:10809 HTTP_PROXY=http://127.0.0.1:10809 NODE_USE_ENV_PROXY=1 npm run pages -- verify --release RELEASE --url https://library.amamiyayuuko.com
```

verify 检查线上发布标识、首页、索引和本次书籍的详情下载链接，成功后把正式书目和封面同步回工作区。之后按授权提交和推送 Git，以便其他环境能从源码重建当前站点。

deploy 出错或超时时先检查 project-status 与线上 release.json；不要把结果未知当作未部署。若线上已经成功而本地同步失败，可以保留快照并重跑 verify。

## 仅更新页面或分类导航

正式书目已具备下载地址时，可以跳过 EPUB 导入与 R2 上传，生成本地快照：

```bash
npm run pages -- prepare --site-only
```

该命令冻结源码、封面与完整正式书目；复制前后校验一致性，保留每本书的 publishedAt / updatedAt。返回的 RELEASE 使用同样的 deploy / verify 流程。它不会验证 EPUB 的公开文件内容；需要复核文件时仍使用 r2 verify。书籍文件或书目内容更新继续使用 book prepare 和上传报告流程。

## 中断与恢复

统一从本次计划、上传报告和发布编号判断下一步，不把本地 ready 当作已上线：

| 中断位置 | 下一步 |
| --- | --- |
| 本地审核 | book status / validate；stale 时重新 prepare |
| R2 上传中断 | 查看上传报告；重跑相同有效计划的 upload，复用已验证的一致对象 |
| Pages 提交中断或 uncertain | pages status --release RELEASE，核对远端部署；不要重复提交 |
| 远端已成功 | pages verify --release RELEASE --url HTTPS_URL，完成全站验证和本地同步 |
| 远端已明确 failure / canceled | 查明原因后 pages deploy --release RELEASE --retry；仅此情况允许显式重试 |
| 线上成功、本地同步中断 | 重跑同一 RELEASE 的 verify；已同步书籍可复用，本地新修改会阻止覆盖 |

```bash
npm run pages -- status --release RELEASE
```

status 只读查询匹配发布编号与生产分支的远端记录，不上传、不部署、不同步。Node fetch 需要代理时设置 NODE_USE_ENV_PROXY=1。deploy 同时使用 Wrangler 和 Node fetch，因此也需要此设置。

每个 Pages 项目使用 .local/pages/PROJECT/publish.lock，提交前写入 active.json 和发布目录 deployment.json。进行中、未定位或未知状态均停止；新发布也不能越过另一份尚未验证完成的 active 发布。成功后 verify 清除对应 active 记录。远端成功的重复 deploy 只提示 verify，不再次提交。

异常退出可能留下锁。先核对锁中 PID 的进程与任务确已终止，再人工移除指定锁；不自动按时间清锁。保留 active.json、deployment.json 和发布快照用于恢复。远端始终无法定位或确认失败的提交保持阻塞，需核对 Pages 控制台，不把“未查到”当作失败。永久失败且需重新制作快照时，核对失败记录后人工解除对应 active 状态，再准备新发布。

线上验证核对 schemaVersion=2 发布标记、全站书目数量与摘要、完整索引 ID 集合与字节摘要、所有书籍详情和下载链接。全站 books 与 changedBooks 分开记录。旧 schemaVersion=1 快照需重新准备，不能交给新版部署流程绕过校验。

## 域名

网站域名与下载域名用途分开：

| 域名 | 用途 |
| --- | --- |
| library.amamiyayuuko.com | Pages 网页 |
| book.amamiyayuuko.com | R2 文件 |

现有网站的 Pages 关联、CNAME 和 HTTPS 已验证。DNS 是维护者一次性手动配置的 CNAME：library → yuuko-library.pages.dev，开启代理；日常发布不需要再编辑它。

查看状态：

```bash
HTTPS_PROXY=http://127.0.0.1:10809 HTTP_PROXY=http://127.0.0.1:10809 NODE_USE_ENV_PROXY=1 node --import tsx tools/pages/cloudflare.ts domain-status
```

将来变更域名时，先关联 Pages，再配置 DNS，最后检查 active、HTTPS、首页与发布标识。可选 DNS Token 的权限应限制到相关 Zone，仅在需要命令行修改 DNS 时本地配置。

## 发布资料与源码

发布快照及 deployment.json 位于 .local/releases/RELEASE/，只保存在本机；Git 保存源码、正式书目和封面，不保存输入 EPUB、密钥、上传报告或发布缓存。

本机迁移时妥善保管所需快照与验证报告，凭据单独处理。缺少旧快照时应重新准备，不虚构旧报告。待办和实现缺口统一见 AGENTS.md。

官方参考：[Direct Upload](https://developers.cloudflare.com/pages/get-started/direct-upload/) · [Pages 域名 API](https://developers.cloudflare.com/api/resources/pages/subresources/projects/subresources/domains/methods/create/)
