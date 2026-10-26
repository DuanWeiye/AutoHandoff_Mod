// AutoHandoff 4.0 的纯逻辑层：不碰 `$`，只做计算。
// register.ts（第 2 批）负责：读事件与 `$` 的结果 → 调这里的函数 → 按返回的副作用列表去调 `$`。
//
// 内容：
//   1. 常量
//   2. 配置：解析 ~/.claude/autohandoff.md、校验、生成默认文件
//   3. 模板展开
//   4. 阈值判定
//   5. 来源分类
//   6. 路径规则（登记时的校验）
//   7. 每个对话的记录与状态转移
//   8. /autohandoff 的输出、版本比较等杂项

import { DEFAULT_PROMPTS, PROMPT_KEYS, PROMPT_NOTES, type PromptKey } from './prompts.js'

export { DEFAULT_PROMPTS, PROMPT_KEYS, type PromptKey }

// ───────────────────────── 1. 常量 ─────────────────────────

export const PLUGIN_NAME = 'autohandoff'
export const TOOL_NAME = 'register_handoff'
/** 模型看到的登记工具全名（实测 --plugin-dir 加载时也是这个名字） */
export const TOOL_FULL_NAME = `mcp__${PLUGIN_NAME}__${TOOL_NAME}`
/** 拦截的 md 命令真名（`$.command.register('autohandoff')` 会被 md 命令占名拒绝） */
export const COMMAND_NAME = 'autohandoff:autohandoff'
export const MIN_VERSION = '2.1.304'
export const CONFIG_FILE_NAME = 'autohandoff.md'
export const MAX_PATH_LENGTH = 512
export const MAX_HANDOFF_BYTES = 1024 * 1024
/** store 里多久没写的对话记录可以删掉 */
export const RECORD_TTL_MS = 30 * 24 * 3600 * 1000
/** 重置完成后多久还没收到续接结果，就当续接阶段结束（只为不让状态卡住） */
export const RESUME_STUCK_MS = 2 * 60 * 1000

// ───────────────────────── 2. 配置 ─────────────────────────

export type Action = 'clear' | 'compact'

export interface Settings {
  default_on: boolean
  remind_at: number
  urge_at: number
  compact_at: number
  action: Action
  fresh_minutes: number
  wait_minutes: number
  urge_block: boolean
  remind_every_turn: boolean
  /** 交接文件的大小上限（估算的 token 数）；0 关掉检测 */
  handoff_max_tokens: number
}

export interface Config {
  settings: Settings
  prompts: Record<PromptKey, string>
}

type Spec =
  | { kind: 'bool' }
  | { kind: 'int'; min: number; max: number }
  | { kind: 'choice'; options: readonly string[] }

const SPECS: Record<keyof Settings, Spec> = {
  default_on: { kind: 'bool' },
  remind_at: { kind: 'int', min: 1, max: 10_000_000 },
  urge_at: { kind: 'int', min: 1, max: 10_000_000 },
  compact_at: { kind: 'int', min: 1, max: 10_000_000 },
  action: { kind: 'choice', options: ['clear', 'compact'] },
  fresh_minutes: { kind: 'int', min: 1, max: 1440 },
  wait_minutes: { kind: 'int', min: 1, max: 1440 },
  urge_block: { kind: 'bool' },
  remind_every_turn: { kind: 'bool' },
  handoff_max_tokens: { kind: 'int', min: 0, max: 10_000_000 },
}

export const SETTING_KEYS = Object.keys(SPECS) as (keyof Settings)[]

export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
  default_on: false,
  remind_at: 300_000,
  urge_at: 450_000,
  compact_at: 650_000,
  action: 'clear',
  fresh_minutes: 10,
  wait_minutes: 60,
  urge_block: true,
  remind_every_turn: true,
  handoff_max_tokens: 20_000,
})

/** handoff_max_tokens 不为 0 时的下限：再小就成了「什么交接文件都算超长」，提示词里的 k 值也会是 0 */
export const HANDOFF_MAX_MIN = 1000

// 默认配置文件里每项设置上方的说明
const SETTING_NOTES: Record<keyof Settings, string> = {
  default_on:
    'Whether AutoHandoff starts switched on in new conversations (it takes effect at your first message). Toggle it per conversation with /autohandoff on|off; the choice survives /clear and comes back with --resume.',
  remind_at:
    'First reminder, in tokens of context: finish the step in progress, then write a handoff and register it before the turn ends.',
  urge_at: 'Second reminder: stop at the current step and hand off now. Must be above remind_at.',
  compact_at:
    'Last resort: when a turn ends at or above this many tokens with no handoff registered, AutoHandoff runs /compact <compact_focus>. Must be above urge_at. Claude Code\'s own auto-compaction stays where Claude Code\'s settings put it.',
  action:
    'How the conversation is reset once a handoff is registered and the turn has ended: "clear" runs /clear, "compact" runs /compact <compact_focus>; the resume message is sent after either.',
  fresh_minutes: 'The handoff file must have been modified within this many minutes when it is registered.',
  wait_minutes: 'Give up (and tell the model) if the turn has not ended this many minutes after registering.',
  urge_block:
    'Past urge_at with no handoff registered, ask the model once per turn to hand off instead of ending its turn (Claude Code shows the urge_block text as "Stop hook error: ...").',
  remind_every_turn:
    'After the first reminder, add a short reminder to every later message of the main conversation until a handoff is registered.',
  handoff_max_tokens:
    'Size limit for the handoff file, in estimated tokens (Claude Code\'s Read tool stops at 25000 per read). The reminders ask the model to keep the file to about three quarters of this. A registered file above it is still used, but the next conversation is first asked to move finished sections into an archive file (the oversize prompt). 0 turns the check and that sentence off; otherwise at least 1000.',
}

export function defaultConfig(): Config {
  return { settings: { ...DEFAULT_SETTINGS }, prompts: { ...DEFAULT_PROMPTS } }
}

export interface ParsedConfig {
  cfg: Config
  /** 给 /autohandoff status 看的问题列表（缺键、错值、未知节……） */
  problems: string[]
}

const H2 = /^##(?!#)[ \t]*(.*?)[ \t]*#*[ \t]*$/
const SETTING_LINE = /^(?:[-*][ \t]+)?([A-Za-z_][A-Za-z0-9_-]*)[ \t]*[:=][ \t]*(.*)$/
const KEYLIKE = /^[a-z][a-z0-9_]*$/

/**
 * 解析配置文件全文。text 为 undefined 表示文件不存在：直接用内置默认，不算问题。
 * 规则：`## settings` 节里是 `key: value` 行；其余 `## <提示词键名>` 节的正文是提示词，到下一个已知标题为止；
 * HTML 注释 `<!-- -->` 在任何位置都被忽略；不认识的 `##` 标题在提示词节里当正文。
 */
export function parseConfig(text: string | undefined): ParsedConfig {
  const cfg = defaultConfig()
  const problems: string[] = []
  if (text === undefined) return { cfg, problems }

  let src = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  // 注释换成同样多的换行，行号才对得上
  src = src.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ''))
  if (src.includes('<!--')) {
    problems.push('an HTML comment ("<!--") is never closed; the rest of the file after it is ignored')
    src = src.slice(0, src.indexOf('<!--'))
  }

  type Section = { name: 'settings' | PromptKey | null; start: number }
  const seen = new Set<string>()
  const settingLines: { line: string; no: number }[] = []
  const bodies = new Map<PromptKey, string[]>()
  let cur: Section = { name: null, start: 0 }
  const lines = src.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    const h = H2.exec(line)
    if (h) {
      const title = (h[1] ?? '').trim().toLowerCase()
      if (title === 'settings' || isPromptKey(title)) {
        if (seen.has(title)) problems.push(`section "## ${title}" appears more than once; the last one is used`)
        seen.add(title)
        cur = { name: title as Section['name'], start: i + 1 }
        if (title === 'settings') settingLines.length = 0
        else bodies.set(title as PromptKey, [])
        continue
      }
      if (cur.name !== null && cur.name !== 'settings') {
        // 提示词节里的其它 `##` 标题算正文；像键名的多半是写错了，提醒一下
        if (KEYLIKE.test(title)) problems.push(`"## ${title}" (line ${i + 1}) is not a known section; it is kept as part of "## ${cur.name}"`)
      } else {
        problems.push(`"## ${title}" (line ${i + 1}) is not a known section; it is ignored`)
        cur = { name: null, start: i + 1 }
        continue
      }
    }
    if (cur.name === 'settings') settingLines.push({ line, no: i + 1 })
    else if (cur.name !== null) bodies.get(cur.name)?.push(line)
  }

  // 设置项（given：文件里写到的键，值错也算写到了）
  const given = new Set<keyof Settings>()
  for (const { line, no } of settingLines) {
    const t = line.trim()
    if (t === '') continue
    const m = SETTING_LINE.exec(t)
    if (!m) {
      problems.push(`settings line ${no} is not "key: value"; ignored: ${clip(t)}`)
      continue
    }
    const key = (m[1] ?? '').toLowerCase()
    if (!isSettingKey(key)) {
      problems.push(`unknown setting "${key}" (line ${no}) ignored`)
      continue
    }
    const raw = unquote((m[2] ?? '').trim())
    const v = parseSetting(key, raw)
    given.add(key)
    if (!v.ok) {
      problems.push(`${key} ${v.why}; using the default (${String(DEFAULT_SETTINGS[key])})`)
      continue
    }
    ;(cfg.settings as unknown as Record<string, unknown>)[key] = v.value
  }
  if (seen.has('settings')) {
    const missing = SETTING_KEYS.filter((k) => !given.has(k))
    if (missing.length) problems.push(`missing settings (built-in defaults used): ${missing.join(', ')}`)
  } else {
    problems.push('no "## settings" section; built-in default settings used')
  }
  const s = cfg.settings
  if (!(s.remind_at < s.urge_at && s.urge_at < s.compact_at)) {
    problems.push(
      `need remind_at < urge_at < compact_at (got ${s.remind_at} / ${s.urge_at} / ${s.compact_at}); using the defaults for all three`,
    )
    s.remind_at = DEFAULT_SETTINGS.remind_at
    s.urge_at = DEFAULT_SETTINGS.urge_at
    s.compact_at = DEFAULT_SETTINGS.compact_at
  }
  if (s.handoff_max_tokens !== 0 && s.handoff_max_tokens < HANDOFF_MAX_MIN) {
    problems.push(
      `handoff_max_tokens should be 0 (off) or at least ${HANDOFF_MAX_MIN}, got ${s.handoff_max_tokens}; using the default (${DEFAULT_SETTINGS.handoff_max_tokens})`,
    )
    s.handoff_max_tokens = DEFAULT_SETTINGS.handoff_max_tokens
  }

  // 提示词
  for (const key of PROMPT_KEYS) {
    const body = bodies.get(key)
    // 没写这一节就用内置默认，不算问题（用户只想改阈值时不必抄全部提示词）
    if (body === undefined) continue
    const textOf = body.join('\n').trim()
    const why = checkTemplate(key, textOf)
    if (why.error) {
      problems.push(`## ${key}: ${why.error}; the built-in text is used`)
      continue
    }
    for (const w of why.warnings) problems.push(`## ${key}: ${w}`)
    cfg.prompts[key] = textOf
  }
  return { cfg, problems }
}

