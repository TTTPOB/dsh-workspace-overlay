// A workspace composition row that registers a scope-owned tool with the real
// ToolRuntime. The row context chains to the workspace scope, so the tool
// lands in the workspace layer: it is visible to the workspace scope and every
// descendant agent scope, disappears when the composition is disposed or
// reloaded, and is replaced by whatever the next composition registers. State
// is observed through `ctx.tools.schemas(scopeKey)`, not through imports, so
// this fixture stays import-free (workspace compositions are loaded through
// Node's internal ESM loader, whose module registry is separate from the test
// runner's).
export const name = 'ws-tool-contribute'

export const inject = ['tools']

export function apply(ctx, config) {
  // register() owns the tool's lifecycle on this row context: disposal of the
  // row (reload, scope teardown) unregisters the tool automatically.
  ctx.tools.register({
    name: config.toolName,
    description: config.description ?? `Tool contributed by ${config.marker}`,
    parameters: {
      type: 'object',
      properties: { value: { type: 'string' } },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    execute: async (args) => `${config.marker}:${String(args.value)}`,
  })
}
