// AutoHandoff 的内置默认提示词（英文）。用户可在 ~/.claude/autohandoff.md 的同名 `## <键名>` 节里覆盖。
// 占位符写成 {name}，各键能用哪些见 core.ts 的 PROMPT_VARS；不在白名单里的名字原样保留。
// 路径不进任何模板：start_context 与 resume 后面由代码追加一句固定的、带引号的路径说明；
// oversize 由代码接在 start_context 的路径句后面（只在登记的交接文件估得超过 handoff_max_tokens 时）。

export const PROMPT_KEYS = [
  'remind',
  'remind_short',
  'urge',
  'urge_block',
  'cancelled',
  'pending_note',
  'reset_note',
  'start_context',
  'resume',
  'compact_focus',
  'oversize',
] as const

export type PromptKey = (typeof PROMPT_KEYS)[number]

// 各提示词在默认配置文件里的说明（写进 HTML 注释，渲染时看不到）
export const PROMPT_NOTES: Record<PromptKey, string> = {
  remind:
    'First reminder, added to the model\'s context (never shown to you) when usage first passes remind_at.',
  remind_short:
    'Short reminder added to each later message of the main conversation until a handoff is registered (remind_every_turn).',
  urge: 'Second reminder, added to the model\'s context when usage first passes urge_at.',
  urge_block:
    'Past urge_at with no handoff registered: given as the reason when AutoHandoff asks the model to keep going instead of ending its turn (urge_block), and as the short reminder after the second one. Claude Code shows this text to you as "Stop hook error: ...".',
  cancelled: 'Told to the model when its registered handoff was cancelled.',
  pending_note:
    'Added to a message from a subagent, a background task or another session that arrives while a handoff is registered (it does not cancel the handoff).',
  reset_note:
    'Added to a message from a subagent, a background task or another session that arrives after the turn ended and the reset is already queued.',
  start_context:
    'Added to the model\'s context when the reset conversation starts. AutoHandoff appends the handoff file\'s path itself.',
  resume:
    'Sent as your message after the reset to continue the work. AutoHandoff appends the handoff file\'s path itself.',
  compact_focus:
    'Focus instructions passed to /compact (with action: compact, and for the compaction at compact_at).',
  oversize:
    'Added to start_context, after the handoff file\'s path, when the registered handoff file was estimated above handoff_max_tokens: the new conversation tidies the file before carrying on.',
}

