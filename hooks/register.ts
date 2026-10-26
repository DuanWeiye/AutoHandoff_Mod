// AutoHandoff 4.0 的 hooks 模块入口：事件接线（薄层）。
// 每个 hook 只做三件事：读事件与 `$` 的结果 → 调 core.transition → 先写 store、再执行副作用。
// 判断都在 core.ts；这里不做业务判断，只负责：
//   - 只把主对话的事件送进 core（agentId / agent_id 有值的一律不送）
//   - 按 session id 找记录；/clear 换 sid 时把记录搬到新 sid（两种先后顺序都对）
//   - 副作用里的 clear/compact/resume 带回调序号，promise 的结果原样带 seq 回送
//   - 任何内部错误一律 catch、放行、记 debug log，绝不影响会话
import type { EngineInterface, Register } from 'claude-code'
import {
  COMMAND_NAME,
  MIN_VERSION,
  TOOL_FULL_NAME,
  TOOL_NAME,
  checkHandoffStat,
  checkPathText,
  checkStillThere,
  configDir,
  configFilePath,
  defaultConfigText,
  estimateReadTokens,
  homeDir,
  isAbsolutePath,
  jobKey,
  isExpired,
  loadRecord,
  looksWindows,
  migrateRecord,
  newRecord,
  parseConfig,
  storeKey,
  toAbsolute,
  transition,
  usableRoots,
  versionAtLeast,
  type Effect,
  type Ev,
  type Job,
  type ParsedConfig,
  type Rec,
  type StatLike,
  type Step,
  type Verdict,
} from './core.js'

type Api = EngineInterface

// `$.state` 里本插件的值（宿主按会话保存：热重载保留，进程重启后是空的）；类型声明在 types/autohandoff.d.ts
const QUEUED_REF = { plugin: 'autohandoff', key: 'queued' } as const
const QUEUED_KEEP = 20

// ───────────────────────── 模块状态（热重载会丢，都只是缓存或辅助） ─────────────────────────

/** 本模块实例是否工作：版本够、是交互会话。session.start 时重算。 */
let gate: { on: boolean; why: string } | null = null
/** session.start 给的 isInteractive；之前到达的事件（teammate 的 session.receive）用 surfaces 推断 */
let interactive: boolean | undefined
let lowVersionWarned = false
/**
 * 最近一次 /clear 换掉的 sid（session.end(clear) 时记下）。新 sid 下还没有记录时据此把旧记录搬过来。
 * 只放模块变量：session.end(clear) 总在 SessionStart(clear) 和自家 clear 的 resolve 之前，热重载后新模块的 session.end 照样会记。
 */
let clearingFrom: { sid: string; t: number } | null = null
/** AUTOHANDOFF_CONFIG 是相对路径的提示已记过 */
let relativeConfigWarned = false
/** 记录的读-改-写串行执行（`$.store` 的 get/set 不是原子的；同一进程里的事件会交错） */
let chain: Promise<unknown> = Promise.resolve()

/** clearingFrom 多久内有效（实测 session.end(clear) 之后几百毫秒内就到 SessionStart(clear) 和 resolve） */
const CLEAR_LINK_MS = 2 * 60 * 1000
const TOAST_MS = 12_000

// 登记工具的说明（模型读）。路径规则与 core.checkPathText / checkHandoffStat 一致。
const TOOL_DESCRIPTION =
  'AutoHandoff: register the handoff file you have just written, so that when this turn ends the conversation is reset ' +
  '(/clear or /compact, as configured) and continued from that file. Call it only after an AutoHandoff reminder asked you to ' +
  'hand off and the file is written; only the main conversation can register (subagents and forks are refused). ' +
  'Then end your turn at once. The file must be inside the project folder (the working directory, the folder Claude Code ' +
  'was started in, or the git repository root) or the Claude Code auto-memory folder (<config dir>/projects/<project>/memory/), ' +
  'non-empty and just modified; its path is absolute or relative to the working directory, with no quotes, tabs, ' +
  'control characters, leading or trailing spaces, or "~".'

