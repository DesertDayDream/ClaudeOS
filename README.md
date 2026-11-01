# ClaudeOS

Give Claude a brain you can see.

- **The cloud** is Claude's memory. A new brain starts as an empty cloud; every memory Claude saves appears as a glowing dot.
- **The Memory tab** lists every memory and searches them; matching dots stay lit. Click a dot or a row to read the whole memory, edit it, or delete it (you can undo, and deleted memories are kept in `~/.claudeos/trash.jsonl`).
- **The spheres** are employees: one per skill (`SKILL.md`). Each gets a name for good. Write a new skill and a new hire appears.
- **The Team tab** is a task board: each employee shows what it's working on (also floating over its head) or how its last run went. Click one to see its recent runs: the task, whether it finished, was stopped or failed, how long it took, Claude's answer and the files that employee wrote.
- **Hire, edit and fire** without asking Claude: *+ Hire an employee* at the top of the Team tab writes a new `SKILL.md` (a name, a description Claude uses to pick it, and its instructions). Click an employee for *Edit SKILL.md* or *Fire*; a fired employee's folder goes to `~/.claudeos/trash/skills` and *Undo* brings it back with the same name. Only the brain's own team can be changed here; your personal and plugin skills open read-only.
- **Token use:** under the chat, a meter shows how many tokens each message resends and whether the cache is still warm; each reply shows what it read and wrote. **Wrap up** saves what matters to the brain and starts a fresh chat that gets a short handover, and ClaudeOS suggests it when a chat gets big or the cache has expired.
- **The chat** sends your requests to Claude inside the brain's folder. You watch the employees it hands work to light up and move toward the brain. Anything that needs your OK shows up as an Allow / Deny card.
- **Linked brains:** from the brain menu, choose *Link brains…* to let this brain use another one. Claude here can read the linked brain's memory (never change it) and hand its team tasks, which run in that brain and send back the answer. Its skills show in the Team tab with a *Copy* button. Linked brains float beside the cloud.
- **Brains** are folders. Make as many as you like (one per project, client or idea) and switch between them from the name under the title.

## The easy way: ClaudeOS.exe (Windows)

If someone gave you `ClaudeOS.exe`, you only need [Claude Code](https://claude.com/claude-code), opened once with `claude` so you're logged in. Double-click `ClaudeOS.exe`: it opens ClaudeOS in your browser and puts an icon in the system tray (click it to open the page again, right-click to quit). It has Node and the memory server built in. Windows may warn that it's from an unknown publisher, because it isn't signed. Its log is in `~/.claudeos/claudeos.log`.

To build it yourself from this folder: `npm install`, then `npm run build:exe`. The result is `dist/ClaudeOS.exe` (about 90 MB), with the ClaudeOS icon from `assets/icon.ico`. To change the icon, edit `scripts/make-icon.mjs` and run `npm run icon` before building.

## What you need to run it from this folder

- [Node.js](https://nodejs.org) 18 or newer
- [Claude Code](https://claude.com/claude-code) (the native installer), opened once with `claude` so you are logged in
- Only for the Creative team's video skills: [ffmpeg](https://ffmpeg.org) and Python 3.10+ with `pip install numpy pillow faster-whisper`

## Start it

- **Windows:** double-click `Start ClaudeOS.cmd`.
- **macOS / Linux:** run `./start.sh` (or `npm start`).

It installs itself the first time, starts a small local server, and opens http://localhost:4747 in your browser.

The first time, ClaudeOS asks you to set up your first brain. Give it a name (or keep the suggested **Brain**), choose where the folder goes (your Desktop by default), and pick how it starts:

- **Empty:** a blank cloud with no team of its own. Hire employees from the Team tab, or ask Claude to write skills.
- **Creative team:** six skills for short videos (reel, pixel, quill, radar, relay, pulse) and starter brand rules.

Or choose **Use a folder I already have** to turn an existing project into a brain.

## What a brain folder contains

ClaudeOS only ever adds what a folder is missing. It never overwrites or deletes your files.

| File | What it is |
|---|---|
| `brain/memory.jsonl` | The brain's memory, run by the official `memory` MCP server. Copy it to back it up. Point other agents (Codex, Claude Desktop) at this file to share the brain. |
| `.mcp.json` | Connects Claude Code to that memory server. |
| `CLAUDE.md` | The habits: search the brain before answering, save decisions after, hand work to the right skill. `AGENTS.md` points other agents at the same rules. |
| `.claude/settings.json` | Hooks that tell ClaudeOS which skill is working. |
| `.claude/skills/` | The brain's own team. |

## Where your data lives

The app folder holds only code, so you can move it, update it or zip it and give it to someone. Your own data is in `~/.claudeos` (`C:\Users\<you>\.claudeos` on Windows): the list of brains, chat history, employee names and the activity log. Set `CLAUDEOS_HOME` to keep it somewhere else.

## Privacy and safety

- Everything runs on your computer. The server only listens on `127.0.0.1`, and the chat only accepts requests from the ClaudeOS page itself, so other websites can't send Claude commands.
- What Claude reads is sent to Anthropic, as with any Claude Code session. Don't put passwords or keys in a brain.

## Credits

The Creative team template is adapted from [bekhruztbx/ai-creative-team](https://github.com/bekhruztbx/ai-creative-team) (MIT, see `templates/creative/skills/LICENSE-ai-creative-team`). The 3D view uses [three.js](https://threejs.org).
