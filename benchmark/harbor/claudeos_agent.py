"""ClaudeOS as a Harbor agent.

Claude Code with what ClaudeOS gives a benchmark chat on top of it, exported from the running app
(chat.mjs harness()) into a bundle folder:
  foundations.md  the instructions every ClaudeOS chat gets as an appended system prompt (the same text each time)
  runtime.md      this chat's own context, which ClaudeOS puts at the top of its first message
  brain/          the brain's CLAUDE.md, AGENTS.md and .claude/skills (added with --add-dir, as ClaudeOS does)
  memory.jsonl    a copy of the brain's shared memory
  memory-mcp.mjs  ClaudeOS's memory server: the official one with its lean search
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
    advisor: str | None = Field(default=None, description="Model that advises on hard steps (Claude Code's --advisor), as ClaudeOS sets it.")


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
        if self.options.advisor:
            extra += f" --advisor {self.options.advisor}"
        return f"{flags} {extra}".strip()

    async def run(
        self, instruction: str, environment: BaseEnvironment, context: AgentContext
    ) -> None:
        await environment.upload_dir(self._bundle, REMOTE)
        # the official memory server package, which ClaudeOS's memory-mcp.mjs wraps
        if (self._bundle / "memory-mcp.mjs").is_file():
            await self.exec_as_agent(
                environment,
                command=f"cd {REMOTE} && npm install --silent --no-audit --no-fund @modelcontextprotocol/server-memory@2.0.1",
            )
        # the instructions, once, as ClaudeOS sends them: an appended system prompt
        self.options.append_system_prompt = (self._bundle / "foundations.md").read_text(encoding="utf-8")
        skills = f"{REMOTE}/brain/.claude/skills"
        if (self._bundle / "brain" / ".claude" / "skills").is_dir():
            self.skills_dir = skills
        # a project-folder chat in ClaudeOS loads the brain's CLAUDE.md beside the project's
        self._resolved_env_vars["CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD"] = "1"
        # this chat's own context at the top of its first message, as ClaudeOS sends it
        runtime = (self._bundle / "runtime.md").read_text(encoding="utf-8").strip()
        first = f"<claudeos-context>\n{runtime}\n</claudeos-context>\n\n" if runtime else ""
        await super().run(first + instruction, environment, context)