const TOOL_SCHEMA = {
  type: 'object',
  properties: {
    file: { type: 'string', description: 'Path of the handoff file (absolute, or relative to the working directory)' },
  },
  required: ['file'],
}

// ───────────────────────── 小工具 ─────────────────────────

function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn)
  chain = run.catch(() => undefined)
  return run
}

function errText(err: unknown): string {
  if (err && typeof err === 'object' && 'message' in err) return String((err as { message: unknown }).message)
  return String(err)
}

function debug($: Api, text: string): void {
  try {
    $.ui.log(text, { to: 'debug' })
  } catch {
    // 连日志都写不了就算了
  }
}

function fail($: Api, where: string, err: unknown): void {
  debug($, `internal error in ${where}: ${errText(err)}`)
}

async function safely<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn()
  } catch {
    return undefined
  }
}

interface EnvVars {
  CLAUDE_CONFIG_DIR?: string
  HOME?: string
  USERPROFILE?: string
}

async function envVars($: Api): Promise<EnvVars> {
  return {
    CLAUDE_CONFIG_DIR: await $.env.get('CLAUDE_CONFIG_DIR'),
    HOME: await $.env.get('HOME'),
    USERPROFILE: await $.env.get('USERPROFILE'),
  }
}

async function realPathOf($: Api, p: string | undefined): Promise<string | undefined> {
  if (!p) return undefined
  const st = await safely(() => $.fs.stat(p, { resolve: true }))
  return st?.realPath
}

async function usageNow($: Api): Promise<{ tokens?: number; window?: number }> {
  const u = await safely(() => $.session.usage())
  return { tokens: u?.context?.tokens, window: u?.context?.window }
}

function contextsOf(step: Step | undefined): string[] {
  if (!step) return []
  return step.fx.filter((f): f is Extract<Effect, { type: 'context' }> => f.type === 'context').map((f) => f.text)
}

function blockOf(step: Step | undefined): string | undefined {
  return step?.fx.find((f): f is Extract<Effect, { type: 'block' }> => f.type === 'block')?.text
}

// ───────────────────────── 启用判定与配置 ─────────────────────────

function gateWhy(): string {
  return gate?.why ?? ''
}

async function enabled($: Api): Promise<boolean> {
  if (gate) return gate.on
  const v = await safely(() => $.session.version())
  const base = v?.base ?? v?.version
  if (!versionAtLeast(base)) {
    gate = { on: false, why: `it needs Claude Code ${MIN_VERSION} or later (this is ${base ?? 'an unknown version'})` }
    if (!lowVersionWarned) {
      lowVersionWarned = true
      try {
        $.ui.toast(`AutoHandoff is not active: ${gate.why}.`, { timeoutMs: TOAST_MS })
      } catch {
        // 没有界面
      }
    }
    return false
  }
  let inter = interactive
  if (inter === undefined) inter = ((await safely(() => $.session.surfaces())) ?? []).length > 0
  gate = inter ? { on: true, why: '' } : { on: false, why: 'it does not work in non-interactive sessions (claude -p, the Agent SDK)' }
  return gate.on
}

/**
 * 配置文件路径：AUTOHANDOFF_CONFIG（另放配置文件时用，PLAN §0 第 19 条）优先，否则 <CC 配置目录>/autohandoff.md。
 * AUTOHANDOFF_CONFIG 只认绝对路径：`$.fs` 会把相对路径解析到工程目录下，读写的就成了工程里的文件。相对路径忽略，并报告一句。
 */
async function configPath($: Api): Promise<{ path: string | undefined; problem?: string }> {
  const own = await $.env.get('AUTOHANDOFF_CONFIG')
  let problem: string | undefined
  if (own) {
    if (isAbsolutePath(own)) return { path: own }
    problem = `AUTOHANDOFF_CONFIG="${own}" is not an absolute path; it is ignored`
    if (!relativeConfigWarned) {
      relativeConfigWarned = true
      debug($, problem)
    }
  }
  const dir = configDir(await envVars($))
  return { path: dir ? configFilePath(dir) : undefined, problem }
}

