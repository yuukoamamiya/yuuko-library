# 项目方案

状态：已完成页面、EPUB 导入、本地审核、R2 上传/校验及 Pages CLI 部署与线上验证，网站已上线至 library.amamiyayuuko.com。日期：2026-11-06。当前操作见 [本地使用说明](local-development.md) 和 [Pages 部署说明](pages-deployment.md)。

## 1. 目标与范围

提供一个个人维护的 AI 翻译电子书分享网站，总量预计不超过 200 本。任何访客均可浏览资料，直接从 R2 下载 EPUB；不要求网站账号。中国大陆访问尽力可用，不承诺各运营商访问质量。

| 能力 | 第一版决定 |
| --- | --- |
| 首页 | 封面、书名、作者、分类、翻译模型；默认按首次上架时间倒序 |
| 书籍详情 | 独立、可直接访问的介绍页，展示完整简介、模型、文件大小和下载入口 |
| 分类 | 来自 EPUB 的 subject；一本书可属于多个分类；没有 subject 时显示“未分类” |
| 搜索 | 书名、作者、简介、分类；不检索正文，不默认检索模型 |
| 版本来源 | AI 翻译由维护者提供模型显示名称；中文出版物转录不显示翻译模型 |
| 下载 | R2 主下载；有可用链接时显示百度网盘备用入口和提取码 |
| 译本 | 每本书一个当前 EPUB；新译本替换当前下载，不提供版本选择 |
| 维护 | 命令行准备与发布；本地预览后由维护者确认 |

不实现在线阅读、鉴权、评论、收藏、下载统计、数据库或网页管理后台。百度端可能要求登录，这不改变网站及 R2 主下载免登录的要求。

## 2. 技术方案

- Astro + TypeScript，使用静态输出模式。首页 `/`，详情 `/books/<id>/`，不运行服务端渲染或 Pages Functions。
- 分类筛选和搜索使用少量原生 JavaScript，不引入 React。小型 JSON 索引随静态站发布。
- 搜索采用 Unicode NFKC 规范化、大小写归一化和子串匹配；空格分隔的多个词要求全部命中。中文可直接按连续文字检索。无拼音、语义或模糊搜索。
- 搜索和分类可组合，状态写入 URL 查询参数，便于返回和分享。分类名称直接显示原值，URL 参数由标准编码函数编码。
- Node.js LTS 环境运行维护 CLI，复用 TypeScript 和项目依赖；使用 EPUB/ZIP/XML 库解析元数据，S3 SDK 访问 R2，锁定版本的 Wrangler CLI 发布 Pages。实施时选择仍在维护的具体依赖并提交锁文件。
- EPUB 不进入 Git、不使用 LFS，也不进入 Pages 构建产物。封面导出为本地图片，字体及页面资源不依赖第三方 CDN。

首版页面需适配手机和桌面，筛选、搜索、下载入口可通过键盘操作；无封面时显示通用占位图。详情页的资料和下载入口直接存在于 HTML 中，关闭 JavaScript 仍能使用。

## 3. 资料来源与结构

输入 EPUB 已经由独立流程完成刮削。本项目只提取，不新增元数据补全、外部刮削或人工覆盖系统。

- 标题、作者、简介、subject 从 OPF 元数据读取；封面兼容 EPUB 2 的 cover 声明和 EPUB 3 的 cover-image 标记。
- 保留作者顺序；subject 仅去掉首尾空白、空项和完全相同的重复项，不翻译、不合并同义分类。
- 简介可能包含 HTML，第一版转成可读纯文本并保留段落；渲染时按文本转义。
- 标题缺失或 EPUB 无法解析时准备失败；作者、简介、封面缺失时在报告中提示，页面使用“作者未提供”“暂无简介”或占位图，不改写 EPUB。
- AI 译本的翻译模型名称必须由维护者提供；中文出版物转录显式声明类型，model 为 null。内部 ID 使用显式传入的稳定英文小写短名，与 EPUB 标题、文件名分离。
- 更新同一本书时显式指定原 ID；不依赖标题猜测身份，不因书名变化改变详情页地址。

拟定目录：

