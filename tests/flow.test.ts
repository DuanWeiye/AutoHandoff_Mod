// 接线层（register.ts）的流程测试：引擎的 `$` 由 claude-code/testing 提供，插件之下的世界（session、store、fs、命令执行、
// 续接提交）由这里的 hook 扮演。事件顺序按实测（docs/mod-feasibility.zh.md §3、§9）排：
// clear 的 promise 先 resolve、约 180 ms 后才到 SessionStart(clear)；子代理的事件带 agentId；工具被拒的回合没有 Stop。
import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { COMMAND_NAME, QUEUED_TOAST, TOOL_FULL_NAME, defaultConfigText, localStamp, storeKey } from '../hooks/core.js'
import { CC_DIR, CWD, HANDOVER, HOME, MIN, NOW, REPO, growingHandover } from './helpers.js'

const OLD = '6f1c2b8e-3a4d-4e5f-9a0b-1c2d3e4f5a6b'
const NEW = 'b7e9d1c3-5f2a-4b6c-8d0e-2f4a6b8c0d1e'
const CONFIG = `${CC_DIR}/autohandoff.md`
const AGENT = 'a904d9323568546da'
const T1 = 'f0b6c7a2-6d1e-4c2a-9a51-1f3e0c9b7d10'
const T2 = '3a9e1d44-0c5b-4f7e-8b2d-6c1a9f0e2b77'
const COMPOSER = { kind: 'composer' } as const

// 用户把阈值压低、开着 default_on 的配置（只写 settings 节，提示词用内置）
const LOW_CONFIG = `## settings
default_on: true
remind_at: 40000
urge_at: 90000
compact_at: 300000
action: clear
fresh_minutes: 10
wait_minutes: 60
urge_block: true
remind_every_turn: true
handoff_max_tokens: 20000
`

interface PendingCommand {
  command: string
  args: string
  resolve: () => void
  fail: () => void
}

interface WorldOptions {
  config?: string | null
  version?: string
  /** HOME 以外的环境变量 */
  env?: Record<string, string>
  /** 符号链接：链接路径 → 目标（stat 的 realPath 按它解析，像真实的 resolve:true） */
  links?: Record<string, string>
  /** 链上排在插件后面的 Stop hook（settings 里的 Stop hook 之类）block 时给的理由 */
  stopBlock?: string
  /** 为真时 $.fs.exists 一律 reject（d.ts：碰到网络位置时 reject；Windows 上用户目录重定向到网络共享就是这样） */
  existsRejects?: boolean
  /** 启动目录（cwd 与 root 都是它）；缺省 CWD */
  launch?: string
  /** null：不在 git 仓库里 */
  repo?: null
}

