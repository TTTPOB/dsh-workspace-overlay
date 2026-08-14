# dsh-workspace-overlay

DSH 树外插件：为每个 canonical workspace 路径提供共享的 Cordis scope（`workspaceCordis` service）。同一 workspace 的所有消费者（session、agent）租用同一个 scope；最后一个租约释放时 scope 被 dispose。可选地，首个租约会把 `<workspace>/.dsh/cordis.yml` 挂载为该 workspace 的 Cordis composition；bundle 同时接线 Agent 集成：`ctx.agents.create/resume` 前置 workspace 绑定，官方 `agentPresets` 的 mount/composeFrom/recompose 被 decorator 接管为 workspace-local preset generation（见下文「Agent 集成」）。此外 `./mcp` 子路径提供从官方 rc.6 `@deepseek-ai/dsh-mcp-client` 移植的 MCP core（transport / tool sync / connection supervisor），本轮仅交付内核、未接 workspace manager 与 bundle（见「MCP core」）。

目标 DSH：`0.1.0-rc.6`（`@deepseek-ai/cordis` 4.0.1、`@deepseek-ai/dsh-scope` 0.1.0-rc.6、`@deepseek-ai/cordis-plugin-include` 1.0.6、`@deepseek-ai/cordis-plugin-loader` 1.0.2、`@deepseek-ai/dsh-agent-presets` 0.1.0-rc.6、`@deepseek-ai/dsh-mcp-client` 0.1.0-rc.6），均为 peer + dev 依赖，版本与安装版一致。

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

包内 `dsh.bundle.patch`（`cordis.patch.yml`）插入两行：`workspace-registry`（`workspaceCordis` provider）与 `workspace-agent-integration`（`dsh-workspace-overlay/integration-plugin`，AgentRegistry + agentPresets decorator 接线，见下文）。

## MCP core（`./mcp` 子路径，本轮未接线）

`src/mcp/` 是从官方 rc.6 `@deepseek-ai/dsh-mcp-client`（MIT，Copyright (c) 2026 DeepSeek，见 `deepseek-harness` 仓库）移植的 MCP 内核，对照已安装 rc.6 的 `lib/types/*.d.ts` 与 `lib/index.js` bundle 行为验证，包内保留 MIT 来源注释：

- `./mcp/types`：判别联合 `Config`（`stdio` / `streamable-http`）、`serverName`、`toolCallTimeoutMs`、`failOnStartupError`、`reconnect` 策略、`McpResult`、`ConnectionHandle` 等公开类型。
- `./mcp/config`：Schemastery `Config` schema（与官方默认值一致：`toolCallTimeoutMs=60000`、`failOnStartupError=false`、`reconnect` 默认 `{enabled:true, initialDelayMs:500, maxDelayMs:30000, maxAttempts:10}`）。
- `./mcp/transport`：`createTransport(config)`。stdio 用 `dsh-subprocess` 的 `scrubbedParentEnv()` 再合并显式 `env`，argv spawn（SDK `shell:false`），支持 `cwd`；streamable-http 传 URL/headers。任何路径都不把 env/headers 值写入日志。
- `./mcp/tools`：`publicToolName`（`mcp__<serverName>__<rawName>`，超长/非法字符时追加 12 位 SHA-256 identity hash，已知答案值取自安装版 rc.6 bundle）、分页 `listTools`、事务化两阶段 `syncTools`（fetch 失败保留上一好代；swap 冲突整代回滚）、`callTool` timeout/cancellation 与 `McpResult` 映射（含 `isError`→throw、legacy `toolResult`、content block 投影）。
- `./mcp/connection`：`RECONNECT_DEFAULTS`、`resolveReconnectPolicy`（复用 `MAX_TIMER_DELAY_MS`）、`startConnection` supervisor——startup 失败策略、`list_changed` 重新同步、指数退避/尝试预算（稳定窗口重置预算）、dispose 关闭 client/transport 并等待工具注销，不留子进程。
- `./mcp`：官方同构的 `name`/`inject`/`Config`/`apply` 入口（含 `serverName` 保留）。

与官方 rc.6 的两处有意的差异（均已注释在源码中）：

1. **输入 schema 断言**：fetch 阶段对 `tool.inputSchema` 运行 `assertSupportedJsonSchema`，不支持的词汇使该次同步整体失败（保留上一好代）；官方只断言 output schema（不支持时回退 `JsonValue`），输入 schema 直接透传。
2. **代变化通知**：`ToolBridgeOptions.onGeneration({serverName, names, status})` 与 `startConnection(ctx, config, policy, onGeneration?)` 在每次提交的代变化（注册成功 / 整代回滚 / give-up / dispose）时同步通知，为未来的 workspace manager 保留；当前不实现任何 mask/restrict。

