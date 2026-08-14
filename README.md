# dsh-workspace-overlay

DSH 树外插件：为每个 canonical workspace 路径提供共享的 Cordis scope（`workspaceCordis` service）。同一 workspace 的所有消费者（session、agent）租用同一个 scope；最后一个租约释放时 scope 被 dispose。可选地，首个租约会把 `<workspace>/.dsh/cordis.yml` 挂载为该 workspace 的 Cordis composition；bundle 同时接线 Agent 集成：`ctx.agents.create/resume` 前置 workspace 绑定，官方 `agentPresets` 的 mount/composeFrom/recompose 被 decorator 接管为 workspace-local preset generation（见下文「Agent 集成」）。`./mcp` 子路径提供从官方 rc.6 `@deepseek-ai/dsh-mcp-client` 移植的 MCP core（transport / tool sync / connection supervisor），以及 workspace-aware MCP manager + 插件入口（global 每 serverName 一进程、workspace override 每 workspace 一进程、继承 global 的 workspace 零额外进程、同名 namespace 整体遮蔽，见「MCP manager」）。

目标 DSH：`0.1.0-rc.6`。运行时peer包括`@deepseek-ai/cordis` 4.0.1、`@deepseek-ai/dsh-scope` 0.1.0-rc.6、`@deepseek-ai/cordis-plugin-include` 1.0.6、`@deepseek-ai/cordis-plugin-loader` 1.0.2、`@deepseek-ai/dsh-agent-presets` 0.1.0-rc.6及代码实际import的DSH service包；版本均与安装版一致。`@deepseek-ai/dsh-mcp-client` 0.1.0-rc.6只作为开发依赖用于Config parity测试。

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

包内 `dsh.bundle.patch`（`cordis.patch.yml`）插入三行：`workspace-registry`（`workspaceCordis` provider）、`workspace-mcp-manager`（`workspaceMcp` provider）与 `workspace-agent-integration`（`dsh-workspace-overlay/integration-plugin`，AgentRegistry + agentPresets decorator 接线，见下文）。manager 行不配置任何默认 MCP server：global MCP 行由 profile patch 按需添加（见「MCP manager」示例），workspace MCP 行写在各 workspace 的 `.dsh/cordis.yml` 里。

## MCP core（`./mcp` 子路径）

`src/mcp/` 是从官方 rc.6 `@deepseek-ai/dsh-mcp-client`（MIT，Copyright (c) 2026 DeepSeek，见 `deepseek-harness` 仓库）移植的 MCP 内核，对照已安装 rc.6 的 `lib/types/*.d.ts` 与 `lib/index.js` bundle 行为验证，包内保留 MIT 来源注释：

- `./mcp/types`：判别联合 `Config`（`stdio` / `streamable-http`）、`serverName`、`toolCallTimeoutMs`、`failOnStartupError`、`reconnect` 策略、`McpResult`、`ConnectionHandle` 等公开类型。
- `./mcp/config`：Schemastery `Config` schema（与官方默认值一致：`toolCallTimeoutMs=60000`、`failOnStartupError=false`、`reconnect` 默认 `{enabled:true, initialDelayMs:500, maxDelayMs:30000, maxAttempts:10}`）。
- `./mcp/transport`：`createTransport(config)`。stdio 用 `dsh-subprocess` 的 `scrubbedParentEnv()` 再合并显式 `env`，argv spawn（SDK `shell:false`），支持 `cwd`；streamable-http 传 URL/headers。任何路径都不把 env/headers 值写入日志。
- `./mcp/tools`：`publicToolName`（`mcp__<serverName>__<rawName>`，超长/非法字符时追加 12 位 SHA-256 identity hash，已知答案值取自安装版 rc.6 bundle）、分页 `listTools`、事务化两阶段 `syncTools`（fetch 失败保留上一好代；swap 冲突整代回滚）、`callTool` timeout/cancellation 与 `McpResult` 映射（含 `isError`→throw、legacy `toolResult`、content block 投影）。
- `./mcp/connection`：`RECONNECT_DEFAULTS`、`resolveReconnectPolicy`（复用 `MAX_TIMER_DELAY_MS`）、`startConnection` supervisor——startup 失败策略、`list_changed` 重新同步、指数退避/尝试预算（稳定窗口重置预算）、dispose 关闭 client/transport 并等待工具注销，不留子进程。
- `./mcp`：官方同构的 `name`/`inject`/`Config`/`apply` 入口（含 `serverName` 保留），保留给与官方语义一致的纯 global 独立使用；workspace-aware 行一律走 `./mcp/workspace-client`。