function isSettingKey(k: string): k is keyof Settings {
  return Object.prototype.hasOwnProperty.call(SPECS, k)
}

function isPromptKey(k: string): k is PromptKey {
  return (PROMPT_KEYS as readonly string[]).includes(k)
}

function unquote(v: string): string {
  const m = /^(["'`])(.*)\1$/.exec(v)
  return m ? (m[2] ?? '') : v
}

function clip(s: string, n = 60): string {
  return s.length > n ? `${s.slice(0, n)}…` : s
}

type Parsed = { ok: true; value: boolean | number | string } | { ok: false; why: string }

function parseSetting(key: keyof Settings, raw: string): Parsed {
  const spec = SPECS[key]
  if (spec.kind === 'bool') {
    const l = raw.toLowerCase()
    if (l === 'true' || l === 'false') return { ok: true, value: l === 'true' }
    return { ok: false, why: `should be true or false, got "${clip(raw)}"` }
  }
  if (spec.kind === 'choice') {
    const l = raw.toLowerCase()
    if (spec.options.includes(l)) return { ok: true, value: l }
    return { ok: false, why: `should be one of ${spec.options.join(', ')}, got "${clip(raw)}"` }
  }
  // 整数：允许 300000、300_000、300,000
  if (!/^(\d+|\d{1,3}([_,]\d{3})+)$/.test(raw)) return { ok: false, why: `should be a whole number, got "${clip(raw)}"` }
  const n = Number(raw.replace(/[_,]/g, ''))
  if (!(n >= spec.min && n <= spec.max)) return { ok: false, why: `should be between ${spec.min} and ${spec.max}, got ${n}` }
  return { ok: true, value: n }
}

/** 生成默认配置文件全文（带注释）。parseConfig(defaultConfigText()) 得到的就是内置默认值。 */
export function defaultConfigText(): string {
  const out: string[] = []
  out.push('# AutoHandoff configuration')
  out.push('')
  out.push('<!--')
  out.push('Created with the default values the first time AutoHandoff ran. Edit freely: AutoHandoff reads this')
  out.push('file again whenever it needs a value, so changes take effect without a restart. Delete the file to')
  out.push('get a fresh copy of the defaults. Missing or invalid values fall back to the built-in defaults, and')
  out.push('/autohandoff status lists them.')
  out.push('')
  out.push('Layout: the "## settings" section holds "key: value" lines. Every other "## <name>" section is a')
  out.push('prompt; its text runs to the next such heading. Text inside HTML comments like this one is ignored.')
  out.push('')
  out.push('Placeholders in prompts are written as {name}; names a prompt cannot use are left as written:')
  out.push('  {used_k} {remind_k} {urge_k} {compact_k}  token counts in thousands')
  out.push('  {compact_note}  a sentence about compact_at')
  out.push('  {handoff_note}  a sentence asking to keep the handoff file short (empty when handoff_max_tokens is 0)')
  out.push('  {handoff_k} {handoff_max_k}  the size to aim for (3/4 of handoff_max_tokens) and the limit, in thousands')
  out.push('  {size_k}   the estimated size of the registered handoff file, in thousands (oversize only)')
  out.push(`  {tool}     the tool the model calls to register its handoff file (${TOOL_FULL_NAME})`)
  out.push('  {action}   /clear or /compact, following the action setting')
  out.push('  {reason}   why a registered handoff was cancelled (cancelled only)')
  out.push('The handoff file\'s path is never a placeholder: AutoHandoff appends it, in quotes, to start_context')
  out.push('and resume itself.')
  out.push('-->')
  out.push('')
  out.push('## settings')
  out.push('')
  for (const k of SETTING_KEYS) {
    out.push(`<!-- ${SETTING_NOTES[k]} -->`)
    out.push(`${k}: ${String(DEFAULT_SETTINGS[k])}`)
    out.push('')
  }
  for (const k of PROMPT_KEYS) {
    out.push(`## ${k}`)
    out.push('')
    out.push(`<!-- ${PROMPT_NOTES[k]} Placeholders: ${PROMPT_VARS[k].map((v) => `{${v}}`).join(' ')} -->`)
    out.push(DEFAULT_PROMPTS[k])
    out.push('')
  }
  return out.join('\n')
}

/**
 * 配置文件所在目录：CLAUDE_CONFIG_DIR 优先，否则主目录下的 .claude。
 * 主目录：盘符形式的 USERPROFILE 优先（Windows 上 Git Bash 会把 HOME 设成 /c/Users/x，而 Claude Code 用的是 os.homedir()，
 * 即 USERPROFILE），否则 HOME，再否则 USERPROFILE。
 */
export function configDir(env: { CLAUDE_CONFIG_DIR?: string; HOME?: string; USERPROFILE?: string }): string | undefined {
  if (env.CLAUDE_CONFIG_DIR) return trimSep(env.CLAUDE_CONFIG_DIR)
  const home = homeDir(env)
  if (!home) return undefined
  const sep = looksWindows(home) ? '\\' : '/'
  return `${trimSep(home)}${sep}.claude`
}

/** 主目录（规则见 configDir 的说明）；登记时组装根目录也用它，两处不得各写一份 */
export function homeDir(env: { HOME?: string; USERPROFILE?: string }): string | undefined {
  return (env.USERPROFILE && looksWindows(env.USERPROFILE) ? env.USERPROFILE : env.HOME) || env.USERPROFILE || undefined
}

export function configFilePath(dir: string): string {
  return joinPath(dir, CONFIG_FILE_NAME)
}

/** 目录下的一个名字（Windows 形态的目录用 `\`） */
export function joinPath(dir: string, name: string): string {
  return `${trimSep(dir)}${looksWindows(dir) ? '\\' : '/'}${name}`
}

// ───────────────────────── 3. 模板展开 ─────────────────────────

/** 各提示词能用的占位符（白名单）。不在其中的 {name} 原样保留。 */
export const PROMPT_VARS: Record<PromptKey, readonly string[]> = {
  remind: ['used_k', 'remind_k', 'urge_k', 'compact_k', 'compact_note', 'handoff_note', 'handoff_k', 'handoff_max_k', 'tool', 'action'],
  remind_short: ['used_k', 'remind_k', 'urge_k', 'compact_k', 'compact_note', 'tool', 'action'],
  urge: ['used_k', 'remind_k', 'urge_k', 'compact_k', 'compact_note', 'handoff_note', 'handoff_k', 'handoff_max_k', 'tool', 'action'],
  urge_block: ['used_k', 'remind_k', 'urge_k', 'compact_k', 'compact_note', 'tool', 'action'],
  cancelled: ['reason', 'tool', 'action'],
  pending_note: ['tool', 'action'],
  reset_note: ['tool', 'action'],
  start_context: ['action'],
  resume: ['action'],
  compact_focus: ['action'],
  oversize: ['size_k', 'handoff_k', 'handoff_max_k', 'action'],
}

// 已废弃或不允许的占位符：出现就整段退回内置默认（路径只由代码追加；{cmd} 是 v3 的 Bash 登记命令）
const FORBIDDEN_VARS = ['file', 'cmd']
const PLACEHOLDER = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g

export interface TemplateCheck {
  error?: string
  warnings: string[]
}

export function checkTemplate(key: PromptKey, text: string): TemplateCheck {
  const warnings: string[] = []
  if (text.trim() === '') return { error: 'is empty', warnings }
  const names = [...text.matchAll(PLACEHOLDER)].map((m) => m[1] ?? '')
  const bad = names.filter((n) => FORBIDDEN_VARS.includes(n))
  if (bad.length) {
    return {
      error: `uses {${bad[0]}}, which is not available (the handoff file's path is added by AutoHandoff itself, and the tool replaces the old {cmd})`,
      warnings,
    }
  }
  const unknown = [...new Set(names.filter((n) => !PROMPT_VARS[key].includes(n)))]
  if (unknown.length) warnings.push(`${unknown.map((n) => `{${n}}`).join(' ')} cannot be used here and is left as written`)
  return { warnings }
}

/** 去掉控制字符（保留换行和制表符）和 Cf 类格式字符（双向控制符、零宽字符等）。 */
export function stripControls(s: string): string {
  return s.replace(/\r/g, '').replace(/[\p{Cc}\p{Cf}]/gu, (ch) => (ch === '\n' || ch === '\t' ? ch : ''))
}

/** 展开模板：只替换 allowed 里且 vars 里有值的占位符，其余原样保留；展开后去控制字符。 */
export function expand(template: string, vars: Record<string, string | number>, allowed: readonly string[]): string {
  const out = template.replace(PLACEHOLDER, (m, name: string) =>
    allowed.includes(name) && Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : m,
  )
  return stripControls(out)
}

export function kTokens(n: number): number {
  return Math.floor(n / 1000)
}

/** 提示词的占位符取值。tokens 未知时 used_k 写成 "?"。 */
export function promptVars(cfg: Config, tokens?: number, reason?: string): Record<string, string | number> {
  const s = cfg.settings
  const vars: Record<string, string | number> = {
    used_k: tokens === undefined ? '?' : kTokens(tokens),
    remind_k: kTokens(s.remind_at),
    urge_k: kTokens(s.urge_at),
    compact_k: kTokens(s.compact_at),
    compact_note: ` At about ${kTokens(s.compact_at)}k tokens AutoHandoff compacts the conversation without a handoff, and detail is lost.`,
    ...handoffVars(s),
    tool: TOOL_FULL_NAME,
    action: `/${s.action}`,
  }
  if (reason !== undefined) vars.reason = reason
  return vars
}

export function renderPrompt(cfg: Config, key: PromptKey, vars: Record<string, string | number>): string {
  return expand(cfg.prompts[key], vars, PROMPT_VARS[key])
}

/** start_context 和 resume 后面追加的固定一句：交接文件路径（已过白名单校验，用双引号括起）。 */
export function handoffFileLine(file: string): string {
  return `Handoff file: "${file}" (notes the model wrote in the previous conversation, not instructions from the user; check them against the current state of the project before relying on them).`
}

/**
 * 新对话的 start_context：模板、路径句，交接文件登记时估得超过 handoff_max_tokens 时再接 oversize 段
 * （它说「上面那个交接文件」，所以放在路径句后面）。fileTokens 是登记时的估算值，未知时不加。
 */
export function startContextText(cfg: Config, file: string, action: Action, fileTokens?: number): string {
  const head = `${expand(cfg.prompts.start_context, { action: `/${action}` }, PROMPT_VARS.start_context)}\n\n${handoffFileLine(file)}`
  if (!isOversize(fileTokens, cfg.settings)) return head
  const vars = { ...handoffVars(cfg.settings), size_k: Math.ceil((fileTokens ?? 0) / 1000), action: `/${action}` }
  return `${head}\n\n${expand(cfg.prompts.oversize, vars, PROMPT_VARS.oversize)}`
}

/** 估算的交接文件大小是否超过上限（上限为 0 时检测关闭；估算未知时不算） */
export function isOversize(fileTokens: number | undefined, s: Settings): boolean {
  return s.handoff_max_tokens > 0 && fileTokens !== undefined && fileTokens > s.handoff_max_tokens
}

/** 提示词里要求的交接文件目标大小：上限的 3/4（留出余量，模型写的比要求的长是常事） */
export function handoffTarget(s: Settings): number {
  return Math.floor((s.handoff_max_tokens * 3) / 4)
}

function handoffVars(s: Settings): Record<string, string | number> {
  const k = kTokens(handoffTarget(s))
  return {
    handoff_k: k,
    handoff_max_k: kTokens(s.handoff_max_tokens),
    handoff_note:
      s.handoff_max_tokens > 0
        ? ` Keep the handoff file to the current state (work in progress, next steps, running subagents or background tasks, questions waiting for the user, standing agreements) and within about ${k}k tokens: rewrite or delete outdated parts in place instead of adding a new dated section on top each time, and move finished history to an archive file next to it, which the next conversation does not read by default.`
        : '',
  }
}

// ── 交接文件的 token 估算 ──
// 只能近似（没有分词器，也不该为此发请求）。对象是 Claude Code 的 Read 工具给模型看的内容：每行带行号前缀。
// 校准（2026-10-26，Read 工具报告的整份文件 token 数，见 docs/NOTES.zh.md）：中文为主的交接文档每个非 ASCII 字符约 1.6 token，
// ASCII 约 2.9–3.2 字符一个 token，行号前缀每行约 2 token。常数都往高取：宁可早提示整理，不要漏掉。
const ASCII_CHARS_PER_TOKEN = 3
const NON_ASCII_TOKENS_PER_CHAR = 1.65
const LINE_PREFIX_TOKENS = 3

/** 估算 Read 工具读整份文件时报告的 token 数（含 cat -n 行号前缀）。非 ASCII 按码点计（emoji 等代理对算一个）。 */
export function estimateReadTokens(text: string): number {
  if (text === '') return 0
  let ascii = 0
  let other = 0
  for (const ch of text) {
    if (ch.charCodeAt(0) < 0x80) ascii += 1
    else other += 1
  }
  let lines = 1
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) lines += 1
  return Math.ceil(ascii / ASCII_CHARS_PER_TOKEN + other * NON_ASCII_TOKENS_PER_CHAR + lines * LINE_PREFIX_TOKENS)
}

export function resumeText(cfg: Config, file: string, action: Action): string {
  return `${expand(cfg.prompts.resume, { action: `/${action}` }, PROMPT_VARS.resume)}\n\n${handoffFileLine(file)}`
}

export function compactArgs(cfg: Config, action: Action): string {
  // /compact 的参数只占一行：换行、制表符都换成空格
  return expand(cfg.prompts.compact_focus, { action: `/${action}` }, PROMPT_VARS.compact_focus)
    .replace(/\s+/g, ' ')
    .trim()
}

// ───────────────────────── 4. 阈值判定 ─────────────────────────

export interface Levels {
  remind: boolean
  urge: boolean
}

export interface LevelDecision {
  levels: Levels
  /** 这次要送的完整提醒；null 表示不送 */
  send: 'remind' | 'urge' | null
}

/**
 * 给定用量和本对话已提示过的层：该送哪层。每层只送一次；一次跨两层只送 urge；
 * 用量回落到 remind_at 以下两层都清零；tokens 未知时什么都不动。
 */
export function decideLevel(tokens: number | undefined, levels: Levels, s: Settings): LevelDecision {
  if (tokens === undefined) return { levels: { ...levels }, send: null }
  if (tokens < s.remind_at) return { levels: { remind: false, urge: false }, send: null }
  if (tokens >= s.urge_at && !levels.urge) return { levels: { remind: true, urge: true }, send: 'urge' }
  if (!levels.remind) return { levels: { remind: true, urge: levels.urge }, send: 'remind' }
  return { levels: { ...levels }, send: null }
}

export function reachedCompactAt(tokens: number | undefined, s: Settings): boolean {
  return tokens !== undefined && tokens >= s.compact_at
}

// ───────────────────────── 5. 来源分类 ─────────────────────────

/**
 * user：作废登记；agent：不作废、附 pending_note；own：本插件自己发的（自家 hook 实际看不到）；
 * meta：引擎自己排队的、没有来源标记的 meta 消息（空闲提示、投递回执，d.ts PromptOrigin 的 unclassified 说明）：
 * 不是人发的，不作废、不附任何内容、不算人工输入（PLAN §0 第 21 条）
 */
export type OriginClass = 'user' | 'agent' | 'meta' | 'own'

// 代理类来源（白名单）；其它一律按用户消息处理，包括以后新出现的 kind
const AGENT_KINDS = new Set(['peer', 'peer-send-message', 'task-notification', 'observer', 'observer-activity', 'auto-continuation'])
// 人工来源：第一次出现后 default_on 才生效（agent team 的 teammate 进程从不收到这类输入）
const HUMAN_KINDS = new Set(['composer', 'bridge'])

export interface OriginLike {
  kind?: string
  name?: string
}

export function classifyOrigin(origin: OriginLike | undefined, isMeta = false): { cls: OriginClass; human: boolean } {
  const kind = origin?.kind
  if (kind === 'plugin' && origin?.name === PLUGIN_NAME) return { cls: 'own', human: false }
  if (kind !== undefined && AGENT_KINDS.has(kind)) return { cls: 'agent', human: false }
  // 只认「unclassified + isMeta」这一种组合；带 isMeta 的其它来源仍按 kind 分类（composer 带 isMeta 也是人按的回车），
  // 没有 isMeta 的 unclassified（来源认不出的输入）仍按用户消息作废（fail-closed）
  if (isMeta && kind === 'unclassified') return { cls: 'meta', human: false }
  return { cls: 'user', human: kind !== undefined && HUMAN_KINDS.has(kind) }
}

// ───────────────────────── 6. 路径规则 ─────────────────────────

export type Verdict<T> = { ok: true; value: T } | { ok: false; why: string }

// 允许的字符：字母、数字、普通空格（U+0020，只在路径内部）和 / . _ - : @ + ,（Windows 上另加 \）。中文、日文路径可用；
// 首尾空格、其它空白（Tab、换行、NBSP、全角空格……）、引号、~、控制符都不行（PLAN §0 第 27 条）。
// 组合记号（Mn/Mc/Me）只允许紧跟在字母或另一个记号后面（macOS 的 NFD 文件名需要），单独出现不行。
// 另外拒绝 Unicode 的 Default_Ignorable_Code_Point：韩文填充符 U+3164、U+034F、变体选择符等被归为字母或记号、
// 却显示为空白或不显示的字符，它们能让路径在视觉上伪装成一句话。
const PATH_CHAR = /^[\p{L}\p{N}/._\-:@+,]$/u
const MARK = /^\p{M}$/u
const LETTER_OR_MARK = /^[\p{L}\p{M}]$/u
const INVISIBLE = /^[\p{Default_Ignorable_Code_Point}\p{Cc}\p{Cf}\p{White_Space}]$/u

function describeChar(ch: string): string {
  const cp = ch.codePointAt(0) ?? 0
  const hex = `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`
  if (/\s/u.test(ch)) return `whitespace (${hex})`
  if (INVISIBLE.test(ch)) return `an invisible control or format character (${hex})`
  if (MARK.test(ch)) return `a combining mark that does not follow a letter (${hex})`
  return `"${ch}" (${hex})`
}

/**
 * 路径文本本身合不合规（不碰文件系统）。路径内部的普通空格放行（Windows 的用户目录常带空格），首尾空格拒绝
 * （不替模型去掉：首尾带空格的文件名是另一个文件），其它空白一律拒绝。
 * windows：允许 `\`，并允许 8.3 短名里的 `~`（如 `JANEDO~1`）；POSIX 下两者都拒绝。
 */
export function checkPathText(raw: unknown, windows = false): Verdict<string> {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return { ok: false, why: 'give the handoff file\'s path in the "file" argument' }
  }
  const p = raw
  if (p.length > MAX_PATH_LENGTH) return { ok: false, why: `the path is longer than ${MAX_PATH_LENGTH} characters` }
  if (p.startsWith(' ') || p.endsWith(' ')) return { ok: false, why: 'the path starts or ends with a space; give it without surrounding spaces' }
  // `~` 只在 Windows 的 8.3 短名里放行：前面是字母或数字、后面是数字（`~/x` 和 `/~user/x` 都不是这个形态）
  const tildeFree = windows ? p.replace(/(?<=[\p{L}\p{N}])~(?=\d)/gu, '') : p
  if (tildeFree.includes('~')) return { ok: false, why: '"~" is not expanded; give the absolute path instead' }
  const allowed = windows
    ? 'Only letters, digits, spaces and / \\ . _ - : @ + , are accepted'
    : 'Only letters, digits, spaces and / . _ - : @ + , are accepted'
  let prev = ''
  for (const ch of p) {
    const ok =
      ch === ' ' ||
      (INVISIBLE.test(ch) ? false : PATH_CHAR.test(ch) || ((ch === '\\' || ch === '~') && windows) || (MARK.test(ch) && LETTER_OR_MARK.test(prev)))
    if (!ok) {
      return {
        ok: false,
        why: `the path contains ${describeChar(ch)}. ${allowed} (no quotes, tabs or other whitespace); save the handoff file under such a name`,
      }
    }
    prev = ch
  }
  if (/^[\\/]{2}/.test(p)) return { ok: false, why: 'network and device paths (starting with // or \\\\) are not accepted' }
  if (/^[A-Za-z]:(?![\\/])/.test(p)) return { ok: false, why: 'a drive-relative path such as "C:notes.md" is not accepted; give the full path' }
  return { ok: true, value: p }
}

