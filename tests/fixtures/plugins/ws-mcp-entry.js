// A workspace composition row that drives the workspace-aware MCP manager.
// Workspace compositions are imported through Node's internal ESM loader,
// whose module registry is separate from the test runner's, so this fixture
// cannot import the TypeScript source directly: it resolves the manager
// through the composition's service graph instead and hands the raw row
// config to `activate()`, which validates it with the MCP Config schema.
export const name = 'ws-mcp-row'

// tools is required because the manager's connection registers through the
// row context (`ctx.tools` needs the inject declaration).
export const inject = ['workspaceMcp', 'tools']

export async function apply(ctx, config) {
  await ctx.workspaceMcp.activate(ctx, config)
}
