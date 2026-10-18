# dsh-workspace-overlay 开发约定

树外 DSH bundle：提供 workspace 级 Cordis scope（`workspaceCordis`）、workspace-aware MCP manager（`workspaceMcp`）与 Agent placement。`dsh-workspace-envrc` 依赖本包提供 canonical workspace scope 与 workspace-aware MCP manager，两个 bundle 必须由同一 profile 按 overlay 在前的顺序声明。

## 不可动摇的契约

- **Workspace identity 是 `realpath(resolve(cwd))`**，精确匹配。不向上找 Git root，不做 monorepo 或 symlink 祖先解析。cwd 不存在、不可读或不可 realpath 时拒绝创建 Agent。
- **绝不修改 Host 的 `process.env`。** 环境差异只落在 workspace-owned 子进程的 spawn 边界或 scope 自有快照上。
- **Workspace 配置是项目代码，属于信任边界。** `<workspace>/.dsh/cordis.yml` 使用与 preset 相同的 Cordis 行方言；`trustWorkspaceConfig` 默认 `true`，只有显式启用本 bundle 的 profile 会读取它。
- **进程数契约**：global 行每 `serverName` 一进程；workspace override 每 workspace 一进程；无同名 override 的 workspace 继承 global、零额外进程。同名 namespace 整体遮蔽，不产生混合视图。
- **要遮蔽某个 global 行，该 global 行也必须走本包入口** `dsh-workspace-overlay/mcp/workspace-client`。官方 `@deepseek-ai/dsh-mcp-client` 注册的行不在 manager 的名字集合里，不会被 mask，其工具会漏进 workspace 视图。
- **Workspace MCP 行必须 `failOnStartupError: true`**，否则连接失败时 Agent 会建在坏 server 上。
- **Mount audit 拒绝把 service 发布到 root realm**；在 `isolate` realm 内发布合法。
- 所有注册必须 effect-owned：最后一个 lease 释放后不得留下 watcher、timer、composition、tool 注册、mask 或子进程。

## 已知边界（不要假装已解决）

- 不 watch preset 的 `agent.cordis.yml`，也不把 live Agent 重绑到新 preset 代际。
- 不 watch JS/包模块与嵌套 include YAML；改本地代码后需重新保存顶层 `cordis.yml` 或重启 Host。
- 没有 blue-green：失败的 reload 不保留上一棵好树。
- `workspace-agent-integration` 与 `workspace-mcp-manager` 这两个 provider 自身不支持 live HMR。
- 不要同时激活自带 bundle patch，否则重复插入行。

## 验证

```sh
pnpm typecheck && pnpm test && pnpm build && pnpm verify:consumer
```

`pnpm test` 通过真实 Loader composition 跑 fixture，不用手工 `ctx.plugin(...)` 代替。`pnpm verify:consumer` 用打包入口与正式 Host 解析器检查解析与激活，不启动 Host。

接口与行为见 [README.md](README.md)；决策与已否决方案见 [ADR 0001](docs/adr/0001-workspace-scoped-composition.md)。

## 分支与发布

- 长期发布分支为 `main`，位于 TTTPOB remote `origin`（github.com/TTTPOB/dsh-workspace-overlay）；本地长期分支必须跟踪 `origin/main`，不跟踪第三方上游。
- 开发和测试使用独立分支或 worktree。
- 发布前先合并到长期分支并 push，等待分支 CI（`.github/workflows/release.yml`）通过。
- 仅从长期分支上的提交，通过 GitHub Actions Release workflow（`.github/workflows/release.yml`）发布；tag 和 Release 资产不可变，不上传本地构建。
- 本机约 13 GB 内存，本地只跑本仓库相关的 scoped 检查；重型全仓检查交给 CI。