依赖策略：`@modelcontextprotocol/sdk`、`zod`为纯SDK，走`dependencies`；`@deepseek-ai/dsh-tools`、`dsh-subprocess`、`dsh-timeout`涉及Host单例或运行时API，按`peerDependencies` + `devDependencies`（版本与安装版rc.6一致）。`@deepseek-ai/dsh-mcp-client`只作为开发依赖用于Config parity测试，移植代码不在运行时import它。

**尚未接 workspace manager / bundle**：本轮只交付可独立测试的 MCP core 模块，`cordis.patch.yml` 未新增任何 MCP 行，`./mcp` 的 `apply` 不会被 profile 加载，也不会自动启动任何 MCP 进程；per-workspace MCP server 编排（manager、`tools.restrict` mask、bundle 接线）留待后续提交。

## 开发

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

`dist/` 由 `tsc` 构建；built-entry smoke test 在目标安装版 DSH 的 profile 依赖树中解析包名后验证。测试通过真实 Loader composition 引导：相对 specifier、裸 specifier（vitest 无 Node internal loader，测试以 stub resolver 记录路由并加载真实 fixture 包）、挂载审计、trust、single-flight、失败重试与 dispose 均有覆盖（`tests/fixtures/plugins/` 下的 fixture 插件经 Node internal loader 导入，测试通过 `globalThis` 观察其状态）。MCP 内核测试（`tests/mcp/`）覆盖：命名已知答案（对照安装版 rc.6 bundle 推导）、重复/非法 schema、分页、`list_changed` 好代替换与失败保留旧代、stdio env scrub/cwd（canary secret 不得泄露）、startup failure true/false、reconnect/give-up、call timeout/cancel、dispose 关闭子进程且工具注销，以及 streamable-http 端到端（header 服务端断言）；fixture server（`tests/fixtures/mcp/fixture-server.ts`）在每个测试进程生命周期内 spawn 并 dispose，不做长驻后台 job。

## Agent 集成（bundle 已启用）

`cordis.patch.yml` 现在插入两行：`workspace-registry`（provider）与 `workspace-agent-integration`（`dsh-workspace-overlay/integration-plugin`）。官方 `agent-presets` row 原样保留；integration 行通过 `inject = ['agents', 'agentPresets', 'workspaceCordis']` 等到三个服务就绪后，可逆地包装 provider-owned 的 `ctx.agents.create/resume` 与 `ctx.agentPresets.mount/composeFrom/recompose`（共用同一个 `AgentBindingCoordinator` 与 `WorkspacePresetRegistry`，dispose 按逆序恢复全部 5 个 method descriptor）。

### 支持的 Agent 创建入口

- **Web 以及所有走公开异步 `ctx.agents.create/resume` 的 consumer**（ACP、SDK/headless、in-process subagent driver）：组合 setup 先 `acquire(cwd)` 再 `bind(agentKey, lease.key)`，随后调用方 setup 里的官方 `agentPresets.mount` 被 decorator 接管：resolve + broken 检查 → 按 `(workspace, preset, 文件 stat stamp)` 确保 workspace-local preset generation（`createScope(lease.ctx, genKey, { parent: lease.key })` 下挂载官方 `mountPreset()`，同一 workspace 多 Agent 共享同一 generation，stamp 变化生成新 generation，旧 superseded generation 在 joined 归零时 dispose）→ rebind agent 到 generation key 并平衡 joined 计数。subagent 的同步 `composeFrom` 继承 parent 的 exact generation（无 I/O、不重挂载；跨 workspace 或 parent 无本 coordinator 记录时明确拒绝/保持 rosterless）；blank-session `recompose` 同样在 workspace 内切换 generation。
- Agent 的 direct parent 是 `mountPreset()` 登记的 generation key，因此官方 `standingMountFor()`／`composedPreset()`／`serviceFor()` 无需包装即可沿 `agent → workspace-local preset` 解析（集成测试证明）。
- Agent scope 的 effect disposer 统一走 `coordinator.unbind()`：先 leave preset generation，再 release workspace lease。

### 明确不支持的路径

- **同步旁路**：`AgentLoop.create(id, options, meta)` 与直接调用 factory 的 `createAgent/resume` 没有 awaited setup seam，不会获得 workspace 绑定——启用本 bundle 的 profile 不得包含配置驱动的同步 Agent entries。
- **decorator 自身的 live HMR**：decorator 是启动结构插件，开发自身时需先 dispose 全部 live Agent 或重启 Host；Host 正常 teardown 与无 live Agent 的 fiber dispose 会完整恢复 5 个 method 并清理 registry（已测试）。
- **冷 transcript 恢复**：`standingKeyFor()` 继续走官方 global standing，不带 workspace 参数。