interface LoadedConfig {
  parsed: ParsedConfig
  path: string | undefined
}

async function readConfig($: Api): Promise<LoadedConfig> {
  const { path, problem: pathProblem } = await configPath($)
  if (!path) {
    const parsed = parseConfig(undefined)
    if (pathProblem) parsed.problems.unshift(pathProblem)
    return { parsed, path }
  }
  let text: string | undefined
  let problem: string | undefined
  try {
    if (await $.fs.exists(path)) text = String(await $.fs.read(path))
  } catch (err) {
    problem = `could not read ${path} (${errText(err)}); built-in defaults used`
  }
  const parsed = parseConfig(text)
  if (problem) parsed.problems.unshift(problem)
  if (pathProblem) parsed.problems.unshift(pathProblem)
  return { parsed, path }
}

/** 配置文件不存在时写一次带注释的默认文件（唯一的 `$.fs.write`，PLAN §0 第 17 条） */
async function ensureConfigFile($: Api): Promise<void> {
  let path: string | undefined
  try {
    path = (await configPath($)).path
    // exists 碰到网络位置会 reject，别的插件的 fs hook 也可能 deny：都按「这次不写」处理
    if (!path || (await $.fs.exists(path))) return
    await $.fs.write(path, defaultConfigText())
    debug($, `wrote the default configuration to ${path}`)
  } catch (err) {
    debug($, `could not write the default configuration${path ? ` to ${path}` : ''}: ${errText(err)}`)
  }
}

// ───────────────────────── 记录：读写、/clear 后的搬迁 ─────────────────────────

async function loadRec($: Api, sid: string): Promise<Rec | null> {
  return loadRecord(await $.store.get(storeKey(sid)))
}

function sameRec(a: Rec, b: Rec): boolean {
  return JSON.stringify({ ...a, t: 0 }) === JSON.stringify({ ...b, t: 0 })
}

/** session.end(clear)：oldSid 刚被 /clear 换掉 */
async function markClearing($: Api, oldSid: string): Promise<void> {
  clearingFrom = { sid: oldSid, t: await $.clock.now() }
}

/**
 * 新 sid 下没有记录：找刚被 /clear 换掉的旧对话的记录，搬到新 sid（只在 SessionStart(clear) 和自家重置的回调里调用）。
 * 候选：模块变量（紧挨着的上一个 sid）→ 回调自己带的旧 sid（发出重置时的 sid；重置排队期间用户先 /clear 过一次时，它比模块变量旧一代）。
 * store 写失败不拦搬迁：用内存里搬好的记录接着处理（见 dispatch 的说明）。
 */
async function adopt($: Api, sid: string, now: number, hint: string | undefined): Promise<Rec | null> {
  const candidates: string[] = []
  if (clearingFrom && clearingFrom.sid !== sid && now - clearingFrom.t <= CLEAR_LINK_MS) candidates.push(clearingFrom.sid)
  if (hint && hint !== sid && !candidates.includes(hint)) candidates.push(hint)
  for (const old of candidates) {
    const rec = await loadRec($, old)
    if (!rec) continue
    const moved = migrateRecord(rec, now)
    try {
      await $.store.set(storeKey(sid), moved)
      // 旧对话的记录只留开关（--resume 回去时恢复）；job、回合、作废说明都随对话搬走或作废
      await $.store.set(storeKey(old), { ...rec, job: null, fallback: null, turn: null, tell: null, t: now })
      if (clearingFrom?.sid === old) clearingFrom = null
    } catch (err) {
      // 没存下：旧记录原样留着，模块变量也留着，下一个事件（SessionStart(clear) 等）再搬一次
      debug($, `could not save the record moved from session ${old} to ${sid}: ${errText(err)}`)
    }
    debug($, `record moved from session ${old} to ${sid} after /clear`)
    return moved
  }
  return null
}

/** 本进程发出过的重置（jobKey 列表）；读不到返回 undefined */
async function queuedList($: Api): Promise<string[] | undefined> {
  try {
    const { value } = await $.state.get(QUEUED_REF)
    return Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string') : []
  } catch (err) {
    debug($, `could not read $.state: ${errText(err)}`)
    return undefined
  }
}

