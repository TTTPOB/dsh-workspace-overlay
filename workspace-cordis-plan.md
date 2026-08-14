# Workspace 级 Cordis Override — 实现计划

> 日期：2026-08-14 · 状态：v3 计划已确定（纯树外插件方案）
> 目标读者：TTTPOB（本计划的作者与实施者）
> 背景讨论：[RFC 941](https://github.com/deepseek-ai/deepseek-harness/discussions/941) · [社区先例 #1320](https://github.com/deepseek-ai/deepseek-harness/discussions/1320)

---

## 1. 背景、目标与固定约束

### 1.1 问题

DSH 当前有 Host 级 composition（profile、bundle、`cordis.patch.yml`）和 Agent 级 composition（preset），但没有 workspace 级的 Cordis composition。同一个 DSH Web Host 可以同时运行多个 cwd 不同的 Session；挂在 root context 的 MCP、工具和服务会被所有 Session 共享，无法表达“项目 A 声明、仅项目 A 可见、项目 A 内共享实例”的语义。

### 1.2 目标

1. 每个 workspace 支持 `<workspace>/.dsh/cordis.yml`，使用与 preset composition 相同的 Cordis 插件行方言。
2. Workspace A 的工具只出现在 A 的 Agent scope chain；Workspace B 查找 A-only 工具时在 transport 前失败。
3. 同一 workspace 的多个 Session 和继承型 subagent 共享一棵 workspace composition，而不是每 Agent 重挂一份。
4. Workspace composition支持按workspace粒度监听变更、在安全的quiescent边界重载，并可完整dispose。
5. Global 注册可被 workspace 同名注册遮蔽；没有 override 的 workspace 继续继承 global 实例，不新建进程。
6. 挂载等待、行激活检查、服务泄漏检查和可逆 effect 与 preset 保持同等严格。

### 1.3 固定实现约束

- 不继续修改 RFC 941；RFC 只保留为问题背景。
- 不增加 RPC、远程协议或 Web API。
- 不修改 `@deepseek-ai/cordis` 核心。
- 以树外DSH bundle实现，通过profile patch新增workspace registry、AgentRegistry decorator和`agentPresets` decorator；保留官方preset provider负责discovery/settings/authoring。
- Workspace 实例身份只由 canonical workspace identity 决定；preset 不参与 workspace runtime 或 workspace MCP 进程的实例键。
- 不修改 Host `process.env`。

### 1.4 第一版非目标

- `.envrc` 执行和 Bash／PTY／LSP 环境注入。
- 完整信任 UI；第一版以 profile 显式启用 workspace config，并保留 trust hook。
- Git worktree、monorepo package 和 symlink 的最终身份模型；第一版先用规范化绝对路径。
- 仅声明 `disabled: true` 而不提供替代实例的 global MCP 禁用语义。
- 真正的无中断事务热重载。
- 冷 Session 在不 resume Agent 时精确恢复 workspace-local 自定义 tool presenter；第一版允许退化为 generic card。

---

## 2. 已验证的 DSH 基础

### 2.1 可直接复用

| 能力 | 现有实现 |
|---|---|
| Cordis 插件行、`config`、`disabled`、`!!js` | `@deepseek-ai/cordis-plugin-include` / preset 的 `PresetTree` |
| Scoped context 与单 parent 链 | `createScope`、`bindScopeParent`、`scopeChainOf` |
| Scoped tool 注册、继承与逐名遮蔽 | `dsh-tools` 的 `ScopedLayers` |
| Preset standing composition | `dsh-agent-presets` 的 `ensureStanding`、`mount`、`composeFrom` |
| Agent 首次发布前 awaited setup | `agentLoop.createAgent/resume(... setup)` |
| 可逆插件生命周期 | Cordis fiber、`ctx.effect()`、registry disposer |
| 配置 watcher 参考 | `Momojie-S/dsh-workspace-mcp` 的 chokidar + debounce 模式 |

### 2.2 社区先例

`@momojie-s/dsh-workspace-mcp` 已证明：

- 可以从 `session.header.cwd` 发现项目配置；
- 可以通过 Agent context 注册 scoped MCP tools；
- 不同 Agent 的工具可见性能够隔离；
- watcher、MCP connection 和 tool disposer 可以随 Agent/HMR 清理。

其代价是每 Agent 一份 MCP 和 watcher，而且 `agent/created` 是非 awaited 通知，不能保证首次 tool assembly 前完成。本计划把 ownership 提升到 workspace standing scope，并把最终挂载放进 Agent factory 的 awaited setup。

### 2.3 当前唯一的 parent binding authority

官方 `dsh-agent-presets` 在 `mount()` 和 `composeFrom()` 中直接执行：

```ts
bindScopeParent(agentKey, presetStandingKey)
```

它私有持有返回的 `ScopeParentBinding`，并用它完成 `recompose()`。外部旁挂 listener 无法在其后再次插入 parent，因为一个 scope key 只能首次绑定一次。

因此纯插件方案不是在官方`mount()`执行后再监听事件，而是：

> 保留官方`agentPresets` provider负责preset discovery、settings、authoring和默认cold presenter standing；树外decorator插件在Host激活时可逆地包装`mount()`、`composeFrom()`和`recompose()`，在这些现有调用点接管workspace acquire、workspace-local preset generation和Agent parent binding。

Decorator不能先调用官方`mount()`再补workspace层；它必须复用官方`resolve()`／authoring API和导出的`mountPreset()`／mount audit helpers，但跳过官方直接绑定Agent→global preset standing的实现。实现从`ctx.get('agentPresets')`取得traceable service，以Cordis导出的`symbols.original`取得provider-owned target，再定义自有method descriptor；禁止只修改某个调用方拿到的traceable shadow。安装时记录method来自own descriptor还是prototype，dispose时只有当前wrapper仍是owner才恢复原descriptor或删除own property。

Decorators是启动结构插件，不承诺在live Agent存在时对自身代码／row做HMR或卸载后恢复官方binding语义；workspace`.dsh/cordis.yml`只按§3.9的quiescent规则重载。开发decorator本身时先dispose所有live Agent或重启Host。Host正常teardown和无live Agent的fiber dispose必须完整恢复method descriptors并清理workspace registry。

选择decorator而不是replacement row还有一个启动器原因：profile patch不能把已有`id: agent-presets` row的`name`换成另一模块，而CLI只向这个row注入shipped preset root。保留官方provider可继续获得完整roster wiring。这不需要RPC或Cordis核心变更。

### 2.4 命名空间状态审计

工具、命令、prompt section 和 skill registration 已具有 scope-aware layer。身份类唯一性（Agent ID、Session ID）保持 root-global 是正确语义。

`dsh-mcp-client` 的 `serverName` reservation 是需要单独适配的例外：当前按 `ctx.root` 唯一，因此 global `a` 已启动时，workspace 再声明 `a` 会在加载阶段失败。

---

## 3. 推荐架构与实现决策

### 3.1 Scope 顺序

采用：

```text
global / Host
  → workspace standing
  → preset standing within that workspace
  → agent / session
  → inherited subagent
```

理由：

- Workspace standing 只按 workspace identity 创建一份，因此 workspace MCP、watcher 和项目服务不随 preset 重复。
- 同一 workspace 可以同时运行不同 preset；每个 preset generation 挂在同一个 workspace parent 下。
- Preset 比项目配置更近，可以 shadow workspace registration，并保留成为 Agent capability policy 的空间。

具体实例：

```text
Workspace A standing
├── .dsh/cordis.yml subtree
├── MCP a for Workspace A（一个进程）
├── Standard preset standing for A
│   ├── Agent A1
│   └── Agent A2
└── Code preset standing for A
    └── Agent A3
```

### 3.2 两类实例键

Workspace 与 preset 的键分开：

```text
Workspace key = canonical workspace identity
Preset generation key = workspace key + preset id + composition stamp
```

因此：

- Workspace resource（MCP、watcher、将来的 env snapshot）不按 preset 复制。
- Preset composition按workspace + preset生成，因为同一个preset standing只有一个parent，不能同时挂到多个workspace。
- 同一`(workspace, preset, stamp)`仍由多个Agent共享，不按Agent复制。
- 这是有意接受的composition开销：preset subtree会按活跃workspace复制；workspace MCP、watcher和项目服务仍只有一份。Phase 2必须测量内置standard/code preset在多workspace下的额外常驻资源，并拒绝preset row意外发布root service。

### 3.3 树外 bundle 组成

```text
dsh-workspace-cordis/
├── workspace-registry          # workspace standing、lease、watcher、composition
├── agent-registry-decorator    # 为ctx.agents.create/resume前置awaited workspace setup
├── agent-presets-decorator     # 让官方preset调用复用同一个binding coordinator
├── preset-generations          # workspace-local preset scope与mount audit
├── workspace-tree              # Include方言、Harness裸包resolver与activation audit
├── mcp-client / mcp-manager    # workspace-aware MCP namespace与连接ownership
├── cordis.patch.yml
└── dist/
```

Profile patch：

1. 保留官方`agent-presets` row和CLI注入的shipped roots。
2. 插入workspace registry、AgentRegistry decorator和agent-presets decorator；它们声明`inject = ['agents', 'agentPresets']`，等待官方services可用后共同使用一个binding coordinator。
3. Global MCP若需要被workspace同名override，必须由workspace-aware MCP adapter管理；未迁移的官方root`dsh-mcp-client`只保证现有Host-global语义。

Bundle把两个decorators和registry放在同一个结构entry/fiber内完成同步method install，并在ready之前不启动任何自有Agent。v1首个支持目标是按请求惰性创建Agent的Web profile；对包含配置启动Agent row的profile，必须通过真实composition test证明该row在decorator ready后才调用公开AgentRegistry，否则不支持。YAML行顺序不是activation保证。

Decorator不替换`ctx.agentPresets` service identity，因此UI、settings、authoring、session preset记录和`standingKeyFor()`保持官方行为。它接管实际写parent binding的调用：`mount`、`composeFrom`和`recompose`。`composedPreset`与`serviceFor`若沿用官方`standingMountFor()`只能识别官方mount registry；decorator优先通过复用导出的`mountPreset()`让workspace-local preset generation继续进入该registry，并用集成测试确认这两个reader能沿`agent→workspace-local preset`识别generation。若registry只检查直接parent或无法区分generation，则再包装这两个reader并使用decorator自有WeakMap。Workspace-local preset generation和`ScopeParentBinding`由decorator拥有；官方provider自己的global standing继续服务无workspace参数的cold presenter lookup，但live Agent不加入该global standing。

树外bundle必须把`@deepseek-ai/cordis`、`dsh-scope`以及所有依靠module-level symbol／WeakMap身份共享的DSH包视为Host单例peer，不能在profile依赖平面安装第二份运行时副本；built-entry smoke必须验证scope key由decorator与agent-loop交叉读写正常。

### 3.4 Workspace 配置格式

`<workspace>/.dsh/cordis.yml` 使用普通 Include row：

```yaml
- id: project-mcp
  name: 'dsh-workspace-cordis/mcp-client'
  config:
    serverName: project-db
    transport: stdio
    command: project-database-mcp
    args: []
    cwd: '${workspaceRoot}'
    env:
      DATABASE_URL: 'postgres://localhost/a'

- id: project-tools
  name: './tools/plugin.js'
  config:
    enabled: true
```

规则：

- 实现`WorkspaceTree` Include子类，镜像官方`PresetTree.import()`的双resolver：`./`／`../`／`file:`按`.dsh/cordis.yml`目录解析；裸specifier通过Host Loader internal和捕获的harness/profile base解析。
- 项目自带插件使用相对specifier；裸包必须已安装到目标profile的依赖树并出现在可解析manifest中，不临时读取workspace的任意`node_modules`。
- Workspace-aware adapter作为bundle export随profile安装；示例`dsh-workspace-cordis/mcp-client`必须经过built-entry Loader smoke，而不是只在源码tsx环境验证。
- 不对任意config string猜测路径语义。
- Workspace-aware内置插件可由自己的schema显式接受`${workspaceRoot}`；第三方插件不会被通用字符串改写，若原样收到占位符应按自身schema拒绝。
- `cwd: .`不因Include`baseUrl`自动变成workspace root；文档和schema不作此错误承诺。

### 3.5 Workspace identity

第一版：

```text
canonical identity string = realpath(resolve(session.header.cwd))
scope key object = 每次WorkspaceEntry generation新建的不透明object
```

Registry用canonical string索引entry；`dsh-scope`只使用object key。两者不可混用，否则entry重建会错误复用已dispose scope ancestry。

只读取：

```text
<canonical identity>/.dsh/cordis.yml
```

Caller负责在Agent创建前确保cwd目录存在。不存在、权限失败或`realpath`失败均在setup中拒绝Agent；不创建目录、不退回lexical path。第一版不向上扫描、不合并nested config；平台大小写、UNC、Git worktree和monorepo规则后置。

### 3.6 Agent创建门禁与唯一parent binding

AgentRegistry decorator可逆包装公开的`ctx.agents.create()`和`resume()`，把调用方的`options.setup`改写为组合setup；不依赖`agent/created`：

```text
combined setup(agentCtx)
  → scopeOf(agentCtx)取得Agent对象和session.header.cwd
  → await ctx.workspaceCordis.acquire(cwd)
  → bind Agent key → workspace key，并保存唯一ScopeParentBinding
  → 在agentCtx effect中登记幂等lease release
  → await调用方原setup(agentCtx)
       → 若调用agentPresets.mount()，preset decorator确保workspace-local preset
       → binding.rebind(workspace-local preset key)
  → 合并workspace与调用方的AgentSetupCommit
  → setup/commit成功后Agent factory才publish
```

这覆盖Web API、ACP、SDK/headless以及其他调用公开`ctx.agents.create/resume`的consumer，并保留它们原有setup和commit语义。Decorator必须用Cordis`symbols.original`操作provider target，保存原method descriptor并在无live Agent的dispose中恢复。

这依赖一个已验证的DSH应用层事实：`ReactLoopAgent`通过`createScope(loopCtx, this)`把Agent对象本身作为scope key。Decorator只读取`agent.session.header.cwd`；若该字段缺失、不是绝对路径、目录不存在／不可读或`realpath`失败，创建在publish前明确拒绝，不退回`process.cwd()`也不代替caller创建目录。

同步`AgentLoop.create(id, options, meta)`和直接调用factory的`createAgent/resume`会绕过AgentRegistry setup，无法等待workspace I/O。v1把它们列为不支持的内部旁路，不伪造运行时保证：目标profile必须不存在配置驱动的同步Agent entries；安装前用`--dump-config`和built composition test证明这一前置条件。若部署需要这些entries，必须先迁移caller到`ctx.agents.create()`，否则不得启用bundle。无workspace config的legacy global-only部署不在本bundle的支持声明内。

Subagent：

```text
AgentRegistry combined setup先为child取得与cwd对应的workspace lease
  → composeFrom(childCtx, parentCtx)保持同步签名
  → 从live binding WeakMap取parent的workspace + exact preset generation
  → 断言child workspace identity与parent一致
  → 使用child已有binding.rebind(parent exact preset key)
```

`composeFrom()`不执行I/O、不重复增加lease、不能退化为async。显式跨workspace的subagent不能使用`composeFrom()`继承，必须作为独立Agent走完整异步create。若parent没有decorator记录且官方`standingMountFor(parentCtx)`也为空，则保持rosterless语义，让child停在自己的workspace parent。

Blank-session recompose只允许同workspace切换preset：先确保target generation，再通过decorator-owned binding原子rebind，同时更新old/target generation joined计数；调用方继续负责“Session尚无产出”前置条件。Workspace identity不可通过recompose改变。

`agent/created`只用于诊断，不承担初始化。Phase 0 listener在Phase 2启用时必须删除，不能保留异步fallback。

### 3.7 Workspace registry 与 lease

```ts
interface WorkspaceLease {
  readonly workspace: WorkspaceEntry
  release(): Promise<void>
}

interface WorkspaceEntry {
  readonly key: object
  readonly root: string
  readonly scope: Scope
  readonly leases: number
  readonly generation?: WorkspaceCompositionGeneration
  readonly presets: Map<string, PresetGeneration>
}

interface PresetGeneration {
  readonly key: object
  readonly presetId: string
  readonly stamp: string
  readonly scope: Scope
  readonly joinedAgents: number
}
```

约束：

- `acquire()`按canonical root single-flight；同一entry的mount、reload和final dispose由一个串行controller拥有。
- `release()`幂等；归零后entry进入disposing，新的`acquire()`不得复用该entry，而要等待dispose后创建下一generation。
- Lease先登记到Agent scope effect，再执行任何可能失败的preset/caller setup；因此后续throw、commit失败、resume失败和Agent dispose都走同一个release。
- 每个live binding记录`workspace lease + exact preset generation? + ScopeParentBinding`。加入／recompose／dispose同步维护`joinedAgents`；归零的旧stamp generation可以dispose，current generation可留到workspace final dispose。
- Agent teardown先让Agent停止并排空tool execution，再dispose Agent scope；Agent-scope disposer先退出preset generation并释放workspace lease，最后一个lease才触发workspace资源teardown。
- 最后一个lease release后先停止watcher并取消／排空reload，再依次dispose零joined preset generations、workspace composition和scope。
- `agent/disposed`只用于观测，不作为唯一引用计数来源。

### 3.8 Cordis context与service可见性

`dsh-scope` parent链只影响`ScopedLayers` registry view和scoped event admission，不改变Cordis service resolution。`global→workspace→preset→agent`不能自动让`agentCtx.get()`继承workspace row发布的service。

v1据此收窄“任意Cordis row”承诺：

- 支持通过scope-aware registry／event贡献能力的row，例如tools、prompt sections、skills、commands、MCP adapter和scoped listeners。
- Workspace tree从registry provider自己的untraced Host context创建workspace scope；preset scope由`createScope(workspace.ctx, presetKey)`创建，但这只安排scope key，仍不会自动穿越Cordis isolate realm。
- Workspace composition内部的provider/consumer只有处在同一显式isolate group时才能互相inject；workspace sibling、preset row和Agent都不能假定能注入该service。
- Preset或Agent若需要workspace状态，使用Host-global稳定service API加调用scope，或通过`ctx.workspaceCordis.serviceFor(agent, name)`显式寻址composition fiber；不能用普通`inject`／`ctx.get()`假装继承。
- v1不承诺任意第三方Host service在Agent中透明可注入；缺少显式consumer seam的row在activation audit中拒绝或记录为unsupported。

这与官方preset的`serviceFor(agent, name)`模式一致：Host调用者先持有Agent，再显式读取该composition fiber内的service，而不是把session-local provider暴露为Host-global injection。

### 3.9 热重载与存活Session一致性

Model-visible capability不能在有历史的live Agent下面原地变化。v1采用**quiescent reload**：watcher会发现并验证变更，但只在workspace没有live Agent lease时激活新generation。

```text
watcher detects change
  → debounce / serialize
  → parse YAML/schema并记录pending stamp
  → 有live leases：保持当前generation，标记pending reload
  → 最后lease release：dispose旧preset generations与workspace composition
  → 若下一次acquire到来，以pending/latest stamp mount并audit后再publish Agent
```

这意味着编辑`.dsh/cordis.yml`不会改变正在运行Session的tool/prompt/service集合；新配置对该workspace所有live Agent结束后的下一次create/resume生效。删除配置也遵循同一规则。该语义不需要在Session log新增capability-generation事件，并避免旧history在新tool schema下继续运行。

失败语义：

- 初次或下一generation mount失败时，等待它的Agent创建失败且不publish；已经结束的旧generation不复活。
- 当前live generation不会因pending config语法错误或import失败而被dispose。
- 错误分类为parse、trust、import、inactive、leak、namespace conflict和dispose，并只记录非敏感诊断。
- 后续文件变化允许重试；真正的live candidate切换和logged generation migration后置。

Watcher每workspace仅一份；禁止每Agent watcher并发重载共享实例。立即dispose与TTL选择只影响无live Agent entry保留多久，不改变“live Agent不热换capability”的规则。

---

## 4. MCP 覆盖与进程模型

### 4.1 进程数契约

配置：

```text
Global: MCP a
Workspace 1: MCP a override, env key 1
Workspace 2: MCP a override, env key 2
Workspace 3: no a override
Workspace 4: no a override
```

预期进程数：**3**。

```text
Global MCP a        # Workspace 3、4 继承
Workspace 1 MCP a   # 自己的 cwd/env
Workspace 2 MCP a   # 自己的 cwd/env
```

同一 workspace 的多个 Agent，无论使用何种 preset，都共享该 workspace 的同一 MCP a。

### 4.2 `serverName` 唯一性域

唯一性改为：

```text
同一个 scope 内唯一
跨 scope 允许同名
```

若实现分层 reservation，数据结构必须显式表示 global：

```ts
interface ServerNameLayers {
  global: Set<string>
  scoped: WeakMap<object, Set<string>>
}
```

不能把 `undefined` 作为 `WeakMap` key。

### 4.3 Namespace 整体遮蔽

MCP override 的单位是 server namespace，不是单个工具名。

若 global `a` 暴露：

```text
t1 t2 t3 t4 t5
```

workspace `a` 只暴露：

```text
t1 t2 t3
```

workspace Agent 只能看到 workspace 的 `t1 t2 t3`；global `t4 t5` 不得漏入形成混合实例视图。

第一版把该语义放在workspace-aware MCP adapter，而不是向通用`dsh-tools`添加prefix概念。Adapter必须同时掌握它管理的global与workspace namespace generations，并完成：

- namespace reservation；
- inherited namespace masking；
- workspace tool registration；
- list_changed后的整代更新；
- reconnect与dispose。

Masking优先复用workspace scope上的`ctx.tools.restrict({ deny: inheritedPublicNames })`：它只屏蔽global tools，workspace-local registrations保持可见，正好表达“替换继承的global namespace”。

Adapter不直接复用当前`syncTools()`的“先dispose旧generation”失败语义，而保存每代完整definitions与disposers：

1. 在不改registry的阶段完成MCP分页fetch、schema转换、public-name去重和candidate definitions构建。
2. 进入一个不跨`await`的同步commit：dispose受影响的旧tool/restriction disposers，注册candidate global/workspace tools，再重建所有override workspace的deny集合。
3. 任一步失败时dispose本次partial registrations，并用缓存的旧definitions与restriction集合同步恢复旧generation；恢复失败是fatal invariant，停止该namespace并报告。
4. Global与workspace reconnect/list_changed按`serverName`串行，不能并发提交同一namespace。

`tools.restrict()`要求deny名称已经是known global tools，所以global candidate registrations必须先于workspace restrictions注册；整个步骤不跨event-loop await，外部assembly看不到中间状态。若真实API测试证明无法满足该commit，再把prefix namespace primitive提升为`dsh-tools`应用层改动，但仍不涉及Cordis核心。

因此，想被workspace同名override的global MCP entry也必须交给该adapter管理。官方root`dsh-mcp-client`可继续用于不可覆盖的纯global server。

### 4.4 诊断

日志和状态至少标识：

```text
serverName
scope kind: global | workspace
workspace basename + canonical path hash
generation
connection status
```

不记录 MCP env values、authorization headers或完整环境快照。

---

## 5. 校验、安全与兼容性

### 5.1 挂载审计

Workspace composition和workspace-local preset composition都必须：

1. await全部Loader rows；
2. 拒绝 inactive rows；
3. 检查意外发布到 root realm的service；
4. 验证失败时dispose本 generation已产生的effects；
5. 证明HMR/dispose后registrations和processes消失。

### 5.2 插件兼容性边界

`.dsh/cordis.yml`复用普通Cordis row语法，但v1不声称所有Host插件都能安全或有意义地workspace化：

- 第一类支持目标是scope-aware registry／event贡献：tools、prompt sections、skills、commands、MCP adapter和scoped listeners。
- Isolate service可以在workspace/preset composition内部供其他row注入；Host或Agent从外部读取时必须使用显式`serviceFor`寻址。
- 隐式发布root service的row由leak audit拒绝；root event、timer、filesystem、network和subprocess side effect无法靠leak audit变成安全沙箱，只能依靠Cordis effect完整dispose。
- Client/browser插件、依赖Agent普通`ctx.get()`透明继承workspace service的插件、以及Bash／PTY／LSP env adapter不属于v1。
- `!!js`和任意项目插件本质上是已信任本机代码执行；本计划只保证scope可见性和lifecycle ownership，不承诺安全隔离。

用workspace MCP、简单tool row、prompt section、scoped event listener和composition-internal isolate service做真实Loader冒烟；unsupported row要在已知时明确拒绝，不静默降级。

### 5.3 信任

Workspace config可以启动进程和加载项目代码。v1不实现完整审批UI，但定义bundle自己的配置与事件，而不假装源码已有trust hook：

```ts
interface Config {
  trustWorkspaceConfig: boolean
}

'workspace-cordis/before-load'(request, next)  // bundle自定义waterfall
```

- Load pipeline固定为`stat/read raw bytes → trust decision → trusted YAML/!!js parse → module import → activation/audit`；trust之前只读取path、mtime、size和content hash。
- `trustWorkspaceConfig`默认`true`：profile启用bundle后会执行进入workspace的项目Cordis config。管理员可显式设为`false`，此时可以发现文件存在，但不得解析／执行`!!js`、import module或启动进程。
- Waterfall是后续approval provider的扩展点，listener必须调用`next()`；没有listener时仍由配置字段作最终deny/allow决定。
- 完整审批后置时，未来信任状态绑定canonical path + content hash。
- `.envrc`永不随Cordis config trust自动allow。
- 默认日志仅显示workspace basename + canonical path hash；显式debug配置才输出完整路径。Secret values、headers和完整env永不记录。

### 5.4 Cold transcript限制

当前Host在不resume Agent的冷历史渲染中只调用：

```ts
agentPresets.standingKeyFor(presetId)
```

它没有workspace参数，不能选择workspace-local preset generation。Decorator不修改该方法，继续返回官方global preset standing。

第一版决定：

- live Agent历史使用Agent scope，workspace与preset presentation准确；
- cold历史仍使用官方preset presenter；preset自带tool presenter保持可用；
- cold workspace-only自定义工具没有presenter时退化为generic card；
- 不为此增加RPC或修改Host API；
- 将来若出现正式内部seam，再提供`standingKeyForSession(presetId, cwd)`。

---

## 6. 分阶段实施

### Phase 0：Agent-scoped语义原型

目标：只验证配置解析、工具隔离和effect dispose；不承诺首次请求可见、共享或生产接入。

- 监听`agent/created`，在Agent scope挂载一个测试tool row并明确记录first-step race。
- 不使用`agent/pre-step`伪装初始化门禁；它发生在prompt/tool assembly之后，只能使更后的assembly看到变化。
- 验证Workspace A-only tool在B中为UNKNOWN_TOOL，Agent dispose后注册和connection清理。
- 记录官方`dsh-mcp-client`同名`serverName`的root冲突基线。
- Phase 2开始前删除该listener实现。

### Phase 1：Workspace registry、tree与lifecycle

目标：独立证明一workspace一scope、一composition、一watcher；此阶段不接入生产Agent parent chain。

- 实现canonical identity、single-flight acquire、幂等lease和serialized final dispose。
- 实现`WorkspaceTree`的workspace-relative与Harness/profile裸包双resolver。
- 在workspace scope挂载`.dsh/cordis.yml`并复用inactive/leak audit。
- 实现pending stamp + quiescent reload；用测试scope fixture验证两个consumer共享实例且live generation不变。
- 覆盖initial mount中止、last-release与watcher callback竞争、下一代失败与后续恢复。

### Phase 2：AgentRegistry与`agentPresets` decorators

目标：形成最终scope链并在公开Agent创建返回前完成组合。

- 保留官方preset provider；两个decorators通过`inject = ['agents', 'agentPresets']`等待services激活。
- 可逆包装`ctx.agents.create/resume`，前置workspace acquire/bind并组合调用方setup与commit；built tests覆盖Web、ACP、SDK/headless实际入口。
- 可逆包装官方preset target的`mount`、`composeFrom`和`recompose`；先验证官方`composedPreset`／`serviceFor`能读取decorator通过`mountPreset()`登记的generation，只有验证失败才包装reader。
- Preset standing按`workspace + preset + stamp`建立在workspace scope下；`mount`／`recompose`用官方`resolve()`加等价unknown／broken检查，不能调用会写第二份binding的原方法。
- `composeFrom`保持同步，复用child已有workspace binding和parent exact generation；`standingKeyFor`、discovery、settings和authoring继续走官方实现。
- 审计目标profile无同步`AgentLoop.create()`／direct factory bypass；有旁路则bundle拒绝声明支持。
- 验证同workspace多preset并发时workspace资源不重复、preset generation joined计数平衡。

### Phase 3：Workspace-aware MCP

目标：global继承、workspace override、namespace整体遮蔽与正确进程数。

- 实现或移植official MCP reconnect／tool sync逻辑到workspace-aware adapter。
- 管理global与workspace namespace generations。
- 验证global `a` + ws1 `a` + ws2 `a`共存且总进程数为3。
- 用部分工具集验证无global namespace漏入。
- 验证dispose ws1不影响global与ws2。

### Phase 4：配置生态

- Workspace environment snapshot与`.envrc` provider。
- Bash、PTY、MCP、LSP在各自spawn边界消费snapshot。
- Global entry纯禁用语义。
- Trust approval与content-hash失效。
- Git worktree、nested workspace和monorepo identity。
- Transactional reload generations。

---

## 7. 验收矩阵

### Profile与创建入口

- `dsh --profile web --dump-config --patch ...`中官方`agent-presets`保留且两个decorators各只有一row，完整config未被意外覆盖。
- Web create/resume、ACP new session、SDK/headless通过公开`ctx.agents.create/resume`时都在publish前await workspace setup。
- 目标profile不存在同步`AgentLoop.create()`或direct factory bypass；故意加入旁路fixture时bundle assembly明确失败。
- Built ESM bundle由安装版DSH Loader解析；Cordis/scope module identity与Host一致；相对项目插件和profile安装的裸包都能按设计resolver加载。

### Scope与可见性

- A声明`tool_a`，A可见；B schema中不存在；B直接调用得到UNKNOWN_TOOL。
- 无`.dsh/cordis.yml`的workspace建立空workspace layer并继承global；不会启动workspace MCP。
- 同canonical workspace的两个Agent共享workspace composition对象、watcher和MCP；concurrent acquire只mount一次。
- 同workspace不同preset共享workspace runtime，但各自加入workspace-local exact preset generation；preset subtree不按Agent复制。
- Subagent继承parent的exact workspace与preset generation；显式跨workspace走独立create而非`composeFrom`。
- Blank-session recompose只切换同workspace内preset parent，joined generation计数和Agent disposer随之更新。
- 普通Agent `ctx.get()`不能读取workspace isolate service；显式`serviceFor`可以读取目标composition中的service。

### MCP

- Global `a` + ws1/ws2 override `a` + ws3/ws4继承 = 3个进程。
- Global `a`暴露`t1..t5`、override只暴露`t1..t3`时，override workspace看不到global`t4/t5`，仍能看到其他非`a` global tools。
- 未override workspace看到global `a`完整工具集；dispose ws1不影响global、ws2或继承workspace。
- 同scope重复`serverName`加载失败；跨workspace同名正常。
- `list_changed`、global/workspace reconnect和registration conflict按namespace串行；candidate失败恢复旧完整generation，不出现partial/mixed view。
- MCP cwd、显式env和HTTP headers只进入owning transport；不修改Host`process.env`，错误和reconnect日志不包含canary secret。

### Lifecycle与reload

- Initial create/resume的parse、trust、import、inactive、leak或MCP namespace失败都会回滚setup且Agent不publish。
- Acquire完成后任一setup/commit失败都只release一次；preset joined disposer先于workspace lease final release执行。
- Last release与watcher callback竞争时，由同一controller停止watcher、排空callback、dispose preset generations、workspace composition、MCP和scope。
- Live Agent期间修改／删除config只更新pending stamp，model-visible capabilities不变；最后release后下一次acquire使用latest generation。
- Pending config错误不破坏live generation；后续修复后下一次quiescent activation恢复。
- Decorator自身只在无live Agent时卸载/HMR；重复加载不叠加method wrapper，Host teardown无孤儿watcher、tool或MCP进程。

### Identity、trust与诊断

- 相同realpath的lexical/symlink cwd命中一个entry；不存在、不可读或realpath失败的cwd在Agent publish前拒绝。
- `trustWorkspaceConfig: false`时可以报告`untrusted`状态，但不会evaluate `!!js`、import项目module或spawn进程。
- 诊断区分not-configured、untrusted、parse、import、inactive、leak、namespace-conflict、reload-pending和dispose-failed。
- 默认日志只含workspace basename/hash，不含完整canonical path、secret values、headers或完整env。
- Root service leak被拒绝并回滚generation；effect-owned root listener/timer/process在fiber dispose后通过行为观察证明消失。

---

## 8. 已确定的产品选择

1. **Scope优先级与多preset**：采用`global→workspace→workspace-local preset→agent`。每个canonical workspace只有一棵workspace runtime/MCP，同workspace可以并发使用多个preset；preset比workspace更近。
2. **Workspace identity v1**：采用exact canonical cwd，即`realpath(session.header.cwd)`，不向上找Git root；不存在、不可读或不可realpath的cwd拒绝Agent。
3. **空闲回收**：最后一个Agent lease释放后立即dispose workspace runtime；下次进入重新挂载latest generation。
4. **信任默认值**：`trustWorkspaceConfig`默认`true`。只有显式启用bundle的profile会读取项目config；启用后默认执行`!!js`和项目插件。完整content-hash审批后置，`.envrc`不继承该信任。
5. **纯插件支持面**：v1支持Web以及所有通过公开异步`ctx.agents.create/resume`创建的Agent，不支持同步`AgentLoop.create()`和direct factory旁路。要求覆盖旁路时需要先增加DSH应用层awaited setup seam，不属于本纯树外方案。

---

## 9. 参考

- `dsh-scope`：`createScope`、`bindScopeParent`、`ScopeParentBinding.rebind`、`scopeChainOf`
- `dsh-agent-presets`：standing mount、`mount`、`composeFrom`、`recompose`、mount audit
- `dsh-tools`：`ScopedLayers`、nearest-name view、UNKNOWN_TOOL lookup
- `dsh-mcp-client`：connection supervisor、tool sync、root-global `activeServerNames`
- `Momojie-S/dsh-workspace-mcp`：Agent-scoped MCP、chokidar和teardown先例
- RFC 941：<https://github.com/deepseek-ai/deepseek-harness/discussions/941>
- 社区先例 #1320：<https://github.com/deepseek-ai/deepseek-harness/discussions/1320>