```text
src/
  pages/                         # Astro 页面
  components/                    # 页面组件
catalog/books/<id>.json           # 已发布书籍资料与当前下载位置
public/covers/<id>/<sha256>.jpg    # 已发布封面；实际扩展名取决于导出格式
tools/book/                      # 上架 CLI
site.config.json                 # 站点与下载域名、Pages 项目名、R2 bucket 等非敏感配置
.local/plans/<plan-id>/           # 待审核快照、EPUB、副本封面、预览构建和变更报告
.local/releases/<plan-id>/        # 发布日志、检查点和失败恢复资料
docs/                            # 项目方案及命令说明
```

`.local/`、`.env*`（除模板）、依赖和构建目录纳入忽略规则。密钥通过环境变量或系统凭据配置，不写进书籍 JSON、发布报告或静态索引。尚未实现时不创建假锁文件、假书目或虚构书籍资料。

书籍记录字段约定：

| 字段 | 含义 |
| --- | --- |
| schemaVersion | 首版为 1 |
| id | 稳定书籍 ID |
| title / authors / description / subjects | 从 EPUB 提取的字符串、作者数组、纯文本简介和分类数组 |
| cover | 相对于站点根目录的图片路径，或 null |
| edition.kind / edition.model | ai-translation 配合人工提供的模型名；transcription 配合 null |
| file.sha256 / file.bytes / file.filename | 原始 EPUB 的内容哈希、字节数和建议下载文件名 |
| downloads.r2Key / downloads.r2Url | 当前文件的对象键和公开 HTTPS 地址 |
| downloads.baidu | 未启用或失败时为 null；成功时记录 url、提取码、有效期和关联的 EPUB SHA-256 |
| publishedAt / updatedAt | ISO 8601 UTC 时间；首次发布时间在更新时保留，界面按 Asia/Shanghai 展示 |

待审核记录与发布记录使用同一字段定义，但只有发布阶段才能补入真实百度链接和发布时间。搜索索引由书目生成，不作为第二份人工维护数据。

## 4. 存储与部署

### R2

使用 Standard 存储，通过下载子域名公开访问，例如 `downloads.example.com`。域名示例不是实际配置。使用 bucket 限定的 S3 读写凭据运行上传。

对象键为 `books/<id>/<sha256>.epub`。逻辑上仍是“替换当前译本”，但不覆盖相同 URL 的内容，防止 CDN 或浏览器缓存返回旧译本。下载响应使用 `application/epub+zip`，并设置包含 UTF-8 文件名的 attachment Content-Disposition；下载按钮使用普通 HTTPS 链接，不在浏览器跨域读取 EPUB，首版无需为此配置 CORS。

上传后通过 S3 元数据核对大小及 SHA-256 元数据（不能把 multipart ETag 当作文件 SHA-256）；通过公开下载域名验证可获取性。实装验证应包含一次真实下载并计算哈希。

失败发布产生的对象暂留，不自动删除。已替换的旧对象至少保留 7 天，便于发布恢复；清理不属于默认上架流程，另行明确选择目标后执行。站点只链接当前文件，旧公开 URL 在清理前可能仍可访问，不提供历史版本入口。

### Pages

新建 Direct Upload 类型的 Pages 项目，用 Wrangler 上传本地构建产物。生产分支名和项目名写入非敏感配置并显式传给部署命令；GitHub 只作版本管理，不启用 push 自动生产部署。

Cloudflare 文档说明 Direct Upload 项目不能直接切换到 Git integration。当前选择符合“确认后发布”，将来改变部署模式时应重新评估项目迁移。

本地准备阶段只启动 localhost 预览，不上传 Pages 预览部署。收到确认后，发布阶段才允许访问 R2 写入接口、百度分享接口和 Pages 部署接口。

### 费用

截至 2026-11-06 的 R2 Standard 文档：每月 10 GB-month 存储、100 万次 A 类操作、1,000 万次 B 类操作免费，公网流出流量免费；超额存储 $0.015/GB-month。假设 200 本、平均 20 MB，文件约 4 GB，正常小站通常可落在免费额度内。账号其他用量及暂留对象同样占额度；免费额度不是账单上限。首次配置时查看账号用量和可用的账单提醒，不宣称已设置硬性支出封顶。

## 5. 百度网盘验证

优先验证官方组织 `baidu-netdisk/bdpan-storage` 的 bdpan CLI。当前文档支持上传、JSON 输出及永久分享；Windows 原生不支持，需要 WSL。OAuth 首次授权需要人工完成，后续可复用并刷新 Token。