/**
 * 记下本进程发出了这个 job 的重置（在写 store、把命令交给 `$.command.run` 之前）。写不进就抛错：
 * 没记下的重置在热重载后会被当成进程重启而作废，命令却还在排队，成了一次没人续接的重置（见 dispatch）
 */
async function noteQueued($: Api, key: string): Promise<void> {
  const cur = (await queuedList($)) ?? []
  const r = await $.state.set(QUEUED_REF, [...cur.filter((k) => k !== key), key].slice(-QUEUED_KEEP))
  // 不带 ifVersion 时 isSet 应总为真；宿主说没写进就按没写进处理
  if (r && r.isSet === false) throw new Error('$.state.set did not write the value')
}

/**
 * 记录里已排队的重置是不是本进程发出的：true 是（热重载），false 不是（进程重启，命令随旧进程没了），
 * undefined 不适用或读不到 `$.state`（core 按热重载处理）
 */
async function queuedHere($: Api, j: Job | null): Promise<boolean | undefined> {
  if (!j || (j.stage !== 'clearing' && j.stage !== 'compacting')) return undefined
  const list = await queuedList($)
  return list === undefined ? undefined : list.includes(jobKey(j))
}

/** 这一步发出新的重置（clear/compact） */
function issuesReset(step: Step): boolean {
  return step.fx.some((f) => f.type === 'clear' || f.type === 'compact')
}

/** 这一步发出的交接 job 重置的标识（兜底压缩没有） */
function resetJobOf(step: Step): string | undefined {
  for (const f of step.fx) if ((f.type === 'clear' || f.type === 'compact') && f.job !== undefined) return f.job
  return undefined
}

interface DispatchOptions {
  /** 记录所在的 sid；缺省取 `$.session.id()` */
  sid?: string
  /** 新 sid 下没有记录时尝试从 /clear 前的对话搬过来 */
  adopt?: boolean
  /** 搬迁的首选旧 sid（自家重置的回调知道自己是从哪个 sid 发出的） */
  from?: string
  config?: LoadedConfig
}

/**
 * 送一个事件进 core：串行地 读记录 → transition → 写回（只在有变化时写），然后执行副作用。
 * make 拿到当前记录再生成事件（turnComplete 要先看有没有 armed 的 job 才复查文件）。
 *
 * 写 store 失败时（store 满、磁盘错误……）：
 *   - 这一步要发出新的重置（clear/compact）：不发。重置的结果要靠存下来的请求序号认领，存不下就会变成一次没人续接的重置；
 *     记录停在原状态（armed 的登记照常由下一条消息、回合结束或超时处理），toast 告诉用户没有重置。
 *     交接 job 的重置还要先在 `$.state` 记下标识（noteQueued），写不进同样按这条处理，而且记录不写回（停在 armed）。
 *   - 其它步骤：副作用照常执行（重置已经发生时，续接比状态记全更要紧）。
 */