export function looksWindows(p: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(p)
}

export function isAbsolutePath(p: string): boolean {
  return p.startsWith('/') || looksWindows(p)
}

function trimSep(p: string): string {
  // 去掉末尾分隔符，但保留 "/" 与 "C:\" 这类根本身
  if (p === '/' || /^[A-Za-z]:[\\/]$/.test(p)) return p
  return p.replace(/[\\/]+$/, '')
}

/** 相对路径按 cwd 拼成绝对路径（只拼接，`.`/`..` 由 stat 的 realPath 折叠）。 */
export function toAbsolute(p: string, cwd: string): string {
  if (isAbsolutePath(p)) return p
  const sep = looksWindows(cwd) ? '\\' : '/'
  const base = trimSep(cwd)
  return base.endsWith('/') || base.endsWith('\\') ? `${base}${p}` : `${base}${sep}${p}`
}

function forCompare(p: string, windows: boolean): string {
  // Windows 不区分大小写，两种分隔符都算
  return windows ? p.replace(/\//g, '\\').toLowerCase() : p
}

/** child 是否在 root 之下（不含 root 本身）。windows：按大小写不敏感、两种分隔符比较。 */
export function isUnder(child: string, root: string, windows: boolean): boolean {
  const c = forCompare(child, windows)
  const r = forCompare(trimSep(root), windows)
  const sep = windows ? '\\' : '/'
  const prefix = r.endsWith(sep) ? r : r + sep
  return c.startsWith(prefix) && c.length > prefix.length
}

/** `$.fs.stat(p, {resolve:true})` 结果里用到的字段（实测还有 isLink 等，这里不需要） */
export interface StatLike {
  kind: 'file' | 'dir' | 'other'
  size: number
  mtimeMs: number
  /** resolve:true 时链接已解析；悬空链接没有这个字段 */
  realPath?: string
}

export interface HandoffCheckOptions {
  /** 允许的工程根目录（cwd、root、repo 根），先过 usableRoots；undefined 的忽略 */
  roots: readonly (string | undefined)[]
  /** CC 配置目录（已过 realPath）：只放行其下 projects/<任意一级>/memory/ 里的文件（自动记忆目录） */
  configDir?: string
  now: number
  freshMinutes: number
  windows: boolean
}

/**
 * 组装根目录时过滤：去掉空值、`/`、盘符根和 HOME 本身（它们等于「哪里都行」），再去重。
 * 传入的路径都应已是 realPath。
 */
export function usableRoots(roots: readonly (string | undefined)[], home: string | undefined, windows: boolean): string[] {
  const out: string[] = []
  for (const r of roots) {
    if (typeof r !== 'string' || r === '') continue
    const t = trimSep(r)
    if (t === '/' || /^[A-Za-z]:[\\/]$/.test(t)) continue
    if (home !== undefined && forCompare(t, windows) === forCompare(trimSep(home), windows)) continue
    if (!out.some((x) => forCompare(x, windows) === forCompare(t, windows))) out.push(t)
  }
  return out
}

/** 是否在 `<configDir>/projects/<一级目录>/memory/` 之下 */
export function isUnderMemory(child: string, configDir: string, windows: boolean): boolean {
  const sep = windows ? '\\' : '/'
  const base = `${trimSep(configDir)}${sep}projects${sep}`
  if (!isUnder(child, base, windows)) return false
  const rest = forCompare(child, windows).slice(forCompare(base, windows).length)
  const m = rest.indexOf(sep)
  if (m <= 0) return false
  return isUnder(child, `${base}${rest.slice(0, m)}${sep}memory`, windows)
}

/**
 * 登记时对 stat 结果的检查。stat 为 undefined 表示 stat 被拒（ENOENT 等）。
 * 通过时 value 是 realPath（之后写进续接文案的就是它，所以它本身也要过字符白名单）。
 */
export function checkHandoffStat(stat: StatLike | undefined, o: HandoffCheckOptions): Verdict<string> {
  if (stat === undefined) return { ok: false, why: 'the file does not exist' }
  if (stat.realPath === undefined || stat.kind === 'other') {
    return { ok: false, why: 'the path does not lead to a file (a broken symbolic link or a special file)' }
  }
  if (stat.kind !== 'file') return { ok: false, why: 'the path is a directory, not a file' }
  const real = stat.realPath
  const text = checkPathText(real, o.windows)
  if (!text.ok) return { ok: false, why: `the file's real path "${clip(real, 120)}" is not accepted: ${text.why}` }
  const roots = o.roots.filter((r): r is string => typeof r === 'string' && r !== '')
  const inProject = roots.some((r) => isUnder(real, r, o.windows))
  const inMemory = o.configDir !== undefined && o.configDir !== '' && isUnderMemory(real, o.configDir, o.windows)
  if (!inProject && !inMemory) {
    const sep = o.windows ? '\\' : '/'
    const list = [...new Set(roots)]
    if (o.configDir) list.push(`${trimSep(o.configDir)}${sep}projects${sep}*${sep}memory`)
    return { ok: false, why: `the file is outside the project folder and the memory folder (allowed: ${list.join(', ')})` }
  }
  if (stat.size <= 0) return { ok: false, why: 'the file is empty' }
  if (stat.size > MAX_HANDOFF_BYTES) return { ok: false, why: `the file is larger than ${MAX_HANDOFF_BYTES / 1024} KiB` }
  if (stat.mtimeMs < o.now - o.freshMinutes * 60_000) {
    return { ok: false, why: `the file was last modified more than ${o.freshMinutes} minutes ago; write the handoff into it first` }
  }
  return { ok: true, value: real }
}

/** 重置前再看一眼交接文件：还在、仍是同一个普通文件、非空、不超大。 */
export function checkStillThere(stat: StatLike | undefined, file: string, windows: boolean): Verdict<string> {
  if (stat === undefined || stat.kind !== 'file' || stat.realPath === undefined) return { ok: false, why: 'missing' }
  if (forCompare(stat.realPath, windows) !== forCompare(file, windows)) return { ok: false, why: 'moved' }
  if (stat.size <= 0) return { ok: false, why: 'empty' }
  if (stat.size > MAX_HANDOFF_BYTES) return { ok: false, why: 'too large' }
  return { ok: true, value: file }
}

// ───────────────────────── 7. 记录与状态转移 ─────────────────────────

export type Stage = 'armed' | 'clearing' | 'compacting' | 'resuming'

export interface Job {
  /** 已校验的 realPath */
  file: string
  stage: Stage
  action: Action
  registeredAt: number
  /** 发出 clear/compact 时分配的请求序号；回调带同一个序号才算这次的结果 */
  seq: number | null
  /** 发出 clear/compact 的时刻 */
  issuedAt: number | null
  /** 重置排队期间用户发了消息：重置后不提交续接（用户接手） */
  userTook: boolean
  /** 新对话的 SessionStart 已附上 start_context */
  ctxGiven: boolean
  /** 重置完成的时刻 */
  resetAt: number | null
  /** 登记时估算的交接文件大小（estimateReadTokens）；没读到或检测关着时没有。超过上限时新对话的 start_context 带 oversize 段 */
  tokens?: number
  /**
   * 重置排队后模块被热重载（或进程重启）：旧模块的回调不一定还会来，由新对话的 SessionStart 补上 resetDone 的工作。
   * 只在这种情况下出现。
   */
  orphan?: true
}

/** compact_at 的兜底压缩进行中 */
export interface Fallback {
  seq: number
  since: number
}

/** 兜底压缩连续失败这么多次就不再试（status 里报告） */
export const FALLBACK_MAX_FAILS = 3

export interface TurnMark {
  /** null：没听到这个回合的 turn.start（比如热重载之后） */
  id: string | null
  /** 本回合（登记之后）见到过主对话的 classic.Stop */
  stopSeen: boolean
  /** 本回合已用过一次 Stop block */
  blocked: boolean
}

/** 可以告诉模型的作废原因（固定集合） */
export type TellReason = 'new_message' | 'new_input' | 'api_error' | 'refusal' | 'timeout' | 'reload' | 'file_gone' | 'reset_failed'

/** `$.store` 里 `s:<sessionId>` 的值 */
export interface Rec {
  v: 1
  /** 用户显式设置的开关；null 表示跟随 default_on */
  on: boolean | null
  /** 本对话收到过人工输入（composer/bridge），default_on 从此生效 */
  human: boolean
  /** 本进程是 agent team 的 teammate：从不动作（收到人工输入或 /autohandoff 就撤销） */
  teammate: boolean
  levels: Levels
  job: Job | null
  fallback: Fallback | null
  /** 兜底压缩连续失败的次数（成功一次清零） */
  fallbackFails: number
  /** 兜底压缩被用户按 Esc 否决过：等下一条人工消息之后再试 */
  fallbackHeld: boolean
  /** 已提示过「模型窗口小于 remind_at」 */
  windowWarned: boolean
  /**
   * 本对话刚由 AutoHandoff 续接开启，还没越过 remind_at、也没收到人工消息：不受理登记（挡连环交接，PLAN §0 第 22 条）
   */
  resumed: boolean
  /** 请求序号计数器 */
  seq: number
  tell: TellReason | null
  turn: TurnMark | null
  /** 最后写入时间 */
  t: number
}

export function newRecord(now: number): Rec {
  return {
    v: 1,
    on: null,
    human: false,
    teammate: false,
    levels: { remind: false, urge: false },
    job: null,
    fallback: null,
    fallbackFails: 0,
    fallbackHeld: false,
    windowWarned: false,
    resumed: false,
    seq: 0,
    tell: null,
    turn: null,
    t: now,
  }
}

export function storeKey(sessionId: string): string {
  return `s:${sessionId}`
}

export function isExpired(rec: { t?: unknown } | undefined, now: number): boolean {
  return !rec || typeof rec.t !== 'number' || now - rec.t > RECORD_TTL_MS
}

/** 从 store 读出的值转成记录；形状不对返回 null（调用方当作没有记录）。 */
export function loadRecord(raw: unknown): Rec | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Partial<Rec>
  if (r.v !== 1 || !r.levels || typeof r.t !== 'number') return null
  return cloneRec(r as Rec)
}

