# 架构与数据说明

本文件说明当前实现；待办与决策状态统一见 [AGENTS.md](../AGENTS.md)，术语见 [CONTEXT.md](../CONTEXT.md)。文件名保留原有 project-plan.md，内容不再作为早期设想清单。

## 系统分工

| 部分 | 当前实现 |
| --- | --- |
| 页面 | Astro 静态生成：首页与每本书的详情页 |
| 检索 | 浏览器加载 search-index.json，使用原生 JavaScript 搜索和筛选 |
| 书目 | Git 中的 catalog/books/*.json |
| 封面 | Git 中的 public/covers/ |
| EPUB | Cloudflare R2，通过独立域名下载 |
| 部署 | Pages Direct Upload；本地构建后由 Wrangler CLI 上传 |
| 维护 | TypeScript 编写的 book、r2、pages 三组工具 |
| 验收与只读状态 | verify 统一本地检查；maintenance health / cleanup-preview 用于独立只读诊断 |

站点没有业务数据库或阅读器。翻译、转录和元数据刮削在本项目之外完成。GitHub 保存可重建网页的源码和正式书目，推送不会自动部署。

## 数据流

1. 维护者提供本地 EPUB、稳定 ID 与版本来源。
2. book prepare 复制 EPUB，提取资料和封面，生成隔离的审核计划并构建预览。
3. 确认后 r2 upload 上传并完整下载校验，生成验证报告。
4. pages prepare 对照上传报告生成正式发布快照，移除预览标记并启用下载按钮。
5. pages deploy 使用 Wrangler 发布固定产物。
6. pages verify 检查线上标识、首页、索引和详情链接，通过后同步正式书目与封面。
7. Luna 子代理选择性提交本任务改动，主代理独立验收；只有主代理在用户明确要求 push 时推送。若待推送提交涉及前端变化，该要求同时授权先准备固定站点快照，再推送、生产部署并验证。

R2 上传、页面部署和源码推送各有独立结果；用户要求 push 时，若待推送范围有前端变化，须按维护流程联动部署和验证，不能用 push 成功替代上线验证。

## 目录

```text
src/                       Astro 页面、组件、样式及浏览器检索
catalog/books/             已上线书目 JSON
public/covers/             已上线封面
site.config.json           站点、R2 和 Pages 的非敏感配置
tools/book/                EPUB 导入及本地审核
tools/r2/                  文件上传和公开下载校验
tools/pages/               正式构建、部署、域名检查及书目同步
tests/                     解析、搜索、快照和发布逻辑测试
.local/plans/              本地审核快照，p-UUID
.local/uploads/            上传日志、校验报告和本地锁
.local/releases/           发布快照与部署记录，r-UUID
.local/pages/              项目锁、active 发布指针与远端状态缓存
.env.local                 本地凭据；不进入 Git 或产物
```

## 书目格式

当前 Book 类型定义在 [src/lib/books.ts](../src/lib/books.ts)，提取逻辑在 [tools/book/epub.ts](../tools/book/epub.ts)。

| 字段 | 当前含义 |
| --- | --- |
| schemaVersion | 当前为 1 |
| id | 稳定书籍标识；与文件名及书名分开 |
| title、authors、description | 书名、作者数组、纯文本简介 |
| subjects | 从 EPUB subject 提取的原始标签 |
| categories | 1–2 个独立分类 ID，更新 EPUB 时默认保留 |
| cover | 站内封面路径，或 null |
| edition.kind | ai-translation 或 transcription |
| edition.model | 维护者给出的模型名称；转录本为 null |
| file | EPUB 的 SHA-256、字节数和原文件名 |
| downloads | R2 对象键、公开 URL，以及当前为 null 的 baidu 占位字段 |
| publishedAt、updatedAt | 发布时间与更新时间，ISO 8601 UTC；页面按 Asia/Shanghai 展示 |

转录本单独标注来源。新版本沿用书籍 ID；不同作者的同名书使用不同 ID。当前每本书只链接一个版本。

### 分类与标签的迁移边界

Calibre／EPUB 的 subject 属于标签，保留原始顺序和内容；独立 categories 用于六个稳定大类。分类名单与校验规则位于 src/lib/categories.ts。首次 65 本迁移见 [分类迁移对照](category-migration.md)，没有改变 EPUB、下载地址或书籍时间。

## EPUB 解析与检索

解析 OPF 元数据，兼容 EPUB 2 的 cover 声明及 EPUB 3 的 cover-image。作者保留顺序，subject 只去除空项、首尾空白和完全重复项。简介转为保留段落的纯文本。

缺少标题或解析失败时停止准备；作者、简介和封面缺失时报告并使用缺省展示，不改写 EPUB。解析器拒绝 DTD 和越界资源路径，不把主动内容 SVG 作为封面直接发布。

检索范围为书名、作者、简介和现有主题词，不检索正文或翻译模型。关键词经过 NFKC 与大小写归一化，空格分词后全部命中才匹配；分类与标签分别筛选，并与关键词取交集；旧 subject URL 参数仍表示原始标签。查询状态写入 URL。

## R2 与 Pages

EPUB 对象键为 books/ID/SHA256.epub。内容变化产生新地址，避免同一个 URL 返回旧缓存。上传设置 EPUB MIME、attachment 和 UTF-8 中文文件名。

上传前检查已有对象，一致则复用；缺失时条件写入，不覆盖冲突对象。公开 GET 核对完整 SHA-256、大小和响应头，不使用 ETag 替代内容哈希。失败和旧版本对象不默认删除，目前没有自动清理策略。

正式网页仅包含书目、封面和前端资源，不包含 EPUB 或凭据。发布产物以文件清单和摘要检查完整性，release.json 用于核对线上版本。生产目标为 Pages 项目 yuuko-library，网站与下载域名分开配置。

## 已知边界

- 百度备用下载未实现；Windows 原生候选已完成只读调研，上传和分享仍待明确授权后验证，详见 [百度备用下载调研](baidu-downloads.md)。utterances 已在本地页面通过 GitHub OAuth、发表评论、自动建 Issue 和刷新后稳定映射验证，尚未 push/deploy；详见 [评论区配置与管理](comments.md)。
- R2 有本地桶级锁和逐本检查点；Pages 有项目锁、远端查重、status 与 verify 恢复入口，但跨三组工具的统一自动发布入口尚未提供。
- release.json schemaVersion=2：books 统计全站，changedBooks 统计本批；完整书目摘要、全站索引摘要及全部详情页参与验证。
- 新发布快照附 Git 提交、脏状态、冻结站点输入 SHA-256 与来源字段。部署要求 clean Git 提交；旧线上 schema2 marker 可由独立体检读取，但会标注缺少溯源信息，旧本地快照必须重新 prepare。源码修改后尚未部署时，线上 marker 不包含新字段。
- maintenance health 从正式 Git 书目检查线上页面与资源，无需原始 EPUB 或云凭据；HEAD 响应用于轻量检查，完整 GET 才校验 EPUB 内容 SHA-256。cleanup-preview 只报告本地对象状态，不执行删除；R2/旧 EPUB 清理仍需单独流程。
- 有内容变化的本批书籍才更新 updatedAt；prepare --site-only 保留书籍时间，部署快照时间记录在 createdAt。
- 审核和发布快照只存于本机 .local/；其他电脑无法仅靠 Git 恢复旧计划，需要保留迁移资料或重新准备。

对应改进只在 AGENTS.md 的待办清单中跟踪。