与官方 rc.6 的两处有意的差异（均已注释在源码中）：

1. **输入 schema 断言**：fetch 阶段对 `tool.inputSchema` 运行 `assertSupportedJsonSchema`，不支持的词汇使该次同步整体失败（保留上一好代）；官方只断言 output schema（不支持时回退 `JsonValue`），输入 schema 直接透传。
2. **代变化通知**：`ToolBridgeOptions.onGeneration({serverName, names, status})` 与 `startConnection(ctx, config, policy, onGeneration?)` 在每次提交的代变化（注册成功 / 整代回滚 / give-up / dispose）时同步通知；workspace manager 消费它维护 global/own 名字集合并重建 mask（见下节）。

依赖策略：`@modelcontextprotocol/sdk`、`zod`为纯SDK，走`dependencies`；`@deepseek-ai/dsh-tools`、`dsh-subprocess`、`dsh-timeout`涉及Host单例或运行时API，按`peerDependencies` + `devDependencies`（版本与安装版rc.6一致）。`@deepseek-ai/dsh-mcp-client`只作为开发依赖用于Config parity测试，移植代码不在运行时import它。

**已接线的 manager / bundle**：`cordis.patch.yml` 新增 `workspace-mcp-manager` provider 行（`workspaceMcp` service），但**不自动插入任何 MCP server**——没有默认 server，启用 bundle 不会启动任何 MCP 进程。global 与 workspace 的 MCP 行都通过同一个入口 `dsh-workspace-overlay/mcp/workspace-client` 声明，由 manager 按行的 scope 决定语义。per-workspace MCP server 编排（进程模型、`tools.restrict` mask、生命周期）见下节。

## MCP manager（`./mcp/manager` + `./mcp/workspace-client`）

`./mcp/manager` 是 `workspaceMcp` service（默认导出的 `Service` 子类，`static inject = ['tools', 'workspaceCordis']`）；`./mcp/workspace-client` 是命名导出的函数插件（无 default），复用当前 MCP `Config` schema，`inject = ['tools', 'workspaceMcp']`，`apply` 只把行 config 交给 `manager.activate(rowCtx, config)`。

### 进程数契约

- **Global 行**（host composition 里的 `workspace-client` 行）：每个 `serverName` 一个进程，供整个 app 共享。
- **Workspace override 行**（`<workspace>/.dsh/cordis.yml` 里的同名 `workspace-client` 行）：每个 workspace 一个进程，使用该 workspace 自己的 cwd/env。
- **继承 workspace**（没有同名 override）：零额外进程，继续使用 global 实例。
- 同一 workspace 的多个 Agent / 多个租约共享该 workspace 的 entry 与这一个进程（composition 每个 workspace 只挂载一次）。

例如 global `a` + ws1/ws2 override `a` + ws3 继承 = **3 个进程**。`dispose` ws1 不影响 global 与 ws2；workspace scope 最后释放时其 MCP 进程随行 fiber 关闭。

### Namespace 整体遮蔽（mask）

Workspace 声明某 `serverName` 时，整个继承的 global `mcp__<serverName>__*` namespace 被遮蔽，不出现“自己几个工具 + global 漏网工具”的混合视图；global 其它 namespace 不受影响。实现是 workspace scope 上的 `ctx.tools.restrict({ deny })`，其中 `deny = 当前 global 全量 public names − workspace own 已注册 names`。减号是 rc.6 `view()` 语义要求的：restriction 会过滤继承面上的所有名字，workspace 自己 layer 注册的工具只对该 scope 自身的视图豁免——对 workspace 下的 Agent（后代 scope）而言它们仍属继承面，若 deny 包含它们，Agent 会连自己的工具都看不到；被减去的名字由 workspace 自己的注册自然 shadow，正是“替换”。