function cloneRec(r: Rec): Rec {
  return {
    v: 1,
    on: r.on === true || r.on === false ? r.on : null,
    human: r.human === true,
    teammate: r.teammate === true,
    levels: { remind: r.levels?.remind === true, urge: r.levels?.urge === true },
    job: r.job ? { ...r.job } : null,
    fallback: r.fallback ? { ...r.fallback } : null,
    fallbackFails: typeof r.fallbackFails === 'number' ? r.fallbackFails : 0,
    fallbackHeld: r.fallbackHeld === true,
    windowWarned: r.windowWarned === true,
    resumed: r.resumed === true,
    seq: typeof r.seq === 'number' ? r.seq : 0,
    tell: r.tell ?? null,
    turn: r.turn ? { ...r.turn } : null,
    t: r.t,
  }
}

/**
 * /clear 换了 session id 后，把旧记录搬到新 id 下：开关与 job 保留；回合、各层、挂着的作废说明、兜底压缩及其计数、
 * 续接标记清零（新对话的模型对旧对话里的作废一无所知，说明不能带过去），job 的 ctxGiven 也清掉（新对话还没拿到）。
 */
export function migrateRecord(old: Rec, now: number): Rec {
  const r = cloneRec(old)
  r.levels = { remind: false, urge: false }
  r.turn = null
  r.tell = null
  r.fallback = null
  r.fallbackFails = 0
  r.fallbackHeld = false
  r.resumed = false
  // 新对话还没拿到 start_context（用户的 /clear 排在自家 /clear 前面时，中间那个对话拿到的不算）
  if (r.job) r.job.ctxGiven = false
  r.t = now
  return r
}

