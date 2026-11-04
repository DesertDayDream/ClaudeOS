"""ClaudeOS as a Harbor agent.

Claude Code with what ClaudeOS gives a benchmark chat on top of it, exported from the running app
(chat.mjs harness()) into a bundle folder:
  foundations.md  the ClaudeOS foundations block ClaudeOS writes into the chat folder's CLAUDE.md
  runtime.md      the runtime context file the chat is told to read before its first message
  brain/          the brain's CLAUDE.md, AGENTS.md and .claude/skills (added with --add-dir, as ClaudeOS does)
  memory.jsonl    a copy of the brain's shared memory, served by the same memory MCP server
  mcp.json        the MCP servers (memory) in Claude Code's --mcp-config format

Everything else (install, sign-in, model, effort, trajectory and token accounting) is Harbor's own
Claude Code agent, so the two contestants differ only by what ClaudeOS adds.

Not included: ClaudeOS's desk MCP (terminal, artifacts, side sessions, approval cards), which needs the
app's own server; a headless benchmark doesn't use them.
"""

import os
from pathlib import Path

from pydantic import Field

from harbor.agents.installed.claude_code import ClaudeCode, ClaudeCodeOptions
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

REMOTE = "/claudeos"


class ClaudeOSOptions(ClaudeCodeOptions):
    bundle: str | None = Field(default=None, description="Host folder with the ClaudeOS bundle.")


class ClaudeOS(ClaudeCode):
    options_model = ClaudeOSOptions
    options: ClaudeOSOptions

    @staticmethod
    def name() -> str:
        return "claudeos"

    def __init__(self, logs_dir: Path, *args, **kwargs):
        super().__init__(logs_dir, *args, **kwargs)
        self._bundle = Path(self.options.bundle or os.environ.get("CLAUDEOS_BENCH_BUNDLE", ""))
        if not (self._bundle / "foundations.md").is_file():
            raise ValueError(f"ClaudeOS bundle not found at {self._bundle!s}")

    def build_cli_flags(self) -> str:
        flags = super().build_cli_flags()
        extra = f"--add-dir {REMOTE}/brain"
        if (self._bundle / "mcp.json").is_file():
            extra += f" --mcp-config {REMOTE}/mcp.json"
        return f"{flags} {extra}".strip()

    async def run(
        self, instruction: str, environment: BaseEnvironment, context: AgentContext
    ) -> None:
        await environment.upload_dir(self._bundle, REMOTE)
        # the foundations block goes into the working folder's CLAUDE.md, exactly as ClaudeOS writes it
        await self.exec_as_agent(
            environment,
            command=(
                "touch /app/CLAUDE.md && "
                "printf '\\n<!-- ClaudeOS foundations: begin -->\\n' >> /app/CLAUDE.md && "
                f"cat {REMOTE}/foundations.md >> /app/CLAUDE.md && "
                "printf '\\n<!-- ClaudeOS foundations: end -->\\n' >> /app/CLAUDE.md"
            ),
        )
        skills = f"{REMOTE}/brain/.claude/skills"
        if (self._bundle / "brain" / ".claude" / "skills").is_dir():
            self.skills_dir = skills
        # a project-folder chat in ClaudeOS loads the brain's CLAUDE.md beside the project's
        self._resolved_env_vars["CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD"] = "1"
        first = f"Read {REMOTE}/runtime.md for this chat's runtime context before proceeding.\n\n"
        await super().run(first + instruction, environment, context)
