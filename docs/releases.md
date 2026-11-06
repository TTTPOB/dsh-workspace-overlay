# 构建与交付

本包要求 Node >=24.9、DSH 0.2.2-rc.1、Cordis 4.1.0、Loader/Include 1.1.0。Workspace 配置仅作输入：运行时条目变更由 `WorkspaceTree.commit(change)` 丢弃，不进入 Include 持久化 journal；加载、修改、释放最后一个 lease 和重新加载都保留原文件字节。

普通开发依赖固定到 npm 上的官方 0.2.2-rc.1；正式构建由 workspace overrides 固定 Agent/preset registry 为发布合同中的 fork1 Release 资产。官方 Agent/preset registry 没有 `registerSetup` / `place`，不能替代 fork 完成类型检查、构建与 Agent placement 测试；不通过兼容层或类型断言绕过。

`.github/release-dependencies.json` 列出所需 0.2.2-rc.1-fork1 Agent/preset registry，资产发布前 `source` 为 `null`，`prepare:release` 和 consumer 验证会拒绝继续。取得本地产物后，将包名到 tarball 的映射写入忽略目录下的 JSON，运行 `node .github/scripts/prepare-local.mjs <映射文件>`；它创建 `.artifacts/local-source` 隔离副本并注入 overrides，不修改真实安装。然后在副本执行 `pnpm typecheck && pnpm test && pnpm build && pnpm release:pack && pnpm verify:consumer`。本机路径不得进入正式 manifest 或锁文件。

正式交付须先填入不可变 GitHub Release 资产 URL 并重新安装生成锁文件，再由长期分支 Actions Release 发布 0.4.0；不覆盖旧资产。插件由 profile 普通 dependencies 安装（`autoInstallPeers: false`），共用插件行按 overlay 在前、envrc 在后声明。本任务不修改日用 profile、Host 或真实安装。
