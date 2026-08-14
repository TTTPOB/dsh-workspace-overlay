# dsh-workspace-overlay

DSH 树外插件：为每个 canonical workspace 路径提供共享的 Cordis scope（`workspaceCordis` service）。同一 workspace 的所有消费者（session、agent）租用同一个 scope；最后一个租约释放时 scope 被 dispose。可选地，首个租约会把 `<workspace>/.dsh/cordis.yml` 挂载为该 workspace 的 Cordis composition。

目标 DSH：`0.1.0-rc.6`（`@deepseek-ai/cordis` 4.0.1、`@deepseek-ai/dsh-scope` 0.1.0-rc.6、`@deepseek-ai/cordis-plugin-include` 1.0.6、`@deepseek-ai/cordis-plugin-loader` 1.0.2、`@deepseek-ai/dsh-agent-presets` 0.1.0-rc.6），均为 peer + dev 依赖，版本与安装版一致。

## API（`./registry`）

- `WorkspaceRegistry extends Service`：默认导出；注册为 `ctx.workspaceCordis`（避免与 DSH Web 的持久 workspace 实体服务 `ctx.workspaceRegistry` 冲突）。`static inject = ['loader']`：provider 只在 Host Loader 存在时激活，workspace scope 继承 Host base，供裸包 specifier 解析。
- `Config`：`trustWorkspaceConfig: boolean`，默认 `true`（是否信任 `<workspace>/.dsh/cordis.yml`）。
- `acquire(cwd)`：`cwd` 必须为绝对路径且指向已存在目录；canonical 为 `realpath(resolve(cwd))`（symlink 归一）。同一 canonical 通过 Map + single-flight 共享一个 entry；并发 acquire 只挂载一次；失败不残留缓存、可重试。
- 首次创建 entry 时：`<root>/.dsh/cordis.yml` 不存在 → 空 workspace scope（继承 global，不启动任何东西）；存在且 `trustWorkspaceConfig` → 挂载 composition，`acquire` 在全部 row 可用后才返回；存在但 `trust=false` → 只 stat 不读／parse／import，仍建立空 scope。
- lease：`key`（不透明 ScopeKey）、`ctx`（scope-owned context）、`canonical`、`trustWorkspaceConfig`、`configured`、`composition`（`{ path, active }`，仅已挂载时存在）；`release()` 幂等，最后一次 release `await scope.dispose()` 并从 Map 删除——composition 子树由 scope 持有，随 scope dispose 完整清理（含 fixture 的 effect disposer）。
- `size` / `get(canonical)`：只读调试视图，含 `configured` 与 `composition` 状态。

## 挂载语义（`./workspace-tree`）

- `WorkspaceTree extends Include`：配置文件固定为 `<canonical>/.dsh/cordis.yml`；`write()` 为 no-op（workspace config 是输入，Loader teardown 永不写回）。
- specifier 解析与官方 `PresetTree` 一致：`./`／`../` 按 `.dsh` 目录解析；绝对路径转 file URL；裸包名通过挂载前捕获的 Host base + `ctx.loader.internal.import` 从 Host 依赖树解析（不读 workspace 任意 `node_modules`）。
- `mountWorkspaceTree(scopeCtx, workspace)`：`await handle.await()` 后复用 `@deepseek-ai/dsh-agent-presets` 导出的 `inactiveRows`／`leakedServices` 做挂载审计——拒绝未激活／缺 inject 的 row，拒绝把 service 发布进 root realm 的 row（isolate realm 内的发布是合法的）。失败时 dispose 子树并抛 `WorkspaceMountError`（携带 workspace 路径）。
- 无 chokidar／live reload：本轮只做首次挂载与完整 dispose；配置热重载（watcher、quiescent generation 切换）留待后续。

## 安装（bundle）

```sh
dsh plugin --profile web add /path/to/dsh-workspace-overlay
```

包内 `dsh.bundle.patch`（`cordis.patch.yml`）插入 `workspace-registry` 行。

## 开发

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

`dist/` 由 `tsc` 构建；built-entry smoke test 在目标安装版 DSH 的 profile 依赖树中解析包名后验证。测试通过真实 Loader composition 引导：相对 specifier、裸 specifier（vitest 无 Node internal loader，测试以 stub resolver 记录路由并加载真实 fixture 包）、挂载审计、trust、single-flight、失败重试与 dispose 均有覆盖（`tests/fixtures/plugins/` 下的 fixture 插件经 Node internal loader 导入，测试通过 `globalThis` 观察其状态）。
