# 百度备用下载调研

本页记录 Windows 原生候选、批量发布及版本更新边界。Cloudflare R2 仍是独立主下载渠道。全馆 65 本原始 EPUB 均已上传并创建永久密码分享，PCS 回读 SHA-256 均验证通过；正式书目当前版本的 65 个百度入口已全部通过匿名访问检查（64 个 EPUB + 1 个加密 RAR）。异常书原始 EPUB 分享和失败证据保留，R2 仍提供原 EPUB。调研和实施均不使用 WSL。

## 候选与已完成的只读检查

- 百度官方 [`bdpan-storage`](https://github.com/baidu-netdisk/bdpan-storage) 不支持 Windows 原生命令行环境；不采用需要 WSL 的方案。百度官方 [`mcp`](https://github.com/baidu-netdisk/mcp) 面向企业生产场景，不作为个人图书馆当前候选。
- 候选为 [BaiduPCS-Go v4.0.2](https://github.com/qjfoidnh/BaiduPCS-Go/releases/tag/v4.0.2) Windows x64。可执行文件位于 `%LOCALAPPDATA%/YuukoLibrary/tools/BaiduPCS-Go-v4.0.2`。下载资产 SHA-256 为 `ce72b3155a710b7c4a2b15611c3aebd11a057d7cccf0529e7703bdde04f0aa30`，已与 GitHub release 资产摘要核对。
- 浏览器 MCP 读取百度请求头可取得 `BDUSS`、`STOKEN`；`document.cookie` 不含这两个值。主代理已从浏览器请求头提取凭据并保存至本机受限凭据文件，原值未回显到对话、未写入仓库或报告；CLI 使用该凭据登录。凭据 JSON 存放于 `%LOCALAPPDATA%/YuukoLibrary/credentials/baidu.json`，CLI 独立配置存放于 `%LOCALAPPDATA%/YuukoLibrary/credentials/baidupcs-config`，并通过 `BAIDUPCS_GO_CONFIG_DIR` 指向配置目录。主代理已核对 ACL 仅当前用户与 SYSTEM 可访问；不要将凭据文件、配置或值提交到仓库、日志或报告。
- 本机 CLI 登录成功，`quota`、`ls /ebook`、`share list` 只读操作成功。拟定但尚不存在的远端 hash 目录上执行 `meta` 时，CLI 返回百度错误 31066（文件或目录不存在），但进程退出码仍为 0。因此任何后续流程都必须检查命令结果及远端元信息，不能只看退出码判定成功。
- 旧文件不能直接充当当前馆藏文件：抽查 `/ebook/保卫马克思 - Louis Althusser.epub` 为 418395 字节，而正式 `book-a62fdd10c370` 当前书目记录为 684495 字节。旧目录或旧分享不能作为当前版本下载地址。

## 单本验证结果与对象方案

`endnotes-2` 当前版本单本试传通过：在独立 SHA 目录上传，`meta` 回读得到预期大小 549533 字节及 fsId `630426207141040`；`share set --period 0` 创建密码保护分享，shareId 为 `4713549165`。无百度登录 Cookie 的访问会跳到提取码验证页，不会暴露文件；提交本次随机提取码后验证接口返回 `errno=0`，密码有效。之后使用 PCS 重新下载并独立计算完整 SHA-256，与正式文件 SHA 完整匹配（前缀 `4471412d`）。登录凭据不入 Git；公开分享 URL、提取码和解压码随书目公开。此验证只证明分享密码有效；访客是否能直接下载、是否须百度登录仍由百度平台规则决定。

上传位置按书籍 ID 和当前 EPUB SHA-256 隔离，每书每个 SHA 使用独立远端目录，仅对该版本文件创建单文件分享。`Book.id` 是外层身份；已实现 `downloads.baidu` 字段为 `url`、`code`、`fileSha256`、`fsId`、`shareId`、`path`、`expiresAt`、`verifiedAt`，并可选包含 `archive`。替换文件产生新目录和新分享，不复用旧版本链接。R2 流程与对象地址保持独立。

CLI 帮助中已核对的语法：

```text
upload --policy skip <local> <remoteDir>
share set -p <code> --period 0 <path>
```

`upload --policy skip` 跳过远端已存在对象。分享期 `0` 表示永久分享，但平台不保证链接永不失效；即使永久分享失效，也不能把旧链接当作有效。试传已验证这些命令的单本效果。

## CLI 与分享更新规则

维护命令：

```bash
npm run baidu -- status [--id ID|--all]
npm run baidu -- prepare [--id ID|--all]
npm run baidu -- publish --id ID
npm run baidu -- publish --all
npm run baidu -- prepare-archive --id ID --name FILE.rar [--archive-password CODE]
npm run baidu -- publish-archive --manifest FILE
```

`status` 本地只读显示书目、SHA 匹配的 `.local/plans` EPUB 与 journal 状态；`prepare` 对源 EPUB 进行本地 SHA/大小核验，不执行云写入。`publish --id ID` 或 `publish --all` 是显式云写入。发布用项目锁和 `.local/baidu/journal.json` 逐本记录检查点；上传后核验 `meta`，PCS 下载回读并核对完整 SHA-256，创建 `--period 0` 密码分享并用 `share list` 核对链接、提取码、路径、分享 ID 和期限，最后只更新书目对应的 `downloads.baidu`。全馆已运行完成，65 本上传分享与 SHA 回读通过，`publish --all` 最终报告 65 complete、0 unavailable。除 `downloads.baidu` 外，本批书目的其它字段（包括 R2 链接和 updatedAt）与任务基线一致。R2 地址不受影响。提取码保存在本地 journal 和正式书目，详情页会显示；书目及网页是公开信息，提取码也会向读者公开。账号凭据始终保存在仓库外。完整参数见 [发布命令参考](publishing-cli.md#baidu-备用下载)。

`share list` 只证明账户登记了分享及其路径、密码和期限，不代表访客一定能打开 URL。批量完成前还要逐条做无百度登录态的匿名链接检查，并在必要时输入提取码确认。若账户列表记录正常，但匿名页和已登录浏览器均显示链接不存在，原因未明：停止对该文件重建分享，保留 journal 证据并从公开书目中剔除不可用百度入口，R2 继续提供下载。不得将这种状态简单算作可用分享，也不得推断链接失效原因。

用户已明确授权在单本试传成功后为全部 65 本当前版本创建密码保护永久分享。原始 EPUB 批次已完成：65 本均上传、创建分享、PCS 回读并完整 SHA-256 验证通过，总计 108772188 字节。正式书目现在有 65 个不同百度入口，64 个普通 EPUB 分享和 1 个 RAR 分享，65/65 匿名提取码检查全部通过。新增书籍在正式书目与匹配的本地 `.local/plans` EPUB 准备完成后，可使用 `publish --id ID` 创建当前版本分享。更新同一本书时，journal 以书籍 ID + EPUB SHA 保存版本历史；新 SHA 使用独立远端目录、检查点和分享，旧版链接不会自动成为当前版本。已验证的上传与回读检查点可续跑。相同 EPUB 字节仅元数据变化时，publish 可复用当前 SHA 的已验证分享，但要求 file、R2 key/URL 与百度下载字段符合 journal 记录的书目守卫。journal schema 1 会在写操作前备份原件并迁移到 schema 2；status 只读显示当前/历史版本和迁移状态。RAR 新版由维护者明确指定新包名与密码，通过新的 `prepare-archive` manifest 形成独立版本；journal key 同时包含源 EPUB SHA、RAR SHA 和文件名摘要，旧 RAR 记录保留。`publish-archive` 上传或切换当前版本前核对绑定的 manifest，不会覆盖历史记录。`--period 0` 表示永久分享设置，不代表链接保证永远有效。R2 的地址和状态独立维护。

异常书为《独裁政权的危机》（`book-3acd82072f85`）：其原 EPUB 永久分享在 `share list` 中路径、提取码和期限均正确，但匿名请求与已登录浏览器页面都显示“百度网盘-链接不存在”，原因未明。不要重复创建该原始 EPUB 分享，也不要将此现象归因为违规或审查。维护者已指定 `普兰查斯著作01.rar`，用 WinRAR 7.13 `-hp` 隐藏文件名加密；无密码解压失败，使用维护者提供的解压密码后成功，RAR SHA-256 为 `e83854585d5a908048ef99fde3e12646b776c68bae503f95164c49567b184083`，内部 EPUB 完整 SHA-256 与正式原件一致。该 RAR 永久密码分享通过匿名提取码挑战和正确密码提交，独立确认可访问。主代理在冻结站点预览中核验详情弹窗显示文件名、提取码、解压密码及链接；复制成功，剪贴板不可用时文本自动选中，320px 布局不溢出。`publish-archive --manifest .local/baidu/archive-prepared.json` 实际复核并导入了既有分享（`reused: true`），没有再次上传或创建分享；专用 archive journal 记录该新版本，原始 EPUB journal/分享保留。原始 R2 EPUB 未改变。

上传和分享费用、长时间登录续期行为尚未确认。CLI 返回码不能独立作为成功证据：拟定 hash 目录的 `meta` 曾返回百度错误 31066 而进程退出码为 0，故每项必须同时验证操作结果与远端元信息。凭据保存在仓库外的本机受限文件，CLI 配置单独存放并设当前用户和 SYSTEM ACL；绝不写入 Git。整个方案不依赖 WSL。

## 接入门槛

异常书采用压缩包是对此次已观察问题的维护者指定处理，不是自动通用降级。未来只有维护者明确指定包名和解压密码时才采用；不得自动猜测书名/文件名、原因或对其他书实施加密。当前包名为 `普兰查斯著作01.rar`，维护者指定解压密码 `114514`；该密码作为公开书目元数据由前端备用下载弹窗显示，与百度提取码分别展示并可复制。

65 条当前分享已写入正式书目并通过匿名提取码可访问检查；maintenance health 的最近一次 263 项全站检查中，65 条百度分享均通过。默认 HEAD 仅检查下载响应头，不能据此宣称已校验完整下载哈希。备用入口已随 release `r-26a96f39-d704-4c26-98a8-956f8eec2094` 上线。2026-11-06 20:03（Asia/Shanghai）生产验证核对了完整索引、65 个详情页及每页直链/百度 URL、提取码和稳定评论 term；RAR 文件名与解压密码 `114514` 正确，真实浏览器中弹窗复制密码成功。固定站点快照来源为 clean commit `c9fdfcb`。不得将旧文件、旧目录分享用于当前书目；不得让百度候选影响 R2 主下载。失败、登录状态不明或远端状态不明时停止并检查，不能盲目重试创建分享。


## 版本恢复

分享创建或导入结果未知时，先查状态和 journal：

```bash
npm run baidu -- status --id ID
npm run baidu -- recover --id ID --source-sha SHA
```

不带分享 ID 的 `recover` 只报告待恢复版本、远端路径和已保存状态。维护者应在百度 `share list` 中人工确认目标记录，再传入精确 `--share-id` 与 `--code`。工具会重新核对远端 meta、完整回读 SHA-256、分享路径/期限/提取码，并保存恢复检查点；结果未知时不会再创建分享。对当前版本，确认后可恢复书目引用；对历史 SHA，只标记历史分享已解决，不覆盖当前书目。RAR 恢复必须使用对应 manifest：

```bash
npm run baidu -- recover --manifest '.local/baidu/archive-manifests/MANIFEST.json' --share-id SHARE_ID --code CODE
```

raw EPUB 与 RAR journal 之间若存在未知状态，新版本发布会停止，必须先核实并恢复。始终保留 journal、schema 迁移备份和迁移记录；不要通过删除文件或改写状态绕过保护。即使分享记录验证通过，匿名平台状态也可能变化，需用 `npm run maintenance -- health` 做全馆匿名提取码检查。
