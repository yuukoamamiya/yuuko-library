# 图书评论区

详情页在版本信息后提供 utterances 评论组件。组件只在读者点击“加载评论”后加载 `https://utteranc.es/client.js`；评论内容由 GitHub Issues 承载，网站不保存评论或 GitHub 凭据。读者需要 GitHub 账号登录后才能发表评论。

## 启用配置

主仓库 `yuukoamamiya/yuuko-library` 与评论仓库分开。启用前需创建公开仓库 [`yuukoamamiya/yuuko-library-comments`](https://github.com/yuukoamamiya/yuuko-library-comments)，并在该仓库安装/授权 [utterances GitHub App](https://github.com/apps/utterances)。App 需要读取 Issues 并创建/更新 Issues 的权限；按 GitHub 安装流程授予评论仓库访问。utterances 会在首次访问每个书籍线程时创建 Issue，仓库应保持公开，使访客能查看讨论。

组件固定设置 `repo=yuukoamamiya/yuuko-library-comments`、`theme=github-light`，Issue 匹配模式为 `issue-term`。映射值为 `book:<稳定书籍 ID>`，不依赖书名、详情页 URL 或标题，因此改名不改变评论归属。不要手工更改已有书籍 ID。

评论是按需加载的：打开详情页不会请求 utterances；读者点击按钮才插入第三方脚本。加载状态会等待嵌入 iframe 自身的 load 事件，脚本失败、iframe 失败或超时均提供重试，同时保留按稳定 term 搜索 GitHub Issues 的链接。禁用 JavaScript 时可使用该链接。`preview.json` 本地预览不会加载第三方评论，也不会创建测试 Issue。

## 管理与边界

评论仓库 Issues 即评论内容。仓库管理员可按 GitHub Issues 的常规方式查看、锁定或删除不当内容；管理者可以在该仓库的 Issues 设置中决定是否允许创建 Issue。关闭 Issues 会使 utterances 无法创建新书目线程。评论仓库必须保留与站点配置一致的所有权和名称，否则组件需同步更新。

本次本地代码变更尚未部署；评论仓库和 App 的创建、安装与授权由主代理处理。完成配置并部署后，需在线核验详情页按需加载、首次创建 Issue、已存在线程匹配、GitHub 登录评论流程和 320px 手机布局。
