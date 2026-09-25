# 构建与交付

个人 Web 发行组合直接依赖本包，并在自己的 patch 声明 `workspace-registry`、`workspace-mcp-manager`、`workspace-agent-integration`。首次构建和交付由 DSH 主 pipeline 负责；本库不在 push、PR 或 tag 上独立发布，也不修改日用 profile 或 Host。

开发时以官方 DSH `0.1.7-rc.2` 依赖基线安装，再显式以已构建的 Agent、preset registry `fork1` tarball overrides 替换；纯官方基线没有 `registerSetup`／`place`，不能完成本包的类型检查。只在隔离工作树使用临时 overrides，不将本机 `file:` 路径提交到 manifest 或锁文件。通过聚焦测试后构建 `dist`，用 `pnpm pack` 检查 `0.2.0` 资产及已删除入口均未出现在归档中。

部署时 DSH 全局安装闭包由个人 Web 包和 pnpm overrides 拥有；验证实际模块解析、五条插件行及 overlay 位于 envrc 前。此处保留的 `cordis.patch.yml` 是独立 bundle 格式，不作为日用 profile 的依赖来源。