async function dispatch($: Api, make: (rec: Rec) => Ev | Promise<Ev>, o: DispatchOptions = {}): Promise<Step> {
  const config = o.config ?? (await readConfig($))
  const cfg = config.parsed.cfg
  const { step, sid } = await serial(async () => {
    const now = await $.clock.now()
    const sid = o.sid ?? (await $.session.id())
    let rec = await loadRec($, sid)
    if (!rec && o.adopt) rec = await adopt($, sid, now, o.from)
    const fresh = rec === null
    const base = rec ?? newRecord(now)
    const ev = await make(base)
    const step = transition(base, ev, { cfg, now })
    // 没有记录且转移后仍是空白记录（开关未动、没收到过人工输入……）就不写，免得每个会话都在 store 里留一份
    const blank = fresh && sameRec(step.rec, newRecord(now))
    const notReset = (why: string, what: string): void => {
      step.fx = [
        { type: 'log', text: `${ev.kind}: reset not issued because ${what} could not be saved`, debug: true },
        { type: 'toast', text: `AutoHandoff could not save its state (${why}), so the conversation was not reset.` },
      ]
    }
    const job = resetJobOf(step)
    if (job !== undefined) {
      try {
        await noteQueued($, job)
      } catch (err) {
        const why = errText(err)
        debug($, `could not write $.state: ${why}`)
        notReset(why, 'the queued reset')
        return { step, sid }
      }
    }
    if (!blank && (fresh || !sameRec(step.rec, base))) {
      try {
        await $.store.set(storeKey(sid), step.rec)
      } catch (err) {
        const why = errText(err)
        debug($, `could not save the record of session ${sid} (${ev.kind}): ${why}`)
        if (issuesReset(step)) notReset(why, 'the record')
        else if (step.accepted === true) {
          // 登记没存下：回合结束时什么也不会发生，所以不能回「已登记」
          step.accepted = false
          step.reply = `Not registered: AutoHandoff could not save the registration (${why}).`
          step.fx = [
            { type: 'log', text: 'registration refused: the record could not be saved', debug: true },
            { type: 'toast', text: `AutoHandoff could not save its state (${why}), so the handoff was not registered.` },
          ]
        }
      }
    }
    return { step, sid }
  })
  runEffects($, step.fx, sid)
  return step
}

// ───────────────────────── 副作用 ─────────────────────────

/** context / block 由调用的 hook 自己放进返回值；其余在这里执行。调用时记录已写进 store。 */
function runEffects($: Api, fx: readonly Effect[], sid: string): void {
  for (const f of fx) {
    try {
      switch (f.type) {
        case 'context':
        case 'block':
          break
        case 'clear':
          issueReset($, sid, f.seq, { command: 'clear' })
          break
        case 'compact':
          issueReset($, sid, f.seq, { command: 'compact', args: f.args })
          break
        case 'resume':
          issueResume($, sid, f.seq, f.text)
          break
        case 'status':
          $.ui.status(f.text)
          break
        case 'toast':
          $.ui.toast(f.text, { timeoutMs: TOAST_MS })
          break
        case 'notify':
          void $.ui.notify(f.text).catch(() => undefined)
          break
        case 'log':
          if (f.debug) $.ui.log(f.text, { to: 'debug' })
          // transcript 里的 ui.log 行不显示换行（实测显示成乱码），多行文字逐行记
          else for (const line of f.text.split('\n')) $.ui.log(line)
          break
        case 'timer':
          $.clock.after(f.ms, () => {
            void dispatch($, () => ({ kind: 'tick' })).catch((err) => fail($, 'tick', err))
          })
          break
      }
    } catch (err) {
      fail($, `effect ${f.type}`, err)
    }
  }
}

/**
 * 排队执行 /clear 或 /compact（回合中会排到空闲才执行），结果带同一个 seq 送回 core。
 * 交接 job 的标识已由 dispatch 记进 `$.state`：之后 session.start 据此区分热重载（命令还在排队）与进程重启。
 */
function issueReset($: Api, sid: string, seq: number, args: { command: 'clear' | 'compact'; args?: string }): void {
  void (async () => {
    let error: string | undefined
    try {
      await $.command.run(args)
    } catch (err) {
      error = errText(err) || 'unknown error'
    }
    if (error === undefined) {
      // clear 已完成，`$.session.id()` 已是新 sid：记录还没搬就从 sid 搬过来
      await dispatch($, () => ({ kind: 'resetDone', seq }), { adopt: true, from: sid })
    } else {
      debug($, `/${args.command} (request ${seq}) was rejected: ${error}`)
      await dispatch($, () => ({ kind: 'resetFailed', seq, message: error }), { adopt: true, from: sid })
    }
  })().catch((err) => fail($, `/${args.command} callback`, err))
}

/** 以用户身份提交续接文案；结果（含被丢弃）带 seq 送回 core。 */
function issueResume($: Api, sid: string, seq: number, text: string): void {
  void (async () => {
    let drop: string | undefined
    try {
      const r = await $.prompt.submit({ text, asUser: true })
      if (r && typeof r === 'object' && 'drop' in r && typeof r.drop === 'string') drop = r.drop
    } catch (err) {
      drop = errText(err) || 'unknown error'
    }
    await dispatch($, () => ({ kind: 'resumeDone', seq, drop }), { adopt: true, from: sid })
  })().catch((err) => fail($, 'resume callback', err))
}