/** 规范化 POSIX 路径里的 `.` 与 `..`（stat 的 realPath 是折叠过的） */
function normalize(p: string): string {
  const out: string[] = []
  for (const part of p.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return `/${out.join('/')}`
}

/** 插件之下的世界：sid、用量、文件、store、命令队列、界面输出 */
function world(on: On, o: WorldOptions = {}) {
  const w = {
    sid: OLD,
    tokens: undefined as number | undefined,
    window: 1_000_000,
    files: new Map<string, { size: number; mtimeMs: number }>(),
    /** 有正文的文件（fs.read 读得到）；交接文件没放正文时 fs.read 失败，像被别的插件的 fs hook 拒绝 */
    texts: new Map<string, string>(),
    /** fs.read 读过的路径（配置文件除外） */
    reads: [] as string[],
    dirs: new Set<string>([HOME, CC_DIR, REPO, CWD, `${REPO}/docs`, `${REPO}/docs/work`]),
    config: o.config === undefined ? LOW_CONFIG : o.config,
    store: new Map<string, string>(),
    writes: [] as { path: string; text: string }[],
    tools: [] as string[],
    toasts: [] as string[],
    statuses: [] as (string | undefined)[],
    logs: [] as string[],
    debug: [] as string[],
    notifies: [] as string[],
    commands: [] as PendingCommand[],
    /** 插件的续接提交：挂起，测试调 release(drop?) 时才有结果（实测在续接回合 turn.start 时 resolve） */
    submits: [] as { text: string; asUser: boolean; release: (drop?: string) => void }[],
    /** 人工消息送到模型时附带的 context */
    delivered: [] as { text: string; context: readonly string[] }[],
    /** 为真时 store.set 抛错（store 满、磁盘错误） */
    storeFails: false,
    /** 宿主替插件保存的 `$.state`（热重载后还在；restart() 模拟进程重启时清空） */
    state: new Map<string, unknown>(),
    /**
     * 为真时 state.set 不写入、回 isSet:false（测试 hook 抛错只会被跳过，落到测试工具包自带的 `$.state` 实现上照样写进去，
     * 所以只能用这个形态模拟写失败）
     */
    stateFails: false,
  }
  const links = o.links ?? {}
  /** 规范化后再把链接前缀换成目标 */
  function real(path: string): string {
    const p = normalize(path)
    for (const [link, target] of Object.entries(links)) {
      if (p === link || p.startsWith(`${link}/`)) return target + p.slice(link.length)
    }
    return p
  }
  if (w.config !== null) w.files.set(CONFIG, { size: w.config.length, mtimeMs: NOW - 3 * 24 * 60 * MIN })
  // store 自己扮演（测试要直接看里面的记录）；值按 JSON 存取，和真实的 store 文件一样
  on('store.get', (_, e) => ({ value: w.store.has(e.key) ? JSON.parse(w.store.get(e.key)!) : undefined }))
  on('store.set', (_, e) => {
    if (w.storeFails) throw new Error('the plugin store is full')
    w.store.set(e.key, JSON.stringify(e.value))
    return { value: undefined }
  })
  on('store.delete', (_, e) => {
    w.store.delete(e.key)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...w.store.keys()] }))
  on('state.get', (_, e) => {
    const k = `${e.plugin}/${e.key}`
    return { value: { value: w.state.get(k), version: w.state.has(k) ? 1 : 0 } }
  })
  on('state.set', (_, e) => {
    if (w.stateFails) return { value: { isSet: false, version: 0 } }
    w.state.set(`${e.plugin}/${e.key}`, JSON.parse(JSON.stringify(e.value)))
    return { value: { isSet: true, version: 1 } }
  })
  const clock = mock.clock(on, { now: NOW })
  mock.env(on, { HOME, ...o.env })

  on('session.id', () => ({ value: w.sid }))
  on('session.cwd', () => ({ value: o.launch ?? CWD }))
  on('session.root', () => ({ value: o.launch ?? CWD }))
  on('session.repo', () => ({ value: o.repo === null ? null : { root: REPO, remote: null, internal: false, name: null } }))
  on('session.surfaces', () => ({ value: ['terminal'] }))
  on('session.version', () => ({ value: { version: o.version ?? '2.1.310', base: o.version ?? '2.1.310' } }))
  on('session.usage', () => ({
    value: { startedAt: NOW - 60 * MIN, context: w.tokens === undefined ? { window: w.window } : { tokens: w.tokens, window: w.window }, rateLimits: [] },
  }))
  on('fs.exists', (_, e) => {
    if (o.existsRejects) throw new Error(`$.fs.exists(${e.path}): a network location`)
    return { value: w.files.has(normalize(e.path)) || w.dirs.has(normalize(e.path)) }
  })
  on('fs.read', (_, e) => {
    if (normalize(e.path) === CONFIG && w.config !== null) return { value: w.config }
    w.reads.push(e.path)
    const text = w.texts.get(normalize(e.path))
    if (text !== undefined) return { value: text }
    throw new Error(`$.fs.read(${e.path}) failed: ENOENT`)
  })
  on('fs.write', (_, e) => {
    w.writes.push({ path: e.path, text: e.text })
    if (e.path === CONFIG) {
      w.config = e.text
      w.files.set(CONFIG, { size: e.text.length, mtimeMs: clock.now() })
    }
    return { value: undefined }
  })
  on('fs.stat', (_, e) => {
    const p = real(e.path)
    const isLink = p !== normalize(e.path)
    const f = w.files.get(p)
    if (f) return { value: { kind: 'file', size: f.size, mtimeMs: f.mtimeMs, isLink, realPath: p } }
    if (w.dirs.has(p)) return { value: { kind: 'dir', size: 4096, mtimeMs: NOW - 9 * 24 * 60 * MIN, isLink, realPath: p } }
    throw new Error(`$.fs.stat(${p}) failed: ENOENT`)
  })
  on('tool.register', (_, e) => {
    w.tools.push(e.name)
    return { value: { tool: `mcp__autohandoff__${e.name}` } }
  })
  on('ui.toast', (_, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.status', (_, e) => {
    w.statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.log', (_, e) => {
    if (e.to === 'debug') w.debug.push(e.text)
    else w.logs.push(e.text)
    return { value: undefined }
  })
  on('ui.notify', (_, e) => {
    w.notifies.push(e.text)
    return { value: { isSent: false, reason: 'no-channel' } }
  })
  // 命令：插件自己排队的 clear/compact 挂起，由测试决定何时完成；用户敲的命令直接完成
  on('command.run', (_, e) => {
    if (e.origin.kind !== 'plugin') return {}
    return new Promise((resolve, reject) => {
      w.commands.push({
        command: e.command,
        args: e.args,
        resolve: () => resolve({ text: '' }),
        // 测试的 hook 失败时被跳过，调用落到最底层而以「no implementation for command.run」失败：
        // 测试里只能这样让插件的 $.command.run 失败，错误文字由不得测试定（Esc 否决的文字在 state.test 里测）
        fail: () => reject(new Error('the command failed')),
      })
    })
  })
  on('prompt.submit', (_, e) => {
    if (e.origin.kind === 'plugin') {
      const origin = e.origin
      return new Promise((resolve) => {
        w.submits.push({
          text: e.text,
          asUser: (origin as { asUser?: boolean }).asUser === true,
          release: (drop) => resolve(drop === undefined ? { text: e.text, origin } : { drop }),
        })
      })
    }
    w.delivered.push({ text: e.text, context: e.context ?? [] })
    return { text: e.text, context: e.context, origin: e.origin }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  on('session.receive', (_, e) => ({ text: e.text }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('classic.SessionStart', () => ({}))
  on('classic.PostToolUse', () => ({}))
  on('classic.Stop', () => (o.stopBlock === undefined ? {} : { block: o.stopBlock }))
  on('tool.call', () => ({ result: 'ok' }))

  /** 刚写好的交接文件 */
  function writeHandoff(path = HANDOVER, size = 6_842): void {
    w.files.set(path, { size, mtimeMs: clock.now() - 2 * MIN })
  }
  /** 刚写好、带正文的交接文件 */
  function writeHandoffText(text: string, path = HANDOVER): void {
    w.files.set(path, { size: text.length, mtimeMs: clock.now() - 2 * MIN })
    w.texts.set(path, text)
  }
  return { w, clock, writeHandoff, writeHandoffText }
}

type W = ReturnType<typeof world>

// ───────── 驱动真实会话里的事件（引擎的 `$`） ─────────


async function start($: any): Promise<void> {
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
}

async function say($: any, text: string, origin: object = COMPOSER, turnId?: string): Promise<any> {
  return $.prompt.submit({ text, origin, wait: false, ...(turnId ? { turnId } : {}) })
}

async function turnStart($: any, turnId: string, agentId?: string): Promise<void> {
  await $.turn.start({ text: 'work', turnId, ...(agentId ? { agentId } : {}) })
}

async function tool($: any, agentId?: string): Promise<any> {
  return $.classic.PostToolUse({
    tool_name: 'Bash',
    tool_input: { command: 'pytest -q tests/test_cache.py' },
    tool_response: { stdout: '12 passed' },
    tool_use_id: 'toolu_01',
    ...(agentId ? { agent_id: agentId, agent_type: 'general-purpose' } : {}),
  })
}

async function registerTool($: any, file: string, agentId?: string): Promise<any> {
  return $.tool.call({ tool: TOOL_FULL_NAME, file, ...(agentId ? { agentId } : {}) })
}

async function stop($: any, active = false, agentId?: string): Promise<any> {
  return $.classic.Stop({ stop_hook_active: active, last_assistant_message: '', ...(agentId ? { agent_id: agentId } : {}) })
}

async function complete($: any, turnId: string, over: object = {}): Promise<void> {
  await $.turn.complete({ answer: '', durationMs: 41_000, isAborted: false, turnId, reason: 'answer', ...over })
}

/** 用户敲 /clear：command.run → session.end(clear) → sid 换新 → SessionStart(clear) */
async function userClear($: any, w: W['w'], to = NEW): Promise<any> {
  await $.command.run({ command: 'clear', args: '', origin: COMPOSER, presentation: PRESENTATION })
  await $.session.end({ reason: 'clear', sessionId: w.sid, resume: { id: w.sid } })
  w.sid = to
  return $.classic.SessionStart({ source: 'clear', session_id: to })
}

function stored(x: W, sid: string): any {
  const v = x.w.store.get(storeKey(sid))
  return v === undefined ? undefined : JSON.parse(v)
}

/** 越过 remind、写交接文件、登记，到回合要结束（Stop 之前） */
async function armedTurn($: any, x: W): Promise<any> {
  await start($)
  x.w.tokens = 36_500
  await say($, 'Refactor src/cache.py and keep the tests green.')
  await turnStart($, T1)
  x.w.tokens = 41_200
  const ptu = await tool($)
  // 第一次越过 remind_at 的 PostToolUse 带完整 remind
  expect(ptu.additionalContext?.length).toBe(1)
  expect(ptu.additionalContext![0]).toContain('past the first threshold of 40k')
  x.writeHandoff()
  x.w.tokens = 43_900
  return registerTool($, HANDOVER)
}

/** armedTurn 之后回合正常结束，clear 已排队 */
async function clearQueued($: any, x: W): Promise<PendingCommand> {
  await armedTurn($, x)
  await stop($)
  await complete($, T1)
  await x.clock.settle()
  expect(x.w.commands.length).toBe(1)
  return x.w.commands[0]!
}

const PRESENTATION = { isFullscreen: false, columns: 160 }

async function slash($: any, args: string): Promise<any> {
  return $.command.run({ command: COMMAND_NAME, args, origin: COMPOSER, presentation: PRESENTATION })
}

// ───────── 场景 ─────────

test('1. clear path in the measured order: /clear resolves first, then SessionStart(clear) in the new session', async ($, on) => {
  const x = world(on)
  const { w, clock } = x
  const reg = await armedTurn($, x)
  expect(w.tools).toEqual(['register_handoff'])
  expect(reg.result).toBe(
    `Handoff registered: "${HANDOVER}". End your turn now: no more tool calls, no questions, no summary. When the turn ends, the conversation is reset with /clear and continued from this file.`,
  )
  expect(w.statuses).toEqual(['handoff registered; /clear when this turn ends'])
  await stop($)
  await complete($, T1)
  await clock.settle()
  expect(w.commands.map((c) => c.command)).toEqual(['clear'])
  expect((stored(x, OLD)).job.stage).toBe('clearing')

  // clear 完成：sid 已换新，promise 先 resolve
  await $.session.end({ reason: 'clear', sessionId: OLD, resume: { id: OLD } })
  w.sid = NEW
  w.tokens = undefined
  w.commands[0]!.resolve()
  await clock.settle()
  expect(w.submits.length).toBe(1)
  expect(w.submits[0]!.asUser).toBe(true)
  expect(w.submits[0]!.text).toStartWith('[AutoHandoff: resume] The context was just reset by AutoHandoff (/clear).')
  expect(w.submits[0]!.text).toContain(`Handoff file: "${HANDOVER}"`)
  // 记录已搬到新 sid；旧 sid 只留开关
  const old = stored(x, OLD)
  expect(old.job).toBeNull()
  expect(old.on).toBe(null)
  expect(old.human).toBe(true)

  // 约 180 ms 后 SessionStart(clear)：start_context 给新对话
  await clock.advance(180)
  const ss = await $.classic.SessionStart({ source: 'clear', session_id: NEW })
  expect(ss.additionalContext?.length).toBe(1)
  expect(ss.additionalContext![0]).toContain('This conversation was just reset by AutoHandoff (/clear)')
  expect(ss.additionalContext![0]).toContain(`Handoff file: "${HANDOVER}"`)
  // 续接回合开始，submit resolve → job 完成，状态行清掉
  await turnStart($, T2)
  w.submits[0]!.release()
  await clock.settle()
  const rec = stored(x, NEW)
  expect(rec.job).toBeNull()
  expect(rec.human).toBe(true)
  expect(w.statuses.at(-1)).toBeUndefined()
  expect(w.debug).toContain(`record moved from session ${OLD} to ${NEW} after /clear`)
  expect(w.debug).toContain('handoff finished: resumed')
})

test('2. clear path in the other order: SessionStart(clear) arrives before the promise resolves; the old record is found through the session that /clear just ended', async ($, on) => {
  const x = world(on)
  const { w, clock } = x
  const cmd = await clearQueued($, x)
  await $.session.end({ reason: 'clear', sessionId: OLD, resume: { id: OLD } })
  w.sid = NEW
  w.tokens = undefined
  const ss = await $.classic.SessionStart({ source: 'clear', session_id: NEW })
  expect(ss.additionalContext?.length).toBe(1)
  expect(ss.additionalContext![0]).toContain(`Handoff file: "${HANDOVER}"`)
  expect(stored(x, NEW).job.stage).toBe('clearing')
  expect(stored(x, NEW).job.ctxGiven).toBe(true)
  expect(w.submits).toEqual([])
  cmd.resolve()
  await clock.settle()
  expect(w.submits.length).toBe(1)
  expect(w.submits[0]!.text).toContain(`Handoff file: "${HANDOVER}"`)
  await turnStart($, T2)
  w.submits[0]!.release()
  await clock.settle()
  expect(stored(x, NEW).job).toBeNull()
  // 只有一次 clear、一次续接、一次 start_context
  expect(w.commands.length).toBe(1)
  expect(w.submits.length).toBe(1)
  expect([...w.store.keys()].sort()).toEqual([storeKey(NEW), storeKey(OLD)].sort())
})

test('3. action compact: /compact with the focus text, same session id, start context at SessionStart(compact), then resume', async ($, on) => {
  const x = world(on, { config: LOW_CONFIG.replace('action: clear', 'action: compact') })
  const { w, clock } = x
  const reg = await armedTurn($, x)
  expect(reg.result).toContain('reset with /compact')
  await stop($)
  await complete($, T1)
  await clock.settle()
  expect(w.commands.map((c) => [c.command, c.args])).toEqual([
    [
      'compact',
      'Keep what is needed to continue the current work: the task and its goal, decisions made, files changed, work in progress, subagents or background tasks still running, open questions and next steps.',
    ],
  ])
  // 压缩中途 SessionStart(compact)，压缩完 promise 才 resolve
  const ss = await $.classic.SessionStart({ source: 'compact', session_id: OLD })
  expect(ss.additionalContext![0]).toContain('(/compact)')
  w.commands[0]!.resolve()
  await clock.settle()
  expect(w.submits.length).toBe(1)
  expect(w.submits[0]!.text).toContain('(/compact)')
  expect(stored(x, OLD).job.stage).toBe('resuming')
  expect(stored(x, NEW)).toBeUndefined()
})

test('4. subagents and forks: their registration is refused and their tool, Stop and turn-end events never reach the main record', async ($, on) => {
  const x = world(on)
  const { w, clock } = x
  await start($)
  w.tokens = 36_500
  await say($, 'Investigate the flaky test with a subagent, then fix it.')
  await turnStart($, T1)
  await turnStart($, 'sub-turn-1', AGENT)
  // 子代理的 hook 里 usage() 读到的是主对话的用量（实测），越线也不能在子代理里提醒
  w.tokens = 95_000
  const sub = await tool($, AGENT)
  expect(sub.additionalContext).toBeUndefined()
  x.writeHandoff()
  const denied = await registerTool($, HANDOVER, AGENT)
  expect(denied.deny).toContain('only the main conversation can register a handoff; subagents and forks cannot.')
  expect(stored(x, OLD).job).toBeNull()
  expect((await stop($, false, AGENT)).block).toBeUndefined()
  await complete($, 'sub-turn-1', { agentId: AGENT })
  expect(stored(x, OLD).levels).toEqual({ remind: false, urge: false })

  // 主对话自己登记，子代理的回合结束不触发 clear，主回合结束才触发
  const ok = await registerTool($, HANDOVER)
  expect(ok.result).toContain('Handoff registered')
  await turnStart($, 'sub-turn-2', AGENT)
  await stop($, false, AGENT)
  await complete($, 'sub-turn-2', { agentId: AGENT })
  await clock.settle()
  expect(w.commands).toEqual([])
  expect(stored(x, OLD).job.stage).toBe('armed')
  await stop($)
  await complete($, T1)
  await clock.settle()
  expect(w.commands.map((c) => c.command)).toEqual(['clear'])
})

test('5. while registered: a user message cancels and tells the model in that message; a task notification does not cancel', async ($, on) => {
  const x = world(on)
  const { w, clock } = x
  await armedTurn($, x)
  // 后台任务的通知送进正在跑的回合：不作废，附 pending_note
  await say($, '<task-notification>Background command "pytest -q" completed (exit code 0)</task-notification>', { kind: 'task-notification' }, T1)
  expect(w.delivered.at(-1)!.context.length).toBe(1)
  expect(w.delivered.at(-1)!.context[0]).toContain('A handoff is registered, and the conversation will be reset with /clear when this turn ends')
  expect(stored(x, OLD).job.stage).toBe('armed')
  // 用户在回合进行中插话：作废，说明附在这条消息上，右上角 toast
  await say($, 'wait, also rename the cache module to store', COMPOSER, T1)
  expect(w.delivered.at(-1)!.context[0]).toStartWith('[AutoHandoff] Your registered handoff was cancelled (a new message from the user arrived).')
  expect(w.toasts).toContain('AutoHandoff: handoff cancelled (a new message from the user arrived)')
  expect(stored(x, OLD).job).toBeNull()
  await stop($)
  await complete($, T1)
  await clock.settle()
  expect(w.commands).toEqual([])
  expect(w.statuses).toEqual(['handoff registered; /clear when this turn ends', undefined])
})

test('6. Esc cancels silently and the short reminder returns with the next message; an API error cancels, toasts and tells the model', async ($, on) => {
  const x = world(on)
  const { w, clock } = x
  await armedTurn($, x)
  await complete($, T1, { isAborted: true, reason: 'aborted' })
  await clock.settle()
  expect(w.commands).toEqual([])
  expect(w.toasts).toEqual([])
  expect(stored(x, OLD).job).toBeNull()
  w.tokens = 44_100
  await say($, 'ok, continue')
  expect(w.delivered.at(-1)!.context[0]).toStartWith('[AutoHandoff] Context usage is about 44k tokens, past the first threshold of 40k')

  // 第二回合：再登记，回合以 API 错误结束（没有 Stop）
  await turnStart($, T2)
  x.writeHandoff()
  await registerTool($, HANDOVER)
  await complete($, T2, { reason: 'error' })
  await clock.settle()
  expect(w.commands).toEqual([])
  expect(w.toasts).toEqual(['AutoHandoff: handoff cancelled (the turn ended with an API error)'])
  expect(w.notifies).toEqual(['AutoHandoff: handoff cancelled (the turn ended with an API error)'])
  await say($, 'retry please')
  expect(w.delivered.at(-1)!.context[0]).toContain('cancelled (the turn ended with an API error)')
})

test('7. a failed /clear cancels, is reported and the model is told', async ($, on) => {
  const x = world(on)
  const { w, clock } = x
  const cmd = await clearQueued($, x)
  cmd.fail()
  await clock.settle()
  expect(stored(x, OLD).job).toBeNull()
  expect(w.submits).toEqual([])
  // store 里只有对话记录（/clear 的搬迁靠模块变量和回调带的旧 sid，不留指针）
  expect([...w.store.keys()]).toEqual([storeKey(OLD)])
  expect(w.toasts).toEqual(['AutoHandoff: handoff cancelled (the reset command failed)'])
  expect(w.debug).toContain('/clear (request 1) was rejected: no implementation for command.run')
  expect(w.statuses.at(-1)).toBeUndefined()
  w.tokens = 46_000
  await say($, 'what happened?')
  expect(w.delivered.at(-1)!.context[0]).toContain('cancelled (the reset command failed)')
})

test('8. a dropped resume message is reported (notify, toast and a transcript line) with the handoff path', async ($, on) => {
  const x = world(on)
  const { w, clock } = x
  const cmd = await clearQueued($, x)
  await $.session.end({ reason: 'clear', sessionId: OLD, resume: { id: OLD } })
  w.sid = NEW
  cmd.resolve()
  await clock.settle()
  await $.classic.SessionStart({ source: 'clear', session_id: NEW })
  w.submits[0]!.release('the session was stopped and nobody has sent input since')
  await clock.settle()
  const text = `AutoHandoff: the conversation was reset, but the resume message was not sent (the session was stopped and nobody has sent input since). Send a message to continue; the handoff file is "${HANDOVER}".`
  expect(w.notifies).toEqual([text])
  expect(w.toasts).toEqual([text])
  expect(w.logs).toContain(text)
  expect(stored(x, NEW).job).toBeNull()
})

test('the handoff file vanishing before the turn ends cancels with a toast instead of clearing', async ($, on) => {
  const x = world(on)
  const { w, clock } = x
  await armedTurn($, x)
  // 模型登记后又把文件挪走了（git stash 之类）：stat 抛 ENOENT
  w.files.delete(HANDOVER)
  await stop($)
  await complete($, T1)
  await clock.settle()
  expect(w.commands).toEqual([])
  expect(w.toasts).toEqual(['AutoHandoff: handoff cancelled (the handoff file was missing, empty or moved when the reset was due)'])
})

test('a manual /clear cancels the registration quietly and carries the switch into the new conversation', async ($, on) => {
  const x = world(on, { config: LOW_CONFIG.replace('default_on: true', 'default_on: false') })
  const { w } = x
  await start($)
  await slash($, 'on')
  expect(w.logs.at(-1)).toStartWith('AutoHandoff is on for this conversation.')
  w.tokens = 41_000
  await say($, 'continue the refactor')
  await turnStart($, T1)
  x.writeHandoff()
  expect((await registerTool($, HANDOVER)).result).toContain('Handoff registered')
  await stop($)
  await complete($, T1, { isAborted: true, reason: 'aborted' })
  // 用户自己 /clear
  await userClear($, w)
  expect(w.commands).toEqual([])
  expect(stored(x, NEW).on).toBe(true)
  expect(stored(x, NEW).job).toBeNull()
  expect(stored(x, OLD).on).toBe(true)
  // 新对话：用量越过 remind 照样提醒（开关跟过来了）
  w.tokens = 41_500
  await say($, 'read docs/work/HANDOVER.md and continue')
  expect(w.delivered.at(-1)!.context[0]).toContain('[AutoHandoff: reminder]')
})

test('/autohandoff is intercepted: answered with nothing (no model turn), output only in ui.log; off refuses registration', async ($, on) => {
  const x = world(on)
  const { w } = x
  await start($)
  w.tokens = 52_300
  const r = await slash($, 'status')
  expect(r).toEqual({})
  // transcript 的 ui.log 行不显示换行：状态逐行记。/autohandoff 本身就是人工输入，default_on 立即生效；
  // 配置里只写了 settings 节，缺提示词节不算问题
  expect(w.logs).toEqual([
    'AutoHandoff is on for this conversation (default_on: true).',
    'Context: 52k of 1000k. Reminders at 40k and 90k, compaction at 300k; reset with /clear.',
    'Handoff: none registered.',
    `Configuration: ${CONFIG}`,
  ])
  await slash($, 'off')
  expect(w.logs.at(-1)).toBe('AutoHandoff is off for this conversation.')
  x.writeHandoff()
  const denied = await registerTool($, HANDOVER)
  expect(denied.deny).toContain('AutoHandoff is off for this conversation.')
  await slash($, 'sometimes')
  expect(w.logs.at(-1)).toBe('Usage: /autohandoff [on|off|status] (no argument toggles)')
  await slash($, '')
  expect(w.logs.at(-1)).toStartWith('AutoHandoff is on for this conversation.')
  expect(w.delivered).toEqual([])
})

test('first run writes the default configuration file once; a broken value is reported by /autohandoff status', async ($, on) => {
  const x = world(on, { config: null })
  const { w } = x
  await start($)
  expect(w.writes.map((wr) => wr.path)).toEqual([CONFIG])
  expect(w.writes[0]!.text).toBe(defaultConfigText())
  await start($)
  expect(w.writes.length).toBe(1)
  w.config = w.config!.replace('remind_at: 300000', 'remind_at: 300k')
  await slash($, 'status')
  expect(w.logs.slice(-2)).toEqual([
    'Configuration problems (built-in defaults used for these):',
    '  - remind_at should be a whole number, got "300k"; using the default (300000)',
  ])
})

test('a Claude Code older than 2.1.304 or a non-interactive run: no tool, no reminders, /autohandoff explains', async ($, on) => {
  const x = world(on, { version: '2.1.290' })
  const { w } = x
  await start($)
  expect(w.tools).toEqual([])
  expect(w.toasts).toEqual(['AutoHandoff is not active: it needs Claude Code 2.1.304 or later (this is 2.1.290).'])
  w.tokens = 95_000
  await say($, 'hello')
  expect(w.delivered[0]!.context).toEqual([])
  await slash($, 'status')
  expect(w.logs.at(-1)).toBe('AutoHandoff is not active in this session: it needs Claude Code 2.1.304 or later (this is 2.1.290).')
  expect(w.store.size).toBe(0)
})

test('claude -p (not interactive): the module stays silent', async ($, on) => {
  const x = world(on)
  const { w } = x
  await $.session.start({ cwd: CWD, surface: null, isInteractive: false })
  expect(w.tools).toEqual([])
  w.tokens = 95_000
  await say($, 'summarize README.md', { kind: 'sdk' })
  await turnStart($, T1)
  expect((await tool($)).additionalContext).toBeUndefined()
  expect(w.delivered[0]!.context).toEqual([])
  expect(w.store.size).toBe(0)
  expect(w.writes).toEqual([])
})

test('registration paths: relative to the working directory, the memory folder, and refusals outside the allowed folders', async ($, on) => {
  const x = world(on)
  const { w } = x
  await start($)
  w.tokens = 41_000
  await say($, 'hand off now')
  await turnStart($, T1)
  // 工作目录是 git 仓库的子目录 server/：相对路径按它解析，仓库根之下都算工程目录
  x.writeHandoff()
  const rel = await registerTool($, '../docs/work/HANDOVER.md')
  expect(rel.result).toBe(
    `Handoff registered: "${HANDOVER}". End your turn now: no more tool calls, no questions, no summary. When the turn ends, the conversation is reset with /clear and continued from this file.`,
  )
  // 自动记忆目录里的笔记可以；~/.claude 的其它文件不行
  const memDir = `${CC_DIR}/projects/-home-user-projects-myproject/memory`
  w.dirs.add(memDir)
  x.writeHandoff(`${memDir}/handoff-2026-10-25.md`, 2_100)
  expect((await registerTool($, `${memDir}/handoff-2026-10-25.md`)).result).toContain('Handoff registered')
  x.writeHandoff(`${CC_DIR}/settings.json`, 3_000)
  const cfg = await registerTool($, `${CC_DIR}/settings.json`)
  expect(cfg.deny).toContain('the file is outside the project folder and the memory folder')
  x.writeHandoff(`${HOME}/notes/todo.md`, 900)
  expect((await registerTool($, `${HOME}/notes/todo.md`)).deny).toContain('outside the project folder')
  expect((await registerTool($, '~/notes/todo.md')).deny).toContain('"~" is not expanded; give the absolute path instead')
  expect((await registerTool($, `${REPO}/docs/missing.md`)).deny).toContain('the file does not exist')
  // 拒绝不影响已登记的那一份
  expect(stored(x, OLD).job.file).toBe(`${memDir}/handoff-2026-10-25.md`)
})

// ───────── 重置已排队之后（PLAN §0 第 20 条）：命令撤不回，job 不作废 ─────────

const MID = '0d2e4f60-7a8b-4c9d-8e0f-a1b2c3d4e5f6'

/** 用户在回合中敲的命令排在回合后面，回合结束、自家 /clear 入队之后才出队执行（实测）；这时 command.run 才看到它 */
async function userCommand($: any, command: string, args = ''): Promise<void> {
  await $.command.run({ command, args, origin: COMPOSER, presentation: PRESENTATION })
}

test('the user\'s /compact typed during the registered turn runs first; the queued /clear still resumes in the new conversation (1 clear, 1 resume)', async ($, on) => {
  const x = world(on)
  const { w, clock } = x
  const cmd = await clearQueued($, x)
  await userCommand($, 'compact', 'keep everything')
  expect(w.toasts).toEqual([QUEUED_TOAST])
  expect(stored(x, OLD).job.stage).toBe('clearing')
  // 用户的压缩跑完：SessionStart(compact)，同一个 sid，不是新对话
  const sc = await $.classic.SessionStart({ source: 'compact', session_id: OLD })
  expect(sc.additionalContext).toBeUndefined()
  // 然后自家的 /clear
  await $.session.end({ reason: 'clear', sessionId: OLD, resume: { id: OLD } })
  w.sid = NEW
  w.tokens = undefined
  cmd.resolve()
  await clock.settle()
  const ss = await $.classic.SessionStart({ source: 'clear', session_id: NEW })
  expect(ss.additionalContext![0]).toContain(`Handoff file: "${HANDOVER}"`)
  await turnStart($, T2)
  w.submits[0]!.release()
  await clock.settle()
  expect(w.commands.length).toBe(1)
  expect(w.submits.length).toBe(1)
  expect(stored(x, NEW).job).toBeNull()
  expect(w.debug.filter((d) => d.startsWith('handoff cancelled'))).toEqual([])
  expect(w.debug).toContain('handoff finished: resumed')
})

test('the user\'s /clear typed during the registered turn: two clears in a row, the handoff follows to the last conversation', async ($, on) => {
  const x = world(on)
  const { w, clock } = x
  const cmd = await clearQueued($, x)
  // 用户的 /clear 先出队：OLD → MID（中间这个对话马上又被自家的 /clear 清掉）
  await userClear($, w, MID)
  expect(w.toasts).toEqual([QUEUED_TOAST])
  expect(stored(x, MID).job.stage).toBe('clearing')
  // 自家的 /clear：MID → NEW，promise 先 resolve
  await $.session.end({ reason: 'clear', sessionId: MID, resume: { id: MID } })
  w.sid = NEW
  cmd.resolve()
  await clock.settle()
  expect(w.submits.length).toBe(1)
  expect(w.debug).toContain(`record moved from session ${MID} to ${NEW} after /clear`)
  const ss = await $.classic.SessionStart({ source: 'clear', session_id: NEW })
  expect(ss.additionalContext![0]).toContain(`Handoff file: "${HANDOVER}"`)
  expect(stored(x, NEW).job.stage).toBe('resuming')
  expect(stored(x, OLD).job).toBeNull()
})

test('/autohandoff off while the /clear is queued: it still resumes, and AutoHandoff is off in the new conversation', async ($, on) => {
  const x = world(on)
  const { w, clock } = x
  const cmd = await clearQueued($, x)
  await slash($, 'off')
  expect(w.logs.at(-1)).toBe('AutoHandoff is off for this conversation. The reset already queued still runs and continues from the handoff file; AutoHandoff stays off after it.')
  expect(w.toasts).toEqual([QUEUED_TOAST])
  await $.session.end({ reason: 'clear', sessionId: OLD, resume: { id: OLD } })
  w.sid = NEW
  cmd.resolve()
  await clock.settle()
  await $.classic.SessionStart({ source: 'clear', session_id: NEW })
  await turnStart($, T2)
  w.submits[0]!.release()
  await clock.settle()
  expect(w.submits.length).toBe(1)
  expect(stored(x, NEW).on).toBe(false)
  w.tokens = 95_000
  await say($, 'thanks, carry on')
  expect(w.delivered.at(-1)!.context).toEqual([])
})

test('a hot reload while the /clear is queued: the new module resumes from SessionStart(clear) even if the old callback never comes', async ($, on) => {
  const x = world(on)
  const { w, clock } = x
  const cmd = await clearQueued($, x)
  // 热重载：session.start 再触发，sid 不变
  await start($)
  expect(stored(x, OLD).job.stage).toBe('clearing')
  expect(stored(x, OLD).job.orphan).toBe(true)
  expect(w.toasts).toEqual([])
  await $.session.end({ reason: 'clear', sessionId: OLD, resume: { id: OLD } })
  w.sid = NEW
  const ss = await $.classic.SessionStart({ source: 'clear', session_id: NEW })
  expect(ss.additionalContext![0]).toContain(`Handoff file: "${HANDOVER}"`)
  await clock.settle()
  expect(w.submits.length).toBe(1)
  expect(w.submits[0]!.text).toContain(`Handoff file: "${HANDOVER}"`)
  // 旧回调要是还来：忽略，不再续接一次
  cmd.resolve()
  await clock.settle()
  expect(w.submits.length).toBe(1)
  await turnStart($, T2)
  w.submits[0]!.release()
  await clock.settle()
  expect(stored(x, NEW).job).toBeNull()
})

test('session.receive: a team-lead delivery to one of this session\'s agents (agentId) is ignored; one to the main conversation of a fresh process marks it as a teammate', async ($, on) => {
  const x = world(on)
  const { w } = x
  await start($)
  const lead = { kind: 'peer', teammate: 'team-lead' }
  await $.session.receive({ origin: lead, text: 'please review src/cache.py', agentId: AGENT })
  expect(w.store.size).toBe(0)
  await $.session.receive({ origin: lead, text: 'please review src/cache.py' })
  expect(stored(x, OLD).teammate).toBe(true)
  w.tokens = 95_000
  await turnStart($, T1)
  expect((await tool($)).additionalContext).toBeUndefined()
  x.writeHandoff()
  expect((await registerTool($, HANDOVER)).deny).toContain('AutoHandoff is off for this conversation.')
})

test('a slash command\'s own prompt.submit is not a new message: the registration stays until command.run decides', async ($, on) => {
  const x = world(on)
  const { w } = x
  await armedTurn($, x)
  await $.prompt.submit({ text: '/model opus', origin: COMPOSER, wait: false, command: { name: 'compact', args: '' } })
  expect(stored(x, OLD).job.stage).toBe('armed')
  expect(w.toasts).toEqual([])
})

test('the store failing when the turn ends: no /clear is issued (it could not be matched afterwards), the user is told, the registration stays', async ($, on) => {
  const x = world(on)
  const { w, clock } = x
  await armedTurn($, x)
  await stop($)
  w.storeFails = true
  await complete($, T1)
  await clock.settle()
  expect(w.commands).toEqual([])
  // 错误文字由测试工具包定（hook 抛错时落到最底层的「no implementation」），只看句式
  expect(w.toasts.length).toBe(1)
  expect(w.toasts[0]).toStartWith('AutoHandoff could not save its state (')
  expect(w.toasts[0]).toEndWith('), so the conversation was not reset.')
  expect(stored(x, OLD).job.stage).toBe('armed')
  // store 恢复后，下一条人工消息照常作废这份登记并告诉模型
  w.storeFails = false
  await say($, 'what happened?')
  expect(w.delivered.at(-1)!.context[0]).toContain('Your registered handoff was cancelled (a new message from the user arrived)')
})

test('$.state failing when the turn ends: no /clear is issued (a reload would take it for a restart and leave a reset nobody resumes), the user is told, the registration stays', async ($, on) => {
  const x = world(on)
  const { w, clock } = x
  await armedTurn($, x)
  await stop($)
  w.stateFails = true
  await complete($, T1)
  await clock.settle()
  expect(w.commands).toEqual([])
  expect(w.toasts.length).toBe(1)
  expect(w.toasts).toEqual(['AutoHandoff could not save its state ($.state.set did not write the value), so the conversation was not reset.'])
  expect(w.debug).toContain('turnComplete: reset not issued because the queued reset could not be saved')
  expect(stored(x, OLD).job.stage).toBe('armed')
  expect(w.state.get('autohandoff/queued')).toBeUndefined()
  // 恢复后，下一条人工消息照常作废这份登记并告诉模型
  w.stateFails = false
  await say($, 'did it reset?')
  expect(w.delivered.at(-1)!.context[0]).toContain('Your registered handoff was cancelled (a new message from the user arrived)')
})

test('the store failing while the /clear runs: the record cannot be moved or saved, but the new conversation still gets the resume message and the start context', async ($, on) => {
  const x = world(on)
  const { w, clock } = x
  const cmd = await clearQueued($, x)
  w.storeFails = true
  await $.session.end({ reason: 'clear', sessionId: OLD, resume: { id: OLD } })
  w.sid = NEW
  cmd.resolve()
  await clock.settle()
  expect(w.submits.length).toBe(1)
  const ss = await $.classic.SessionStart({ source: 'clear', session_id: NEW })
  expect(ss.additionalContext![0]).toContain(`Handoff file: "${HANDOVER}"`)
  expect(w.submits.length).toBe(1)
  expect(w.debug.some((d) => d.startsWith(`could not save the record moved from session ${OLD} to ${NEW}`))).toBe(true)
})

test('~/.claude as a symbolic link: a note in the memory folder is accepted under its real path', async ($, on) => {
  const REAL_CC = '/data/cc-config'
  const x = world(on, { links: { [CC_DIR]: REAL_CC } })
  const { w } = x
  const memDir = `${REAL_CC}/projects/-home-user-projects-myproject/memory`
  w.dirs.add(REAL_CC)
  w.dirs.add(memDir)
  await start($)
  w.tokens = 41_000
  await say($, 'hand off now')
  await turnStart($, T1)
  x.writeHandoff(`${memDir}/handoff-2026-10-25.md`, 2_100)
  const r = await registerTool($, `${CC_DIR}/projects/-home-user-projects-myproject/memory/handoff-2026-10-25.md`)
  expect(r.result).toBe(
    `Handoff registered: "${memDir}/handoff-2026-10-25.md". End your turn now: no more tool calls, no questions, no summary. When the turn ends, the conversation is reset with /clear and continued from this file.`,
  )
  // 链接目标里记忆目录以外的文件照样拒绝
  x.writeHandoff(`${REAL_CC}/settings.json`, 3_000)
  expect((await registerTool($, `${CC_DIR}/settings.json`)).deny).toContain('outside the project folder and the memory folder')
})

test('AUTOHANDOFF_CONFIG absolute: the default file is written there', async ($, on) => {
  const own = '/srv/team/autohandoff.md'
  const x = world(on, { env: { AUTOHANDOFF_CONFIG: own }, config: null })
  await start($)
  expect(x.w.writes.map((wr) => wr.path)).toEqual([own])
})

test('AUTOHANDOFF_CONFIG relative: ignored (it would land in the project), reported once in debug and in status; the default file is used', async ($, on) => {
  const x = world(on, { env: { AUTOHANDOFF_CONFIG: 'conf/autohandoff.md' } })
  const { w } = x
  await start($)
  expect(w.writes).toEqual([])
  await slash($, 'status')
  await slash($, 'status')
  expect(w.logs).toContain(`Configuration: ${CONFIG}`)
  expect(w.logs).toContain('  - AUTOHANDOFF_CONFIG="conf/autohandoff.md" is not an absolute path; it is ignored')
  expect(w.debug.filter((d) => d.includes('is not an absolute path')).length).toBe(1)
})

test('$.fs.exists rejecting (the configuration folder on a network share): the tool is still registered first, nothing is written, and the switch, reminder and registration still work', async ($, on) => {
  const x = world(on, { config: null, existsRejects: true })
  const { w } = x
  await start($)
  expect(w.tools).toEqual(['register_handoff'])
  // 默认配置文件没写成（exists 先 reject 了），原因进 debug
  expect(w.writes).toEqual([])
  expect(w.debug.some((d) => d.startsWith(`could not write the default configuration to ${CONFIG}: `))).toBe(true)
  // 配置读不到，按内置默认（default_on 关、remind_at 300k）；用户手动打开
  await slash($, 'on')
  w.tokens = 296_000
  await say($, 'Refactor src/cache.py and keep the tests green.')
  await turnStart($, T1)
  w.tokens = 312_400
  const ptu = await tool($)
  expect(ptu.additionalContext?.length).toBe(1)
  expect(ptu.additionalContext![0]).toContain('past the first threshold of 300k')
  x.writeHandoff()
  const reg = await registerTool($, HANDOVER)
  expect(reg.result).toStartWith(`Handoff registered: "${HANDOVER}".`)
  await slash($, 'status')
  expect(w.logs.some((l) => l.includes(`could not read ${CONFIG}`))).toBe(true)
})

// ───────── 第 3 批 ─────────

test('a process restart while the /clear was queued: $.state is empty, so the job is cancelled and the model told; the user\'s own /clear afterwards is a plain clear', async ($, on) => {
  const x = world(on)
  const { w, clock } = x
  await clearQueued($, x)
  // 发出 /clear 时记下了 job（热重载时据此认出命令还在本进程排队）
  expect(w.state.get('autohandoff/queued')).toEqual([`${NOW}:1`])
  // 进程在 clear 完成前没了；之后 claude --resume 同一个对话：宿主的 $.state 是新的
  w.state.clear()
  await clock.advance(2 * MIN)
  await start($)
  expect(stored(x, OLD).job).toBeNull()
  expect(w.toasts).toEqual(['AutoHandoff: handoff cancelled (AutoHandoff was restarted or reloaded before the reset)'])
  expect(w.debug).toContain('restarted: /clear (request 1) was queued by a process that has ended')
  // 用户自己 /clear：不再提示「已排队、撤不回」，新对话没有交接、没有续接
  const ss = await userClear($, w)
  expect(ss.additionalContext).toBeUndefined()
  await clock.settle()
  expect(w.toasts.length).toBe(1)
  expect(w.submits).toEqual([])
  expect(stored(x, NEW).job).toBeNull()
})

test('a hot reload keeps $.state: the queued /clear is recognised as this process\'s and the orphan resumes once', async ($, on) => {
  const x = world(on)
  const { w, clock } = x
  await clearQueued($, x)
  await start($)
  expect(stored(x, OLD).job.orphan).toBe(true)
  expect(w.toasts).toEqual([])
  await $.session.end({ reason: 'clear', sessionId: OLD, resume: { id: OLD } })
  w.sid = NEW
  await $.classic.SessionStart({ source: 'clear', session_id: NEW })
  await clock.settle()
  expect(w.submits.length).toBe(1)
})

test('the store failing at registration: the model is told it was not registered (it would have been forgotten), and the user gets a toast', async ($, on) => {
  const x = world(on)
  const { w } = x
  await start($)
  w.tokens = 41_000
  await say($, 'hand off now')
  await turnStart($, T1)
  x.writeHandoff()
  w.storeFails = true
  const r = await registerTool($, HANDOVER)
  expect(r.deny).toStartWith('Not registered: AutoHandoff could not save the registration (')
  expect(w.toasts.length).toBe(1)
  expect(w.toasts[0]).toEndWith('), so the handoff was not registered.')
  expect(w.statuses).toEqual([])
  w.storeFails = false
  expect(stored(x, OLD).job).toBeNull()
})

test('another Stop hook below already blocks: its block stands alone, ours is not added and the urge level stays unsent', async ($, on) => {
  const x = world(on, { stopBlock: 'lint: 2 errors in src/cache.py; fix them before ending the turn' })
  const { w } = x
  await start($)
  w.tokens = 85_000
  await say($, 'finish the cache refactor')
  await turnStart($, T1)
  w.tokens = 95_000
  const r = await stop($)
  expect(r.block).toBe('lint: 2 errors in src/cache.py; fix them before ending the turn')
  expect(w.debug).toContain('another Stop hook already asked the model to continue; the urge block was not added')
  expect(stored(x, OLD).levels.urge).toBe(false)
  // 模型按那个 hook 继续修：下一次工具调用拿到完整 urge
  const ptu = await tool($)
  expect(ptu.additionalContext![0]).toContain('[AutoHandoff: hand off now]')
})

test('an engine notice (unclassified, isMeta) delivered into the registered turn does not cancel and gets nothing attached', async ($, on) => {
  const x = world(on)
  const { w } = x
  await armedTurn($, x)
  await $.prompt.submit({ text: 'Agent "scout" is idle', origin: { kind: 'unclassified' }, isMeta: true, wait: false, turnId: T1 })
  expect(stored(x, OLD).job.stage).toBe('armed')
  expect(w.delivered.at(-1)!.context).toEqual([])
  expect(w.debug).toContain('message: origin unclassified, isMeta, into the running turn')
  expect(w.toasts).toEqual([])
})

test('chain guard: right after the resume, the new conversation\'s registration is refused; after the user writes it is accepted', async ($, on) => {
  const x = world(on)
  const { w, clock } = x
  const cmd = await clearQueued($, x)
  await $.session.end({ reason: 'clear', sessionId: OLD, resume: { id: OLD } })
  w.sid = NEW
  w.tokens = undefined
  cmd.resolve()
  await clock.settle()
  await $.classic.SessionStart({ source: 'clear', session_id: NEW })
  await turnStart($, T2)
  w.submits[0]!.release()
  await clock.settle()
  // 续接回合：交接文件里写着「继续交接」，模型又去登记
  w.tokens = 31_800
  x.writeHandoff()
  const r = await registerTool($, HANDOVER)
  expect(r.deny).toStartWith('Not registered: this conversation has just been continued from a handoff file and its context is below the first threshold (40k).')
  expect(stored(x, NEW).job).toBeNull()
  await stop($)
  await complete($, T2)
  await clock.settle()
  expect(w.commands.length).toBe(1)
  // 用户能在 /autohandoff status 里看到登记暂不受理（查看状态不算发话，不解除）
  await slash($, 'status')
  expect(w.logs).toContain(
    'Just continued from a handoff file: a new handoff is not accepted until context passes 40k or you send a message (this stops a reset loop).',
  )
  expect((await registerTool($, HANDOVER)).deny).toStartWith('Not registered: this conversation has just been continued')
  // 用户发话之后（比如要求交接）照常受理
  await say($, 'please hand off now, I need to restart the machine')
  expect((await registerTool($, HANDOVER)).result).toContain('Handoff registered')
})

test('action compact and the user\'s /clear runs first: the new conversation gets the handoff at SessionStart(clear); the queued /compact then fails on the empty conversation and the resume still comes', async ($, on) => {
  const x = world(on, { config: LOW_CONFIG.replace('action: clear', 'action: compact') })
  const { w, clock } = x
  const cmd = await clearQueued($, x)
  expect(cmd.command).toBe('compact')
  const ss = await userClear($, w)
  expect(w.toasts).toEqual([QUEUED_TOAST])
  expect(ss.additionalContext![0]).toContain(`Handoff file: "${HANDOVER}"`)
  expect(w.debug).toContain('a /clear not run by AutoHandoff started a new conversation while /compact is queued; it gets the handoff now')
  cmd.fail()
  await clock.settle()
  expect(w.submits.length).toBe(1)
  expect(w.submits[0]!.text).toContain('(/compact)')
  expect(w.toasts).toEqual([QUEUED_TOAST])
  await turnStart($, T2)
  w.submits[0]!.release()
  await clock.settle()
  expect(stored(x, NEW).job).toBeNull()
})

// ───────── 本轮交接文件与超长退回（PLAN §0 第 30 条） ─────────

/** 本轮交接文件：<启动目录>/.autohandoff/_AUTOHANDOFF_<本地时间>_<会话 ID 前 8 位>.md */
function notePath(at: number, sid = OLD, dir = CWD): string {
  return `${dir}/.autohandoff/_AUTOHANDOFF_${localStamp(at)}_${sid.slice(0, 8)}.md`
}

/** 一份写给下个对话的交接文件（几节，远低于 15k） */
const NOTE_TEXT = growingHandover(3)

/** 越过 remind，拿到提醒（返回 PostToolUse 的结果）；之后由测试写文件、登记 */
async function reminded($: any, x: W): Promise<any> {
  await start($)
  x.w.tokens = 36_500
  await say($, 'Finish the upload state machine and rerun the acceptance tests.')
  await turnStart($, T1)
  x.w.tokens = 41_200
  return tool($)
}

test('handoff file to write: the reminder names a new file under the launch folder; written there and registered, the next conversation gets it, and its own first reminder names a new file', async ($, on) => {
  const x = world(on)
  const ptu = await reminded($, x)
  const P = notePath(x.clock.now())
  expect(ptu.additionalContext![0]!.endsWith(`Handoff file to write: "${P}" (a new file for this handoff; register this path).`)).toBe(true)
  // 下一条消息（同一轮）的短提醒还是它
  x.w.tokens = 41_900
  const later = await say($, 'Also check the Windows paths.', COMPOSER, T2)
  expect(later.context.at(-1)).toContain(`Handoff file to write: "${P}"`)
  x.writeHandoffText(NOTE_TEXT, P)
  const reg = await registerTool($, P)
  expect(reg.result).toStartWith(`Handoff registered: "${P}".`)
  expect(x.w.reads).toEqual([P])
  await stop($)
  await complete($, T1)
  await x.clock.settle()
  await $.session.end({ reason: 'clear', sessionId: OLD, resume: { id: OLD } })
  x.w.sid = NEW
  x.w.tokens = undefined
  x.w.commands[0]!.resolve()
  await x.clock.settle()
  const ss = await $.classic.SessionStart({ source: 'clear', session_id: NEW })
  expect(ss.additionalContext![0]).toContain(`Handoff file: "${P}"`)
  expect(x.w.submits[0]!.text).toContain(`Handoff file: "${P}"`)
  // 旧对话的记录不再留着这条路径：--resume 回去再被提醒时不会让它覆盖新对话续接用的那份
  expect(stored(x, OLD).note).toBeNull()
  expect(stored(x, NEW).note).toBeNull()
  x.w.submits[0]!.release()
  await x.clock.settle()
  // 新对话越过 remind：新时刻、新会话 ID
  x.clock.advance(35 * MIN)
  await turnStart($, T2)
  x.w.tokens = 40_300
  const next = await tool($)
  const P2 = notePath(x.clock.now(), NEW)
  expect(P2).not.toBe(P)
  expect(next.additionalContext![0]!.endsWith(`Handoff file to write: "${P2}" (a new file for this handoff; register this path).`)).toBe(true)
})

test('handoff file to write: started from the home folder (no usable project folder), the reminder asks for the file in the auto-memory folder instead', async ($, on) => {
  const x = world(on, { launch: HOME, repo: null })
  const ptu = await reminded($, x)
  const text: string = ptu.additionalContext![0]!
  expect(text).toContain(`Handoff file to write: a new file named "_AUTOHANDOFF_${localStamp(x.clock.now())}_6f1c2b8e.md" in the Claude Code auto-memory folder`)
  // 写进记忆目录后照常登记
  const mem = `${CC_DIR}/projects/-home-user/memory/_AUTOHANDOFF_${localStamp(x.clock.now())}_6f1c2b8e.md`
  x.writeHandoffText(NOTE_TEXT, mem)
  expect((await registerTool($, mem)).result).toStartWith(`Handoff registered: "${mem}".`)
})

test('handoff file to write: a launch folder whose path has characters the whitelist refuses is not put in the reminder; the memory folder is used', async ($, on) => {
  const launch = '/home/user/Dropbox (Personal)/proj'
  const x = world(on, { launch, repo: null })
  x.w.dirs.add(launch)
  const ptu = await reminded($, x)
  const text: string = ptu.additionalContext![0]!
  expect(text).not.toContain(launch)
  const name = `_AUTOHANDOFF_${localStamp(x.clock.now())}_6f1c2b8e.md`
  expect(text.endsWith(`a new file named "${name}" in the Claude Code auto-memory folder (<config dir>/projects/<project>/memory/), because AutoHandoff has no usable project folder path for it (Claude Code was started in the home folder or at the root of the file system, or the project folder's path has characters AutoHandoff does not accept). Register its full path.`)).toBe(true)
  const mem = `${CC_DIR}/projects/-home-user-Dropbox--Personal--proj/memory/${name}`
  x.writeHandoffText(NOTE_TEXT, mem)
  expect((await registerTool($, mem)).result).toStartWith(`Handoff registered: "${mem}".`)
})

test('oversize: the project\'s own HANDOVER.md over the limit is not to be cut; the reply points to this round\'s handoff file', async ($, on) => {
  const x = world(on)
  await reminded($, x)
  const P = notePath(x.clock.now())
  x.writeHandoffText(growingHandover(40))
  const big = await registerTool($, HANDOVER)
  expect(big.deny).toContain(`Do not delete from or shorten "${HANDOVER}" for this`)
  expect(big.deny).toContain(`Instead write the handoff as a new file of about 15k tokens that makes sense on its own, at "${P}".`)
  expect(stored(x, OLD).job).toBeNull()
  x.writeHandoffText(NOTE_TEXT, P)
  expect((await registerTool($, P)).result).toStartWith(`Handoff registered: "${P}".`)
})

test('oversize: a handoff file over handoff_max_tokens is read once and refused with the estimate; shortened, it is registered', async ($, on) => {
  const x = world(on)
  await reminded($, x)
  const P = notePath(x.clock.now())
  x.writeHandoffText(growingHandover(40), P)
  const big = await registerTool($, P)
  expect(big.deny).toMatch(/^Not registered: the handoff file is about \d+k tokens by AutoHandoff's estimate, over the 20k limit \(handoff_max_tokens\), .* Shorten it to about 15k tokens\./)
  expect(x.w.reads).toEqual([P])
  expect(stored(x, OLD).job).toBeNull()
  x.writeHandoffText(NOTE_TEXT, P)
  expect((await registerTool($, P)).result).toStartWith(`Handoff registered: "${P}".`)
  expect(stored(x, OLD).job.file).toBe(P)
})

test('oversize: the project\'s own HANDOVER.md (a user\'s custom prompts) is registered like any legal path when under the limit', async ($, on) => {
  const x = world(on)
  await reminded($, x)
  x.writeHandoffText(growingHandover(4))
  expect((await registerTool($, HANDOVER)).result).toStartWith(`Handoff registered: "${HANDOVER}".`)
})

test('oversize: the handoff file cannot be read at registration (another plugin denies it): still registered, no size check, logged', async ($, on) => {
  const x = world(on)
  await reminded($, x)
  x.writeHandoff()
  const reg = await registerTool($, HANDOVER)
  expect(reg.result).toStartWith('Handoff registered:')
  expect(x.w.reads).toEqual([HANDOVER])
  // 测试 hook 抛错只会被跳过，落到底层「no implementation」：错误文字由不得测试定
  expect(x.w.debug.some((l) => l.startsWith('could not read the handoff file to estimate its size: '))).toBe(true)
})

test('oversize: handoff_max_tokens 0 never reads the handoff file and registers any size', async ($, on) => {
  const x = world(on, { config: LOW_CONFIG.replace('handoff_max_tokens: 20000', 'handoff_max_tokens: 0') })
  await reminded($, x)
  x.writeHandoffText(growingHandover(40))
  expect((await registerTool($, HANDOVER)).result).toStartWith('Handoff registered:')
  expect(x.w.reads).toEqual([])
})