Manager从每个连接（global与workspace都接）的generation通知维护全量名字集合；global generation换代、give-up、dispose，以及workspace own工具列表变化（`list_changed`）时，对该`serverName`的全部live workspace override在各自的串行commit链上重建mask。替代restriction先安装，旧restriction再在同一同步步骤中dispose；重建失败时保留上一好mask，且`await`之间不存在完全解除遮蔽的窗口。Workspace override没有global generation时不需要mask。`restrict()`要求scoped ctx且deny名已是继承面已知名，这两条都由“先注册、后建mask”的时序保证。

### 生命周期与失败语义

- Manager 不自己持有 workspace lease；行 fiber 由 workspace scope 通过 composition 持有。最后 Agent lease release → workspace scope dispose → 行 fiber effect 依次：`await connection.dispose()`（关进程、注销工具）→ 移除 override/mask/reservation。
- **Workspace 行必须 `failOnStartupError: true`**，否则该行在 load 时明确失败；初始连接/同步失败使整个 workspace composition mount 拒绝，`acquire()` 抛错——任何 Agent 都不会在坏 server 上发布。失败后 reservation/mask/进程全部回滚，修复 `.dsh/cordis.yml` 后重试即可。
- 同 scope（global 或同一 workspace）重复 `serverName` 在 load 时失败；跨 workspace 同名允许。每 (scope, serverName) 一个 reservation。

### cwd 与安全

- Workspace stdio 行的 `cwd`：`''` 或字面 `'${workspaceRoot}'` → canonical workspace root（经 registry 的 `workspaceForScope` 解析，不猜 `process.cwd()`）；绝对路径原样使用；其它相对路径在 load 时拒绝。Global 行保持官方 cwd 语义。
- 子进程 env 复用官方 `scrubbedParentEnv()`（credential 形状与陈旧 `DSH_*` 名被剥除）再合并行内显式 `env`；日志/错误只含 serverName、scope kind、workspace basename + path hash，从不记录 env/header 值。

### 与官方 `@deepseek-ai/dsh-mcp-client` 的同名规则

官方插件在独立模块级 reservation 里维护 `serverName`（manager 无法共享）：

- **不要**在同一个 profile 里同时用官方行和 `workspace-client` 行声明**相同 `serverName` 的 global 行**：两者都会向 global layer 注册同名工具，后者以注册冲突安全失败（`failOnStartupError: true` 时行 load 失败；否则整代回滚并记日志），但这是配置错误。
- 官方 global 行 + manager workspace override：workspace 行会 shadow 同名的 global 工具，但 manager 不知道官方 global 的名字集合，**不会**建 mask——global 未被 shadow 的工具会漏入，形成混合视图。想被 workspace override 的 global 行必须也用 `workspace-client` 入口管理。

### YAML 示例

Global 行（profile 的 `cordis.patch.yml`）：

```yaml
- insert:
    - id: global-db-mcp
      name: dsh-workspace-overlay/mcp/workspace-client
      config:
        serverName: db
        transport: stdio
        command: my-db-mcp
        args: []
        cwd: ''
        failOnStartupError: true
```

Workspace 行（`<workspace>/.dsh/cordis.yml`）：

```yaml
- id: ws-db-mcp
  name: dsh-workspace-overlay/mcp/workspace-client
  config:
    serverName: db
    transport: stdio
    command: my-db-mcp
    args: []
    cwd: '${workspaceRoot}'
    env:
      DATABASE_URL: 'postgres://localhost/a'
    failOnStartupError: true
```

### 支持边界

- 只支持 scope-aware registry／event 贡献（tools 注册与 `tools.restrict` mask）；MCP 行的 `isolate`/root-service 发布由挂载审计拒绝。
- 不承诺 manager provider 行自身在 live workspace 行存在时热重载（与 decorator 同级的启动结构插件）；workspace 行随各自 workspace scope 正常 dispose。
- streamable-http 行同样支持（无 cwd 语义）；workspace 行同样强制 `failOnStartupError: true`。

## 开发

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