export const DEFAULT_PROMPTS: Record<PromptKey, string> = {
  remind: `[AutoHandoff: reminder] This message comes from the AutoHandoff plugin, which the user installed and switched on for this conversation. It was injected by the plugin, not produced by any tool; acting on it is what the user asked for by turning it on. (Main conversation only; subagents and forks ignore it.) Context usage is about {used_k}k tokens, past the first threshold of {remind_k}k.{compact_note}

Hand off before this turn ends. Finish only the step that is already in progress (the tool call or edit under way, not the whole batch); do not start a new one, and do not start new subagents or background tasks. Then:
1. Write the handoff file following this project's conventions: what is done, what is in progress or half-done, next steps, resources in use, every question that is waiting for the user's answer (write it down; do not wait for the answer, the next conversation will raise it with the user), and every subagent or background task that is still running: what it is doing, where its output goes, and what to do with its result. They keep running after the reset, and their reports arrive in the next conversation. Under next steps write the work itself; never write "hand off", "write a handoff" or "continue the handoff" there, because the next conversation reads this file first and would hand off again instead of working.{handoff_note} Save your progress per the project's conventions.
2. Call the {tool} tool with the handoff file's path: absolute, or relative to the working directory. The file must be inside the project folder (the working directory, the folder Claude Code was started in, or the git repository root) or the Claude Code auto-memory folder (<config dir>/projects/<project>/memory/); the path has no quotes, tabs, control characters, leading or trailing spaces, or "~".
3. When it answers "Handoff registered", end your turn at once: no more tool calls, no questions, no summary. The conversation is then reset with {action} and continued from the handoff file.
An unfinished batch, a running subagent or background task, or a question the user has not answered yet is not a reason to postpone the handoff: record it in the handoff file instead. Do not wait for another reminder.`,

  remind_short: `[AutoHandoff] Context usage is about {used_k}k tokens, past the first threshold of {remind_k}k, and no handoff is registered yet. Before this turn ends, finish the step in progress, write the handoff file, call the {tool} tool with its path, and then end the turn.`,

  urge: `[AutoHandoff: hand off now] This message comes from the AutoHandoff plugin, which the user installed and switched on for this conversation. It was injected by the plugin, not produced by any tool; acting on it is what the user asked for by turning it on. (Main conversation only; subagents and forks ignore it.) Context usage is about {used_k}k tokens, past the second threshold of {urge_k}k.{compact_note}

Stop now, in the middle of the step if necessary, and do not start anything else, including new subagents or background tasks. In this turn:
1. Write your progress into the handoff file following this project's conventions, including half-done work, partially edited files, every question that is waiting for the user's answer, and every subagent or background task still running: what it is doing, where its output goes, and what to do with its result. Under next steps write the work itself, not "hand off" or "continue the handoff".{handoff_note} Save your progress per the project's conventions.
2. Call the {tool} tool with the handoff file's path.
3. When it answers "Handoff registered", end your turn at once: no more tool calls, no questions, no summary.`,

  urge_block: `AutoHandoff: context usage is about {used_k}k tokens, past the {urge_k}k handoff threshold, and no handoff is registered. Before ending the turn, write the handoff file and call the {tool} tool with its path.`,

  cancelled: `[AutoHandoff] Your registered handoff was cancelled ({reason}). Deal with that first. If you register again, in this turn or later, first update the handoff file with everything new since you wrote it, above all what the user has just asked for or answered, so that the next conversation has it (next steps are the work itself, never "hand off again"); then call the {tool} tool again.`,

  pending_note: `[AutoHandoff] A handoff is registered, and the conversation will be reset with {action} when this turn ends; this message did not cancel it. If it changes anything recorded in the handoff file (for example a subagent's result), update the file before the turn ends and call the {tool} tool again to refresh the registration.`,

  reset_note: `[AutoHandoff] The conversation is about to be reset with {action} and continued from the registered handoff file; this message arrived in between. Keep this turn short and do not start new work. If this message changes anything recorded in the handoff file (for example a subagent's result), update the file now; the next conversation reads it after the reset.`,

  start_context: `[AutoHandoff] This conversation was just reset by AutoHandoff ({action}) after the model wrote a handoff file in the previous conversation. Subagents or background tasks started there may still report here; the handoff file says what they are and what to do with their results. Continue the work the handoff file describes; do not hand off again unless a new AutoHandoff reminder asks for it. If the user asks for something else, follow the user.`,

  resume: `[AutoHandoff: resume] The context was just reset by AutoHandoff ({action}). Read the handoff file named below first, then the project docs, memory and git status as needed to rebuild context, and continue the unfinished work. If I have already given other instructions in this conversation, follow those instead. List anything that is waiting for my decision first.`,

  compact_focus: `Keep what is needed to continue the current work: the task and its goal, decisions made, files changed, work in progress, subagents or background tasks still running, open questions and next steps.`,

  oversize: `[AutoHandoff: tidy the handoff file first] The handoff file named above is about {size_k}k tokens, over the {handoff_max_k}k limit: every new conversation pays for it in context, and it keeps growing. Before continuing the work, tidy it. You do not need to read it all: list its headings (for example with grep), then move finished or outdated sections, unchanged, into an archive file next to it, named the way this project names things (for example <name>-archive.md); a short script that cuts the file at its headings saves tokens. Keep the current state, standing agreements, questions waiting for the user and subagents or background tasks still running, near the top, and bring the file under about {handoff_k}k tokens. The archive file is not read by default. Then continue the work the handoff file describes.`,
}