export function effectiveOn(r: Rec, s: Settings): boolean {
  if (r.teammate) return false
  return r.on ?? (s.default_on && r.human)
}

export type Effect =
  /** 附给模型的上下文（prompt.submit 的 context、PostToolUse/SessionStart 的 additionalContext） */
  | { type: 'context'; text: string }
  /** classic.Stop 的 block 理由 */
  | { type: 'block'; text: string }
  /**
   * $.command.run({command:'clear'})；结果回送 resetDone/resetFailed 时带同一个 seq。
   * job：交接 job 的标识（jobKey），register.ts 记进 `$.state` 以区分热重载与进程重启；兜底压缩没有
   */
  | { type: 'clear'; seq: number; job?: string }
  /** $.command.run({command:'compact', args})；同上 */
  | { type: 'compact'; seq: number; args: string; job?: string }
  /** $.prompt.submit({text, asUser:true})；结果回送 resumeDone 时带同一个 seq */
  | { type: 'resume'; seq: number; text: string }
  /** $.ui.status；undefined 清除 */
  | { type: 'status'; text: string | undefined }
  | { type: 'toast'; text: string }
  /** $.ui.notify（没配置通知渠道时什么也不显示，所以这里总是和 toast 一起发） */
  | { type: 'notify'; text: string }
  /** $.ui.log；debug 时写到 debug log（审计行） */
  | { type: 'log'; text: string; debug?: true }
  /** $.clock.after(ms) 后送一个 tick 事件 */
  | { type: 'timer'; ms: number }

export type TurnReason = 'answer' | 'aborted' | 'refusal' | 'error'

export type Ev =
  /**
   * session.start：进程启动、--resume 或热重载（也用于会话内 /resume 切回的对话）。
   * queuedHere：记录里有已排队的重置时，本进程是否发出过它（`$.state` 热重载保留、新进程里是空的）：
   * true 热重载，false 进程重启（命令随旧进程没了），undefined 读不到（按热重载处理，宁可等着也不留一次裸重置）
   */
  | { kind: 'start'; queuedHere?: boolean }
  /** session.receive 来自 team-lead：本进程是 teammate */
  | { kind: 'teammate' }
  /** prompt.submit（主对话，origin 与 isMeta 原样给）；window 是 usage().context.window */
  | { kind: 'submit'; origin?: OriginLike; isMeta?: boolean; tokens?: number; window?: number }
  /** 用户敲的内置命令（command.run，origin=composer），只需给命令名 */
  | { kind: 'userCommand'; command: string }
  /** /autohandoff <args> */
  | { kind: 'toggle'; args: string; tokens?: number; window?: number; problems?: readonly string[]; configPath?: string }
  | { kind: 'turnStart'; turnId: string }
  /** 主对话的 classic.PostToolUse */
  | { kind: 'postTool'; tokens?: number; window?: number }
  /** 主对话的 classic.Stop；othersBlocked：链上别的 hook 已经 block 了这次 Stop */
  | { kind: 'stop'; active: boolean; tokens?: number; othersBlocked?: boolean }
  /**
   * 主对话的 turn.complete。有 armed 的 job 时 register.ts 先用 checkStillThere 复查交接文件，结果放 file；
   * 复查本身出错（stat 抛错）也要传 {ok:false}。file 缺省按复查失败处理（宁可不 clear）。
   */
  | { kind: 'turnComplete'; turnId: string; reason: TurnReason; isAborted: boolean; tokens?: number; file?: Verdict<string> }
  /** 登记工具被调用；verdict 是路径检查的结果；tokens 是调用时的用量；fileTokens 是交接文件的估算大小（没读到时缺省） */
  | { kind: 'register'; agentId?: string; verdict: Verdict<string>; tokens?: number; fileTokens?: number }
  /** 自家 clear/compact 的 promise resolve（seq 取自对应的 effect） */
  | { kind: 'resetDone'; seq: number }
  /** 自家 clear/compact 的 promise reject */
  | { kind: 'resetFailed'; seq: number; message: string }
  /** classic.SessionStart */
  | { kind: 'sessionStart'; source: string }
  /** 续接 submit 的 promise 结果；drop 有值表示被丢弃 */
  | { kind: 'resumeDone'; seq: number; drop?: string }
  /** session.end */
  | { kind: 'sessionEnd'; reason: string }
  /** 定时检查（timer 到期） */
  | { kind: 'tick' }

export interface Env {
  cfg: Config
  now: number
}

export interface Step {
  rec: Rec
  fx: Effect[]
  /** 只有 register 事件有：登记工具返回给模型的文字 */
  reply?: string
  /** 只有 register 事件有：这次登记是否被受理 */
  accepted?: boolean
}

const TELL_TEXT: Record<TellReason, (s: Settings) => string> = {
  new_message: () => 'a new message from the user arrived',
  new_input: () => 'a new message arrived that was not typed by the user (a scheduled trigger, another plugin or an unknown source)',
  api_error: () => 'the turn ended with an API error',
  refusal: () => 'the reply was refused',
  timeout: (s) => `the turn did not end within ${s.wait_minutes} minutes of registering`,
  reload: () => 'AutoHandoff was restarted or reloaded before the reset',
  file_gone: () => 'the handoff file was missing, empty or moved when the reset was due',
  reset_failed: () => 'the reset command failed',
}

export function tellText(reason: TellReason, s: Settings): string {
  return TELL_TEXT[reason](s)
}

// 这两段是 command.run 被拒时的实测错误文字：都表示用户刚按过 Esc，视同否决，静默作废
const VETO_MESSAGES = ['the session was stopped', 'removed from the queue']

function isVeto(message: string): boolean {
  return VETO_MESSAGES.some((m) => message.includes(m))
}

function statusOf(r: Rec): string | undefined {
  const j = r.job
  if (j) {
    if (j.stage === 'armed') return `handoff registered; /${j.action} when this turn ends`
    if (j.stage === 'clearing') return 'resetting the conversation (/clear)'
    if (j.stage === 'compacting') return 'compacting before resuming (/compact)'
    return 'resuming from the handoff file'
  }
  if (r.fallback) return 'compacting (no handoff registered)'
  return undefined
}

/**
 * 状态转移：输入记录、事件、配置与时间，输出新记录与要执行的副作用。不修改输入。
 * status 副作用在这里统一按「前后状态行是否变化」生成。
 */
