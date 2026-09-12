# 发布与依赖维护

推送 `v*` tag 触发 [Release workflow](../.github/workflows/release.yml)。Tag 必须等于 `v` 加 `package.json.version`。main、PR 与手工运行执行相同检查，但不发布。GitHub Actions 使用 Node 24 和 manifest 固定的 pnpm，读取冻结 lockfile，依次 typecheck、test、清空 dist 后 build、pack；只有验证通过才创建 Release，附件为预构建 `.tgz` 与 `SHA256SUMS`。同名 Release 不覆盖，修复后使用新版本。

发布步骤：更新版本与安装示例，执行 `pnpm install`（仅依赖变化时）、`pnpm typecheck && pnpm test && pnpm build && pnpm release:pack`，提交后推送 main 和对应 `v<version>` tag。安装使用 Release 的固定下载 URL，不能使用 `latest/download`。构建产物不提交到 Git，也不需要安装时执行构建脚本。

DSH/Cordis 共享运行时包放在 peerDependencies；devDependencies 固定经过测试的基线，lockfile 提供可复现安装。升级 Host 后先核对实际子包版本，再更新开发基线并验证 API。Semver 的 `^` 不会自动包含另一个版本号上的预发布版；按验证结果调整 peer 范围。普通运行时库留在 dependencies。

日常 profile 通过安装版 `dsh plugin --profile web add <Release URL>` reconciliation，并使用 Host 提供的共享 peers。检查 manifest、lockfile、实际模块解析、bundle 顺序和 `dsh --profile web --dump-config`，重启 Host 后验证新建会话。overlay 必须位于 envrc 之前。相同版本的两个物理安装也可能产生独立 Symbol/WeakMap，版本相同不能代替模块身份验证。

开发目录的 `link:` 会把本地 devDependencies 带入模块解析，因此不作为日常安装方式。日常 profile 切换到 tarball 并验证后，可执行 `pnpm clean` 删除本地 dist；再次开发运行 `pnpm build` 即可恢复。pnpm store/cache 使用用户级默认位置。