// ───────────────────────── 各事件的处理（hook 本体只管放行与 catch） ─────────────────────────

async function onSessionStart($: Api, isInteractive: boolean): Promise<void> {
  interactive = isInteractive
  gate = null
  if (!(await enabled($))) {
    debug($, `inactive: ${gateWhy()}`)
    return
  }
  // 登记工具最先注册：后面任何一步出错（网络位置上的配置目录让 $.fs.exists reject、别的插件 deny 等）都不能让它缺席
  try {
    await $.tool.register({ name: TOOL_NAME, description: TOOL_DESCRIPTION, inputSchema: TOOL_SCHEMA, isDeferred: false })
  } catch (err) {
    fail($, 'tool.register', err)
  }
  // 以下几步失败都只是少了默认配置文件或清理，不影响 start 的作废判断
  await safely(() => ensureConfigFile($))
  await safely(() => cleanupStore($))
  // 进程刚起、--resume 或模块热重载：挂着的 job 由 core 处理（登记中的作废；已排队的看是不是本进程发出的）
  await dispatch($, async (rec) => ({ kind: 'start', queuedHere: await queuedHere($, rec.job) }))
}

/** 删掉 30 天没动过的对话记录 */
async function cleanupStore($: Api): Promise<void> {
  const now = await $.clock.now()
  for (const k of await $.store.keys()) {
    if (k.startsWith('s:') && isExpired((await $.store.get(k)) as { t?: unknown } | undefined, now)) await $.store.delete(k)
  }
}

async function checkHandoffPath($: Api, raw: unknown, now: number, freshMinutes: number): Promise<Verdict<string>> {
  const cwd = await $.session.cwd()
  const windows = looksWindows(cwd)
  const text = checkPathText(raw, windows)
  if (!text.ok) return text
  const abs = toAbsolute(text.value, cwd)
  const stat: StatLike | undefined = await safely(() => $.fs.stat(abs, { resolve: true }))
  const env = await envVars($)
  const repo = await safely(() => $.session.repo())
  const roots = usableRoots(
    [await realPathOf($, cwd), await realPathOf($, await safely(() => $.session.root())), await realPathOf($, repo?.root)],
    await realPathOf($, homeDir(env)),
    windows,
  )
  const cc = configDir(env)
  return checkHandoffStat(stat, { roots, configDir: await realPathOf($, cc), now, freshMinutes, windows })
}

/**
 * 登记时估算交接文件的大小（PLAN §0 第 30 条）：读一次正文，只用来数字符，不解析、不进任何文本。
 * 读失败（刚被删、别的插件的 fs hook 拒绝……）不影响登记，只是这次没有大小检测；文件真没了由回合结束时的复查处理。
 */
async function handoffTokens($: Api, file: string): Promise<number | undefined> {
  try {
    return estimateReadTokens(String(await $.fs.read(file)))
  } catch (err) {
    debug($, `could not read the handoff file to estimate its size: ${errText(err)}`)
    return undefined
  }
}

/** 重置前复查交接文件；stat 抛错（文件没了）也是复查失败 */
async function recheck($: Api, file: string): Promise<Verdict<string>> {
  const stat = await safely(() => $.fs.stat(file, { resolve: true }))
  return checkStillThere(stat, file, looksWindows(file))
}