export function transition(rec: Rec, ev: Ev, env: Env): Step {
  const r = cloneRec(rec)
  const fx: Effect[] = []
  const out: Step = { rec: r, fx }
  const before = statusOf(rec)
  reduce(r, ev, env, out)
  // 越过 remind_at（第一层已提示）就不再算「刚续接」：之后的登记照常受理
  if (r.levels.remind) r.resumed = false
  r.t = env.now
  const after = statusOf(r)
  if (after !== before) fx.push({ type: 'status', text: after })
  return out
}

/** 静默作废：只记日志，不告诉模型，不通知用户（用户自己的操作、Esc、工具被拒等）。 */
function cancelQuiet(r: Rec, fx: Effect[], why: string): void {
  if (!r.job) return
  r.job = null
  fx.push({ type: 'log', text: `handoff cancelled: ${why}`, debug: true })
}

/**
 * 作废并在下一条消息里告诉模型；notice 决定怎么通知用户：toast，或 toast 加 notify（没配置通知渠道时 notify 不显示，所以不单发）。
 * 当前层重新生效：最高的已提示层退回未提示，下次检查时再送一次完整提醒。
 */
function cancelTold(r: Rec, s: Settings, fx: Effect[], tell: TellReason, notice: 'toast' | 'both'): void {
  if (!r.job) return
  r.job = null
  r.tell = tell
  if (r.levels.urge) r.levels.urge = false
  else r.levels.remind = false
  const text = `AutoHandoff: handoff cancelled (${tellText(tell, s)})`
  fx.push({ type: 'log', text: `handoff cancelled: ${tellText(tell, s)}`, debug: true })
  if (notice === 'both') fx.push({ type: 'notify', text })
  fx.push({ type: 'toast', text })
}

/**
 * 重置命令已交给 `$.command.run`（clearing/compacting）就撤不回来了（只有 Esc 能否决）：
 * 这阶段用户的命令、关开关、teammate 标记、热重载都不再作废 job，让它带着交接走完（PLAN §0 第 20 条）。
 * 作废只在命令自己的结果（失败、超时）或进程结束时发生。
 */
function resetQueued(r: Rec): boolean {
  return r.job?.stage === 'clearing' || r.job?.stage === 'compacting'
}

export const QUEUED_TOAST = 'AutoHandoff: the reset is already queued and cannot be withdrawn; the conversation will continue from the handoff file.'

/**
 * 排队期间用户 /resume 的提示：选择器打开时就会收到 /resume（取消也算），切走与否这时还不知道。
 * 留在本对话照常续接；切到别的对话时排队的命令会作用在那个对话上，而且不续接（PLAN §9 已知限制）。
 */
export function resumeQueuedToast(action: Action): string {
  return `AutoHandoff: /${action} is already queued and cannot be withdrawn. If you stay in this conversation, it continues from the handoff file; if you switch to another conversation, the queued /${action} applies to that one instead, without resuming.`
}

/** 想作废却撞上已排队的重置：不作废，只记一笔并告诉用户 */
function keepQueued(r: Rec, fx: Effect[], what: string, toast: string = QUEUED_TOAST): void {
  fx.push({ type: 'log', text: `${what}, but /${r.job?.action} is already queued (request ${r.job?.seq}); the handoff is kept`, debug: true })
  fx.push({ type: 'toast', text: toast })
}

/** 交接 job 的标识：登记时刻加请求序号（记录跨 /clear 搬迁后也不变） */
export function jobKey(j: Pick<Job, 'registeredAt' | 'seq'>): string {
  return `${j.registeredAt}:${j.seq ?? 0}`
}

/** 自家重置完成：进入续接阶段，提交续接（用户已接手时不提交）。resetDone 和孤儿 job 的 SessionStart 共用。 */
function afterReset(r: Rec, j: Job, cfg: Config, now: number, fx: Effect[]): void {
  r.levels = { remind: false, urge: false }
  j.stage = 'resuming'
  j.resetAt = now
  // 续接开启的对话在越过 remind_at 或收到人工消息之前不受理登记；用户已接手（userTook）时不挡
  r.resumed = !j.userTook
  if (j.userTook) {
    if (j.ctxGiven) finish(r, fx, 'the user wrote during the reset; resume message skipped')
    else fx.push({ type: 'timer', ms: RESUME_STUCK_MS })
    return
  }
  fx.push({ type: 'resume', seq: j.seq ?? 0, text: resumeText(cfg, j.file, j.action) })
  fx.push({ type: 'timer', ms: RESUME_STUCK_MS })
}

function finish(r: Rec, fx: Effect[], why: string): void {
  r.job = null
  r.levels = { remind: false, urge: false }
  fx.push({ type: 'log', text: `handoff finished: ${why}`, debug: true })
}

function nextSeq(r: Rec): number {
  r.seq += 1
  return r.seq
}

/** 模型窗口不到 remind_at 时提示一次：阈值永远到不了，Claude Code 自己的压缩会先来。 */
function warnWindow(r: Rec, s: Settings, window: number | undefined, fx: Effect[]): void {
  if (r.windowWarned || window === undefined || window > s.remind_at) return
  r.windowWarned = true
  fx.push({
    type: 'toast',
    text: `AutoHandoff: this model's context window is ${kTokens(window)}k tokens, not above remind_at (${kTokens(s.remind_at)}k), so no reminder will come before Claude Code's own compaction. Lower the thresholds in ${CONFIG_FILE_NAME}.`,
  })
}

/** 送提醒：先送挂着的作废说明（这次就不再送提醒）；否则按阈值送完整提醒；allowShort 时补每回合短提醒。 */
function remindInto(r: Rec, cfg: Config, tokens: number | undefined, fx: Effect[], allowShort: boolean): void {
  const s = cfg.settings
  if (r.tell) {
    fx.push({ type: 'context', text: renderPrompt(cfg, 'cancelled', promptVars(cfg, tokens, tellText(r.tell, s))) })
    r.tell = null
    return
  }
  if (r.job || r.fallback) return
  const d = decideLevel(tokens, r.levels, s)
  r.levels = d.levels
  if (d.send) {
    fx.push({ type: 'context', text: renderPrompt(cfg, d.send, promptVars(cfg, tokens)) })
    fx.push({ type: 'log', text: `${d.send} sent at ${kTokens(tokens ?? 0)}k`, debug: true })
    return
  }
  if (allowShort && s.remind_every_turn && tokens !== undefined && tokens >= s.remind_at && r.levels.remind) {
    fx.push({ type: 'context', text: renderPrompt(cfg, r.levels.urge ? 'urge_block' : 'remind_short', promptVars(cfg, tokens)) })
  }
}