`dist/` 由 `tsc` 构建；built-entry smoke test 在目标安装版 DSH 的 profile 依赖树中解析包名后验证。测试通过真实 Loader composition 引导：相对 specifier、裸 specifier（vitest 无 Node internal loader，测试以 stub resolver 记录路由并加载真实 fixture 包）、挂载审计、trust、single-flight、失败重试与 dispose 均有覆盖（`tests/fixtures/plugins/` 下的 fixture 插件经 Node internal loader 导入，测试通过 `globalThis` 观察其状态）。MCP 内核测试（`tests/mcp/`）覆盖：命名已知答案（对照安装版 rc.6 bundle 推导）、重复/非法 schema、分页、`list_changed` 好代替换与失败保留旧代、stdio env scrub/cwd（canary secret 不得泄露）、startup failure true/false、reconnect/give-up、call timeout/cancel、dispose 关闭子进程且工具注销，以及 streamable-http 端到端（header 服务端断言）；fixture server（`tests/fixtures/mcp/fixture-server.ts`）在每个测试进程生命周期内 spawn 并 dispose，不做长驻后台 job。MCP manager 测试覆盖：mock-SDK 状态机（`manager.spec.ts`——reservation 同 scope 重复/跨 workspace 允许、workspace 行强制 `failOnStartupError`、cwd 解析、mask 真实 ScopedLayers 语义（global a t1..t5 + ws a t1..t3 + global b → ws 视图仅 a t1..t3 且 b 保留）、global 换代重建/清空释放、own 列表变化重建、startup 回滚与 teardown）与真实 composition + fixture 进程（`manager-integration.spec.ts`——global a + ws1/ws2 override + ws3 继承 = 3 进程、同 workspace 两租约一进程、`cwd:''`/`${workspaceRoot}` 端到端、坏 server 阻止 acquire 且修复可重试、日志无 canary secret）。

## Agent 集成（bundle 已启用）

`cordis.patch.yml` 现在插入三行：`workspace-registry`（provider）、`workspace-mcp-manager`（provider）与 `workspace-agent-integration`（`dsh-workspace-overlay/integration-plugin`）。官方 `agent-presets` row 原样保留；integration 行通过 `inject = ['agents', 'agentPresets', 'workspaceCordis']` 等到三个服务就绪后，可逆地包装 provider-owned 的 `ctx.agents.create/resume` 与 `ctx.agentPresets.mount/composeFrom/recompose`（共用同一个 `AgentBindingCoordinator` 与 `WorkspacePresetRegistry`，dispose 按逆序恢复全部 5 个 method descriptor）。

### 支持的 Agent 创建入口

- **Web 以及所有走公开异步 `ctx.agents.create/resume` 的 consumer**（ACP、SDK/headless、in-process subagent driver）：组合 setup 先 `acquire(cwd)` 再 `bind(agentKey, lease.key)`，随后调用方 setup 里的官方 `agentPresets.mount` 被 decorator 接管：resolve + broken 检查 → 按 `(workspace, preset, 文件 stat stamp)` 确保 workspace-local preset generation（`createScope(lease.ctx, genKey, { parent: lease.key })` 下挂载官方 `mountPreset()`，同一 workspace 多 Agent 共享同一 generation，stamp 变化生成新 generation，旧 superseded generation 在 joined 归零时 dispose）→ rebind agent 到 generation key 并平衡 joined 计数。subagent 的同步 `composeFrom` 继承 parent 的 exact generation（无 I/O、不重挂载；跨 workspace 或 parent 无本 coordinator 记录时明确拒绝/保持 rosterless）；blank-session `recompose` 同样在 workspace 内切换 generation。
- Agent 的 direct parent 是 `mountPreset()` 登记的 generation key，因此官方 `standingMountFor()`／`composedPreset()`／`serviceFor()` 无需包装即可沿 `agent → workspace-local preset` 解析（集成测试证明）。
- Agent scope 的 effect disposer 统一走 `coordinator.unbind()`：先 leave preset generation，再 release workspace lease。

### 明确不支持的路径

- **同步旁路**：`AgentLoop.create(id, options, meta)` 与直接调用 factory 的 `createAgent/resume` 没有 awaited setup seam，不会获得 workspace 绑定——启用本 bundle 的 profile 不得包含配置驱动的同步 Agent entries。
- **decorator 自身的 live HMR**：decorator 是启动结构插件，开发自身时需先 dispose 全部 live Agent 或重启 Host；Host 正常 teardown 与无 live Agent 的 fiber dispose 会完整恢复 5 个 method 并清理 registry（已测试）。
- **冷 transcript 恢复**：`standingKeyFor()` 继续走官方 global standing，不带 workspace 参数。
