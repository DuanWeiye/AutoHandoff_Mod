# AutoHandoff Mod

A Claude Code plugin that hands a long conversation over to a fresh context automatically.

This is version 4 of AutoHandoff, rewritten as a Claude Code mod (an in-process hooks module: no keystroke
injection, no `settings.json` hooks). Version 3, the hook-and-keystroke implementation, is kept as a separate
repository: [DuanWeiye/AutoHandoff](https://github.com/DuanWeiye/AutoHandoff). Install one or the other, not both.

As the context fills up, AutoHandoff asks the model to write a handoff file (what is done, what is in progress, what
comes next) and register it. When the model's turn has ended, AutoHandoff resets the conversation with `/clear` (or
`/compact`) and sends a resume message, so the fresh conversation reads the handoff file and carries on. If the model
never hands off, AutoHandoff compacts the conversation itself before Claude Code's own auto-compaction would.

| Stage | Default | What happens |
|---|---|---|
| Reminder | `remind_at` = 300k tokens | The model is told to finish the step in progress and, before the turn ends, write the handoff file and register it. |
| Hand off now | `urge_at` = 450k tokens | The model is told to stop at the current step and hand off right away. If it tries to end its turn without doing so, it is asked once more (once per turn). |
| Last resort | `compact_at` = 650k tokens | A turn that ends at or above this with no handoff registered is followed by `/compact`. Claude Code's own auto-compaction stays where your Claude Code settings put it. |

AutoHandoff is **off by default** in every conversation; turn it on with `/autohandoff on` (or set `default_on`).