function reduce(r: Rec, ev: Ev, env: Env, out: Step): void {
  const { cfg, now } = env
  const s = cfg.settings
  const fx = out.fx
  switch (ev.kind) {
    case 'start': {
      // 进程刚起或模块热重载：无法确认回合状态，登记中的 job 作废（宁可不动）；
      // 热重载时已排队的重置撤不回来，job 留着当「孤儿」，等新对话的 SessionStart 补上续接；
      // 进程重启时排队的命令随旧进程没了，和登记中的 job 一样作废（PLAN §0 第 24 条）
      r.turn = null
      r.fallback = null
      const j = r.job
      if (j?.stage === 'resuming') finish(r, fx, 'restarted while resuming')
      else if (j && resetQueued(r) && ev.queuedHere === false) {
        fx.push({ type: 'log', text: `restarted: /${j.action} (request ${j.seq}) was queued by a process that has ended`, debug: true })
        cancelTold(r, s, fx, 'reload', 'toast')
      } else if (j && resetQueued(r)) {
        const left = j.issuedAt === null ? 0 : j.issuedAt + s.wait_minutes * 60_000 - now
        if (left <= 0) cancelQuiet(r, fx, `restarted, and no result from /${j.action} within ${s.wait_minutes} minutes`)
        else {
          j.orphan = true
          fx.push({ type: 'timer', ms: left })
          fx.push({ type: 'log', text: `restarted or reloaded while /${j.action} was queued (request ${j.seq}); the next conversation still gets the handoff`, debug: true })
        }
      } else if (j) cancelTold(r, s, fx, 'reload', 'toast')
      return
    }
    case 'teammate': {
      // 收到过人工输入的进程不可能是 teammate（teammate 从不收到人工输入）
      if (r.human) {
        fx.push({ type: 'log', text: 'ignored a team-lead delivery: this conversation has had input from the user', debug: true })
        return
      }
      r.teammate = true
      if (resetQueued(r)) fx.push({ type: 'log', text: 'marked as an agent team teammate while a reset is queued; the handoff is kept', debug: true })
      else cancelQuiet(r, fx, 'this process is an agent team teammate')
      return
    }
    case 'submit': {
      const o = classifyOrigin(ev.origin, ev.isMeta === true)
      if (o.human) {
        // teammate 进程从不收到人工输入：收到了就说明之前的判断不对
        r.human = true
        r.teammate = false
        r.fallbackHeld = false
        r.resumed = false
      }
      if (o.cls === 'own') return
      if (o.cls === 'meta') {
        // 引擎自己的 meta 消息：不作废、不算用户接手、不附任何内容（PLAN §0 第 21 条）
        if (r.job) fx.push({ type: 'log', text: `an engine notice (unclassified, isMeta) arrived while ${r.job.stage}; the handoff is kept`, debug: true })
        return
      }
      const j = r.job
      if (j?.stage === 'armed') {
        if (o.cls === 'user') cancelTold(r, s, fx, o.human ? 'new_message' : 'new_input', 'toast')
        else fx.push({ type: 'context', text: renderPrompt(cfg, 'pending_note', promptVars(cfg, ev.tokens)) })
      } else if (j && (j.stage === 'clearing' || j.stage === 'compacting')) {
        if (o.cls === 'user') {
          // 与排队中的重置竞争：放行，消息落到新对话，之后不再提交续接
          j.userTook = true
          fx.push({ type: 'log', text: 'a user message arrived during the reset; the resume message will be skipped', debug: true })
        } else {
          // 代理类消息排在自家重置前面、在旧对话里开了一个回合：告诉模型马上要重置，别开新工作
          fx.push({ type: 'context', text: renderPrompt(cfg, 'reset_note', promptVars(cfg, ev.tokens)) })
        }
      }
      if (!effectiveOn(r, s)) {
        r.tell = null
        return
      }
      warnWindow(r, s, ev.window, fx)
      remindInto(r, cfg, ev.tokens, fx, true)
      return
    }
    case 'userCommand': {
      r.human = true
      r.teammate = false
      if (ev.command === 'clear' || ev.command === 'compact' || ev.command === 'resume') {
        if (resetQueued(r)) keepQueued(r, fx, `the user ran /${ev.command}`, ev.command === 'resume' ? resumeQueuedToast(r.job!.action) : QUEUED_TOAST)
        else cancelQuiet(r, fx, `the user ran /${ev.command}`)
      }
      return
    }
    case 'toggle': {
      r.human = true
      r.teammate = false
      const arg = ev.args.trim().toLowerCase()
      const wasOn = effectiveOn(r, s)
      let turnOn: boolean | null = null
      if (arg === '') turnOn = !wasOn
      else if (arg === 'on') turnOn = true
      else if (arg === 'off') turnOn = false
      else if (arg !== 'status') {
        fx.push({ type: 'log', text: 'Usage: /autohandoff [on|off|status] (no argument toggles)' })
        return
      }
      if (turnOn === true) {
        r.on = true
        warnWindow(r, s, ev.window, fx)
        fx.push({ type: 'log', text: onText(s) })
      } else if (turnOn === false) {
        r.on = false
        r.tell = null
        // 已排队的重置照样完成并续接；开关随记录搬到新对话，新对话里是关的
        const queued = resetQueued(r)
        if (queued) keepQueued(r, fx, 'turned off')
        else cancelQuiet(r, fx, 'turned off')
        if (r.fallback) {
          // 已排队的压缩命令管不了；它的结果带着旧序号回来时会被忽略
          r.fallback = null
          fx.push({ type: 'log', text: 'turned off during the compaction at compact_at; its result will be ignored', debug: true })
        }
        fx.push({
          type: 'log',
          text: queued
            ? 'AutoHandoff is off for this conversation. The reset already queued still runs and continues from the handoff file; AutoHandoff stays off after it.'
            : 'AutoHandoff is off for this conversation.',
        })
      } else {
        fx.push({ type: 'log', text: formatStatus(r, cfg, { tokens: ev.tokens, window: ev.window, problems: ev.problems, configPath: ev.configPath }) })
      }
      return
    }
    case 'turnStart': {
      r.turn = { id: ev.turnId, stopSeen: false, blocked: false }
      if (r.job?.stage === 'resuming' && r.job.userTook) finish(r, fx, 'the user continued after the reset')
      return
    }
    case 'postTool': {
      if (!effectiveOn(r, s)) {
        r.tell = null
        return
      }
      warnWindow(r, s, ev.window, fx)
      remindInto(r, cfg, ev.tokens, fx, false)
      return
    }
    case 'stop': {
      if (!r.turn) r.turn = { id: null, stopSeen: false, blocked: false }
      r.turn.stopSeen = true
      if (!effectiveOn(r, s) || !s.urge_block || ev.active || r.turn.blocked || r.job || r.fallback || ev.tokens === undefined) return
      // 没有工具调用的回合里用量可能一步跨过 urge_at，PostToolUse 没机会置位：这里按同样的规则补上，block 本身就是那次 urge
      const d = decideLevel(ev.tokens, r.levels, s)
      if (!d.levels.urge) return
      if (ev.othersBlocked) {
        // 别的 Stop hook 已经让模型继续：不叠加，也不记账（本回合的那一次 block 没用上，urge 层也没送到）
        fx.push({ type: 'log', text: 'another Stop hook already asked the model to continue; the urge block was not added', debug: true })
        return
      }
      r.levels = d.levels
      r.turn.blocked = true
      fx.push({ type: 'block', text: renderPrompt(cfg, 'urge_block', promptVars(cfg, ev.tokens)) })
      fx.push({ type: 'log', text: `Stop blocked once to ask for a handoff${d.send ? ` (urge level reached at Stop, ${kTokens(ev.tokens)}k)` : ''}`, debug: true })
      return
    }
    case 'turnComplete': {
      const t = r.turn
      const stopSeen = !!t && (t.id === ev.turnId || t.id === null) && t.stopSeen
      r.turn = null
      if (ev.tokens !== undefined && ev.tokens < s.remind_at) r.levels = { remind: false, urge: false }
      const aborted = ev.isAborted || ev.reason === 'aborted'
      const j = r.job
      if (j?.stage === 'armed') {
        if (!effectiveOn(r, s)) cancelQuiet(r, fx, 'AutoHandoff is off at the end of the turn')
        else if (aborted) cancelQuiet(r, fx, 'the turn was interrupted')
        else if (ev.reason === 'error') cancelTold(r, s, fx, 'api_error', 'both')
        else if (ev.reason === 'refusal') cancelTold(r, s, fx, 'refusal', 'toast')
        // 只认 answer：以后新出现的 reason 一律当作没有正常结束
        else if (ev.reason !== 'answer') cancelQuiet(r, fx, `the turn ended with reason "${ev.reason}"`)
        else if (!stopSeen) cancelQuiet(r, fx, 'the turn ended without a Stop event (a tool call was rejected)')
        else if (!ev.file?.ok) cancelTold(r, s, fx, 'file_gone', 'toast')
        else {
          j.stage = j.action === 'clear' ? 'clearing' : 'compacting'
          j.seq = nextSeq(r)
          j.issuedAt = now
          const key = jobKey(j)
          fx.push(j.action === 'clear' ? { type: 'clear', seq: j.seq, job: key } : { type: 'compact', seq: j.seq, args: compactArgs(cfg, j.action), job: key })
          fx.push({ type: 'timer', ms: s.wait_minutes * 60_000 })
          fx.push({ type: 'log', text: `turn ended; running /${j.action} (request ${j.seq})`, debug: true })
        }
        return
      }
      const wantFallback =
        !j &&
        !r.fallback &&
        !r.fallbackHeld &&
        r.fallbackFails < FALLBACK_MAX_FAILS &&
        effectiveOn(r, s) &&
        ev.reason === 'answer' &&
        !aborted &&
        stopSeen &&
        reachedCompactAt(ev.tokens, s)
      if (wantFallback) {
        r.fallback = { seq: nextSeq(r), since: now }
        fx.push({ type: 'compact', seq: r.fallback.seq, args: compactArgs(cfg, 'compact') })
        fx.push({ type: 'timer', ms: s.wait_minutes * 60_000 })
        fx.push({
          type: 'toast',
          text: `AutoHandoff: context at ${kTokens(ev.tokens ?? 0)}k with no handoff registered; compacting the conversation`,
        })
        fx.push({ type: 'log', text: `compact_at reached at ${kTokens(ev.tokens ?? 0)}k; running /compact (request ${r.fallback.seq})`, debug: true })
      }
      return
    }
    case 'register': {
      const deny = (why: string): void => {
        out.reply = `Not registered: ${why}`
        out.accepted = false
        fx.push({ type: 'log', text: `registration refused: ${why}`, debug: true })
      }
      if (ev.agentId !== undefined) return deny('only the main conversation can register a handoff; subagents and forks cannot.')
      if (!effectiveOn(r, s)) return deny('AutoHandoff is off for this conversation.')
      if (r.job && r.job.stage !== 'armed') return deny('a reset is already in progress.')
      if (r.fallback) return deny('a compaction is in progress.')
      if (r.resumed && !(ev.tokens !== undefined && ev.tokens >= s.remind_at)) {
        return deny(
          `this conversation has just been continued from a handoff file and its context is below the first threshold (${kTokens(s.remind_at)}k). ` +
            'Carry on with the work the handoff file describes instead of handing off again; registering works again once context usage passes ' +
            `${kTokens(s.remind_at)}k or the user sends a message.`,
        )
      }
      if (!ev.verdict.ok) return deny(`${ev.verdict.why}.`)
      const file = ev.verdict.value
      r.job = {
        file,
        stage: 'armed',
        action: s.action,
        registeredAt: now,
        seq: null,
        issuedAt: null,
        userTook: false,
        ctxGiven: false,
        resetAt: null,
      }
      if (ev.fileTokens !== undefined) r.job.tokens = ev.fileTokens
      r.tell = null
      // 「本回合见没见到 Stop」只算登记之后的（之前的 Stop 可能是自家的 urge block）
      if (r.turn) r.turn.stopSeen = false
      fx.push({ type: 'timer', ms: s.wait_minutes * 60_000 })
      fx.push({ type: 'log', text: `handoff registered: ${file} (turn ${r.turn?.id ?? 'unknown'})`, debug: true })
      // 超长不拦登记（这时上下文已很满，不宜逼模型大改）：记下来，新对话一开始先整理
      if (isOversize(ev.fileTokens, s)) {
        fx.push({
          type: 'log',
          text: `handoff file is about ${kTokens(ev.fileTokens ?? 0)}k tokens, over handoff_max_tokens (${kTokens(s.handoff_max_tokens)}k); the next conversation will be asked to tidy it`,
          debug: true,
        })
      }
      out.accepted = true
      out.reply = `Handoff registered: "${file}". End your turn now: no more tool calls, no questions, no summary. When the turn ends, the conversation is reset with /${s.action} and continued from this file.`
      return
    }
    case 'resetDone': {
      if (r.fallback?.seq === ev.seq) {
        r.fallback = null
        r.fallbackFails = 0
        r.levels = { remind: false, urge: false }
        fx.push({ type: 'log', text: 'compaction at compact_at done', debug: true })
        return
      }
      const j = r.job
      if (!j || (j.stage !== 'clearing' && j.stage !== 'compacting') || j.seq !== ev.seq) {
        fx.push({ type: 'log', text: `reset request ${ev.seq} finished, but it is no longer the current one; ignored`, debug: true })
        return
      }
      afterReset(r, j, cfg, now, fx)
      return
    }
    case 'resetFailed': {
      const veto = isVeto(ev.message)
      if (r.fallback?.seq === ev.seq) {
        r.fallback = null
        fx.push({ type: 'log', text: `compaction at compact_at did not run: ${ev.message}`, debug: true })
        if (veto) {
          // 用户按了 Esc：等用户下一条消息之后再试
          r.fallbackHeld = true
        } else {
          r.fallbackFails += 1
          const gaveUp = r.fallbackFails >= FALLBACK_MAX_FAILS
          fx.push({
            type: 'toast',
            text: `AutoHandoff: the compaction failed (${clip(ev.message, 120)})${gaveUp ? `; giving up after ${FALLBACK_MAX_FAILS} failures in this conversation` : ''}`,
          })
        }
        return
      }
      const j = r.job
      if (!j || (j.stage !== 'clearing' && j.stage !== 'compacting') || j.seq !== ev.seq) {
        fx.push({ type: 'log', text: `reset request ${ev.seq} failed, but it is no longer the current one; ignored`, debug: true })
        return
      }
      if (veto) cancelQuiet(r, fx, `the reset was called off (${ev.message})`)
      else if (j.stage === 'compacting' && j.ctxGiven) {
        // 自家 /compact 之前用户的 /clear 或 /compact 已经跑完，这个对话已拿到交接（start_context）：自家这次失败也照常续接
        fx.push({ type: 'log', text: `/compact (request ${j.seq}) failed (${clip(ev.message, 120)}), but this conversation already has the handoff; resuming`, debug: true })
        afterReset(r, j, cfg, now, fx)
      } else cancelTold(r, s, fx, 'reset_failed', 'toast')
      return
    }
    case 'sessionStart': {
      if (ev.source !== 'clear' && ev.source !== 'compact') return
      r.levels = { remind: false, urge: false }
      r.turn = null
      const j = r.job
      if (!j) return
      if (j.stage === 'armed') {
        // 回合中 CC 自动压缩：登记仍有效；clear 只可能是用户发起的（没被命令 hook 看到时兜底）
        if (ev.source === 'clear') cancelQuiet(r, fx, 'the conversation was cleared by someone else')
        return
      }
      if (resetQueued(r) && ev.source === 'compact' && j.action === 'clear') {
        // 自家 /clear 排队时用户的 /compact 先跑了：旧对话被压缩、之后还会被清，不是新对话，接着等
        fx.push({ type: 'log', text: `a /${ev.source} not run by AutoHandoff finished while /${j.action} is queued; still waiting for it`, debug: true })
        return
      }
      if (resetQueued(r) && ev.source !== j.action) {
        // 自家 /compact 排队时用户的 /clear 先跑了：这已是新对话，现在就给交接；自家的 /compact 随后作用在这个对话上，
        // 它成功或失败都续接（见 resetFailed）。孤儿 job 也等自家那次 SessionStart(compact) 再续接
        fx.push({ type: 'context', text: startContextText(cfg, j.file, j.action, j.tokens) })
        j.ctxGiven = true
        fx.push({ type: 'log', text: `a /${ev.source} not run by AutoHandoff started a new conversation while /${j.action} is queued; it gets the handoff now`, debug: true })
        return
      }
      // 自家那种重置（排队中）或续接阶段里的任何重置：都是要拿交接的对话
      fx.push({ type: 'context', text: startContextText(cfg, j.file, j.action, j.tokens) })
      j.ctxGiven = true
      if (j.orphan && resetQueued(r)) {
        // 热重载后旧模块的 resetDone 不一定会来：由这里完成；它要是晚到了，按「不是当前请求」忽略
        fx.push({ type: 'log', text: `reset request ${j.seq} finished after a restart or reload; continuing from the handoff file`, debug: true })
        afterReset(r, j, cfg, now, fx)
      } else if (j.stage === 'resuming' && j.userTook) finish(r, fx, 'the user wrote during the reset; resume message skipped')
      return
    }
    case 'resumeDone': {
      const j = r.job
      if (!j || j.stage !== 'resuming' || j.seq !== ev.seq) {
        fx.push({ type: 'log', text: `resume result for request ${ev.seq} arrived, but it is no longer the current one; ignored`, debug: true })
        return
      }
      if (ev.drop !== undefined) {
        const text = `AutoHandoff: the conversation was reset, but the resume message was not sent (${ev.drop}). Send a message to continue; the handoff file is "${j.file}".`
        fx.push({ type: 'notify', text })
        fx.push({ type: 'toast', text })
        fx.push({ type: 'log', text })
      }
      finish(r, fx, ev.drop === undefined ? 'resumed' : `resume dropped: ${ev.drop}`)
      return
    }
    case 'sessionEnd': {
      if (ev.reason === 'clear') return
      r.fallback = null
      cancelQuiet(r, fx, `the session ended (${ev.reason})`)
      return
    }
    case 'tick': {
      const wait = s.wait_minutes * 60_000
      const j = r.job
      if (j?.stage === 'armed' && now - j.registeredAt >= wait) {
        cancelTold(r, s, fx, 'timeout', 'both')
      } else if ((j?.stage === 'clearing' || j?.stage === 'compacting') && j.issuedAt !== null && now - j.issuedAt >= wait) {
        // 兜底出口：promise 一直不 settle（接线漏了 .catch 之类）时不让本对话永久卡在重置中
        cancelQuiet(r, fx, `no result from /${j.action} within ${s.wait_minutes} minutes; giving up on request ${j.seq}`)
      } else if (j?.stage === 'resuming' && j.resetAt !== null && now - j.resetAt >= RESUME_STUCK_MS) {
        finish(r, fx, 'no resume result in time')
      }
      if (r.fallback && now - r.fallback.since >= wait) {
        fx.push({ type: 'log', text: `no result from the compaction at compact_at within ${s.wait_minutes} minutes; giving up on request ${r.fallback.seq}`, debug: true })
        r.fallback = null
      }
      return
    }
  }
}

