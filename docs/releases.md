# 构建与交付

本包由解析共用插件的 profile 普通 dependencies 安装（`autoInstallPeers: false`），`$DSH_HOME/cordis.patch.yml` 统一声明 `workspace-registry`、`workspace-mcp-manager`、`workspace-agent-integration`。首次构建和交付由 DSH 主 pipeline 负责；本库不在 push、PR 或 tag 上独立发布，也不修改日用 profile 或 Host。

开发时以官方 DSH `0.1.7-rc.2` 依赖基线安装，再显式以已构建的 Agent、preset registry `fork1` tarball overrides 替换；纯官方基线没有 `registerSetup`／`place`，不能完成本包的类型检查。只在隔离工作树使用临时 overrides，不将本机 `file:` 路径提交到 manifest 或锁文件。通过聚焦测试后构建 `dist`，用 `pnpm pack` 检查 `0.2.0` 资产及已删除入口均未出现在归档中。

部署时官方同名 fork 由 pnpm 全局 overrides 替换，独立插件由正常 profile dependencies 安装；验证实际模块解析、五条共用插件行及 overlay 位于 envrc 前。此处保留的 `cordis.patch.yml` 是独立 bundle 格式；日用 bundles 只含官方 base／Web app，避免自动追加本包造成重复插入。
