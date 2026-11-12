// 接线层（register.ts）的流程测试：引擎的 `$` 由 claude-code/testing 提供，插件之下的世界（session、store、fs、命令执行、
// 续接提交）由这里的 hook 扮演。事件顺序按实测（docs/mod-feasibility.zh.md §3、§9）排：
// clear 的 promise 先 resolve、约 180 ms 后才到 SessionStart(clear)；子代理的事件带 agentId；工具被拒的回合没有 Stop。
import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { COMMAND_NAME, QUEUED_TOAST, TOOL_FULL_NAME, defaultConfigText, localStamp, markKey, newRecord, storeKey } from '../hooks/core.js'
import { CC_DIR, CWD, HANDOVER, HOME, MIN, NOW, REPO, growingHandover } from './helpers.js'

const OLD = '6f1c2b8e-3a4d-4e5f-9a0b-1c2d3e4f5a6b'
const NEW = 'b7e9d1c3-5f2a-4b6c-8d0e-2f4a6b8c0d1e'
const CONFIG = `${CC_DIR}/autohandoff.md`
const AGENT = 'a904d9323568546da'
const T1 = 'f0b6c7a2-6d1e-4c2a-9a51-1f3e0c9b7d10'
const T2 = '3a9e1d44-0c5b-4f7e-8b2d-6c1a9f0e2b77'
const T3 = '7e4b0c19-2d5a-4f38-b6c1-9a0d3e5f7b28'
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
resume_guard_tokens: 20000
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
    /** 为真时只有写入期标记（t: 开头的键）写不进：记录照常写进 */
    markFails: false,
    /** store.get 被调用的次数 */
    storeGets: 0,
    /** 为真时读配置文件出错（读到一半的 I/O 错误、别的插件的 fs hook 拒绝） */
    configUnreadable: false,
    /** 接下来这么多次 store.get 抛错（另一个进程正在写、锁竞争重试耗尽、文件读不出来）；Infinity 表示一直读不了 */
    storeReadFails: 0,
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
  on('store.get', (_, e) => {
    w.storeGets += 1
    if (w.storeReadFails > 0) {
      w.storeReadFails -= 1
      throw new Error('the plugin store could not be read')
    }
    return { value: w.store.has(e.key) ? JSON.parse(w.store.get(e.key)!) : undefined }
  })
  on('store.set', (_, e) => {
    if (w.storeFails) throw new Error('the plugin store is full')
    if (w.markFails && e.key.startsWith('t:')) throw new Error('the plugin store is busy')
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
    if (normalize(e.path) === CONFIG && w.configUnreadable) throw new Error(`$.fs.read(${e.path}) failed: EIO`)
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

/** store 里的对话记录键（不含写入期标记） */
function recordKeys(x: W): string[] {
  return [...x.w.store.keys()].filter((k) => k.startsWith('s:'))
}

/** 等一个要靠时钟往前走才能做完的调用（读 store 失败后的重试在等 `$.clock.sleep`） */
async function ride<T>(clock: W['clock'], p: Promise<T>): Promise<T> {
  let done = false
  p.then(
    () => (done = true),
    () => (done = true),
  )
  for (let i = 0; i < 40 && !done; i++) await clock.advance(25)
  return p
}

/** 交接完成、续接回合开始后，模型照交接文件里的话又去登记：被连环交接守卫拒绝（这次的用量成为增量的基准） */
async function resumedAndRefused($: any, x: W): Promise<void> {
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
  w.tokens = 31_800
  x.writeHandoff()
  expect((await registerTool($, HANDOVER)).deny).toStartWith('Not registered: this conversation was continued from a handoff file')
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
  expect(recordKeys(x).sort()).toEqual([storeKey(NEW), storeKey(OLD)].sort())
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
  expect(recordKeys(x)).toEqual([storeKey(OLD)])
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
    'Configuration problems:',
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

test('a Remote Control message sent while the registered turn ran: Claude Code runs it before the queued /clear, in the old conversation, with a note; the new conversation is still resumed (1 clear, 1 resume)', async ($, on) => {
  // 2026-11-12 实例与 e2e 实测的顺序（CC 2.1.322）：回合结束 → turn.complete（自家 /clear 入队）→ 引擎取出早已在排队的消息
  // （prompt.submit 这时才到）→ 旧对话为它跑一个回合 → /clear 执行 → 新对话
  const x = world(on)
  const { w, clock } = x
  const cmd = await clearQueued($, x)
  w.tokens = 44_600
  await say($, 'While you are in there: does the cache key include the tenant id, or only the request path?', { kind: 'bridge' })
  const got = w.delivered.at(-1)!
  expect(got.context.length).toBe(1)
  expect(got.context[0]).toStartWith('[AutoHandoff] The handoff you registered is still in effect: when this turn ends, the conversation is reset with /clear')
  expect(got.context[0]).toEndWith(`Registered handoff file: "${HANDOVER}".`)
  expect(stored(x, OLD).job.stage).toBe('clearing')
  expect(w.toasts).toEqual([])
  // 旧对话里的这个回合：模型把要留给新对话的内容补进交接文件（登记后文件变了不影响已排队的重置），回合正常结束
  await turnStart($, T2)
  x.writeHandoff(HANDOVER, 7_310)
  w.tokens = 46_100
  expect((await tool($)).additionalContext).toBeUndefined()
  expect((await stop($)).block).toBeUndefined()
  await complete($, T2)
  await clock.settle()
  // 没有第二次重置；状态行一直是重置中
  expect(w.commands.length).toBe(1)
  expect(w.statuses.at(-1)).toBe('resetting the conversation (/clear)')
  // /clear 执行：promise 先 resolve，再到 SessionStart(clear)
  await $.session.end({ reason: 'clear', sessionId: OLD, resume: { id: OLD } })
  w.sid = NEW
  w.tokens = undefined
  cmd.resolve()
  await clock.settle()
  expect(w.submits.length).toBe(1)
  expect(w.submits[0]!.asUser).toBe(true)
  expect(w.submits[0]!.text).toStartWith('[AutoHandoff: resume] The context was just reset by AutoHandoff (/clear).')
  expect(w.submits[0]!.text).toContain(`Handoff file: "${HANDOVER}"`)
  await clock.advance(180)
  const ss = await $.classic.SessionStart({ source: 'clear', session_id: NEW })
  expect(ss.additionalContext?.length).toBe(1)
  expect(ss.additionalContext![0]).toContain(`Handoff file: "${HANDOVER}"`)
  await turnStart($, T3)
  w.submits[0]!.release()
  await clock.settle()
  expect(stored(x, NEW).job).toBeNull()
  // 新对话带连环交接守卫（人在旧对话里说过话不解除）
  expect(stored(x, NEW).resumed).toBe(true)
  expect(w.submits.length).toBe(1)
  expect(w.debug.filter((d) => d.startsWith('handoff cancelled'))).toEqual([])
  expect(w.debug).toContain('a user message arrived before the queued /clear (request 1); it is answered in this conversation, and the resume message follows the reset')
  expect(w.debug).toContain('handoff finished: resumed')
})

test('action compact with a message queued ahead of the /compact: answered before the compaction with the note; the compacted conversation gets the start context and the resume message', async ($, on) => {
  const x = world(on, { config: LOW_CONFIG.replace('action: clear', 'action: compact') })
  const { w, clock } = x
  await armedTurn($, x)
  await stop($)
  await complete($, T1)
  await clock.settle()
  expect(w.commands.map((c) => c.command)).toEqual(['compact'])
  await say($, 'Also keep the old cache keys readable for one release.', { kind: 'bridge' })
  expect(w.delivered.at(-1)!.context[0]).toContain('the conversation is reset with /compact and continued from the handoff file named below')
  await turnStart($, T2)
  await stop($)
  await complete($, T2)
  await clock.settle()
  expect(w.commands.length).toBe(1)
  // 压缩中途 SessionStart(compact)，压缩完 promise 才 resolve
  const ss = await $.classic.SessionStart({ source: 'compact', session_id: OLD })
  expect(ss.additionalContext![0]).toContain('(/compact)')
  w.commands[0]!.resolve()
  await clock.settle()
  expect(w.submits.length).toBe(1)
  expect(w.submits[0]!.text).toContain('(/compact)')
  expect(stored(x, OLD).job.stage).toBe('resuming')
})

test('a message that reaches the new conversation between SessionStart(clear) and the result of the /clear: answered there with nothing attached, and the resume message is still sent once', async ($, on) => {
  // 另一种事件顺序（用例 2）：SessionStart(clear) 先到、命令的 promise 后 resolve。这中间新对话里到了一条消息
  const x = world(on)
  const { w, clock } = x
  const cmd = await clearQueued($, x)
  await $.session.end({ reason: 'clear', sessionId: OLD, resume: { id: OLD } })
  w.sid = NEW
  w.tokens = undefined
  const ss = await $.classic.SessionStart({ source: 'clear', session_id: NEW })
  expect(ss.additionalContext![0]).toContain(`Handoff file: "${HANDOVER}"`)
  await say($, 'Before you go on: warm the cache from the staging bucket, not from production.', { kind: 'bridge' })
  // 重置已经发生：不说「马上要重置」，也不作废；续接还没发
  expect(w.delivered.at(-1)!.context).toEqual([])
  expect(stored(x, NEW).job.stage).toBe('clearing')
  expect(w.submits).toEqual([])
  expect(w.toasts).toEqual([])
  cmd.resolve()
  await clock.settle()
  // 结果回来：续接照常提交（新对话不会答完这一句就停在原地）
  expect(w.submits.length).toBe(1)
  expect(w.submits[0]!.asUser).toBe(true)
  expect(w.submits[0]!.text).toContain(`Handoff file: "${HANDOVER}"`)
  expect(stored(x, NEW).job.stage).toBe('resuming')
  await turnStart($, T2)
  w.submits[0]!.release()
  await clock.settle()
  expect(stored(x, NEW).job).toBeNull()
  expect(w.commands.length).toBe(1)
  expect(w.submits.length).toBe(1)
  expect(w.debug).toContain('a user message arrived after the reset, before the result of /clear (request 1); nothing attached')
  expect(w.debug).toContain('handoff finished: resumed')
  expect(w.debug.filter((d) => d.startsWith('handoff cancelled'))).toEqual([])
  // 守卫在续接时置位，比那条消息晚：模型马上又去登记会被拒，用户再发一句之后照常受理
  w.tokens = 31_800
  x.writeHandoff()
  expect((await registerTool($, HANDOVER)).deny).toStartWith('Not registered: this conversation was continued from a handoff file')
  await say($, 'That is all from me; hand off whenever the reminder asks.')
  expect((await registerTool($, HANDOVER)).result).toContain('Handoff registered')
})

test('the user\'s /clear typed during the registered turn, and a message answered in the conversation it opens: our queued /clear wipes that one, and the last conversation is resumed once', async ($, on) => {
  const x = world(on)
  const { w, clock } = x
  const cmd = await clearQueued($, x)
  // 用户的 /clear 先出队：OLD → MID，这个对话当场拿到交接
  const mid = await userClear($, w, MID)
  expect(mid.additionalContext![0]).toContain(`Handoff file: "${HANDOVER}"`)
  expect(w.toasts).toEqual([QUEUED_TOAST])
  // 排在自家 /clear 前面的消息在 MID 里得到一个回合：什么都不附，这期间不续接、不再发重置
  w.tokens = 9_400
  await say($, 'Which test file covers the eviction order?', { kind: 'bridge' })
  expect(w.delivered.at(-1)!.context).toEqual([])
  await turnStart($, T2)
  w.tokens = 13_700
  expect((await tool($)).additionalContext).toBeUndefined()
  expect((await stop($)).block).toBeUndefined()
  await complete($, T2)
  await clock.settle()
  expect(stored(x, MID).job.stage).toBe('clearing')
  expect(w.submits).toEqual([])
  expect(w.commands.length).toBe(1)
  // 自家的 /clear：MID → NEW，promise 先 resolve，再到 SessionStart(clear)
  await $.session.end({ reason: 'clear', sessionId: MID, resume: { id: MID } })
  w.sid = NEW
  w.tokens = undefined
  cmd.resolve()
  await clock.settle()
  expect(w.submits.length).toBe(1)
  expect(w.submits[0]!.text).toContain(`Handoff file: "${HANDOVER}"`)
  const ss = await $.classic.SessionStart({ source: 'clear', session_id: NEW })
  expect(ss.additionalContext![0]).toContain(`Handoff file: "${HANDOVER}"`)
  await turnStart($, T3)
  w.submits[0]!.release()
  await clock.settle()
  expect(stored(x, NEW).job).toBeNull()
  expect(stored(x, NEW).resumed).toBe(true)
  expect(w.submits.length).toBe(1)
  expect(w.commands.length).toBe(1)
  expect(w.debug).toContain('handoff finished: resumed')
  expect(w.debug.filter((d) => d.startsWith('handoff cancelled'))).toEqual([])
})

test('action compact, the user\'s /clear runs first and the user works a turn in the new conversation before the queued /compact runs: the compacted conversation still gets the start context and the resume message, once', async ($, on) => {
  const x = world(on, { config: LOW_CONFIG.replace('action: clear', 'action: compact') })
  const { w, clock } = x
  const cmd = await clearQueued($, x)
  expect(cmd.command).toBe('compact')
  const ss = await userClear($, w)
  expect(ss.additionalContext![0]).toContain(`Handoff file: "${HANDOVER}"`)
  // 用户在自己清出来的新对话里先说了一句，模型干了一个回合；自家的 /compact 还排着
  w.tokens = 8_200
  await say($, 'Start with the failing eviction test, then the rest of the handoff.')
  expect(w.delivered.at(-1)!.context).toEqual([])
  await turnStart($, T2)
  w.tokens = 12_600
  expect((await tool($)).additionalContext).toBeUndefined()
  expect((await stop($)).block).toBeUndefined()
  await complete($, T2)
  await clock.settle()
  expect(stored(x, NEW).job.stage).toBe('compacting')
  expect(w.submits).toEqual([])
  expect(w.commands.length).toBe(1)
  // 自家的 /compact 在这个对话上执行：SessionStart(compact) 再给一次交接，结果回来后续接一次
  w.tokens = undefined
  const sc = await $.classic.SessionStart({ source: 'compact', session_id: NEW })
  expect(sc.additionalContext![0]).toContain('(/compact)')
  cmd.resolve()
  await clock.settle()
  expect(w.submits.length).toBe(1)
  expect(w.submits[0]!.text).toContain('(/compact)')
  expect(w.submits[0]!.text).toContain(`Handoff file: "${HANDOVER}"`)
  await turnStart($, T3)
  w.submits[0]!.release()
  await clock.settle()
  expect(stored(x, NEW).job).toBeNull()
  expect(stored(x, NEW).resumed).toBe(true)
  expect(w.submits.length).toBe(1)
  expect(w.commands.length).toBe(1)
  expect(w.debug).toContain('a user message arrived after the reset, before the result of /compact (request 1); nothing attached')
  expect(w.debug).toContain('handoff finished: resumed')
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

test('action compact, and the turn that runs ahead of the queued /compact ends just before wait_minutes is up: the compaction is under way when the timer fires, and the handoff is not dropped', async ($, on) => {
  const x = world(on, { config: LOW_CONFIG.replace('action: clear', 'action: compact') })
  const { w, clock } = x
  await armedTurn($, x)
  await stop($)
  await complete($, T1)
  await clock.settle()
  expect(w.commands.map((c) => c.command)).toEqual(['compact'])
  // 回合结束前就在排队的消息让压缩前的对话又干了将近一小时（wait_minutes 是 60）
  await say($, 'Before you stop: does the cache survive a restart of the worker, or is it rebuilt?', { kind: 'bridge' })
  await turnStart($, T2)
  await clock.advance(59 * MIN + 50_000)
  w.tokens = 71_300
  await stop($)
  await complete($, T2)
  await clock.settle()
  // /compact 开始执行（十几秒）；发出时挂的 60 分钟计时在这期间到点
  await clock.advance(12_000)
  expect(stored(x, OLD).job.stage).toBe('compacting')
  expect(w.toasts).toEqual([])
  const ss = await $.classic.SessionStart({ source: 'compact', session_id: OLD })
  expect(ss.additionalContext![0]).toContain(`Handoff file: "${HANDOVER}"`)
  w.commands[0]!.resolve()
  await clock.settle()
  expect(w.submits.length).toBe(1)
  expect(w.submits[0]!.text).toContain(`Handoff file: "${HANDOVER}"`)
  expect(w.debug.filter((d) => d.startsWith('handoff cancelled'))).toEqual([])
})

test('a queued /clear whose result never comes back: after wait_minutes of an idle conversation it is set aside (toast, notification, the model told); when it runs after all, the new conversation is still resumed', async ($, on) => {
  const x = world(on)
  const { w, clock } = x
  const cmd = await clearQueued($, x)
  await clock.advance(60 * MIN)
  const said = 'AutoHandoff: the queued /clear did not run within 60 minutes and was set aside; if it still runs, the conversation continues from the handoff file.'
  expect(w.toasts).toEqual([said])
  expect(w.notifies).toEqual([said])
  expect(w.statuses.at(-1)).toBeUndefined()
  expect(stored(x, OLD).job).toBeNull()
  expect(stored(x, OLD).stalled.file).toBe(HANDOVER)
  await slash($, 'status')
  expect(w.logs).toContain(`An earlier /clear (request 1) was queued but has not run; if it still runs, the conversation continues from "${HANDOVER}".`)
  // 命令终究执行了：记录连同被搁置的重置搬到新 sid，照常续接并给交接；旧 sid 的记录里不再留着它
  await $.session.end({ reason: 'clear', sessionId: OLD, resume: { id: OLD } })
  w.sid = NEW
  w.tokens = undefined
  cmd.resolve()
  await clock.settle()
  expect(w.submits.length).toBe(1)
  expect(w.submits[0]!.text).toContain(`Handoff file: "${HANDOVER}"`)
  await clock.advance(180)
  const ss = await $.classic.SessionStart({ source: 'clear', session_id: NEW })
  expect(ss.additionalContext![0]).toContain(`Handoff file: "${HANDOVER}"`)
  expect(stored(x, NEW).job.stage).toBe('resuming')
  expect(stored(x, NEW).stalled).toBeNull()
  expect(stored(x, OLD).stalled).toBeNull()
  await turnStart($, T2)
  w.submits[0]!.release()
  await clock.settle()
  expect(stored(x, NEW).job).toBeNull()
})

test('a hot reload during the turn that runs ahead of the queued /clear, then Esc: the old module cannot report that the /clear was dropped, so the interrupted turn itself counts as the veto; the user\'s next messages are not told "still registered", and after a later reload-and-clear by the user nothing is resumed', async ($, on) => {
  const x = world(on)
  const { w, clock } = x
  await clearQueued($, x)
  await say($, 'Before you stop: does the cache survive a restart of the worker, or is it rebuilt?', { kind: 'bridge' })
  await turnStart($, T2)
  // 回合进行中插件更新、模块热重载；回合还在跑（工具调用照常）
  await start($)
  expect(stored(x, OLD).job.orphan).toBe(true)
  await clock.advance(5 * MIN)
  w.tokens = 47_800
  await tool($)
  // 用户按 Esc 打断这个回合：引擎把排队的 /clear 一起移出队列，旧模块的回调报不回来（这里不让它有结果）
  await complete($, T2, { isAborted: true, reason: 'aborted' })
  await clock.settle()
  // 当场按否决处理（不等空闲计时）：不再显示重置中，告诉用户；命令万一还在，留在 stalled 里的那份照常认领
  expect(w.toasts).toEqual(['AutoHandoff: handoff cancelled (the queued reset was called off by Esc)'])
  expect(w.statuses.at(-1)).toBe('paused until your next input (stopped with Esc)')
  expect(stored(x, OLD).job).toBeNull()
  expect(stored(x, OLD).stalled.orphan).toBe(true)
  // 用户接着说话：这条消息告诉模型登记已作废（不是「登记仍有效，回合结束就重置，不要开始新工作」），挂起也到此为止
  await say($, 'ok, go on with the refactor')
  expect(w.delivered.at(-1)!.context[0]).toContain('Your registered handoff was cancelled (the queued reset was called off by Esc)')
  expect(w.delivered.at(-1)!.context.join('\n')).not.toContain('still in effect')
  expect(w.statuses.at(-1)).toBeUndefined()
  // 过了一小时也没有第二次通知
  await clock.advance(61 * MIN)
  expect(w.toasts.length).toBe(1)
  // 又一次热重载之后用户自己 /clear：被搁置的那次已经丢掉，新对话不给交接、不续接
  await start($)
  const ss = await userClear($, w)
  await clock.settle()
  expect(ss.additionalContext).toBeUndefined()
  expect(w.submits).toEqual([])
  expect(stored(x, NEW).stalled).toBeNull()
})

test('a hot reload while the /clear is queued, the command is then lost without a word (the old module cannot report it), and the user keeps working in the conversation: the idle minutes between turns add up to wait_minutes, so it is not held in "resetting" for as long as the user stays', async ($, on) => {
  const x = world(on)
  const { w, clock } = x
  await clearQueued($, x)
  // 插件更新、模块热重载；排队的 /clear 之后没有执行，也没有任何结果回来（这里不让它有结果）
  await start($)
  expect(stored(x, OLD).job.orphan).toBe(true)
  // 用户每隔九分钟发一条消息，每个回合一分钟：两次输入的间隔从不到 wait_minutes
  const round = async (text: string, turnId: string): Promise<readonly string[]> => {
    await clock.advance(9 * MIN)
    await say($, text)
    const context = w.delivered.at(-1)!.context
    await turnStart($, turnId)
    await tool($)
    await clock.advance(1 * MIN)
    await stop($)
    await complete($, turnId)
    await clock.settle()
    return context
  }
  const asks = [
    'Does the cache survive a restart of the worker?',
    'Which tests cover the eviction path?',
    'Show me the diff of src/cache.py once more.',
    'Is the tenant id part of the cache key?',
    'What is still failing in tests/test_cache.py?',
    'Rename CacheEntry.ttl to ttl_seconds everywhere.',
  ]
  for (const [i, text] of asks.entries()) {
    const context = await round(text, `turn-${i}`)
    // 这段时间消息仍被告知「登记仍有效」：命令还在不在，新模块无从知道
    expect(context[0]).toContain('The handoff you registered is still in effect')
    expect(stored(x, OLD).job.stage).toBe('clearing')
  }
  expect(w.toasts).toEqual([])
  // 回合之间的空闲累计到 60 分钟（6 × 9 分钟之后再过 6 分钟）：搁置，状态行清掉，告诉用户；下一条消息告诉模型，不再说「登记仍有效」
  const context = await round('And update the docstring of get().', 'turn-last')
  expect(w.toasts).toEqual(['AutoHandoff: the queued /clear did not run within 60 minutes and was set aside; if it still runs, the conversation continues from the handoff file.'])
  expect(stored(x, OLD).job).toBeNull()
  expect(stored(x, OLD).stalled.orphan).toBe(true)
  expect(context[0]).toContain('Your registered handoff was cancelled (the queued reset did not run within 60 minutes)')
  expect(w.statuses.at(-1)).toBeUndefined()
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
  // 模型已经停下等重置：没人在场时 toast 一闪就没了，所以另有通知
  expect(w.notifies).toEqual(w.toasts)
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
  expect(w.notifies).toEqual(w.toasts)
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
  // 续接回合：交接文件里写着「继续交接」，模型一上来就去登记（这次登记的用量就是增量的基准）
  w.tokens = 31_800
  x.writeHandoff()
  const r = await registerTool($, HANDOVER)
  expect(r.deny).toBe(
    'Not registered: this conversation was continued from a handoff file less than a minute ago and its context has grown only 0k since (31k now). ' +
      'Carry on with the work the handoff file describes, and hand off only when an AutoHandoff reminder asks for it or the user\'s or the project\'s instructions call for ending this conversation and continuing in a new one (updating a handover or notes document such as HANDOVER.md does not count). Registering works again once the context has grown by about 20k since the resume, passes 40k, or the user or another Claude session sends a message.',
  )
  expect(stored(x, NEW).job).toBeNull()
  expect(stored(x, NEW).resumedTokens).toBe(31_800)
  await stop($)
  await complete($, T2)
  await clock.settle()
  expect(w.commands.length).toBe(1)
  // 用户能在 /autohandoff status 里看到登记暂不受理和增量（查看状态不算发话，不解除）
  await slash($, 'status')
  expect(w.logs).toContain(
    'Just continued from a handoff file less than a minute ago: a new handoff is not accepted until context has grown by 20k since the resume (from 31k, 0k so far), passes 40k, or a message arrives from you or another Claude session, or you type a command (this stops a reset loop).',
  )
  expect((await registerTool($, HANDOVER)).deny).toStartWith('Not registered: this conversation was continued from a handoff file')
  // 用户发话之后（比如要求交接）照常受理
  await say($, 'please hand off now, I need to restart the machine')
  expect((await registerTool($, HANDOVER)).result).toContain('Handoff registered')
})

test('chain guard: a command the user types (/autohandoff on) lifts it like a message; /autohandoff status and commands from the SDK host do not', async ($, on) => {
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
  w.tokens = 33_200
  await tool($)
  await stop($)
  await complete($, T2)
  expect([stored(x, NEW).resumed, stored(x, NEW).resumedTokens]).toEqual([true, 33_200])
  // SDK 主机发来的命令（不是人敲的）、查看状态：不解除
  await $.command.run({ command: 'model', args: 'sonnet', origin: { kind: 'sdk' }, presentation: PRESENTATION })
  await $.command.run({ command: COMMAND_NAME, args: 'on', origin: { kind: 'sdk' }, presentation: PRESENTATION })
  await slash($, 'status')
  expect(stored(x, NEW).resumed).toBe(true)
  // 用户亲手敲 /autohandoff on（本来就开着）：人在场，解除
  await slash($, 'on')
  expect([stored(x, NEW).resumed, stored(x, NEW).resumedAt, stored(x, NEW).resumedTokens]).toEqual([false, null, null])
  x.writeHandoff()
  expect((await registerTool($, HANDOVER)).result).toContain('Handoff registered')
})

test('chain guard, driven by another session: the resumed conversation gets only agent messages for hours and hands off on its own once its context has grown by resume_guard_tokens', async ($, on) => {
  // 主人的设置：remind_at 400k、默认的 resume_guard_tokens（100k）；全局规则是约 300k 主动交接
  const config = LOW_CONFIG.replace('remind_at: 40000', 'remind_at: 400000')
    .replace('urge_at: 90000', 'urge_at: 450000')
    .replace('compact_at: 300000', 'compact_at: 650000')
    .replace('resume_guard_tokens: 20000', 'resume_guard_tokens: 100000')
  const x = world(on, { config })
  const { w, clock } = x
  const PEER = { kind: 'peer-send-message' }
  const T3 = '8c2f4e61-9b0d-4a3c-b5e7-0d1f2a3b4c5d'
  const T4 = 'e1d2c3b4-a596-4877-8a9b-0c1d2e3f4a5b'
  // 上一段对话：还没到提醒（remind_at 400k），约 300k 时用户要求交接
  await start($)
  w.tokens = 288_000
  await say($, 'Batch 4 is merged. Hand off now, the context is getting long.')
  await turnStart($, T1)
  w.tokens = 301_500
  expect((await tool($)).additionalContext).toBeUndefined()
  x.writeHandoff()
  expect((await registerTool($, HANDOVER)).result).toContain('Handoff registered')
  await stop($)
  await complete($, T1)
  await clock.settle()
  // 重置、续接
  await $.session.end({ reason: 'clear', sessionId: OLD, resume: { id: OLD } })
  w.sid = NEW
  w.tokens = undefined
  w.commands[0]!.resolve()
  await clock.settle()
  await $.classic.SessionStart({ source: 'clear', session_id: NEW })
  await turnStart($, T2)
  w.submits[0]!.release()
  await clock.settle()
  expect(stored(x, NEW).resumedTokens).toBeNull()
  // 续接回合读交接文件：第一次响应之后的 PostToolUse 给出基准
  w.tokens = 38_400
  await tool($)
  expect(stored(x, NEW).resumedTokens).toBe(38_400)
  await stop($)
  await complete($, T2)
  // 编排会话派来的活（会话间消息），这个对话里没人打字
  await clock.advance(60 * MIN)
  await say($, 'Batch 5: port the cache tests to the new fixture layout.', PEER)
  await turnStart($, T3)
  w.tokens = 97_500
  await tool($)
  await clock.advance(47 * MIN)
  w.tokens = 121_300
  x.writeHandoff()
  const early = await registerTool($, HANDOVER)
  expect(early.deny).toBe(
    'Not registered: this conversation was continued from a handoff file 107 minutes ago and its context has grown only 82k since (121k now). ' +
      'Carry on with the work the handoff file describes, and hand off only when an AutoHandoff reminder asks for it or the user\'s or the project\'s instructions call for ending this conversation and continuing in a new one (updating a handover or notes document such as HANDOVER.md does not count). Registering works again once the context has grown by about 100k since the resume, passes 400k, or the user or another Claude session sends a message.',
  )
  await stop($)
  await complete($, T3)
  await clock.advance(2 * 60 * MIN)
  await say($, 'Batch 6: wire the new fixtures into CI.', PEER)
  await turnStart($, T4)
  w.tokens = 138_400
  await tool($)
  expect(stored(x, NEW).resumed).toBe(false)
  expect(stored(x, NEW).resumedTokens).toBeNull()
  // 约 300k 按工程规则主动交接：受理，回合结束后重置
  w.tokens = 296_000
  await tool($)
  x.writeHandoff()
  expect((await registerTool($, HANDOVER)).result).toContain('Handoff registered')
  await stop($)
  await complete($, T4)
  await clock.settle()
  expect(w.commands.map((c) => c.command)).toEqual(['clear', 'clear'])
  expect(w.toasts).toEqual([])
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

// ───────── 4.3.0 ─────────

test('the store unreadable when the turn ends: read again twice, then the event is skipped; the user is told once (toast and notification) and the registration stays for the next message', async ($, on) => {
  const x = world(on)
  const { w, clock } = x
  await armedTurn($, x)
  await stop($)
  // 另一个进程把 store 文件写坏了、或锁一直拿不到：这一步读不到记录，不知道有没有登记
  w.storeReadFails = Infinity
  w.storeGets = 0
  await ride(clock, complete($, T1))
  await clock.settle()
  expect(w.storeGets).toBe(3)
  expect(w.commands).toEqual([])
  expect(w.toasts.length).toBe(1)
  expect(w.toasts[0]).toStartWith('AutoHandoff could not read its saved state (')
  expect(w.toasts[0]).toEndWith('); a handoff registered in this conversation may not run until this clears.')
  expect(w.notifies).toEqual(w.toasts)
  // 还读不了的时候，后面的事件不再重复提示
  await ride(clock, say($, 'Background command "pytest -q" completed (exit code 0).', { kind: 'task-notification' }))
  expect(w.toasts.length).toBe(1)
  // 读得了之后：登记原样还在，下一条人工消息照常作废它并告诉模型
  w.storeReadFails = 0
  expect(stored(x, OLD).job.stage).toBe('armed')
  await say($, 'what happened?')
  expect(w.delivered.at(-1)!.context[0]).toContain('Your registered handoff was cancelled (a new message from the user arrived)')
  // 以后再读不了，会再说一次
  w.storeReadFails = Infinity
  await ride(clock, turnStart($, T2))
  expect(w.toasts.filter((t) => t.startsWith('AutoHandoff could not read its saved state')).length).toBe(2)
})

test('the store unreadable just as the queued /clear finishes: the result is delivered again a moment later, and the new conversation still gets its resume message', async ($, on) => {
  const x = world(on)
  const { w, clock } = x
  const cmd = await clearQueued($, x)
  await $.session.end({ reason: 'clear', sessionId: OLD, resume: { id: OLD } })
  w.sid = NEW
  w.tokens = undefined
  // /clear 做完的那一刻另一个进程正占着 store：命令的结果送进来，三次读都失败。这个结果只来一次
  w.storeReadFails = 3
  w.storeGets = 0
  cmd.resolve()
  await clock.settle()
  // 约 180 ms 后的 SessionStart(clear) 排在它后面，轮到时已经读得到：记录搬到新对话，交接随 start_context 给出
  await clock.advance(180)
  const ss = await ride(clock, $.classic.SessionStart({ source: 'clear', session_id: NEW }))
  expect(ss.additionalContext![0]).toContain(`Handoff file: "${HANDOVER}"`)
  expect(w.debug.filter((d) => d.startsWith('event skipped: the saved state could not be read')).length).toBe(1)
  expect(stored(x, NEW).job.stage).toBe('clearing')
  expect(w.submits).toEqual([])
  // 结果隔半秒再送一次：这次读到了，续接照发，守卫置位——新对话没有停在原地
  await clock.advance(500)
  expect(w.submits.length).toBe(1)
  expect(w.submits[0]!.text).toContain(`Handoff file: "${HANDOVER}"`)
  expect(stored(x, NEW).job.stage).toBe('resuming')
  expect(stored(x, NEW).resumed).toBe(true)
  await turnStart($, T2)
  w.submits[0]!.release()
  await clock.settle()
  expect(stored(x, NEW).job).toBeNull()
  expect(w.debug).toContain('handoff finished: resumed')
  // 读失败只说了一次，没有别的提示
  expect(w.toasts.length).toBe(1)
  expect(w.toasts[0]).toStartWith('AutoHandoff could not read its saved state (')
  expect(w.notifies).toEqual(w.toasts)
})

test('the store unreadable for the whole ten seconds after the queued /clear ran: the result is delivered five times and then given up; the user was told once, and the new conversation takes messages as a plain one', async ($, on) => {
  const x = world(on)
  const { w, clock } = x
  const cmd = await clearQueued($, x)
  await $.session.end({ reason: 'clear', sessionId: OLD, resume: { id: OLD } })
  w.sid = NEW
  w.tokens = undefined
  // store 文件坏了一阵子（另一个进程写到一半被杀）：结果怎么送都读不出记录
  w.storeReadFails = Infinity
  w.storeGets = 0
  cmd.resolve()
  await clock.settle()
  await clock.advance(180)
  const ss = await ride(clock, $.classic.SessionStart({ source: 'clear', session_id: NEW }))
  expect(ss.additionalContext).toBeUndefined()
  await clock.advance(20_000)
  // 结果送了 5 次（每次读 3 回），SessionStart(clear) 读了 3 回
  expect(w.storeGets).toBe(18)
  expect(w.submits).toEqual([])
  expect(w.toasts.length).toBe(1)
  expect(w.toasts[0]).toStartWith('AutoHandoff could not read its saved state (')
  expect(w.notifies).toEqual(w.toasts)
  // 之后 store 好了：新对话里用户的消息照常送到，什么都不附；交接文件还在原处，由用户让模型去读
  w.storeReadFails = 0
  w.tokens = 30_500
  await say($, 'The conversation was cleared but nothing came after it. Where were we?')
  expect(w.delivered.at(-1)!.context).toEqual([])
  expect(w.submits).toEqual([])
})

test('the wait_minutes timer firing while the store is unreadable for a moment: the tick is delivered again, and the queued /clear that never ran is still set aside with its toast and notification', async ($, on) => {
  const x = world(on)
  const { w, clock } = x
  await clearQueued($, x)
  await clock.advance(60 * MIN - 1)
  expect(w.toasts).toEqual([])
  // 定时器到点的那半秒 store 读不出来：登记时和回合结束时各挂的一个定时器都到点，各自重试完都没读到；到点的 tick 不会再来第二次
  w.storeReadFails = Infinity
  await clock.advance(1 + 500)
  expect(stored(x, OLD).job.stage).toBe('clearing')
  // 隔半秒再送时已经读得到
  w.storeReadFails = 0
  await clock.advance(500)
  const said = 'AutoHandoff: the queued /clear did not run within 60 minutes and was set aside; if it still runs, the conversation continues from the handoff file.'
  expect(w.toasts.filter((t) => t === said).length).toBe(1)
  expect(w.notifies.filter((t) => t === said).length).toBe(1)
  expect(stored(x, OLD).job).toBeNull()
  expect(stored(x, OLD).stalled.file).toBe(HANDOVER)
})

test('the store unreadable for a moment when the turn ends (another process is writing): the second read succeeds and the /clear is issued as usual', async ($, on) => {
  const x = world(on)
  const { w, clock } = x
  await armedTurn($, x)
  await stop($)
  w.storeReadFails = 1
  await ride(clock, complete($, T1))
  await clock.settle()
  expect(w.commands.map((c) => c.command)).toEqual(['clear'])
  expect(stored(x, OLD).job.stage).toBe('clearing')
  expect(w.toasts).toEqual([])
  expect(w.notifies).toEqual([])
})

test('a mistyped value in the configuration file is announced with a toast once, not silently replaced by the default; a different mistake later is announced again', async ($, on) => {
  const x = world(on)
  const { w } = x
  await start($)
  w.tokens = 36_500
  await say($, 'Refactor src/cache.py and keep the tests green.')
  expect(w.toasts).toEqual([])
  // 用户改配置时把 true 打错了：default_on 回落成 false，开着的对话就此关掉——要让他当场知道
  w.config = LOW_CONFIG.replace('default_on: true', 'default_on: ture')
  await turnStart($, T1)
  expect(w.toasts).toEqual(['AutoHandoff configuration: default_on should be true or false, got "ture"; using the default (false). /autohandoff status lists the details.'])
  w.tokens = 41_200
  expect((await tool($)).additionalContext).toBeUndefined()
  await tool($)
  expect(w.toasts.length).toBe(1)
  // 改对了：不再提，提醒恢复
  w.config = LOW_CONFIG
  expect((await tool($)).additionalContext?.length).toBe(1)
  expect(w.toasts.length).toBe(1)
  // 又写错两处（阈值写成 40k 之后三个阈值的顺序也不对了）：再说一次，带上还有几条
  w.config = LOW_CONFIG.replace('remind_at: 40000', 'remind_at: 40k').replace('action: clear', 'action: wipe')
  await tool($)
  expect(w.toasts.length).toBe(2)
  expect(w.toasts[1]).toBe(
    'AutoHandoff configuration: remind_at should be a whole number, got "40k"; using the default (300000) (and 2 more). /autohandoff status lists the details.',
  )
  await slash($, 'status')
  expect(w.toasts.length).toBe(2)
  expect(w.logs).toContain('  - action should be one of clear, compact, got "wipe"; using the default (clear)')
})

test('a configuration file that only sets two thresholds (other keys left out, resume_guard_tokens above remind_at) is not a mistake: no toast, listed in status only', async ($, on) => {
  const x = world(on, { config: '## settings\nremind_at: 40000\nurge_at: 90000\n' })
  const { w } = x
  await start($)
  await say($, 'hello')
  await slash($, 'status')
  expect(w.toasts).toEqual([])
  expect(w.logs.some((l) => l.startsWith('  - missing settings (built-in defaults used): default_on, compact_at'))).toBe(true)
  expect(w.logs.some((l) => l.startsWith('  - resume_guard_tokens (100000) is not below remind_at (40000), so it has no effect; treated as 0'))).toBe(true)
})

test('the configuration file unreadable when the turn ends (a read error): the configuration read last is kept, so AutoHandoff stays on and the registered handoff still resets; the user is told once', async ($, on) => {
  const x = world(on)
  const { w, clock } = x
  await armedTurn($, x)
  // default_on: true 写在配置里；这时回落内置默认（false）的话，这个对话就成了关的，登记在回合结束时被悄悄作废
  w.configUnreadable = true
  await stop($)
  await complete($, T1)
  await clock.settle()
  expect(w.commands.map((c) => c.command)).toEqual(['clear'])
  expect(w.toasts.length).toBe(1)
  expect(w.toasts[0]).toStartWith(`AutoHandoff configuration: could not read ${CONFIG} (`)
  expect(w.toasts[0]).toEndWith('); the configuration read last is kept. /autohandoff status lists the details.')
  // 阈值也还是用户写的 40k，不是默认的 300k
  await slash($, 'status')
  expect(w.logs.some((l) => l.includes('Reminders at 40k and 90k, compaction at 300k'))).toBe(true)
  expect(w.toasts.length).toBe(1)
  // 读得了之后问题消失
  w.configUnreadable = false
  await slash($, 'status')
  expect(w.logs.at(-1)).toBe(`Configuration: ${CONFIG}`)
})

test('a configuration file on a share that reads only now and then: the read error is announced once and the mistake in the file once, however often it flips; a new mistake is still announced', async ($, on) => {
  const x = world(on, { config: LOW_CONFIG.replace('action: clear', 'action: wipe') })
  const { w } = x
  const MISTAKE = 'AutoHandoff configuration: action should be one of clear, compact, got "wipe"; using the default (clear). /autohandoff status lists the details.'
  await start($)
  w.tokens = 36_500
  await say($, 'Refactor src/cache.py and keep the tests green.')
  expect(w.toasts).toEqual([MISTAKE])
  await turnStart($, T1)
  // 文件读不出来了：说一次读不了；沿用的那份配置里的写错不再重复
  w.configUnreadable = true
  await tool($)
  expect(w.toasts.length).toBe(2)
  expect(w.toasts[1]).toStartWith(`AutoHandoff configuration: could not read ${CONFIG} (`)
  expect(w.toasts[1]).toEndWith('); the configuration read last is kept. /autohandoff status lists the details.')
  // 之后读得到、读不到来回翻转：一个 toast 都不再弹
  for (let i = 0; i < 4; i++) {
    w.configUnreadable = i % 2 === 1
    await tool($)
    await slash($, 'status')
  }
  expect(w.toasts.length).toBe(2)
  // 两样都还在 status 里
  w.configUnreadable = true
  await slash($, 'status')
  expect(w.logs.some((l) => l.startsWith(`  - could not read ${CONFIG} (`))).toBe(true)
  expect(w.logs).toContain('  - action should be one of clear, compact, got "wipe"; using the default (clear)')
  // 读得到的时候用户又写错一处：只说新的这一处
  w.configUnreadable = false
  w.config = w.config!.replace('urge_block: true', 'urge_block: yes')
  await tool($)
  expect(w.toasts.length).toBe(3)
  expect(w.toasts[2]).toBe('AutoHandoff configuration: urge_block should be true or false, got "yes"; using the default (true). /autohandoff status lists the details.')
  // 把 action 改对了，过后又写错：消失后再出现的要再说
  w.config = w.config!.replace('action: wipe', 'action: clear')
  await tool($)
  expect(w.toasts.length).toBe(3)
  w.config = w.config!.replace('action: clear', 'action: wipe')
  await tool($)
  expect(w.toasts.length).toBe(4)
  expect(w.toasts[3]).toBe(MISTAKE)
})

test('session start drops records not written for 30 days by reading the key names once; no record is read for it, and every record written carries a write mark', async ($, on) => {
  const x = world(on)
  const { w, clock } = x
  const DAY = 24 * 60 * MIN
  const sid = (i: number): string => `${String(i).padStart(8, '0')}-3a4d-4e5f-9a0b-1c2d3e4f5a6b`
  // 一个用了几个月的 store：60 个对话在一个多月前最后写过，200 个最近两周还在用，3 个的记录没有标记
  for (let i = 0; i < 263; i++) {
    const at = NOW - (i < 60 ? 41 + (i % 20) : i % 14) * DAY
    w.store.set(storeKey(sid(i)), JSON.stringify({ ...newRecord(at), on: i % 3 === 0 ? true : null, human: true }))
    if (i < 260) w.store.set(markKey(sid(i), at), '1')
  }
  await start($)
  // 启动只为本会话自己的记录读了一次 store，不随键数增加
  expect(w.storeGets).toBe(1)
  const left = recordKeys(x)
  expect(left.length).toBe(203)
  expect(left.includes(storeKey(sid(0)))).toBe(false)
  expect(left.includes(storeKey(sid(59)))).toBe(false)
  expect(left.includes(storeKey(sid(60)))).toBe(true)
  expect(left.includes(storeKey(sid(262)))).toBe(true)
  // 删掉的对话的标记也没了；3 份没有标记的记录各补了一个这一期的标记，没有删
  expect([...w.store.keys()].filter((k) => k.startsWith('t:')).length).toBe(203)
  for (const i of [260, 261, 262]) expect(w.store.has(markKey(sid(i), NOW))).toBe(true)
  // 本会话写下记录时带上这一期的标记
  await say($, 'Refactor src/cache.py and keep the tests green.')
  expect(w.store.has(storeKey(OLD))).toBe(true)
  expect(w.store.has(markKey(OLD, NOW))).toBe(true)
  // 补了标记的那 3 份从这时起算：四周后的启动还留着，六周后的启动删掉，连同补的标记
  await clock.advance(28 * DAY)
  await start($)
  expect(recordKeys(x).includes(storeKey(sid(262)))).toBe(true)
  await clock.advance(14 * DAY)
  await start($)
  for (const i of [260, 261, 262]) {
    expect(w.store.has(storeKey(sid(i)))).toBe(false)
    expect(w.store.has(markKey(sid(i), NOW))).toBe(false)
  }
})

test('a write mark that could not be saved while the record was (the store was busy), in a conversation that never writes again: the next session start gives the record a mark, and it is dropped 30 to 40 days later like any other', async ($, on) => {
  const x = world(on)
  const { w, clock } = x
  const DAY = 24 * 60 * MIN
  const marks = (): string[] => [...w.store.keys()].filter((k) => k.startsWith('t:'))
  await start($)
  // 这个对话第一次写记录时标记没写进（另一个进程占着 store），记录写进了；之后用户关了终端，它再没写过
  w.markFails = true
  await say($, 'Refactor src/cache.py and keep the tests green.')
  w.markFails = false
  expect(w.store.has(storeKey(OLD))).toBe(true)
  expect(marks()).toEqual([])
  expect(w.debug.some((d) => d.startsWith(`could not save the write mark of session ${OLD}: `))).toBe(true)
  await $.session.end({ reason: 'other', sessionId: OLD, resume: { id: OLD } })
  // 第二天在同一个工程里开了新会话：那份记录没有被读，补上了当天这一期的标记
  await clock.advance(DAY)
  w.sid = NEW
  w.storeGets = 0
  await start($)
  expect(w.storeGets).toBe(1)
  expect(marks()).toEqual([markKey(OLD, NOW + DAY)])
  expect(w.store.has(storeKey(OLD))).toBe(true)
  // 再启动不重复补；四周后还在（用户 --resume 回去照样找得到它的开关）
  await clock.advance(28 * DAY)
  await start($)
  expect(marks()).toEqual([markKey(OLD, NOW + DAY)])
  expect(w.store.has(storeKey(OLD))).toBe(true)
  // 六周后的启动把它和标记一起删掉
  await clock.advance(14 * DAY)
  await start($)
  expect(w.store.has(storeKey(OLD))).toBe(false)
  expect(marks()).toEqual([])
})

test('chain guard: a message another session delivers to the main conversation lifts it; a report from one of this session\'s own subagents, a task notification, a delivery for an agent and the agent-team mailbox do not', async ($, on) => {
  const x = world(on)
  const { w } = x
  await resumedAndRefused($, x)
  const PEER = { kind: 'peer' }
  const refused = async (): Promise<void> => {
    expect((await registerTool($, HANDOVER)).deny).toStartWith('Not registered: this conversation was continued from a handoff file')
  }
  // 后台子代理的最终汇报：prompt.submit 的来源也是 peer，但它不经过 session.receive
  await say($, 'The reviewer agent has finished: two minor findings in src/cache.py, no blockers.', PEER)
  await refused()
  // 后台命令结束的通知
  await say($, 'Background command "pytest -q" completed (exit code 0).', { kind: 'task-notification' })
  await refused()
  // 别的会话发给本会话某个子代理的消息、agent team 信箱里 teammate 的消息
  await $.session.receive({ origin: PEER, text: 'ping for the worker agent', agentId: AGENT })
  await $.session.receive({ origin: { kind: 'peer', teammate: 'researcher', isVerified: true }, text: 'notes from the researcher' })
  await refused()
  expect(stored(x, NEW).resumed).toBe(true)
  // 协调会话发来消息：先是 session.receive（投给主对话，没有 agentId），之后才是它的 prompt.submit
  const text = 'Message from the coordinating session: the release is cut at 18:00, wrap up and hand off once the tests pass.'
  await $.session.receive({ origin: PEER, text })
  expect(w.debug).toContain('delivery: origin peer')
  expect(w.debug).toContain('a message from another session arrived (peer); a handoff can be registered again')
  expect(stored(x, NEW).resumed).toBe(false)
  await say($, text, PEER)
  expect((await registerTool($, HANDOVER)).result).toContain('Handoff registered')
})

test('chain guard: a message the user sends through a channel (Telegram) lifts it like a typed one', async ($, on) => {
  const x = world(on)
  await resumedAndRefused($, x)
  await say($, 'how far along are you? hand off now if the migration is done', { kind: 'channel', server: 'plugin:telegram:telegram' })
  expect(stored(x, NEW).resumed).toBe(false)
  expect((await registerTool($, HANDOVER)).result).toContain('Handoff registered')
})

test('default_on in a session nobody has typed in: a scheduled prompt does not switch AutoHandoff on, the first channel message (Telegram) does, and the reminder, registration and reset then work as usual', async ($, on) => {
  const x = world(on)
  const { w, clock } = x
  const TG = { kind: 'channel', server: 'plugin:telegram:telegram' }
  await start($)
  // 定时任务先开了一个回合，越过了 remind_at：没人发过话，default_on 还没生效，不提醒
  w.tokens = 36_500
  await say($, 'Nightly check: list the failing tests.', { kind: 'scheduled-trigger' })
  await turnStart($, T1)
  w.tokens = 41_200
  expect((await tool($)).additionalContext).toBeUndefined()
  expect((await stop($)).block).toBeUndefined()
  await complete($, T1)
  await clock.settle()
  expect(stored(x, OLD).human).toBe(false)
  // 用户从 Telegram 发来第一句话：从这条消息起生效，已越线，完整提醒随它送到
  await say($, 'Fix the two cache tests that failed last night and tell me when they pass.', TG)
  expect(stored(x, OLD).human).toBe(true)
  expect(w.delivered.at(-1)!.context.length).toBe(1)
  expect(w.delivered.at(-1)!.context[0]).toContain('past the first threshold of 40k')
  await turnStart($, T2)
  x.writeHandoff()
  w.tokens = 43_900
  expect((await registerTool($, HANDOVER)).result).toContain('Handoff registered')
  await stop($)
  await complete($, T2)
  await clock.settle()
  expect(w.commands.map((c) => c.command)).toEqual(['clear'])
})