async function onRegister($: Api, e: { agentId?: string; file?: unknown }): Promise<{ result: string } | { deny: string }> {
  if (!(await enabled($))) return { deny: `AutoHandoff is not active in this session: ${gateWhy()}` }
  const config = await readConfig($)
  let verdict: Verdict<string> = { ok: false, why: 'not checked' }
  // 子代理和 fork 的调用不看路径，core 直接拒绝
  const s = config.parsed.cfg.settings
  if (e.agentId === undefined) verdict = await checkHandoffPath($, e.file, await $.clock.now(), s.fresh_minutes)
  // 路径通过了才读（realPath 已过白名单、≤ 1 MiB）；检测关着（0）就不读
  const fileTokens = verdict.ok && s.handoff_max_tokens > 0 ? await handoffTokens($, verdict.value) : undefined
  const { tokens } = await usageNow($)
  const step = await dispatch($, () => ({ kind: 'register', agentId: e.agentId, verdict, tokens, fileTokens }), { config })
  const reply = step.reply ?? 'Not registered.'
  return step.accepted === true ? { result: reply } : { deny: reply }
}

async function onToggle($: Api, args: string): Promise<void> {
  if (!(await enabled($))) {
    $.ui.log(`AutoHandoff is not active in this session: ${gateWhy()}.`)
    return
  }
  const config = await readConfig($)
  const u = await usageNow($)
  await dispatch(
    $,
    () => ({ kind: 'toggle', args, tokens: u.tokens, window: u.window, problems: config.parsed.problems, configPath: config.path }),
    { config },
  )
}

// /clear、/compact、/resume 由 userCommand 处理，/autohandoff 由 toggle 处理；它们的 prompt.submit（带 command）不再当作新消息
const HANDLED_COMMANDS = new Set(['clear', 'compact', 'resume', COMMAND_NAME])

