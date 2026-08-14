# dsh-workspace-overlay

DSH 树外插件：为每个 canonical workspace 路径提供共享的 Cordis scope（`workspaceRegistry` service）。同一 workspace 的所有消费者（session、agent）租用同一个 scope；最后一个租约释放时 scope 被 dispose。

目标 DSH：`0.1.0-rc.6`（`@deepseek-ai/cordis` 4.0.1、`@deepseek-ai/dsh-scope` 0.1.0-rc.6），两者均为 peer + dev 依赖，版本与安装版一致。

## API（`./registry`）

- `WorkspaceRegistry extends Service`：默认导出；注册为 `ctx.workspaceRegistry`。
- `Config`：`trustWorkspaceConfig: boolean`，默认 `true`（是否信任 `<workspace>/.dsh/cordis.yml`）。
- `acquire(cwd)`：`cwd` 必须为绝对路径且指向已存在目录；canonical 为 `realpath(resolve(cwd))`（symlink 归一）。同一 canonical 通过 Map + single-flight 共享一个 entry；失败不残留缓存、可重试。
- lease：`key`（不透明 ScopeKey）、`ctx`（scope-owned context）、`canonical`、`trustWorkspaceConfig`；`release()` 幂等，最后一次 release `await scope.dispose()` 并从 Map 删除。
- `size` / `get(canonical)`：只读调试视图。

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

`dist/` 由 `tsc` 构建；built-entry smoke test 在目标安装版 DSH 的 profile 依赖树中解析包名后验证。
