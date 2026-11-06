# 百度备用下载调研

本页记录 Windows 原生候选和单本验证边界。百度备用下载尚未接入；Cloudflare R2 仍是当前独立主下载渠道。调研遵守不使用 WSL 的要求。

## 候选与已完成的只读检查

- 百度官方 [`bdpan-storage`](https://github.com/baidu-netdisk/bdpan-storage) 不支持 Windows 原生命令行环境；不采用需要 WSL 的方案。百度官方 [`mcp`](https://github.com/baidu-netdisk/mcp) 面向企业生产场景，不作为个人图书馆当前候选。
- 候选为 [BaiduPCS-Go v4.0.2](https://github.com/qjfoidnh/BaiduPCS-Go/releases/tag/v4.0.2) Windows x64。可执行文件位于 `%LOCALAPPDATA%/YuukoLibrary/tools/BaiduPCS-Go-v4.0.2`。下载资产 SHA-256 为 `ce72b3155a710b7c4a2b15611c3aebd11a057d7cccf0529e7703bdde04f0aa30`，已与 GitHub release 资产摘要核对。
- 浏览器 MCP 读取百度请求头可取得 `BDUSS`、`STOKEN`；`document.cookie` 不含这两个值。主代理已从浏览器请求头提取凭据并保存至本机受限凭据文件，原值未回显到对话、未写入仓库或报告；CLI 使用该凭据登录。凭据 JSON 存放于 `%LOCALAPPDATA%/YuukoLibrary/credentials/baidu.json`，CLI 独立配置存放于 `%LOCALAPPDATA%/YuukoLibrary/credentials/baidupcs-config`，并通过 `BAIDUPCS_GO_CONFIG_DIR` 指向配置目录。主代理已核对 ACL 仅当前用户与 SYSTEM 可访问；不要将凭据文件、配置或值提交到仓库、日志或报告。
- 本机 CLI 登录成功，`quota`、`ls /ebook`、`share list` 只读操作成功。拟定但尚不存在的远端 hash 目录上执行 `meta` 时，CLI 返回百度错误 31066（文件或目录不存在），但进程退出码仍为 0。因此任何后续流程都必须检查命令结果及远端元信息，不能只看退出码判定成功。
- 旧文件不能直接充当当前馆藏文件：抽查 `/ebook/保卫马克思 - Louis Althusser.epub` 为 418395 字节，而正式 `book-a62fdd10c370` 当前书目记录为 684495 字节。旧目录或旧分享不能作为当前版本下载地址。

## 拟验证的对象方案

上传位置按书籍 ID 和当前 EPUB SHA-256 隔离，每书每个 SHA 使用独立远端目录，仅对该版本文件创建单文件分享。预期记录的映射字段为 `bookId`、`fileSha256`、`path`、`fsid`、`shareId`、`url`、`code`、`expiresAt`。替换文件产生新目录和新分享，不复用旧版本链接。R2 流程与对象地址保持独立。

CLI 帮助中已核对的语法：

```text
upload --policy skip <local> <remoteDir>
share set -p <code> --period 7 <path>
```

`upload --policy` 默认 `skip`；分享期 `7` 表示 7 天，`0` 表示长期，但不保证链接永不失效。语法核对不等于完成上传或分享验证。

## 尚待授权和验证

主代理已准备当前正式 `endnotes-2` EPUB（549533 字节），并异步向用户询问对该单本执行上传及 7 天分享的明确授权；当前状态为待授权。未获得授权前不执行上传、创建分享或其他写操作。

获授权后仍需逐项验证：上传后核对远端元信息、重新下载后计算完整 SHA-256 与本地正式文件一致、创建单文件 7 天分享并确认链接/提取码/有效期、检查登录续期行为，并查明费用条件。记录命令输出的语义结果并核验远端状态，不能以零退出码代替成功证据。上传、分享、完整性、续期和费用均尚未验证；没有接入站点字段或自动降级逻辑。

## 接入门槛

单本验证通过且用户另行批准接入后，才考虑 CLI 自动化和失败降级。不得将旧文件、旧目录分享用于当前书目；不得让百度候选影响 R2 主下载。每次内容更新需要新的 SHA 目录和分享映射。失败、登录状态不明或远端状态不明时停止并检查，不能盲目重试创建分享。
