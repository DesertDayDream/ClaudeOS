# {{NAME}}

This folder is a ClaudeOS brain: one Claude with a shared brain and a team of skills. The ClaudeOS app shows it live and lets you chat with it.

## The shared brain
Long-term memory lives in the `memory` MCP server (`brain/memory.jsonl`). Other agents (Codex, Claude Desktop) may read and write the same file.
- **Search first.** Before answering about the user's work, plans, preferences or past decisions, call `mcp__memory__search_nodes` or `mcp__memory__open_nodes`. Prefer what you find over guessing; say so if it looks out of date.
- **Save after.** When the user makes a decision, states a preference ("from now on…", "always…", "never…") or a fact worth keeping comes up, save it right away: `mcp__memory__add_observations` on the matching entity, or `mcp__memory__create_entities` for a new one. One short, dated fact per observation. Confirm in one line.
- **Only this brain.** Save memories only here, never in Claude Code's own memory files (`MEMORY.md` and the `memory/` folder under `~/.claude/projects`), even when the user says "remember". Other agents and new chats can't see those.
- Main entities: **"Brand rules"** (style, voice, channel), **"Lessons"** (what worked, from pulse), **"Ideas"** (from radar), **"Decisions"** (anything else the user decides).
- Never save passwords, API keys, tokens or private details about other people.

## The team (skills in `.claude/skills/`)
- **reel**: one raw clip from `inbox/` in, a finished vertical edit with captions out
- **pixel**: the cover image for an edit
- **quill**: scripts, hooks and voice-overs in the user's voice
- **radar**: comments and notes in `inbox/radar/` in, a ranked shortlist of video ideas out
- **relay**: post copy (titles, descriptions, captions); never posts
- **pulse**: analytics CSVs in `inbox/stats/` in, lessons for the next script out

Hand work to the skills that match the task, and only those. When a task has several parts, split it so each part goes to its own skill (a finished reel = reel, then pixel, then relay) instead of doing it all in one. Skills get better over time: if a step keeps failing or the user repeats a correction, propose an edit to that skill's `SKILL.md`, show the change, and save it only after they say OK.

## Folders
- `inbox/` raw clips waiting to be edited; `inbox/radar/` comments and notes; `inbox/stats/` exported analytics
- `out/` finished work: `out/<clip-name>/`, `out/scripts/`, `out/radar/`, `out/pulse/`
- `done/` raw clips that were edited successfully
- `brain/` the shared brain file

## Rules
- Run the skill scripts with `python` (if that command is missing, use `python3`).
- One command per Bash call, no `&&` chains.
- Nothing gets published, uploaded or posted. Finished work waits in `out/` for the user's OK.
- Never delete files.
