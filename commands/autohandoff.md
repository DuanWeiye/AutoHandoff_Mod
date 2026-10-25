---
name: autohandoff
description: "AutoHandoff for this conversation: hand off and reset automatically at configurable context thresholds. Usage: /autohandoff [on|off|status] (no argument toggles)"
argument-hint: "[on|off|status]"
---
This command is normally answered by the AutoHandoff mod and never reaches the model. If you are reading it, the mod is not running in this session: Claude Code is older than 2.1.304, mods are switched off (for example `--safe-mode`, `--bare`, `disableAllHooks`, an organization policy, or a workspace that has not been trusted yet), or this is not an interactive terminal session. Reply with one sentence telling the user that AutoHandoff is not active in this session and that it needs Claude Code 2.1.304 or later with mods enabled; do nothing else.