实施第一步用一本允许公开分享的真实 EPUB 验证：

1. 安装前检查当前官方文档和安装包来源，确认 WSL 与本机 CLI 的文件路径映射。
2. 由维护者完成授权；不得在命令输出或仓库中记录 Token。
3. 上传文件，创建永久分享，读取真实返回的链接和提取码。
4. 浏览器打开链接，核实文件、有效期和实际下载体验；对照本地 EPUB 确认文件一致。
5. 确认账号是否需要额外权益或接口付费，记录实测日期、版本和费用条件。

以上需要独立明确授权，因为会产生公开分享。文档支持不视为账号实测成功。验证未通过时，全站仍可只用 R2。备用链接在有结果的书籍上显示，不显示无效按钮，不保证“永久”链接永不被撤销。

## 6. 维护流程与发布边界

以 `prepare → preview → 人工确认 → publish` 为主流程，完整参数、状态和恢复约定见 [上架命令规范](publishing-cli.md)。

确认绑定具体 plan ID 和变更摘要，范围包括计划中的书籍、模型、目标站点、R2 文件及可选百度公开分享。确认后如计划内 EPUB 或模型被改动，或工作区的页面模板、依赖、站点配置、书目基线改变，重新准备和预览。原始输入路径的文件变化不影响已复制的快照，也不会自动进入发布。CLI 不把一个自动生成的标记当作聊天中的用户授权。

发布先上传并验证文件，再部署引用这些文件的页面。R2 失败阻止部署；可选百度失败记录原因并继续 R2 单渠道发布。新译本不能沿用旧 EPUB 的百度链接。

不同计划不能同时向同一站点发布。恢复使用原计划和检查点，不在不确定时反复创建分享或盲目重复部署。不能把文件上传成功报告成网站发布成功。

## 7. 实施顺序与验收

1. **导入与页面**：实现 EPUB 提取、静态列表/详情、分类和搜索。用真实样本核对作者、简介、subject、封面；补充 EPUB 2/3、中文文件名和无封面的针对性样本。
2. **本地维护流程**：实现 prepare、preview、status、validate，保证不需要云凭据即可准备；预览覆盖新增和更新、手机与桌面，以及组合筛选、空结果、无 JavaScript 详情页。
3. **存储验证**：配置后实测 R2 的公开下载、响应头和文件哈希；独立验证百度 CLI。百度未就绪时仍可继续。
4. **受控发布**：实现 publish 和 resume，验证未确认不执行远程写入；确认后按计划部署，并正确报告百度失败、R2 失败、部署失败和部署结果不确定。
5. **首本上线**：以一本真实书走完整预览与确认流程，核对线上详情页、搜索/分类和真实下载；然后再批量导入。

2026-11-06 已完成初始 65 本的导入、R2 验证与整批上传：108,772,188 bytes，逐本公开下载的完整 SHA-256、响应头和中文文件名校验通过，并与远端对象列表核对一致。本机报告见 `.local/uploads/2026-11-06-upload-summary.md`。随后已通过独立 pages CLI 完成生产部署、线上核验及书目同步；library.amamiyayuuko.com 的域名和 HTTPS 状态均为 active，65 本详情页已核验。百度备用下载及统一 book publish/resume 流程仍待实现。

## 8. 查证来源

以下资料于 2026-11-06 查阅，首次实施时再次核实变化：

- [Cloudflare Pages Direct Upload](https://developers.cloudflare.com/pages/get-started/direct-upload/)
- [R2 定价](https://developers.cloudflare.com/r2/pricing/)
- [R2 上传对象与 HTTP 元数据](https://developers.cloudflare.com/r2/objects/upload-objects/)
- [R2 与缓存的一致性](https://developers.cloudflare.com/r2/reference/consistency/)
- [百度网盘官方组织 CLI/Skill 项目](https://github.com/baidu-netdisk/bdpan-storage)
- [bdpan 命令参考](https://github.com/baidu-netdisk/bdpan-storage/blob/main/skills/baidu-drive/reference/bdpan-commands.md)
- [bdpan 授权说明](https://github.com/baidu-netdisk/bdpan-storage/blob/main/skills/baidu-drive/reference/authentication.md)
