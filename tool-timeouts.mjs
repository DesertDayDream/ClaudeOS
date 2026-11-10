// How long one MCP tool call may run. Outside servers (Blender, Unreal, a project's own) get a limit,
// so a server that hangs fails the call and the chat carries on instead of waiting all day. ClaudeOS's own
// server keeps a long one: approvals wait for the user and specialist runs can take hours.
export const TOOL_TIMEOUT_MS = 10 * 60 * 1000;
export const LONG_TOOL_TIMEOUT_MS = 24 * 3600 * 1000;