Version 4 is a rewrite as a Claude Code **mod** (a hooks module that runs inside Claude Code). It no longer types
into the terminal, needs no Python, tmux or console tricks, and works the same on every platform Claude Code runs
mods on. See [Upgrading from version 3](#upgrading-from-version-3).

## Requirements

- Claude Code **2.1.304 or later** with mods enabled. Developed and tested with 2.1.310.
  Mods do not run under `--safe-mode`, `--bare`, `disableAllHooks`, an organization policy that turns them off, or in
  a folder whose workspace trust you have not accepted yet. In those cases AutoHandoff does nothing, and
  `/autohandoff` answers that it is not active.
- An **interactive** session. `claude -p` and the Agent SDK cannot run `/clear` or send messages from a plugin, so
  AutoHandoff stays silent there.
- Tested in the terminal CLI on Linux. Windows, macOS, the VS Code extension and the desktop app have not been tested
  end to end (see [Known limitations](#known-limitations)).

## Install

The repository is a plugin marketplace with one plugin, `autohandoff`. Inside Claude Code:

```
/plugin marketplace add DuanWeiye/AutoHandoff_Mod
/plugin install autohandoff@autohandoff
```

Or from a local clone:

```
git clone https://github.com/DuanWeiye/AutoHandoff_Mod.git <dir>
```

```
/plugin marketplace add <dir>
/plugin install autohandoff@autohandoff
```

(From a shell: `claude plugin marketplace add <dir>` and `claude plugin install autohandoff@autohandoff`.)
Start a new session or run `/reload-plugins` to load it.

The marketplace is named `autohandoff`, the same as version 3's. If version 3 is installed, remove it first (see
[Upgrading from version 3](#upgrading-from-version-3)); otherwise `marketplace add` reports that the name is taken.

To try it in one session without installing: `claude --plugin-dir <dir>`.

### Updating

- **Installed from GitHub**: run `claude plugin marketplace update autohandoff`, then
  `claude plugin update autohandoff@autohandoff`, then restart the session (or run `/reload-plugins`). The new
  version is copied into `~/.claude/plugins/cache/`; sessions that are already running keep the old one until then.
- **Installed from a local clone**: Claude Code (checked with 2.1.310) loads the plugin from that folder in place;
  `claude plugin list` shows `Read from: <dir>`, and `claude plugin update` reports that there is nothing to update.
  After `git pull`, the next session (or `/reload-plugins`) uses the new code, whatever the version number. Because
  the folder itself is what runs, close running sessions before pulling a new major version (see [Upgrading from version 3](#upgrading-from-version-3)).
  If `claude plugin list` shows no `Read from:` line, your Claude Code copies the plugin into the cache instead: use
  the two update commands above.
- **Your configuration file is not updated.** `~/.claude/autohandoff.md` keeps every prompt as it was when the file
  was created, and a prompt written in the file replaces the built-in one, so a new version's prompt changes do not
  reach you by themselves (4.2.1 added `reset_note_user`; 4.2.0 changed `start_context`; 4.1.0 changed `remind`, `remind_short`, `urge`, `urge_block`,
  `start_context` and `resume`). Merge the new text from `hooks/prompts.ts` into the sections you have not
  customised, or delete those sections, or delete the file to get a fresh copy (note your settings first and put them
  back). New settings use their defaults until you add them; `/autohandoff status` lists the missing ones.

### Uninstall

```
/plugin uninstall autohandoff@autohandoff
/plugin marketplace remove autohandoff
```

Then delete `~/.claude/autohandoff.md` if you no longer want your settings.

### Upgrading from version 3

Version 3 lives in its own repository ([DuanWeiye/AutoHandoff](https://github.com/DuanWeiye/AutoHandoff)) and
is not updated in place. Finish or cancel (`/autohandoff off`) any handoff that a running version 3 session has
registered and close all sessions (version 3's hooks run at every prompt and turn end; uninstalling under a running
session breaks them). Then, in a shell:

```
claude plugin uninstall autohandoff@autohandoff
claude plugin marketplace remove autohandoff
claude plugin marketplace add DuanWeiye/AutoHandoff_Mod      # or a local clone
claude plugin install autohandoff@autohandoff
```

Start new sessions. Version 4 does **not** read the old configuration:

- Settings and prompts now live in `~/.claude/autohandoff.md` (created with the defaults on first run). Copy over any
  thresholds you had changed in `~/.claude/autohandoff.toml`; the keys are the same, without the `takeover.`,
  `context.` and `handoff.` prefixes, and `wait_turn_end_minutes` is now `wait_minutes`. Customised prompts have to be rewritten: the model now calls a tool
  (`{tool}`) instead of running a command (`{cmd}`), and the handoff path is added by AutoHandoff (no `{file}`).
- `~/.claude/autohandoff.toml` and the `~/.claude/autohandoff-state/` folder are no longer used; delete them by hand.
  AutoHandoff never reads, moves or deletes them.
- If you added AutoHandoff hooks to a `settings.json` by hand for an older version, remove them.
- `AUTOHANDOFF_STATE_DIR` and `AUTOHANDOFF_DISABLE` are no longer read; see [Configuration](#configuration).

## Usage

In a conversation:

```
/autohandoff on | off | status     # no argument toggles; /autohandoff:autohandoff also works
```

The command is handled by the mod and never reaches the model; its output appears as dim lines in the transcript.
The on/off choice belongs to the conversation: it survives `/clear` and `/compact`, and comes back when you
`--resume` the conversation. New conversations follow `default_on`, which takes effect at the first message you
type (so agent team teammates, which never receive typed input, never switch on by themselves).

`/autohandoff status` shows whether AutoHandoff is on, the current context usage, the thresholds, the registered
handoff with its stage (or, before that, the handoff file the model has been asked to write), the configuration file
in use and any problems in it.

While a handoff is registered, a reset is running or AutoHandoff is paused after Esc (see Cancellation below), a
status line under the input box says so (Claude Code shows
plugin status lines with a ⚠ in front). Short notices appear in the top-right corner.

### What the model does

When a reminder arrives, the model writes a **handoff file for the next conversation** at the path AutoHandoff puts
at the end of the reminder, then calls the **`register_handoff`** tool (full name `mcp__autohandoff__register_handoff`)
with that path, and ends its turn. The reminder text tells it all of this; it does not need to know the tool in advance.
The model may also hand off before any reminder when your instructions or the project's (for example a `CLAUDE.md`
rule to hand off at a certain size) ask it to end the conversation and continue in a new one; the tool's description
allows that, but not handing off just because a task is finished or a handover document (such as `HANDOVER.md`) was
updated. The same rules apply, except that no path has been named yet, so the model picks one that passes the
rules below.

The path is `<project folder>/.autohandoff/_AUTOHANDOFF_<YYYYMMDD>_<HHMMSS>_<session>.md`: the folder Claude Code
was started in (or, if that is the home folder, the working directory or the git root), the local time of the first
reminder, and the first 8 characters of the session id, so that several conversations open in one project never
share a file. The path stays the same for the whole handoff (later reminders, registering again after a cancel); the
next conversation gets a new one when it hands off in turn. Started from the home folder with no project folder at
all, or when no project folder gives a path that passes the path rules below (a folder name with an apostrophe,
parentheses, `#` or `~`, or a path over 512 characters), the model is asked to put the file in the auto-memory folder
instead.

The file is written from scratch every time and has to make sense on its own: the next conversation reads it, and
only it, as the complete handoff. The model carries over what is still open from the handoff file its own
conversation started from (questions waiting for you, running subagents, standing agreements), never from whatever
file in the folder is newest. A project's own handoff or progress documents (a `HANDOVER.md` that grows a dated
section per handoff, say) are updated the way the project does it; AutoHandoff neither reads nor limits them. You may
want to add `.autohandoff/` to the project's `.gitignore`. (The folder is not under `.claude/`: Claude Code
asks for permission before every write there, whatever the permission rules say.) The tool answers immediately
and never asks for permission. Only the main conversation can register; subagents and forks are refused.
Registering again before the turn ends replaces the earlier registration; a refused attempt leaves the earlier one in
effect, and the reply says so.

The handoff file must be:

- inside the **project folder**: the working directory, the folder Claude Code was started in, or the root of the
  git repository; or inside Claude Code's **auto-memory folder**, `~/.claude/projects/<project>/memory/`;
- a regular file (symbolic links are followed and judged by their target), not empty, at most 1 MiB, and modified
  within `fresh_minutes`;
- by AutoHandoff's estimate, not above `handoff_max_tokens` (see below);
- named by an absolute path or one relative to the working directory, with only letters (any script), digits,
  spaces and `/ . _ - : @ + ,` (on Windows also `\`, and `~` only inside 8.3 short names such as `PROGRA~1`), at most
  512 characters. Spaces are fine inside the path (`C:\Users\Jane Doe\project\HANDOVER.md`) but not at either end;
  tabs and other whitespace, quotes, `~` (it is not expanded), control and invisible characters are refused.

Anything else is refused with the reason, and the model can fix it and register again. The home folder itself and
a drive root never count as a project folder, and nothing else under `~/.claude` (settings, credentials,
transcripts) is accepted.

### What happens after registration

1. The turn ends normally. AutoHandoff checks the file once more (still there, same file, not empty) and queues
   `/clear` (or `/compact <compact_focus>` with `action: compact`). The command runs as soon as Claude Code is idle.
2. The new conversation starts with a note in the model's context (`start_context`) that names the handoff file and
   says it is the complete handoff; other project documents are read only for details.
3. AutoHandoff sends the resume message (`resume`) as your message; Claude Code shows it with
   "Prompt from the autohandoff plugin". The model reads the handoff file and continues.

**Handoff file size.** The next conversation reads the whole handoff file, and Claude Code's Read tool stops at
25,000 tokens per read. The reminders ask for about three quarters of `handoff_max_tokens` (15k by default). At
registration AutoHandoff reads the file once and estimates its size the way the Read tool counts it (line-number
prefix included; the estimate errs on the high side). A file above `handoff_max_tokens` is not registered. If it is
the file AutoHandoff named, the model is told the estimate and the limit, shortens the file and registers again. Any
other file (a project's own `HANDOVER.md`, say, if your custom prompts ask for that) is left alone: the model is told
not to cut it and to write the handoff to the file AutoHandoff named instead. The estimate counts tokens, not lines;
the Read tool also stops at 2,000 lines per read, which matters only for a file of very short lines.

Subagents, background shells and monitors that are still running are not waited for: they keep running across the
reset, and their reports arrive in the new conversation. The reminders ask the model to list them in the handoff file
together with what to do with their results.

## How it works

AutoHandoff keeps one small record per conversation in the plugin store and moves it to the new session id when
`/clear` changes it. Every decision comes from typed hook events; it never reads the screen or the transcript.

**Thresholds.** Context usage is read from Claude Code (`$.session.usage()`, the same number as the status line)
after every tool call of the main conversation, at every message and when a turn ends. Each threshold is sent once
per conversation (jumping over both sends only the second), as context the model sees and you do not. After the first
reminder, every later message of the main conversation carries a short reminder until a handoff is registered
(`remind_every_turn`). Past `urge_at`, the first attempt to end a turn without a handoff is blocked once with the
`urge_block` text (`urge_block`); Claude Code shows that text to you as "Stop hook error: …". If another plugin or
settings hook already blocked that stop, AutoHandoff adds nothing. When usage drops below `remind_at` (after a
compaction) the reminders start over. If the model's context window is not above `remind_at`, a notice says so once.

**Where messages come from.** Each incoming message of the main conversation is classified by the origin Claude Code
stamps on it:

- typed by you (or from another front end bridged to this session), and any origin AutoHandoff does not know: a
  registered handoff is cancelled and the model is told why in that same message;
- from an agent (a subagent hand-back, a task or background-shell notification, another session): the handoff stays
  registered and the message carries a note asking the model to update the handoff file if the message changes it;
- a notice the engine queues by itself (`isMeta` with no origin): ignored;
- AutoHandoff's own resume message: ignored.

**Cancellation.** A registered handoff is cancelled, and nothing is reset, when:

| Cause | Model told | Notice |
|---|---|---|
| A new message from you, or from an unknown source | yes, in that message | toast |
| The turn ends with an API error, or the reply is refused | yes, at the next message | toast (and notification for API errors) |
| The turn does not end within `wait_minutes` of registering | yes | toast and notification |
| The handoff file is gone, moved or empty when the turn ends | yes | toast |
| AutoHandoff is reloaded or Claude Code restarts before the reset is queued | yes | toast |
| You press Esc, or reject a tool (the turn ends without a Stop) | no: you stopped it, so it waits for you | none |
| You press Esc after the reset is queued, and Claude Code drops the queued reset | yes, at the next message; no, if this conversation already has the handoff (your own `/clear` ran first) | toast; none in that second case |
| The reset is refused as soon as it is issued, because you stopped the session with Esc earlier and have not typed since | yes, at the next message | toast and notification |
| A queued reset has still not run after `wait_minutes` of idle time: it is set aside, not dropped (see below) | yes, at the next message; no, if this conversation already has the handoff | toast and notification |
| You run `/clear`, `/compact` or `/resume`, or `/autohandoff off` | no | none |
| Claude Code exits | no | none |

When the model is told, the reminder it last received counts as unsent again, so it is repeated at the next chance.
The cancellation note asks the model, before it registers again, to update the handoff file with whatever is new,
above all what you just asked for.

**Once the reset is queued** it cannot be withdrawn (only Esc can veto it before it runs). `/clear`, `/compact`,
`/resume` and `/autohandoff off` typed in that window do not cancel it; a toast says the reset is queued. After
`/autohandoff off` the reset still runs and resumes, and AutoHandoff stays off in the new conversation. If you press
Esc in that window (for example to stop a turn that runs ahead of the reset), Claude Code drops the queued reset too:
a toast says the handoff was cancelled, the model is told at the next message, and AutoHandoff does not queue the
reset again by itself. In a conversation that already has the handoff (your own `/clear` ran before the queued
`/compact`) nothing is said: nothing was lost, and the model there never registered anything.

**After Esc, AutoHandoff pauses until your next input.** Once Claude Code has refused a reset because you pressed
Esc, it refuses every reset a plugin issues until you send input. Reminding the model in that time would only make
it write and register a handoff that cannot be carried out, once for every agent report that comes in. So from the
refusal until your next message or command (typed here or sent through Remote Control; `/autohandoff status` does
not count) AutoHandoff sends no reminders, does not hold a turn open at `urge_at`, does not accept a handoff (the
model is told why and when it works again) and does not compact at `compact_at`. The status line reads "paused
until your next input (stopped with Esc)". Reports from agents and background tasks, scheduled prompts and other
plugins' prompts do not end the pause; your next input does, and the reminder comes back with it. The same pause
applies when the refused reset is the first you hear of it: you stopped a turn with Esc, left, and a later agent
report led the model to hand off. That refusal is announced once, with a toast and a notification.

A queued reset runs as soon as the conversation is idle, so time spent in a turn that runs ahead of it (see the next
paragraph) is not waiting time, however long that turn takes. If the conversation has been idle for `wait_minutes`
in total and the reset still has not reported back, AutoHandoff sets it aside instead of leaving the conversation
"resetting" for good: a toast and a notification say that the queued command was set aside, the model is told at the
next message that its registration no longer stands (not in a conversation that already has the handoff), and
reminders and registration work again. The handoff is not dropped: if that reset does run later, the conversation is
still continued from the handoff file. The set-aside reset is forgotten when a new handoff is registered, when
AutoHandoff compacts at `compact_at`, when you run `/clear` or `/compact` yourself, and when Claude Code exits.

**Messages that were waiting when the turn ended.** Some messages are not delivered into a running turn and wait in
Claude Code's queue until it ends: one you send through Remote Control while the model is working, a scheduled
prompt, another plugin's prompt, an agent's report. The reset is queued only when the turn ends, behind them, so
Claude Code first gives each of them a turn in the old conversation and resets afterwards. AutoHandoff adds a note to
such a message. A report from an agent (a subagent, a background task, another session) gets `reset_note`: keep the
turn short and update the handoff file if the message changes it. Every other message, whether you wrote it or not
(Remote Control, a scheduled prompt, another plugin's prompt, a channel message, an unknown source), gets
`reset_note_user`: answer as usual but start no new work, and add whatever the next conversation must act on to the
registered handoff file, whose path is given. The reset then runs and the resume message is sent as usual. The new
conversation knows only what is in the handoff file. Pressing Esc during that turn drops the queued reset and cancels
the handoff, as described above. Only a message of that second kind that is handled by a conversation which already
has the handoff counts as the conversation having been taken over, and then the resume message is skipped: one that
arrives after AutoHandoff's own reset has happened but before AutoHandoff has the reset's result, or one you send in
the conversation your own `/clear` opened while AutoHandoff's `/compact` was still queued.

**Reload versus restart.** When the mod is hot-reloaded (for example the plugin is updated) while a reset is queued,
the queued command still runs and the new module sends the resume message once. When Claude Code itself was
restarted (a crash, a killed process) and the conversation is resumed, the queued command died with the old process:
the handoff is cancelled with a toast, the model is told, and a later `/clear` of yours is an ordinary one.
AutoHandoff tells the two apart with per-session state the host keeps across hot reloads but not across processes.

**No reset loops.** A conversation that AutoHandoff has just continued from a handoff file does not accept a new
registration until its context has grown by `resume_guard_tokens` (100k by default) since the resume, its context
passes `remind_at`, or you type a message or a command in it (`/autohandoff status` does not count). The growth is
counted from the first usage reading after the resume (Claude Code reports no usage between the reset and the first
response), which comes before the model reads the handoff file: the 20–60k tokens a resumed conversation usually
spends reading the handoff file and project documents are part of it. If Claude Code's own compaction drops the
context below that first reading, the growth counts as zero until the context is back above it (this happens only
when `remind_at` is above the point where Claude Code compacts). Messages from subagents, background tasks or other
sessions do not lift it, so a conversation that another session keeps busy for hours can still hand off once it has
done that much new work and your or the project's instructions call for ending the conversation and continuing in a
new one (updating a handover document does not count). A refused model is told to carry
on with the work and to hand off only when a reminder or those instructions ask for it, how long ago the
conversation was continued, how much its context has grown and when registering works again.
`/autohandoff status` shows the same. The reminders also tell the model to write the work itself under "next steps",
never "hand off again".

**The `compact_at` safety net.** When a main-conversation turn ends at or above `compact_at` with no handoff
registered, AutoHandoff queues `/compact <compact_focus>`. During that compaction no reminders are added and
registrations are refused. If you veto it with Esc, AutoHandoff pauses until your next input, as described under
Cancellation, and tries again after that; after three failures it stops trying in that conversation
(`/autohandoff status` says so).

**Failing safe.** Every hook catches its own errors and lets the event through, so AutoHandoff never blocks your
input. If its state cannot be saved when a reset is due, it does not reset and tells you; a registration that cannot
be saved is answered "Not registered".

## Configuration

One file: `~/.claude/autohandoff.md` (in `CLAUDE_CONFIG_DIR` when that is set). It is created with every default and
comments the first time AutoHandoff runs, and read again whenever a value is needed, so edits take effect without a
restart. Delete it to get a fresh copy. Missing or invalid values fall back to the built-in defaults and are listed by
`/autohandoff status`.

The file is Markdown. The `## settings` section holds `key: value` lines; every other `## <name>` section is a prompt
whose text runs to the next such heading. HTML comments (`<!-- -->`) are ignored anywhere.

```markdown
## settings

default_on: false
remind_at: 300000
urge_at: 450000
compact_at: 650000
action: clear
fresh_minutes: 10
wait_minutes: 60
urge_block: true
remind_every_turn: true
handoff_max_tokens: 20000
resume_guard_tokens: 100000

## remind

[AutoHandoff: reminder] ... your own text ...
```

| Key | Default | Meaning |
|---|---|---|
| `default_on` | `false` | Whether new conversations start switched on (from your first message). |
| `remind_at` | `300000` | First reminder, in tokens of context. |
| `urge_at` | `450000` | Second reminder. Must be above `remind_at`. |
| `compact_at` | `650000` | Compact when a turn ends here with no handoff. Must be above `urge_at`. |
| `action` | `clear` | `clear` or `compact`: how the conversation is reset after a handoff. |
| `fresh_minutes` | `10` | The handoff file must have been modified this recently when registered (1–1440). |
| `wait_minutes` | `60` | Give up if the turn has not ended this long after registering (1–1440). Also how long a conversation may be idle, added up across turns, with a queued reset that has not run before the reset is set aside. |
| `urge_block` | `true` | Past `urge_at`, block the first attempt to end a turn without a handoff, once per turn. |
| `remind_every_turn` | `true` | After the first reminder, add a short reminder to every later message until a handoff is registered. |
| `handoff_max_tokens` | `20000` | Size limit for the handoff file, in estimated tokens. The reminders ask for about 3/4 of it; a larger file is not registered (see *Handoff file size*). `0` turns the check off; otherwise at least 2000. |
| `resume_guard_tokens` | `100000` | A conversation just continued from a handoff file accepts no new handoff until its context has grown by this much since the resume (or passes `remind_at`, or you type a message or command); this stops a reset loop. The growth includes the 20–60k spent reading the handoff file and project documents after the resume. `0` drops the growth condition; otherwise at least 10000. A value at or above `remind_at` has no effect and counts as `0`. |

Token values accept `300000`, `300_000` or `300,000`, up to 10,000,000 (`remind_at`, `urge_at` and `compact_at` from 1;
`handoff_max_tokens` and `resume_guard_tokens` also take `0`, see the table). If `remind_at < urge_at < compact_at`
does not hold, all three use their defaults.

**Prompts.** Eleven prompts can be replaced; a section you leave out uses the built-in text (the generated file contains
all of them, so you can edit in place):

| Section | Used for |
|---|---|
| `remind` | First reminder. |
| `remind_short` | Short reminder on later messages (`remind_every_turn`). |
| `urge` | Second reminder. |
| `urge_block` | Reason given when a turn end is blocked past `urge_at`, and the short reminder after the second one. Shown to you as "Stop hook error: …". |
| `cancelled` | Tells the model its registered handoff was cancelled, and why. |
| `pending_note` | Added to an agent message that arrives while a handoff is registered. |
| `reset_note` | Added to an agent message that arrives while the reset is queued. |
| `reset_note_user` | Added to any other message (yours, a scheduled prompt, another plugin's, a channel's, an unknown source) that was waiting when the turn ended and is answered before the queued reset. |
| `start_context` | Context for the model at the start of the reset conversation. |
| `resume` | The message sent as you after the reset. |
| `compact_focus` | Focus instructions passed to `/compact` (`action: compact` and `compact_at`). |

Placeholders are written `{name}`: `{used_k}` `{remind_k}` `{urge_k}` `{compact_k}` (thousands of tokens),
`{compact_note}` (a sentence about `compact_at`), `{handoff_note}` (the sentence giving the handoff file's size budget,
empty when `handoff_max_tokens` is 0), `{handoff_k}` `{handoff_max_k}` (the size to aim for and the limit),
`{tool}` (the registration tool's full name), `{action}` (`/clear` or `/compact`: the `action` setting, or, in
`reset_note_user`, `start_context` and `resume`, the command queued for the registered handoff), `{reason}` (in
`cancelled` only).
Each prompt accepts only the ones that make sense for it, and others are left as written. Paths are never
placeholders: AutoHandoff appends the path of the handoff file to write to `remind`, `remind_short`, `urge` and
`urge_block`, and the registered file's path to `reset_note_user`, `start_context` and `resume` (in the last two
marked as notes from the previous conversation rather than instructions from you). A prompt that uses `{file}` or the old `{cmd}` falls back to the built-in text.

**Environment variables.**

- `AUTOHANDOFF_CONFIG`: the **absolute** path of a configuration file to use instead of `~/.claude/autohandoff.md`
  (created with the defaults if missing). A relative path is ignored and reported by `/autohandoff status`, because it
  would resolve inside the project.
- To keep AutoHandoff out of one Claude Code process, start it with the plugin disabled, for example
  `claude --settings '{"enabledPlugins":{"autohandoff@autohandoff":false}}'`, or run `/autohandoff off` in the
  conversation. Version 3's `AUTOHANDOFF_DISABLE` is not read.

AutoHandoff never changes Claude Code's settings.

## Known limitations

- **Messages typed during a compaction are still followed by the resume message.** Claude Code holds a message you
  type while `/compact` runs until the compaction has finished, so AutoHandoff cannot tell you took over; both your
  message and the resume message are handled, and the resume message says to follow your instructions first.
- **A subagent's permission dialog can outlive the reset.** When a background subagent is waiting for your approval,
  the queued `/clear` does not wait for it. The dialog on screen then belongs to the subagent from the previous
  conversation: answer it as usual, and its report arrives in the new conversation.
- **`/resume` while a reset is queued.** If you switch to another conversation in that window, the queued `/clear`
  (or `/compact`) applies to the conversation you switched to, without a resume message. Its transcript is still
  there: `/resume` it again. The toast shown when you open `/resume` says this.
- **A reload between two clears.** If you type `/clear` while the handoff turn is running and AutoHandoff is
  hot-reloaded exactly between your `/clear` and its own, the resume message can land in the intermediate
  conversation and be cleared away. The window is a fraction of a second; the handoff file is still there.
- **The same conversation open in two processes.** Resuming a conversation in a second terminal while the first one
  has a reset queued makes the second one cancel it; the first then clears without resuming.
- **A compaction that does not get below `compact_at`.** Only failed compactions are counted. If `compact_at` is set
  so low that a successful compaction still leaves usage above it, every turn ending above it compacts again. Keep
  `compact_at` well above what a compacted conversation needs.
- **A plugin reload while a reset is queued.** After a reload AutoHandoff no longer hears what became of the queued
  command. If you press Esc in the turn ahead of it, AutoHandoff takes the interrupted turn as the veto. If the
  command is lost in some other way, messages you send keep being told that the reset is about to happen until the
  idle time between turns adds up to `wait_minutes`; then it is set aside as described above.
- **Esc and channels.** The pause after Esc ends only with input typed in the session or sent through Remote
  Control. A message that reaches the session through a channel plugin does not end it.
- **If the per-session state cannot be read** when Claude Code starts, a queued reset is treated as still running:
  for up to `wait_minutes` of idle time the conversation gets no reminders and refuses registrations, and the status
  line keeps saying it is resetting; then the reset is set aside with a toast. This needs the host's in-memory state
  to fail and has not been observed.
- **Untested environments.** Only the terminal CLI on Linux has been tested end to end. Windows path handling is
  covered by unit tests only, and the VS Code extension,
  the desktop app and Remote Control have not been tried.
- **Mods are an early API.** Claude Code may change it without notice; AutoHandoff checks the version at start and
  stays inactive below 2.1.304.

## Development

```
claude plugin validate .     # manifests, hooks module, the $ calls it makes
claude plugin test .         # unit and flow tests (tests/*.test.ts), no session or network needed
```

| Path | Purpose |
|---|---|
| `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` | Plugin and marketplace manifests (the repository root is the plugin). |
| `hooks/hooks.json` | Names the hooks module. |
| `hooks/register.ts` | Event wiring: reads events and `$`, calls the core, carries out its effects. |
| `hooks/core.ts` | Pure logic: configuration, thresholds, origin classes, path rules, the per-conversation state machine. |
| `hooks/prompts.ts` | Built-in prompts. |
| `types/autohandoff.d.ts` | Type contract for the per-session state (`$.state`). |
| `commands/autohandoff.md` | `/autohandoff`; answered by the mod, and only reaches the model when mods are not running. |
| `tests/` | `core.test.ts` (logic), `state.test.ts` (state machine), `flow.test.ts` (hooks against a stubbed host). |
| `e2e/` | End-to-end driver for real sessions, plus an API fault-injection proxy and a helper mod that queues a prompt behind a running turn. |

**End-to-end tests** run real Claude Code sessions (they use your login and spend tokens):

```
e2e/mod_setup.sh init <work dir>                     # test project, low-threshold configs, test settings
python3 e2e/drive.py <work dir> [scenario ...] [--repeat N] [--keep]
python3 e2e/drive.py <work dir> --cleanup-only       # after --keep
```

Scenarios: `clear draft dialog deny interject notify cmp slash print compact fallback ctype agentdialog reload restart
esc apierr subreg urge userclear chain limit queued queuedc escq` (all by default). Each session runs in a separate tmux server (`SOCK`, default
`ahmod`) with `--plugin-dir` pointing at this checkout and `--settings` that disables an installed
`autohandoff@autohandoff`; the configuration comes from the work directory through `AUTOHANDOFF_CONFIG`. Afterwards
the driver kills the tmux server and removes exactly what the test sessions left under `~/.claude` (their project
transcripts, per-session files and plugin-store records) and the work directory; it prints the workspace-trust entry
it leaves in `~/.claude.json`.

- Run **one** driver per checkout at a time: all `--plugin-dir` sessions of the plugin share one store file.
- Do **not edit `hooks/`** while it runs: Claude Code hot-reloads a `--plugin-dir` mod when its files change.
- The sessions still load your user-level `~/.claude/CLAUDE.md`, which can sway scenarios that depend on the model
  following instructions.

Installing the plugin from a local directory copies the **whole folder** into `~/.claude/plugins/cache/`, untracked
files included (a `private/` folder, `.claude/worktrees/`, test caches). That copy is not what runs (see
[Updating](#updating)), but it takes space and confuses the question of which code is loaded. Install from GitHub,
or clean the folder before installing from it.

## License

MIT. See [LICENSE](LICENSE).