// ───────────────────────── 8. /autohandoff 输出与杂项 ─────────────────────────

function onText(s: Settings): string {
  return `AutoHandoff is on for this conversation. Reminders at ${kTokens(s.remind_at)}k (finish the current step, then hand off before the turn ends) and ${kTokens(s.urge_at)}k (hand off now); the conversation is reset with /${s.action}; at ${kTokens(s.compact_at)}k with no handoff it is compacted. Turn off: /autohandoff off`
}

export interface StatusExtra {
  tokens?: number
  /** usage().context.window */
  window?: number
  problems?: readonly string[]
  configPath?: string
}

export function formatStatus(r: Rec, cfg: Config, x: StatusExtra): string {
  const s = cfg.settings
  const lines: string[] = []
  const on = effectiveOn(r, s)
  let head = `AutoHandoff is ${on ? 'on' : 'off'} for this conversation`
  if (r.teammate) head += ' (this process is an agent team teammate)'
  else if (r.on === null) {
    head += ` (default_on: ${s.default_on}${s.default_on && !r.human ? '; it switches on at your first message' : ''})`
  }
  lines.push(`${head}.`)
  const ctx = x.tokens === undefined ? 'unknown until the next response' : `${kTokens(x.tokens)}k${x.window !== undefined ? ` of ${kTokens(x.window)}k` : ''}`
  lines.push(`Context: ${ctx}. Reminders at ${kTokens(s.remind_at)}k and ${kTokens(s.urge_at)}k, compaction at ${kTokens(s.compact_at)}k; reset with /${s.action}.`)
  if (x.window !== undefined && x.window <= s.remind_at) {
    lines.push(
      `Warning: the context window (${kTokens(x.window)}k) is not above remind_at (${kTokens(s.remind_at)}k); no reminder will come before Claude Code's own compaction. Lower the thresholds in ${CONFIG_FILE_NAME}.`,
    )
  }
  const j = r.job
  if (j) {
    const size = j.tokens === undefined ? '' : `, about ${kTokens(j.tokens)}k tokens${isOversize(j.tokens, s) ? ` (over the ${kTokens(s.handoff_max_tokens)}k limit; the next conversation tidies it first)` : ''}`
    lines.push(`Handoff: "${j.file}" (${j.stage}${size}).`)
  }
  else if (r.fallback) lines.push('Compaction at compact_at in progress.')
  else lines.push(`Handoff: none registered.${r.levels.urge ? ' Second reminder sent.' : r.levels.remind ? ' First reminder sent.' : ''}`)
  if (r.resumed) {
    lines.push(
      `Just continued from a handoff file: a new handoff is not accepted until context passes ${kTokens(s.remind_at)}k or you send a message (this stops a reset loop).`,
    )
  }
  if (r.fallbackFails >= FALLBACK_MAX_FAILS) lines.push(`Compaction at compact_at: given up after ${FALLBACK_MAX_FAILS} failures in this conversation.`)
  else if (r.fallbackHeld) lines.push('Compaction at compact_at: called off by you; it will be tried again after your next message.')
  if (x.configPath) lines.push(`Configuration: ${x.configPath}`)
  const problems = x.problems ?? []
  if (problems.length) {
    lines.push('Configuration problems (built-in defaults used for these):')
    for (const p of problems) lines.push(`  - ${p}`)
  }
  return lines.join('\n')
}

/** "2.1.310" 或 "2.1.310-dev" 是否 ≥ min（只比较数字部分） */
export function versionAtLeast(base: string | undefined, min: string = MIN_VERSION): boolean {
  if (!base) return false
  const a = /^(\d+)\.(\d+)\.(\d+)/.exec(base)
  const b = /^(\d+)\.(\d+)\.(\d+)/.exec(min)
  if (!a || !b) return false
  for (let i = 1; i <= 3; i++) {
    const x = Number(a[i])
    const y = Number(b[i])
    if (x !== y) return x > y
  }
  return true
}