// ───────────────────────── 接线 ─────────────────────────

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    try {
      await onSessionStart($, e.isInteractive)
    } catch (err) {
      fail($, 'session.start', err)
    }
    return r
  })

  // agent team 的 teammate 进程最先收到的是 team-lead 的消息（它从不收到人工输入）。
  // 只看投给主对话的（agentId 为空）：进程内 teammate 模式下，lead 进程也会收到投给 teammate 循环的、带 agentId 的这类事件
  on('session.receive', async ($, e, next) => {
    try {
      const origin = e.origin as unknown as { teammate?: unknown }
      if (e.agentId === undefined && origin.teammate === 'team-lead' && (await enabled($))) await dispatch($, () => ({ kind: 'teammate' }))
    } catch (err) {
      fail($, 'session.receive', err)
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // 主对话的每条消息：作废/附说明/提醒都由 core 决定，附加内容走 context（用户看不到）
  on('prompt.submit', async ($, e, next) => {
    let add: string[] = []
    try {
      if (!(e.command && HANDLED_COMMANDS.has(e.command.name)) && (await enabled($))) {
        const isMeta = e.isMeta === true
        // 审计行：来源分类（含 isMeta）的依据，e2e 用它核对实际到达的消息
        debug($, `message: origin ${e.origin.kind}${isMeta ? ', isMeta' : ''}${e.turnId ? ', into the running turn' : ''}`)
        const u = await usageNow($)
        add = contextsOf(await dispatch($, () => ({ kind: 'submit', origin: e.origin, isMeta, tokens: u.tokens, window: u.window })))
      }
    } catch (err) {
      fail($, 'prompt.submit', err)
    }
    return next(add.length ? { ...e, context: [...(e.context ?? []), ...add] } : e)
  }).catch(($, e, next) => next(e))

  // /autohandoff：md 命令的真名；不调 next，命令被完全拦截，输出只走 ui.log（模型看不到）
  on('command.run', { command: COMMAND_NAME }, async ($, e) => {
    try {
      await onToggle($, e.args)
    } catch (err) {
      fail($, '/autohandoff', err)
      $.ui.log(`AutoHandoff: internal error (${errText(err)})`)
    }
    return {}
  }).catch(() => ({}))

  // 用户自己敲的命令（/clear、/compact、/resume 作废登记）；自家发起的命令这里看不到
  on('command.run', async ($, e, next) => {
    try {
      const kind = e.origin.kind
      if (e.command !== COMMAND_NAME && (kind === 'composer' || kind === 'bridge') && (await enabled($))) {
        await dispatch($, () => ({ kind: 'userCommand', command: e.command }))
      }
    } catch (err) {
      fail($, 'command.run', err)
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    try {
      if (e.agentId === undefined && (await enabled($))) await dispatch($, () => ({ kind: 'turnStart', turnId: e.turnId }))
    } catch (err) {
      fail($, 'turn.start', err)
    }
    return next(e)
  })

  // 回合中途的用量与提醒（实测 PostToolUse 时 usage() 已是这次请求的值，不比 turn.step 晚）
  on('classic.PostToolUse', async ($, e, next) => {
    const r = await next(e)
    try {
      if (e.agent_id === undefined && (await enabled($))) {
        const u = await usageNow($)
        const add = contextsOf(await dispatch($, () => ({ kind: 'postTool', tokens: u.tokens, window: u.window })))
        if (add.length) return { ...r, additionalContext: [...(r.additionalContext ?? []), ...add] }
      }
    } catch (err) {
      fail($, 'classic.PostToolUse', err)
    }
    return r
  }).catch(($, e, next) => next(e))

  on('classic.Stop', async ($, e, next) => {
    const r = await next(e)
    try {
      if (e.agent_id === undefined && (await enabled($))) {
        const u = await usageNow($)
        // 链上排在后面的 hook（含 settings 里的 Stop hook）已经 block 了：core 不叠加、不记账
        const othersBlocked = r.block !== undefined
        const block = blockOf(await dispatch($, () => ({ kind: 'stop', active: e.stop_hook_active, tokens: u.tokens, othersBlocked })))
        if (block !== undefined) return { ...r, block }
      }
    } catch (err) {
      fail($, 'classic.Stop', err)
    }
    return r
  }).catch(($, e, next) => next(e))

  // 回合结束：有 armed 的 job 先复查交接文件，再由 core 决定是否排队 /clear（或 /compact）
  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    try {
      if (e.agentId === undefined && (await enabled($))) {
        const u = await usageNow($)
        await dispatch($, async (rec) => ({
          kind: 'turnComplete',
          turnId: e.turnId,
          reason: e.reason,
          isAborted: e.isAborted,
          tokens: u.tokens,
          file: rec.job?.stage === 'armed' ? await recheck($, rec.job.file) : undefined,
        }))
      }
    } catch (err) {
      fail($, 'turn.complete', err)
    }
    return r
  })

  // 登记工具：hook 直接作答（不弹权限框）；子代理/fork 的调用由 core 拒绝
  on('tool.call', { tool: TOOL_FULL_NAME }, async ($, e) => {
    const input = e as unknown as { agentId?: string; file?: unknown }
    return onRegister($, { agentId: input.agentId, file: input.file })
  }).catch(() => ({ deny: 'AutoHandoff internal error; the handoff was not registered.' }))

  // 新对话（clear/compact 之后）：附 start_context；clear 换了 sid，记录在这里或重置回调里搬过来
  on('classic.SessionStart', async ($, e, next) => {
    const r = await next(e)
    try {
      if (await enabled($)) {
        const sid = typeof e.session_id === 'string' && e.session_id ? e.session_id : await $.session.id()
        if (e.source === 'clear' || e.source === 'compact') {
          const step = await dispatch($, () => ({ kind: 'sessionStart', source: e.source }), { sid, adopt: e.source === 'clear' })
          const add = contextsOf(step)
          if (add.length) return { ...r, additionalContext: [...(r.additionalContext ?? []), ...add] }
        } else if (e.source === 'resume') {
          // 切回一个旧对话：它的记录里若还挂着 job，和进程启动一样处理
          await dispatch($, async (rec) => ({ kind: 'start', queuedHere: await queuedHere($, rec.job) }), { sid })
        }
      }
    } catch (err) {
      fail($, 'classic.SessionStart', err)
    }
    return r
  }).catch(($, e, next) => next(e))

  on('session.end', async ($, e, next) => {
    try {
      if (await enabled($)) {
        if (e.reason === 'clear') await markClearing($, e.sessionId)
        else await dispatch($, () => ({ kind: 'sessionEnd', reason: e.reason }), { sid: e.sessionId })
      }
    } catch (err) {
      fail($, 'session.end', err)
    }
    return next(e)
  })
}
