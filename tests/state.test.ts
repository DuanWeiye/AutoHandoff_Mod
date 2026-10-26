// 状态机：按真实会话里的事件顺序驱动 transition()，检查记录与副作用。不需要 `$` 打桩。
import { expect, test } from 'claude-code/testing'
import {
  FALLBACK_MAX_FAILS,
  QUEUED_TOAST,
  RESUME_STUCK_MS,
  TOOL_FULL_NAME,
  defaultConfig,
  migrateRecord,
  newRecord,
  transition,
  type Ev,
  type Rec,
} from '../hooks/core.js'
import { FILE_OK, HANDOVER, MIN, NOW, cfgWith, contexts, lastSeq, ofType, onRecord, run } from './helpers.js'

const T1 = 'f0b6c7a2-6d1e-4c2a-9a51-1f3e0c9b7d10'
const T2 = '3a9e1d44-0c5b-4f7e-8b2d-6c1a9f0e2b77'
const COMPOSER = { kind: 'composer' }
const REG: Ev = { kind: 'register', verdict: { ok: true, value: HANDOVER } }
type TurnComplete = Extract<Ev, { kind: 'turnComplete' }>
const DONE: TurnComplete = { kind: 'turnComplete', turnId: T1, reason: 'answer', isAborted: false, tokens: 318_400, file: FILE_OK }
// 实测的 command.run 被拒文字（用户按过 Esc）
const VETO = 'autohandoff: $.command.run: the session was stopped and nobody has sent input since'
const WAIT = 60 * MIN

/** 一个越过 remind 后在回合里登记好交接的对话（到 Stop 之前） */
function armed(rec: Rec = onRecord(), cfg = defaultConfig()) {
  return run(
    rec,
    [
      { kind: 'submit', origin: COMPOSER, tokens: 296_000 },
      { kind: 'turnStart', turnId: T1 },
      { kind: 'postTool', tokens: 301_900 },
      { kind: 'postTool', tokens: 309_300 },
      REG,
    ],
    cfg,
  )
}

/** 登记后回合正常结束、clear 已排队的对话；返回记录与请求序号 */
function clearing(cfg = defaultConfig()) {
  const t = run(armed(onRecord(), cfg).rec, [{ kind: 'stop', active: false }, DONE], cfg)
  return { rec: t.rec, seq: lastSeq(t.all), trace: t }
}

/** 一个没有登记、正常结束在 compact_at 之上的主回合 */
function bigTurn(tokens = 652_000, turnId = T1): Ev[] {
  return [
    { kind: 'turnStart', turnId },
    { kind: 'stop', active: false, tokens },
    { kind: 'turnComplete', turnId, reason: 'answer', isAborted: false, tokens },
  ]
}

/** 兜底压缩已排队的对话 */
function compacting(rec: Rec = onRecord({ levels: { remind: true, urge: true } }), tokens = 652_000) {
  const t = run(rec, bigTurn(tokens))
  return { rec: t.rec, seq: lastSeq(t.all), trace: t }
}

test('clear path: remind → register → Stop → turn ends → /clear → resume', () => {
  const a = armed()
  // 第一次越线的 PostToolUse 送完整 remind，之后的 PostToolUse 不再送
  expect(contexts(a.steps[2]!.fx).length).toBe(1)
  expect(contexts(a.steps[2]!.fx)[0]).toContain('past the first threshold of 300k')
  expect(contexts(a.steps[3]!.fx)).toEqual([])
  const reg = a.steps[4]!
  expect(reg.reply).toBe(
    `Handoff registered: "${HANDOVER}". End your turn now: no more tool calls, no questions, no summary. When the turn ends, the conversation is reset with /clear and continued from this file.`,
  )
  expect(ofType(reg.fx, 'timer')).toEqual([{ type: 'timer', ms: WAIT }])
  expect(ofType(reg.fx, 'status')).toEqual([{ type: 'status', text: 'handoff registered; /clear when this turn ends' }])
  expect(ofType(reg.fx, 'log')[0]!.text).toBe(`handoff registered: ${HANDOVER} (turn ${T1})`)
  expect(a.rec.job?.stage).toBe('armed')

  const b = run(a.rec, [{ kind: 'stop', active: false, tokens: 318_400 }, DONE])
  expect(ofType(b.all, 'block')).toEqual([])
  // 每次发出 clear 都带请求序号，并再起一个 wait_minutes 的兜底计时
  expect(ofType(b.steps[1]!.fx, 'clear')).toEqual([{ type: 'clear', seq: 1, job: `${NOW}:1` }])
  expect(ofType(b.steps[1]!.fx, 'timer')).toEqual([{ type: 'timer', ms: WAIT }])
  expect(b.rec.job?.stage).toBe('clearing')
  expect(b.rec.job?.seq).toBe(1)

  // 实测顺序：clear 的 promise 先 resolve，约 180 ms 后才到 SessionStart(clear)；register.ts 先按新 sid 搬记录
  const c = run(migrateRecord(b.rec, NOW), [{ kind: 'resetDone', seq: 1 }, { kind: 'sessionStart', source: 'clear' }])
  const resume = ofType(c.steps[0]!.fx, 'resume')
  expect(resume.length).toBe(1)
  expect(resume[0]!.seq).toBe(1)
  expect(resume[0]!.text.startsWith('[AutoHandoff: resume] The context was just reset by AutoHandoff (/clear).')).toBe(true)
  expect(resume[0]!.text).toContain(`Handoff file: "${HANDOVER}"`)
  const sc = contexts(c.steps[1]!.fx)
  expect(sc.length).toBe(1)
  expect(sc[0]).toContain(`Handoff file: "${HANDOVER}"`)
  expect(c.rec.job?.stage).toBe('resuming')

  const d = run(c.rec, [{ kind: 'resumeDone', seq: 1 }])
  expect(d.rec.job).toBe(null)
  expect(d.rec.levels).toEqual({ remind: false, urge: false })
  expect(d.rec.on).toBe(true)
  expect(ofType(d.all, 'status')).toEqual([{ type: 'status', text: undefined }])
})

test('clear path with the events in the other order: SessionStart(clear) before the promise resolves (same record; finding the old record under the new session id is register.ts\'s job)', () => {
  const { rec, seq } = clearing()
  const a = run(rec, [{ kind: 'sessionStart', source: 'clear' }, { kind: 'resetDone', seq }, { kind: 'resumeDone', seq }])
  expect(contexts(a.steps[0]!.fx)[0]).toContain(`"${HANDOVER}"`)
  expect(ofType(a.steps[1]!.fx, 'resume').length).toBe(1)
  expect(a.rec.job).toBe(null)
})

test('compact path: action compact runs /compact with the focus, then resumes', () => {
  const cfg = cfgWith({ action: 'compact' })
  const a = armed(onRecord(), cfg)
  expect(a.steps[4]!.reply).toContain('reset with /compact')
  const b = run(a.rec, [{ kind: 'stop', active: false }, DONE], cfg)
  const compact = ofType(b.steps[1]!.fx, 'compact')
  expect(compact.length).toBe(1)
  expect(compact[0]!.seq).toBe(1)
  expect(compact[0]!.args).toMatch(/^Keep what is needed to continue the current work: .*next steps\.$/)
  const c = run(b.rec, [{ kind: 'sessionStart', source: 'compact' }, { kind: 'resetDone', seq: 1 }], cfg)
  expect(contexts(c.steps[0]!.fx)[0]).toContain('(/compact)')
  expect(ofType(c.steps[1]!.fx, 'resume')[0]!.text).toContain('(/compact)')
})

test('stale callbacks: a result with another request number is ignored', () => {
  // 旧模块里排队的压缩在热重载后才 resolve，而此时新的 clear 已排队：旧结果不得冒充新 job 的
  const fb = compacting()
  expect(fb.seq).toBe(1)
  const reloaded = run(fb.rec, [{ kind: 'start' }])
  expect(reloaded.rec.fallback).toBe(null)
  const next = run(reloaded.rec, [
    { kind: 'submit', origin: COMPOSER, tokens: 655_000 },
    { kind: 'turnStart', turnId: T2 },
    REG,
    { kind: 'stop', active: false, tokens: 656_000 },
    { ...DONE, turnId: T2, tokens: 656_000 },
  ])
  expect(next.rec.job?.stage).toBe('clearing')
  const seq = lastSeq(next.all)
  expect(seq).toBe(2)
  const stale = run(next.rec, [{ kind: 'resetDone', seq: 1 }])
  expect(stale.rec.job?.stage).toBe('clearing')
  expect(ofType(stale.all, 'resume')).toEqual([])
  expect(ofType(stale.all, 'log')[0]!.text).toBe('reset request 1 finished, but it is no longer the current one; ignored')
  // 旧请求的失败同样被忽略；正确的序号才推进
  const staleFail = run(stale.rec, [{ kind: 'resetFailed', seq: 1, message: 'unknown command' }])
  expect(staleFail.rec.job?.stage).toBe('clearing')
  const good = run(staleFail.rec, [{ kind: 'resetDone', seq }])
  expect(good.rec.job?.stage).toBe('resuming')
  // 续接结果也要对号
  const wrongResume = run(good.rec, [{ kind: 'resumeDone', seq: 1 }])
  expect(wrongResume.rec.job?.stage).toBe('resuming')
  expect(run(wrongResume.rec, [{ kind: 'resumeDone', seq }]).rec.job).toBe(null)
})

test('registration is refused from a subagent, when off, and during a reset', () => {
  const sub = run(onRecord(), [{ kind: 'register', agentId: 'a904d9323568546da', verdict: { ok: true, value: HANDOVER } }])
  expect(sub.steps[0]!.reply).toBe('Not registered: only the main conversation can register a handoff; subagents and forks cannot.')
  expect(sub.rec.job).toBe(null)

  const off = run(newRecord(NOW), [REG])
  expect(off.steps[0]!.reply).toBe('Not registered: AutoHandoff is off for this conversation.')

  const bad = run(onRecord(), [{ kind: 'register', verdict: { ok: false, why: 'the file is empty' } }])
  expect(bad.steps[0]!.reply).toBe('Not registered: the file is empty.')

  const busy = run(clearing().rec, [REG])
  expect(busy.steps[0]!.reply).toBe('Not registered: a reset is already in progress.')

  // 已登记时再登记：刷新（比如子代理的结果补进交接后）
  const again = run(armed().rec, [[REG, NOW + 3 * MIN]])
  expect(again.rec.job?.registeredAt).toBe(NOW + 3 * MIN)
})

test('a user message while registered cancels it and tells the model in that message', () => {
  const a = run(armed().rec, [{ kind: 'submit', origin: COMPOSER, tokens: 320_000 }])
  expect(a.rec.job).toBe(null)
  const ctx = contexts(a.all)
  expect(ctx).toEqual([
    `[AutoHandoff] Your registered handoff was cancelled (a new message from the user arrived). Deal with that first. If you register again, in this turn or later, first update the handoff file with everything new since you wrote it, above all what the user has just asked for or answered, so that the next conversation has it (next steps are the work itself, never "hand off again"); then call the ${TOOL_FULL_NAME} tool again.`,
  ])
  expect(ofType(a.all, 'toast')).toEqual([{ type: 'toast', text: 'AutoHandoff: handoff cancelled (a new message from the user arrived)' }])
  // 当前层重新生效：下一次 PostToolUse 再送完整 remind
  expect(a.rec.levels.remind).toBe(false)
  const b = run(a.rec, [{ kind: 'turnStart', turnId: T2 }, { kind: 'postTool', tokens: 324_000 }])
  expect(contexts(b.all)[0]).toContain('[AutoHandoff: reminder]')
})

test('a message from a scheduled trigger or another plugin cancels too, with wording that does not blame the user', () => {
  for (const origin of [{ kind: 'scheduled-trigger' }, { kind: 'plugin', name: 'mod-probe' }, { kind: 'brand-new-kind' }, undefined]) {
    const a = run(armed().rec, [{ kind: 'submit', origin, tokens: 320_000 }])
    expect(a.rec.job).toBe(null)
    expect(contexts(a.all)[0]).toContain(
      'Your registered handoff was cancelled (a new message arrived that was not typed by the user (a scheduled trigger, another plugin or an unknown source)).',
    )
  }
})

test('subagent reports and task notifications do not cancel; they get the pending note', () => {
  for (const kind of ['task-notification', 'peer', 'peer-send-message']) {
    const a = run(armed().rec, [{ kind: 'submit', origin: { kind }, tokens: 320_000 }])
    expect(a.rec.job?.stage).toBe('armed')
    expect(contexts(a.all)).toEqual([
      `[AutoHandoff] A handoff is registered, and the conversation will be reset with /clear when this turn ends; this message did not cancel it. If it changes anything recorded in the handoff file (for example a subagent's result), update the file before the turn ends and call the ${TOOL_FULL_NAME} tool again to refresh the registration.`,
    ])
  }
})

test('an agent message that opens a turn while the reset is queued gets the reset note', () => {
  // CC 的队列把回合中到达的 task-notification 排在自家 clear 前面：它在旧对话里开了一个回合
  const { rec } = clearing()
  const a = run(rec, [{ kind: 'submit', origin: { kind: 'task-notification' }, tokens: 318_400 }])
  expect(a.rec.job?.stage).toBe('clearing')
  expect(a.rec.job?.userTook).toBe(false)
  expect(contexts(a.all)).toEqual([
    "[AutoHandoff] The conversation is about to be reset with /clear and continued from the registered handoff file; this message arrived in between. Keep this turn short and do not start new work. If this message changes anything recorded in the handoff file (for example a subagent's result), update the file now; the next conversation reads it after the reset.",
  ])
  // 登记刷新在此阶段被拒
  expect(run(a.rec, [REG]).steps[0]!.reply).toBe('Not registered: a reset is already in progress.')
})

test('Esc cancels silently; the per-turn short reminder comes back with the next message', () => {
  const a = run(armed().rec, [{ kind: 'turnComplete', turnId: T1, reason: 'aborted', isAborted: true, tokens: 312_000 }])
  expect(a.rec.job).toBe(null)
  expect(a.rec.tell).toBe(null)
  expect(ofType(a.all, 'toast')).toEqual([])
  expect(ofType(a.all, 'clear')).toEqual([])
  const b = run(a.rec, [{ kind: 'submit', origin: COMPOSER, tokens: 312_000 }])
  expect(contexts(b.all)).toEqual([
    `[AutoHandoff] Context usage is about 312k tokens, past the first threshold of 300k, and no handoff is registered yet. Before this turn ends, finish the step in progress, write the handoff file, call the ${TOOL_FULL_NAME} tool with its path, and then end the turn.`,
  ])
})

test('a rejected tool (turn ends without Stop) cancels silently', () => {
  const a = run(armed().rec, [{ ...DONE }])
  expect(a.rec.job).toBe(null)
  expect(a.rec.tell).toBe(null)
  expect(ofType(a.all, 'clear')).toEqual([])
  // Stop 在登记之前（比如自家的 urge block）不算
  const b = run(onRecord({ levels: { remind: true, urge: true } }), [
    { kind: 'turnStart', turnId: T1 },
    { kind: 'stop', active: false, tokens: 460_000 },
    REG,
    DONE,
  ])
  expect(ofType(b.steps[1]!.fx, 'block').length).toBe(1)
  expect(b.rec.job).toBe(null)
  expect(ofType(b.all, 'clear')).toEqual([])
})

test('only reason "answer" lets the reset run; an unknown future reason cancels silently', () => {
  const a = run(armed().rec, [{ kind: 'stop', active: false }, { ...DONE, reason: 'budget_exhausted' as TurnComplete['reason'] }])
  expect(a.rec.job).toBe(null)
  expect(a.rec.tell).toBe(null)
  expect(ofType(a.all, 'clear')).toEqual([])
  expect(ofType(a.all, 'toast')).toEqual([])
  expect(ofType(a.all, 'log').map((l) => l.text)).toContain('handoff cancelled: the turn ended with reason "budget_exhausted"')
})

test('an API error cancels, notifies (toast and notify), tells the model next time and re-arms the level', () => {
  const a = run(armed().rec, [{ kind: 'turnComplete', turnId: T1, reason: 'error', isAborted: false }])
  expect(a.rec.job).toBe(null)
  expect(a.rec.tell).toBe('api_error')
  // notify 在没配置通知渠道时什么也不显示，所以总是配一条 toast
  expect(ofType(a.all, 'notify')).toEqual([{ type: 'notify', text: 'AutoHandoff: handoff cancelled (the turn ended with an API error)' }])
  expect(ofType(a.all, 'toast')).toEqual([{ type: 'toast', text: 'AutoHandoff: handoff cancelled (the turn ended with an API error)' }])
  const b = run(a.rec, [{ kind: 'submit', origin: COMPOSER, tokens: 313_000 }, { kind: 'turnStart', turnId: T2 }, { kind: 'postTool', tokens: 315_000 }])
  expect(contexts(b.steps[0]!.fx)).toEqual([
    `[AutoHandoff] Your registered handoff was cancelled (the turn ended with an API error). Deal with that first. If you register again, in this turn or later, first update the handoff file with everything new since you wrote it, above all what the user has just asked for or answered, so that the next conversation has it (next steps are the work itself, never "hand off again"); then call the ${TOOL_FULL_NAME} tool again.`,
  ])
  expect(contexts(b.steps[2]!.fx)[0]).toContain('[AutoHandoff: reminder]')
})

test('a refusal cancels with a toast; a vanished or unchecked handoff file cancels too', () => {
  const r = run(armed().rec, [{ kind: 'turnComplete', turnId: T1, reason: 'refusal', isAborted: false }])
  expect(r.rec.tell).toBe('refusal')
  expect(ofType(r.all, 'toast').length).toBe(1)
  const g = run(armed().rec, [{ kind: 'stop', active: false }, { ...DONE, file: { ok: false, why: 'missing' } }])
  expect(g.rec.job).toBe(null)
  expect(g.rec.tell).toBe('file_gone')
  expect(ofType(g.all, 'clear')).toEqual([])
  expect(ofType(g.all, 'toast')).toEqual([
    { type: 'toast', text: 'AutoHandoff: handoff cancelled (the handoff file was missing, empty or moved when the reset was due)' },
  ])
  // 复查结果缺省（register.ts 没传）：按复查失败处理，同样作废、toast、下条消息告诉模型；宁可不 clear
  const u = run(armed().rec, [{ kind: 'stop', active: false }, { ...DONE, file: undefined }])
  expect(u.rec.job).toBe(null)
  expect(u.rec.tell).toBe('file_gone')
  expect(ofType(u.all, 'clear')).toEqual([])
  expect(ofType(u.all, 'toast').length).toBe(1)
  const next = run(u.rec, [{ kind: 'submit', origin: COMPOSER, tokens: 318_400 }])
  expect(contexts(next.all)[0]).toContain('cancelled (the handoff file was missing, empty or moved when the reset was due)')
})

test('a rejected reset command: Esc vetoes are silent, other failures are reported', () => {
  const { rec, seq } = clearing()
  for (const message of [VETO, 'the command was removed from the queue before it ran']) {
    const a = run(rec, [{ kind: 'resetFailed', seq, message }])
    expect(a.rec.job).toBe(null)
    expect(a.rec.tell).toBe(null)
    expect(ofType(a.all, 'toast')).toEqual([])
  }
  const b = run(rec, [{ kind: 'resetFailed', seq, message: 'autohandoff: $.command.run: unknown command "clear"' }])
  expect(b.rec.tell).toBe('reset_failed')
  expect(ofType(b.all, 'toast').length).toBe(1)
})

test('a dropped resume message is reported with the handoff path', () => {
  const { rec, seq } = clearing()
  const base = run(rec, [{ kind: 'resetDone', seq }]).rec
  const a = run(base, [{ kind: 'resumeDone', seq, drop: 'the session was stopped and nobody has sent input since' }])
  expect(a.rec.job).toBe(null)
  const n = ofType(a.all, 'notify')
  expect(n.length).toBe(1)
  expect(n[0]!.text).toContain(`"${HANDOVER}"`)
  expect(ofType(a.all, 'toast').length).toBe(1)
})

test('Stop block: once per turn, not when stop_hook_active, not when switched off in the config', () => {
  const urged = onRecord({ levels: { remind: true, urge: true } })
  const a = run(urged, [
    { kind: 'turnStart', turnId: T1 },
    { kind: 'stop', active: false, tokens: 462_000 },
    { kind: 'stop', active: true, tokens: 463_000 },
    { kind: 'stop', active: false, tokens: 463_500 },
  ])
  const blocks = ofType(a.all, 'block')
  expect(blocks).toEqual([
    {
      type: 'block',
      text: `AutoHandoff: context usage is about 462k tokens, past the 450k handoff threshold, and no handoff is registered. Before ending the turn, write the handoff file and call the ${TOOL_FULL_NAME} tool with its path.`,
    },
  ])
  // 下一回合又能 block 一次
  const b = run(a.rec, [{ kind: 'turnComplete', turnId: T1, reason: 'answer', isAborted: false, tokens: 463_500 }, { kind: 'turnStart', turnId: T2 }, { kind: 'stop', active: false, tokens: 464_000 }])
  expect(ofType(b.all, 'block').length).toBe(1)
  // urge_block: false；只到 remind 层；已登记：都不 block
  expect(ofType(run(urged, [{ kind: 'stop', active: false, tokens: 462_000 }], cfgWith({ urge_block: false })).all, 'block')).toEqual([])
  expect(ofType(run(onRecord({ levels: { remind: true, urge: false } }), [{ kind: 'stop', active: false, tokens: 400_000 }]).all, 'block')).toEqual([])
  expect(ofType(run(armed().rec, [{ kind: 'stop', active: false, tokens: 462_000 }]).all, 'block')).toEqual([])
})

test('Stop block also fires when a turn without tool calls jumps past urge_at', () => {
  // 一个纯回答回合把用量从 200k 带到 470k：没有 PostToolUse 置位，Stop 自己按阈值补上
  const a = run(onRecord(), [{ kind: 'turnStart', turnId: T1 }, { kind: 'stop', active: false, tokens: 470_000 }])
  expect(ofType(a.all, 'block').length).toBe(1)
  expect(a.rec.levels).toEqual({ remind: true, urge: true })
  // block 之后模型继续回合：PostToolUse 不再重复送 urge，下一条消息带短提醒
  const b = run(a.rec, [{ kind: 'postTool', tokens: 472_000 }, { kind: 'stop', active: false, tokens: 473_000 }])
  expect(contexts(b.all)).toEqual([])
  expect(ofType(b.all, 'block')).toEqual([])
  // 用户消息作废了 urge 层的登记，下一回合又没有工具调用：Stop 照样 block
  const c = run(run(armed(onRecord({ levels: { remind: true, urge: false } })).rec, [{ kind: 'postTool', tokens: 455_000 }]).rec, [
    { kind: 'submit', origin: COMPOSER, tokens: 456_000 },
    { kind: 'turnStart', turnId: T2 },
    { kind: 'stop', active: false, tokens: 458_000 },
  ])
  expect(c.rec.job).toBe(null)
  expect(ofType(c.all, 'block').length).toBe(1)
  // 只到 remind 层：Stop 不 block，也不替 PostToolUse 送 remind
  const d = run(onRecord(), [{ kind: 'turnStart', turnId: T1 }, { kind: 'stop', active: false, tokens: 350_000 }])
  expect(ofType(d.all, 'block')).toEqual([])
  expect(d.rec.levels).toEqual({ remind: false, urge: false })
})

test('after urge, each later message carries the short urge text', () => {
  const a = run(onRecord(), [
    { kind: 'submit', origin: COMPOSER, tokens: 446_000 },
    { kind: 'turnStart', turnId: T1 },
    { kind: 'postTool', tokens: 455_000 },
    { kind: 'turnComplete', turnId: T1, reason: 'answer', isAborted: false, tokens: 458_000 },
    { kind: 'submit', origin: { kind: 'task-notification' }, tokens: 458_000 },
  ])
  expect(contexts(a.steps[0]!.fx)[0]).toContain('[AutoHandoff: reminder]')
  expect(contexts(a.steps[2]!.fx)[0]).toContain('[AutoHandoff: hand off now]')
  expect(contexts(a.steps[4]!.fx)[0]).toMatch(/^AutoHandoff: context usage is about 458k tokens, past the 450k handoff threshold/)
  // remind_every_turn: false 时不附
  const b = run(onRecord({ levels: { remind: true, urge: false } }), [{ kind: 'submit', origin: COMPOSER, tokens: 330_000 }], cfgWith({ remind_every_turn: false }))
  expect(contexts(b.all)).toEqual([])
})

test('/autohandoff: toggle, on, off, status and bad arguments; user /clear cancels', () => {
  const cfg = defaultConfig()
  const t = run(newRecord(NOW), [{ kind: 'toggle', args: '' }], cfg)
  expect(t.rec.on).toBe(true)
  expect(ofType(t.all, 'log')[0]!.text).toMatch(/^AutoHandoff is on for this conversation\. Reminders at 300k .* 450k .*\/clear; at 650k/)
  expect(run(t.rec, [{ kind: 'toggle', args: '' }]).rec.on).toBe(false)

  const off = run(armed().rec, [{ kind: 'toggle', args: ' OFF ' }])
  expect(off.rec.on).toBe(false)
  expect(off.rec.job).toBe(null)
  expect(ofType(off.all, 'log').map((l) => l.text)).toContain('AutoHandoff is off for this conversation.')

  const st = run(armed().rec, [
    { kind: 'toggle', args: 'status', tokens: 309_300, window: 1_000_000, problems: ['remind_at should be a whole number, got "300k"; using the default (300000)'], configPath: '/home/user/.claude/autohandoff.md' },
  ])
  const text = ofType(st.all, 'log')[0]!.text
  expect(text).toBe(
    [
      'AutoHandoff is on for this conversation.',
      'Context: 309k of 1000k. Reminders at 300k and 450k, compaction at 650k; reset with /clear.',
      `Handoff: "${HANDOVER}" (armed).`,
      'Configuration: /home/user/.claude/autohandoff.md',
      'Configuration problems (built-in defaults used for these):',
      '  - remind_at should be a whole number, got "300k"; using the default (300000)',
    ].join('\n'),
  )
  expect(st.rec.job?.stage).toBe('armed')

  const bad = run(onRecord(), [{ kind: 'toggle', args: 'enable' }])
  expect(ofType(bad.all, 'log')).toEqual([{ type: 'log', text: 'Usage: /autohandoff [on|off|status] (no argument toggles)' }])
  expect(bad.rec.on).toBe(true)

  for (const command of ['clear', 'compact', 'resume']) {
    const u = run(armed().rec, [{ kind: 'userCommand', command }])
    expect(u.rec.job).toBe(null)
    expect(u.rec.tell).toBe(null)
  }
  expect(run(armed().rec, [{ kind: 'userCommand', command: 'model' }]).rec.job?.stage).toBe('armed')
})

test('/autohandoff off during the compaction at compact_at clears it; its late result is ignored', () => {
  const { rec, seq } = compacting()
  const off = run(rec, [{ kind: 'toggle', args: 'off' }])
  expect(off.rec.fallback).toBe(null)
  expect(ofType(off.all, 'status')).toEqual([{ type: 'status', text: undefined }])
  const late = run(off.rec, [{ kind: 'resetDone', seq }])
  expect(late.rec.fallback).toBe(null)
  expect(ofType(late.all, 'log')[0]!.text).toContain('no longer the current one; ignored')
})

test('a small context window is pointed out once (toast) and in status', () => {
  // 200k 窗口的模型配默认阈值：永远到不了 300k
  const a = run(onRecord(), [
    { kind: 'submit', origin: COMPOSER, tokens: 12_000, window: 200_000 },
    { kind: 'turnStart', turnId: T1 },
    { kind: 'postTool', tokens: 40_000, window: 200_000 },
    { kind: 'submit', origin: COMPOSER, tokens: 60_000, window: 200_000 },
  ])
  expect(ofType(a.all, 'toast')).toEqual([
    {
      type: 'toast',
      text: "AutoHandoff: this model's context window is 200k tokens, not above remind_at (300k), so no reminder will come before Claude Code's own compaction. Lower the thresholds in autohandoff.md.",
    },
  ])
  expect(a.rec.windowWarned).toBe(true)
  const st = ofType(run(a.rec, [{ kind: 'toggle', args: 'status', tokens: 60_000, window: 200_000 }]).all, 'log')[0]!.text
  expect(st).toContain('Context: 60k of 200k.')
  expect(st).toContain('Warning: the context window (200k) is not above remind_at (300k)')
  // 1M 窗口、关着的开关、读不到窗口：都不提示
  expect(ofType(run(onRecord(), [{ kind: 'submit', origin: COMPOSER, tokens: 12_000, window: 1_000_000 }]).all, 'toast')).toEqual([])
  expect(ofType(run(newRecord(NOW), [{ kind: 'submit', origin: COMPOSER, tokens: 12_000, window: 200_000 }]).all, 'toast')).toEqual([])
  expect(ofType(run(onRecord(), [{ kind: 'submit', origin: COMPOSER, tokens: 12_000 }]).all, 'toast')).toEqual([])
  // 阈值配得比窗口低就没问题
  expect(ofType(run(onRecord(), [{ kind: 'submit', origin: COMPOSER, tokens: 12_000, window: 200_000 }], cfgWith({ remind_at: 120_000, urge_at: 150_000, compact_at: 180_000 })).all, 'toast')).toEqual([])
  // /autohandoff on 时也提示一次
  expect(ofType(run(newRecord(NOW), [{ kind: 'toggle', args: 'on', window: 200_000 }]).all, 'toast').length).toBe(1)
})

test('a reload or restart with a registered handoff cancels it and tells the model', () => {
  const a = run(armed().rec, [{ kind: 'start' }])
  expect(a.rec.job).toBe(null)
  expect(a.rec.tell).toBe('reload')
  expect(ofType(a.all, 'toast')).toEqual([{ type: 'toast', text: 'AutoHandoff: handoff cancelled (AutoHandoff was restarted or reloaded before the reset)' }])
  // 续接阶段被重载：直接结束，不告诉新对话的模型
  const { rec, seq } = clearing()
  const b = run(run(rec, [{ kind: 'resetDone', seq }]).rec, [{ kind: 'start' }])
  expect(b.rec.job).toBe(null)
  expect(b.rec.tell).toBe(null)
})

test('a user message racing the queued /clear: let through, no resume message, start context still given', () => {
  const { rec, seq } = clearing()
  const a = run(rec, [{ kind: 'submit', origin: COMPOSER, tokens: 318_400 }, { kind: 'resetDone', seq }, { kind: 'sessionStart', source: 'clear' }])
  expect(ofType(a.all, 'resume')).toEqual([])
  expect(contexts(a.steps[2]!.fx)[0]).toContain(`"${HANDOVER}"`)
  expect(a.rec.job).toBe(null)
  // 代理类消息不算用户接手
  const b = run(rec, [{ kind: 'submit', origin: { kind: 'task-notification' } }, { kind: 'resetDone', seq }])
  expect(ofType(b.all, 'resume').length).toBe(1)
})

test('a user message during the resuming stage: the model sees nothing extra, the resume result still closes the job', () => {
  const { rec, seq } = clearing()
  const resuming = run(rec, [{ kind: 'resetDone', seq }]).rec
  const a = run(resuming, [{ kind: 'submit', origin: COMPOSER, tokens: 9_000 }])
  expect(a.rec.job?.stage).toBe('resuming')
  expect(contexts(a.all)).toEqual([])
  expect(run(a.rec, [{ kind: 'resumeDone', seq }]).rec.job).toBe(null)
})

test('default_on takes effect at the first human message; teammates never switch on, but a human message or /autohandoff clears a wrong teammate mark', () => {
  const cfg = cfgWith({ default_on: true })
  const fresh = newRecord(NOW)
  // teammate 进程：先收到 team-lead 的 receive，回合从不经过人工输入
  const mate = run(fresh, [{ kind: 'teammate' }, { kind: 'turnStart', turnId: T1 }, { kind: 'postTool', tokens: 480_000 }, REG], cfg)
  expect(contexts(mate.all)).toEqual([])
  expect(mate.steps[3]!.reply).toBe('Not registered: AutoHandoff is off for this conversation.')
  // 收到过人工输入的对话不可能是 teammate：team-lead 的投递（进程内 teammate 模式下 lead 也会收到）不改任何东西
  const lead = run(armed().rec, [{ kind: 'teammate' }])
  expect(lead.rec.teammate).toBe(false)
  expect(lead.rec.job?.stage).toBe('armed')
  expect(ofType(lead.all, 'log')[0]!.text).toBe('ignored a team-lead delivery: this conversation has had input from the user')
  // 先来的是任务通知：还不生效
  const n = run(fresh, [{ kind: 'submit', origin: { kind: 'task-notification' }, tokens: 320_000 }], cfg)
  expect(contexts(n.all)).toEqual([])
  expect(n.rec.human).toBe(false)
  // 人工输入之后生效
  const h = run(n.rec, [{ kind: 'submit', origin: COMPOSER, tokens: 320_000 }], cfg)
  expect(h.rec.human).toBe(true)
  expect(contexts(h.all)[0]).toContain('[AutoHandoff: reminder]')
  // 显式 off 优先于 default_on
  expect(contexts(run({ ...h.rec, on: false, levels: { remind: false, urge: false } }, [{ kind: 'submit', origin: COMPOSER, tokens: 320_000 }], cfg).all)).toEqual([])
  // 误标为 teammate 的进程：人工输入或 /autohandoff 一来就撤销标记（teammate 从不收到这两种）
  const wrong = run(fresh, [{ kind: 'teammate' }, { kind: 'toggle', args: 'on' }, { kind: 'postTool', tokens: 320_000 }], cfg)
  expect(wrong.rec.teammate).toBe(false)
  expect(contexts(wrong.all)[0]).toContain('[AutoHandoff: reminder]')
  const wrong2 = run(fresh, [{ kind: 'teammate' }, { kind: 'submit', origin: COMPOSER, tokens: 320_000 }], cfg)
  expect(wrong2.rec.teammate).toBe(false)
  expect(contexts(wrong2.all)[0]).toContain('[AutoHandoff: reminder]')
})

test('compact_at: a turn ending past it with no handoff compacts; the levels reset afterwards', () => {
  const a = run(onRecord({ levels: { remind: true, urge: true } }), [
    { kind: 'turnStart', turnId: T1 },
    { kind: 'stop', active: false, tokens: 652_000 },
    { kind: 'stop', active: true, tokens: 655_000 },
    { kind: 'turnComplete', turnId: T1, reason: 'answer', isAborted: false, tokens: 655_000 },
  ])
  const c = ofType(a.steps[3]!.fx, 'compact')
  expect(c.length).toBe(1)
  expect(c[0]!.seq).toBe(1)
  expect(ofType(a.steps[3]!.fx, 'timer')).toEqual([{ type: 'timer', ms: WAIT }])
  expect(a.rec.fallback).toEqual({ seq: 1, since: NOW })
  expect(ofType(a.all, 'status').at(-1)).toEqual({ type: 'status', text: 'compacting (no handoff registered)' })
  // 压缩期间不登记、不提醒；再来一个回合结束也不重复排队
  const mid = run(a.rec, [
    REG,
    { kind: 'submit', origin: { kind: 'task-notification' }, tokens: 655_000 },
    { kind: 'turnStart', turnId: T2 },
    { kind: 'stop', active: false, tokens: 658_000 },
    { kind: 'turnComplete', turnId: T2, reason: 'answer', isAborted: false, tokens: 658_000 },
  ])
  expect(mid.steps[0]!.reply).toBe('Not registered: a compaction is in progress.')
  expect(contexts(mid.all)).toEqual([])
  expect(ofType(mid.all, 'compact')).toEqual([])
  const b = run(a.rec, [{ kind: 'sessionStart', source: 'compact' }, { kind: 'resetDone', seq: 1 }])
  expect(contexts(b.all)).toEqual([])
  expect(ofType(b.all, 'resume')).toEqual([])
  expect(b.rec.fallback).toBe(null)
  expect(b.rec.levels).toEqual({ remind: false, urge: false })
  // 被 Esc、工具被拒、用户关掉时都不压缩
  const urged = onRecord({ levels: { remind: true, urge: true } })
  expect(ofType(run(urged, [{ kind: 'turnStart', turnId: T1 }, { kind: 'turnComplete', turnId: T1, reason: 'aborted', isAborted: true, tokens: 660_000 }]).all, 'compact')).toEqual([])
  expect(ofType(run(urged, [{ kind: 'turnStart', turnId: T1 }, { kind: 'turnComplete', turnId: T1, reason: 'answer', isAborted: false, tokens: 660_000 }]).all, 'compact')).toEqual([])
  expect(ofType(run({ ...urged, on: false }, [{ kind: 'turnStart', turnId: T1 }, { kind: 'stop', active: false }, { kind: 'turnComplete', turnId: T1, reason: 'answer', isAborted: false, tokens: 660_000 }]).all, 'compact')).toEqual([])
})

test('compact_at: after an Esc veto it waits for the next human message; after repeated failures it gives up', () => {
  // 用户按 Esc 否决了排队的压缩：后面子代理汇报开的回合不再排队，用户发一句话后才再试
  const v = compacting()
  const vetoed = run(v.rec, [{ kind: 'resetFailed', seq: v.seq, message: VETO }])
  expect(vetoed.rec.fallback).toBe(null)
  expect(vetoed.rec.fallbackHeld).toBe(true)
  expect(ofType(vetoed.all, 'toast')).toEqual([])
  const agentTurn = run(vetoed.rec, [
    { kind: 'submit', origin: { kind: 'task-notification' }, tokens: 660_000 },
    { kind: 'turnStart', turnId: T2 },
    { kind: 'stop', active: false, tokens: 662_000 },
    { kind: 'turnComplete', turnId: T2, reason: 'answer', isAborted: false, tokens: 662_000 },
  ])
  expect(ofType(agentTurn.all, 'compact')).toEqual([])
  expect(ofType(run(agentTurn.rec, [{ kind: 'toggle', args: 'status', tokens: 662_000 }]).all, 'log')[0]!.text).toContain('called off by you; it will be tried again after your next message')
  const humanTurn = run(agentTurn.rec, [
    { kind: 'submit', origin: COMPOSER, tokens: 662_000 },
    { kind: 'turnStart', turnId: T2 },
    { kind: 'stop', active: false, tokens: 665_000 },
    { kind: 'turnComplete', turnId: T2, reason: 'answer', isAborted: false, tokens: 665_000 },
  ])
  expect(ofType(humanTurn.all, 'compact').length).toBe(1)

  // 压缩本身失败（比如 prompt too long）：每次都有 toast，连续 3 次后不再试，status 里说明
  let rec = onRecord({ levels: { remind: true, urge: true } })
  const toasts: string[] = []
  for (let i = 0; i < FALLBACK_MAX_FAILS; i++) {
    const c = compacting(rec)
    expect(ofType(c.trace.all, 'compact').length).toBe(1)
    const f = run(c.rec, [{ kind: 'resetFailed', seq: c.seq, message: 'autohandoff: $.command.run: Error: prompt is too long' }])
    toasts.push(...ofType(f.all, 'toast').map((t) => t.text))
    rec = f.rec
  }
  const noMore = run(rec, bigTurn())
  expect(ofType(noMore.all, 'compact')).toEqual([])
  rec = noMore.rec
  expect(toasts).toEqual([
    'AutoHandoff: the compaction failed (autohandoff: $.command.run: Error: prompt is too long)',
    'AutoHandoff: the compaction failed (autohandoff: $.command.run: Error: prompt is too long)',
    'AutoHandoff: the compaction failed (autohandoff: $.command.run: Error: prompt is too long); giving up after 3 failures in this conversation',
  ])
  expect(rec.fallbackFails).toBe(3)
  expect(ofType(run(rec, [{ kind: 'toggle', args: 'status', tokens: 652_000 }]).all, 'log')[0]!.text).toContain('given up after 3 failures in this conversation')
  // 成功一次就清零
  const again = compacting(onRecord({ levels: { remind: true, urge: true }, fallbackFails: 2 }))
  expect(run(again.rec, [{ kind: 'resetDone', seq: again.seq }]).rec.fallbackFails).toBe(0)
})

test('wait_minutes: the timer cancels a registration whose turn never ended, and a reset that never settles', () => {
  const a = armed()
  expect(run(a.rec, [[{ kind: 'tick' }, NOW + WAIT - MIN]]).rec.job?.stage).toBe('armed')
  const b = run(a.rec, [[{ kind: 'tick' }, NOW + WAIT]])
  expect(b.rec.job).toBe(null)
  expect(b.rec.tell).toBe('timeout')
  expect(ofType(b.all, 'notify')).toEqual([{ type: 'notify', text: 'AutoHandoff: handoff cancelled (the turn did not end within 60 minutes of registering)' }])
  expect(ofType(b.all, 'toast')).toEqual([{ type: 'toast', text: 'AutoHandoff: handoff cancelled (the turn did not end within 60 minutes of registering)' }])

  // clear 排队了却一直没有结果（接线漏了 .catch 之类）：从发出时刻算 wait_minutes 后静默放弃，不告诉模型
  const issuedLate = run(armed().rec, [[{ kind: 'stop', active: false }, NOW + 50 * MIN], [DONE, NOW + 50 * MIN]])
  expect(issuedLate.rec.job?.stage).toBe('clearing')
  // 登记后 60 分钟的 tick（armed 的计时器）到了：clear 才发出 10 分钟，不动
  expect(run(issuedLate.rec, [[{ kind: 'tick' }, NOW + WAIT]]).rec.job?.stage).toBe('clearing')
  const stuck = run(issuedLate.rec, [[{ kind: 'tick' }, NOW + 50 * MIN + WAIT]])
  expect(stuck.rec.job).toBe(null)
  expect(stuck.rec.tell).toBe(null)
  expect(ofType(stuck.all, 'toast')).toEqual([])
  expect(ofType(stuck.all, 'log')[0]!.text).toBe('handoff cancelled: no result from /clear within 60 minutes; giving up on request 1')
  expect(ofType(stuck.all, 'status')).toEqual([{ type: 'status', text: undefined }])
  // 之后登记又能受理
  expect(run(stuck.rec, [[REG, NOW + 50 * MIN + WAIT]]).rec.job?.stage).toBe('armed')

  // 兜底压缩同样有出口
  const fb = compacting()
  expect(run(fb.rec, [[{ kind: 'tick' }, NOW + WAIT - MIN]]).rec.fallback).not.toBe(null)
  const fbStuck = run(fb.rec, [[{ kind: 'tick' }, NOW + WAIT]])
  expect(fbStuck.rec.fallback).toBe(null)
  expect(ofType(fbStuck.all, 'toast')).toEqual([])

  // 续接结果迟迟不来：只是收尾，不告诉模型
  const { rec, seq } = clearing()
  const r = run(rec, [{ kind: 'resetDone', seq }, [{ kind: 'tick' }, NOW + RESUME_STUCK_MS]])
  expect(r.rec.job).toBe(null)
  expect(r.rec.tell).toBe(null)
})

test('session end (not /clear) cancels; CC auto-compaction mid-turn keeps the registration', () => {
  expect(run(armed().rec, [{ kind: 'sessionEnd', reason: 'clear' }]).rec.job?.stage).toBe('armed')
  expect(run(armed().rec, [{ kind: 'sessionEnd', reason: 'prompt_input_exit' }]).rec.job).toBe(null)
  const a = run(armed().rec, [{ kind: 'sessionStart', source: 'compact' }])
  expect(a.rec.job?.stage).toBe('armed')
  expect(contexts(a.all)).toEqual([])
  expect(run(armed().rec, [{ kind: 'sessionStart', source: 'clear' }]).rec.job).toBe(null)
})

test('crossing both levels in one step sends only the urge; tokens unknown after compaction change nothing', () => {
  const a = run(onRecord(), [{ kind: 'turnStart', turnId: T1 }, { kind: 'postTool', tokens: 471_000 }, { kind: 'postTool', tokens: 475_000 }])
  const ctx = contexts(a.all)
  expect(ctx.length).toBe(1)
  expect(ctx[0]).toContain('[AutoHandoff: hand off now]')
  const b = run(a.rec, [{ kind: 'sessionStart', source: 'compact' }, { kind: 'submit', origin: COMPOSER }, { kind: 'turnStart', turnId: T2 }, { kind: 'postTool', tokens: 61_000 }])
  expect(contexts(b.all)).toEqual([])
  expect(b.rec.levels).toEqual({ remind: false, urge: false })
})

test('a pending cancel notice does not follow a manual /clear into the new conversation', () => {
  const a = run(armed().rec, [{ kind: 'turnComplete', turnId: T1, reason: 'error', isAborted: false }])
  expect(a.rec.tell).toBe('api_error')
  const moved = migrateRecord(run(a.rec, [{ kind: 'userCommand', command: 'clear' }]).rec, NOW + MIN)
  const first = run(moved, [{ kind: 'submit', origin: COMPOSER, tokens: 8_000 }])
  expect(contexts(first.all)).toEqual([])
  expect(first.rec.on).toBe(true)
})

test('transition never mutates its input record', () => {
  const rec = armed().rec
  const copy = JSON.parse(JSON.stringify(rec))
  transition(rec, { kind: 'submit', origin: COMPOSER, tokens: 330_000 }, { cfg: defaultConfig(), now: NOW })
  transition(rec, { kind: 'stop', active: false }, { cfg: defaultConfig(), now: NOW })
  transition(rec, { kind: 'turnComplete', turnId: T1, reason: 'answer', isAborted: false, tokens: 318_400, file: FILE_OK }, { cfg: defaultConfig(), now: NOW })
  expect(rec).toEqual(copy)
})

// ───────── 重置已排队（clearing/compacting）：命令撤不回，job 不再作废（PLAN §0 第 20 条） ─────────

test('a queued reset is not withdrawn by the user\'s /clear, /compact or /resume: logged, toasted, and the reset still resumes', () => {
  for (const command of ['clear', 'compact', 'resume']) {
    const { rec, seq } = clearing()
    const u = run(rec, [{ kind: 'userCommand', command }])
    expect(u.rec.job?.stage).toBe('clearing')
    expect(u.rec.tell).toBe(null)
    // /resume：选择器打开时就收到，切不切走还不知道，提示如实说两种结果
    const toast = command === 'resume'
      ? 'AutoHandoff: /clear is already queued and cannot be withdrawn. If you stay in this conversation, it continues from the handoff file; if you switch to another conversation, the queued /clear applies to that one instead, without resuming.'
      : QUEUED_TOAST
    expect(ofType(u.all, 'toast')).toEqual([{ type: 'toast', text: toast }])
    expect(ofType(u.all, 'log')[0]!.text).toBe(`the user ran /${command}, but /clear is already queued (request ${seq}); the handoff is kept`)
    expect(ofType(u.all, 'status')).toEqual([])
    const done = run(migrateRecord(u.rec, NOW), [{ kind: 'resetDone', seq }, { kind: 'sessionStart', source: 'clear' }])
    expect(ofType(done.all, 'resume').length).toBe(1)
    expect(contexts(done.all)[0]).toContain(`Handoff file: "${HANDOVER}"`)
  }
  // 登记中（还没排队）照旧静默作废
  expect(run(armed().rec, [{ kind: 'userCommand', command: 'compact' }]).rec.job).toBe(null)
})

test('the user\'s own /compact running before the queued /clear: its SessionStart(compact) is not the new conversation', () => {
  const { rec, seq } = clearing()
  const a = run(rec, [
    { kind: 'userCommand', command: 'compact' },
    { kind: 'sessionStart', source: 'compact' },
  ])
  expect(contexts(a.all)).toEqual([])
  expect(a.rec.job?.stage).toBe('clearing')
  expect(a.rec.job?.ctxGiven).toBe(false)
  expect(ofType(a.steps[1]!.fx, 'log')[0]!.text).toBe('a /compact not run by AutoHandoff finished while /clear is queued; still waiting for it')
  // 然后自家的 /clear：新对话照常拿到 start_context 和续接
  const b = run(migrateRecord(a.rec, NOW), [{ kind: 'resetDone', seq }, { kind: 'sessionStart', source: 'clear' }, { kind: 'resumeDone', seq }])
  expect(ofType(b.all, 'resume').length).toBe(1)
  expect(contexts(b.all).length).toBe(1)
  expect(b.rec.job).toBe(null)
})

test('/autohandoff off while the reset is queued: the reset still resumes, and the new conversation is off', () => {
  const { rec, seq } = clearing()
  const off = run(rec, [{ kind: 'toggle', args: 'off' }])
  expect(off.rec.on).toBe(false)
  expect(off.rec.job?.stage).toBe('clearing')
  expect(ofType(off.all, 'toast')).toEqual([{ type: 'toast', text: QUEUED_TOAST }])
  expect(ofType(off.all, 'log').map((l) => l.text)).toContain(
    'AutoHandoff is off for this conversation. The reset already queued still runs and continues from the handoff file; AutoHandoff stays off after it.',
  )
  const moved = migrateRecord(off.rec, NOW)
  const after = run(moved, [{ kind: 'resetDone', seq }, { kind: 'sessionStart', source: 'clear' }, { kind: 'resumeDone', seq }])
  expect(ofType(after.all, 'resume').length).toBe(1)
  expect(after.rec.on).toBe(false)
  // 新对话里越过 remind 也不提醒
  const later = run(after.rec, [{ kind: 'submit', origin: COMPOSER, tokens: 320_000 }, { kind: 'turnStart', turnId: T2 }, { kind: 'postTool', tokens: 330_000 }])
  expect(contexts(later.all)).toEqual([])
  // compact 路径同样
  const cfg = cfgWith({ action: 'compact' })
  const c = clearing(cfg)
  expect(c.rec.job?.stage).toBe('compacting')
  expect(run(c.rec, [{ kind: 'toggle', args: 'off' }], cfg).rec.job?.stage).toBe('compacting')
})

test('a reload while the reset is queued: the job is kept as an orphan and the new conversation\'s SessionStart resumes it', () => {
  const { rec, seq } = clearing()
  const r = run(rec, [[{ kind: 'start' }, NOW + 2 * MIN]])
  expect(r.rec.job?.stage).toBe('clearing')
  expect(r.rec.job?.orphan).toBe(true)
  expect(r.rec.tell).toBe(null)
  expect(ofType(r.all, 'toast')).toEqual([])
  // 计时器停了：按发出时刻重挂剩下的时间
  expect(ofType(r.all, 'timer')).toEqual([{ type: 'timer', ms: WAIT - 2 * MIN }])
  // 旧模块的回调没来：SessionStart(clear) 给 start_context 并提交续接
  const ss = run(migrateRecord(r.rec, NOW + 3 * MIN), [[{ kind: 'sessionStart', source: 'clear' }, NOW + 3 * MIN]])
  expect(contexts(ss.all)[0]).toContain(`Handoff file: "${HANDOVER}"`)
  const resume = ofType(ss.all, 'resume')
  expect(resume.length).toBe(1)
  expect(resume[0]!.seq).toBe(seq)
  expect(ss.rec.job?.stage).toBe('resuming')
  // 旧回调要是晚到了：不是当前请求，忽略，不会再续接一次
  const late = run(ss.rec, [{ kind: 'resetDone', seq }])
  expect(ofType(late.all, 'resume')).toEqual([])
  expect(run(late.rec, [{ kind: 'resumeDone', seq }]).rec.job).toBe(null)
  // 旧回调先到（模块没丢回调时）：照常走 resetDone，SessionStart 只给 start_context
  const first = run(migrateRecord(r.rec, NOW), [{ kind: 'resetDone', seq }, { kind: 'sessionStart', source: 'clear' }])
  expect(ofType(first.all, 'resume').length).toBe(1)
  expect(contexts(first.all).length).toBe(1)
  // 用户在重置期间说过话：不续接
  const took = run(rec, [{ kind: 'submit', origin: COMPOSER, tokens: 318_400 }, { kind: 'start' }, { kind: 'sessionStart', source: 'clear' }])
  expect(ofType(took.all, 'resume')).toEqual([])
  expect(took.rec.job).toBe(null)
  // 重启时离发出已过 wait_minutes：放弃
  const stale = run(rec, [[{ kind: 'start' }, NOW + WAIT]])
  expect(stale.rec.job).toBe(null)
  expect(ofType(stale.all, 'log')[0]!.text).toBe('handoff cancelled: restarted, and no result from /clear within 60 minutes')
  // compact：同一个 sid，SessionStart(compact) 补上续接
  const cfg = cfgWith({ action: 'compact' })
  const c = clearing(cfg)
  const cr = run(c.rec, [{ kind: 'start' }, { kind: 'sessionStart', source: 'compact' }], cfg)
  expect(ofType(cr.all, 'resume')[0]!.text).toContain('(/compact)')
})

test('a team-lead delivery while the reset is queued keeps the job; migration drops the compaction at compact_at', () => {
  // human 为假、显式打开的对话（例如 --resume 回来、还没打字）
  const rec: Rec = { ...clearing().rec, human: false }
  const t = run(rec, [{ kind: 'teammate' }])
  expect(t.rec.teammate).toBe(true)
  expect(t.rec.job?.stage).toBe('clearing')
  const m = migrateRecord(onRecord({ fallback: { seq: 3, since: NOW }, seq: 3 }), NOW)
  expect(m.fallback).toBe(null)
})

test('registration steps say whether they were accepted', () => {
  const a = armed()
  expect(a.steps[4]!.accepted).toBe(true)
  expect(run(a.rec, [{ kind: 'register', verdict: { ok: false, why: 'the file is empty' } }]).steps[0]!.accepted).toBe(false)
  expect(run(newRecord(NOW), [REG]).steps[0]!.accepted).toBe(false)
})

// ───────── 第 3 批：作废全集（事件 × 状态）、isMeta、连环交接、compact 窗口、Stop 叠加、重启与热重载 ─────────

const CFG_COMPACT = cfgWith({ action: 'compact' })

/** 各状态的记录：没有 job、登记中、/clear 已排队、/compact 已排队、续接中、兜底压缩中 */
function states(): Record<string, { rec: Rec; seq: number; cfg: ReturnType<typeof defaultConfig> }> {
  const c = clearing()
  const k = clearing(CFG_COMPACT)
  const f = compacting()
  return {
    idle: { rec: onRecord({ levels: { remind: true, urge: false } }), seq: 0, cfg: defaultConfig() },
    armed: { rec: armed().rec, seq: 0, cfg: defaultConfig() },
    clearing: { rec: c.rec, seq: c.seq, cfg: defaultConfig() },
    compacting: { rec: k.rec, seq: k.seq, cfg: CFG_COMPACT },
    resuming: { rec: run(c.rec, [{ kind: 'resetDone', seq: c.seq }]).rec, seq: c.seq, cfg: defaultConfig() },
    fallback: { rec: f.rec, seq: f.seq, cfg: defaultConfig() },
  }
}

/** 一步之后的形态：job 的阶段（没有 job 为 none）、兜底压缩在不在、挂着的作废说明、重置排队期间用户是否已接手 */
function shape(r: Rec): string {
  return `${r.job ? r.job.stage : 'none'}${r.fallback ? '+fallback' : ''}${r.tell ? ` tell:${r.tell}` : ''}${r.job?.userTook ? ' took' : ''}`
}

test('cancel matrix: every event that can cancel, in every state (PLAN §3.3 and §0 items 20, 21, 23, 24)', () => {
  const S = ['idle', 'armed', 'clearing', 'compacting', 'resuming', 'fallback'] as const
  // 第 4 项（可选）：送事件前先改记录
  type Row = [string, (seq: number) => Ev | [Ev, number], Record<(typeof S)[number], string>, ((r: Rec) => Rec)?]
  const kept = { idle: 'none', armed: 'armed', clearing: 'clearing', compacting: 'compacting', resuming: 'resuming', fallback: 'none+fallback' }
  // 人工消息作废登记时，作废说明当场附在这条消息上（tell 随即清空）；排队中的重置则记下用户已接手
  const tookOver = { ...kept, armed: 'none', clearing: 'clearing took', compacting: 'compacting took' }
  const rows: Row[] = [
    // 消息：人工、来源不明、引擎 meta、代理、自家
    ['human message', () => ({ kind: 'submit', origin: COMPOSER, tokens: 320_000 }), tookOver],
    ['unclassified message without isMeta', () => ({ kind: 'submit', origin: { kind: 'unclassified' }, tokens: 320_000 }), tookOver],
    ['engine meta message (unclassified + isMeta)', () => ({ kind: 'submit', origin: { kind: 'unclassified' }, isMeta: true, tokens: 320_000 }), kept],
    ['task notification', () => ({ kind: 'submit', origin: { kind: 'task-notification' }, tokens: 320_000 }), kept],
    ['own resume message', () => ({ kind: 'submit', origin: { kind: 'plugin', name: 'autohandoff' }, tokens: 9_000 }), kept],
    // 用户命令与开关
    ['user /clear', () => ({ kind: 'userCommand', command: 'clear' }), { ...kept, armed: 'none', resuming: 'none' }],
    ['user /compact', () => ({ kind: 'userCommand', command: 'compact' }), { ...kept, armed: 'none', resuming: 'none' }],
    ['user /resume', () => ({ kind: 'userCommand', command: 'resume' }), { ...kept, armed: 'none', resuming: 'none' }],
    ['user /model (not a reset)', () => ({ kind: 'userCommand', command: 'model' }), kept],
    ['/autohandoff off', () => ({ kind: 'toggle', args: 'off' }), { ...kept, armed: 'none', resuming: 'none', fallback: 'none' }],
    ['/autohandoff status', () => ({ kind: 'toggle', args: 'status' }), kept],
    // 进程：热重载（命令还在本进程排队）、进程重启、会话结束
    ['hot reload', () => ({ kind: 'start', queuedHere: true }), { ...kept, armed: 'none tell:reload', resuming: 'none', fallback: 'none' }],
    [
      'process restart',
      () => ({ kind: 'start', queuedHere: false }),
      { ...kept, armed: 'none tell:reload', clearing: 'none tell:reload', compacting: 'none tell:reload', resuming: 'none', fallback: 'none' },
    ],
    // agent team 的 teammate 标记（只对没收到过人工输入的进程起作用）
    [
      'team-lead delivery (teammate)',
      () => ({ kind: 'teammate' }),
      { ...kept, armed: 'none', resuming: 'none' },
      (r) => ({ ...r, human: false }),
    ],
    ['session end (exit)', () => ({ kind: 'sessionEnd', reason: 'prompt_input_exit' }), { idle: 'none', armed: 'none', clearing: 'none', compacting: 'none', resuming: 'none', fallback: 'none' }],
    ['session end (clear)', () => ({ kind: 'sessionEnd', reason: 'clear' }), kept],
    // 回合结束的各种方式（turnId 对不上的回合：只有 armed 关心）
    ['turn interrupted (Esc)', () => ({ kind: 'turnComplete', turnId: T1, reason: 'aborted', isAborted: true, tokens: 320_000 }), { ...kept, armed: 'none' }],
    ['turn ended with an API error', () => ({ kind: 'turnComplete', turnId: T1, reason: 'error', isAborted: false, tokens: 320_000 }), { ...kept, armed: 'none tell:api_error' }],
    ['turn ended without Stop (tool rejected)', () => ({ kind: 'turnComplete', turnId: T1, reason: 'answer', isAborted: false, tokens: 320_000, file: FILE_OK }), { ...kept, armed: 'none' }],
    // 计时：登记后 / 发出后 / 续接后都已超时
    ['timer past every limit', () => [{ kind: 'tick' }, NOW + 2 * WAIT], { ...kept, armed: 'none tell:timeout', clearing: 'none', compacting: 'none', resuming: 'none', fallback: 'none' }],
    // 自家命令的结果
    ['own reset vetoed by Esc', (seq) => ({ kind: 'resetFailed', seq, message: VETO }), { ...kept, clearing: 'none', compacting: 'none', fallback: 'none' }],
    [
      'own reset failed',
      (seq) => ({ kind: 'resetFailed', seq, message: 'autohandoff: $.command.run: Error: Not enough messages to compact' }),
      { ...kept, clearing: 'none tell:reset_failed', compacting: 'none tell:reset_failed', fallback: 'none' },
    ],
    // 会话开始
    ['SessionStart(clear) not from AutoHandoff', () => ({ kind: 'sessionStart', source: 'clear' }), { ...kept, armed: 'none' }],
    ['SessionStart(compact) not from AutoHandoff', () => ({ kind: 'sessionStart', source: 'compact' }), kept],
  ]
  const fails: string[] = []
  for (const [name, make, want, prep] of rows) {
    const all = states()
    for (const st of S) {
      const { rec, seq, cfg } = all[st]
      const got = shape(run(prep ? prep(rec) : rec, [make(seq)], cfg).rec)
      if (got !== want[st]) fails.push(`${name} @ ${st}: got ${got}, want ${want[st]}`)
    }
  }
  expect(fails).toEqual([])
})

test('isMeta: an engine notice (unclassified + isMeta) never cancels, never counts as the user taking over, adds nothing, and is not human input', () => {
  const META: Ev = { kind: 'submit', origin: { kind: 'unclassified' }, isMeta: true, tokens: 320_000 }
  const a = run(armed().rec, [META])
  expect(a.rec.job?.stage).toBe('armed')
  expect(contexts(a.all)).toEqual([])
  expect(ofType(a.all, 'toast')).toEqual([])
  expect(ofType(a.all, 'log')[0]!.text).toBe('an engine notice (unclassified, isMeta) arrived while armed; the handoff is kept')
  // 排队中：不算用户接手，重置后照常续接
  const { rec, seq } = clearing()
  const q = run(rec, [META, { kind: 'resetDone', seq }])
  expect(q.rec.job?.userTook).toBe(false)
  expect(ofType(q.all, 'resume').length).toBe(1)
  expect(contexts(q.all)).toEqual([])
  // 不算人工输入：default_on 不因它生效；提醒与挂着的作废说明也不附在它上面
  const cfg = cfgWith({ default_on: true })
  const fresh = run(newRecord(NOW), [META], cfg)
  expect(fresh.rec.human).toBe(false)
  expect(contexts(fresh.all)).toEqual([])
  const told = run(armed().rec, [{ kind: 'turnComplete', turnId: T1, reason: 'error', isAborted: false }, META])
  expect(told.rec.tell).toBe('api_error')
  expect(contexts(told.steps[1]!.fx)).toEqual([])
  // 只认这一种组合：没有 isMeta 的 unclassified、带 isMeta 的 composer 仍按用户消息作废
  const unknown = run(armed().rec, [{ kind: 'submit', origin: { kind: 'unclassified' }, tokens: 320_000 }])
  expect(unknown.rec.job).toBe(null)
  expect(contexts(unknown.all)[0]).toContain('cancelled (a new message arrived that was not typed by the user')
  const typed = run(armed().rec, [{ kind: 'submit', origin: COMPOSER, isMeta: true, tokens: 320_000 }])
  expect(typed.rec.job).toBe(null)
  expect(contexts(typed.all)[0]).toContain('cancelled (a new message from the user arrived)')
  expect(typed.rec.human).toBe(true)
})

/** 续接已提交的新对话（action 默认 clear） */
function resumed(cfg = defaultConfig()) {
  const { rec, seq } = clearing(cfg)
  return run(migrateRecord(rec, NOW), [{ kind: 'resetDone', seq }, { kind: 'sessionStart', source: cfg.settings.action }, { kind: 'resumeDone', seq }], cfg).rec
}

test('chain guard: a conversation just continued from a handoff refuses to register until it passes remind_at or the user writes', () => {
  const r = resumed()
  expect(r.resumed).toBe(true)
  expect(r.job).toBe(null)
  const REASON =
    'Not registered: this conversation has just been continued from a handoff file and its context is below the first threshold (300k). ' +
    'Carry on with the work the handoff file describes instead of handing off again; registering works again once context usage passes 300k or the user sends a message.'
  // 续接回合里模型照着交接文件里的「继续交接」又去登记：拒绝
  const a = run(r, [{ kind: 'turnStart', turnId: T2 }, { kind: 'postTool', tokens: 61_000 }, { kind: 'register', verdict: FILE_OK, tokens: 63_000 }])
  expect(a.steps[2]!.reply).toBe(REASON)
  expect(a.steps[2]!.accepted).toBe(false)
  expect(a.rec.job).toBe(null)
  // 读不到用量时也拒绝（宁可不交接）
  expect(run(r, [{ kind: 'register', verdict: FILE_OK }]).steps[0]!.reply).toBe(REASON)
  // 任务通知、引擎 meta 消息不解除
  const notes = run(r, [
    { kind: 'submit', origin: { kind: 'task-notification' }, tokens: 64_000 },
    { kind: 'submit', origin: { kind: 'unclassified' }, isMeta: true, tokens: 64_000 },
    { kind: 'register', verdict: FILE_OK, tokens: 64_000 },
  ])
  expect(notes.steps[2]!.accepted).toBe(false)
  // 人工消息解除
  const human = run(r, [{ kind: 'submit', origin: COMPOSER, tokens: 64_000 }, { kind: 'register', verdict: FILE_OK, tokens: 64_000 }])
  expect(human.rec.resumed).toBe(false)
  expect(human.steps[1]!.accepted).toBe(true)
  // 越过 remind_at 解除：送了 remind 之后登记照常受理
  const big = run(r, [{ kind: 'turnStart', turnId: T2 }, { kind: 'postTool', tokens: 305_000 }, { kind: 'register', verdict: FILE_OK, tokens: 306_000 }])
  expect(contexts(big.steps[1]!.fx)[0]).toContain('[AutoHandoff: reminder]')
  expect(big.rec.resumed).toBe(false)
  expect(big.steps[2]!.accepted).toBe(true)
  // 登记时用量已过 remind_at（提醒还没来得及送）也受理
  expect(run(r, [{ kind: 'register', verdict: FILE_OK, tokens: 301_000 }]).steps[0]!.accepted).toBe(true)
  // compact 路径同样
  expect(resumed(CFG_COMPACT).resumed).toBe(true)
  // 用户在重置期间发过消息（接手了）：不挡
  const { rec, seq } = clearing()
  const took = run(rec, [{ kind: 'submit', origin: COMPOSER, tokens: 318_400 }, { kind: 'resetDone', seq }])
  expect(took.rec.resumed).toBe(false)
  // 用户自己 /clear 出来的新对话不带这个标记
  expect(migrateRecord({ ...r, resumed: true }, NOW).resumed).toBe(false)
})

test('chain guard prompts: the handoff instructions say next steps are the work itself, never "hand off again"', () => {
  const p = defaultConfig().prompts
  expect(p.remind).toContain('Under next steps write the work itself; never write "hand off", "write a handoff" or "continue the handoff" there')
  expect(p.urge).toContain('Under next steps write the work itself, not "hand off" or "continue the handoff".')
  expect(p.cancelled).toContain('(next steps are the work itself, never "hand off again")')
  expect(p.start_context).toContain('do not hand off again unless a new AutoHandoff reminder asks for it')
})

test('compact window (action compact): a human message, an agent message, /autohandoff off and an engine notice while /compact runs', () => {
  const cfg = CFG_COMPACT
  const { rec, seq } = clearing(cfg)
  expect(rec.job?.stage).toBe('compacting')
  // 人工消息：放行，压缩后不提交续接（用户接手），SessionStart(compact) 照样给交接
  const h = run(rec, [{ kind: 'submit', origin: COMPOSER, tokens: 318_000 }, { kind: 'sessionStart', source: 'compact' }, { kind: 'resetDone', seq }], cfg)
  expect(contexts(h.steps[0]!.fx)).toEqual([])
  expect(contexts(h.steps[1]!.fx)[0]).toContain(`Handoff file: "${HANDOVER}"`)
  expect(ofType(h.all, 'resume')).toEqual([])
  expect(h.rec.job).toBe(null)
  expect(h.rec.resumed).toBe(false)
  // resolve 先到、SessionStart 后到：同样只给交接、不续接
  const h2 = run(rec, [{ kind: 'submit', origin: COMPOSER, tokens: 318_000 }, { kind: 'resetDone', seq }, { kind: 'sessionStart', source: 'compact' }], cfg)
  expect(ofType(h2.all, 'resume')).toEqual([])
  expect(contexts(h2.steps[2]!.fx).length).toBe(1)
  expect(h2.rec.job).toBe(null)
  // 代理消息：附 reset_note，压缩后照常续接
  const a = run(rec, [{ kind: 'submit', origin: { kind: 'task-notification' }, tokens: 318_000 }, { kind: 'sessionStart', source: 'compact' }, { kind: 'resetDone', seq }], cfg)
  expect(contexts(a.steps[0]!.fx)[0]).toContain('The conversation is about to be reset with /compact')
  expect(ofType(a.all, 'resume').length).toBe(1)
  // /autohandoff off：压缩照样完成并续接，之后是关的
  const off = run(rec, [{ kind: 'toggle', args: 'off' }, { kind: 'sessionStart', source: 'compact' }, { kind: 'resetDone', seq }, { kind: 'resumeDone', seq }], cfg)
  expect(ofType(off.all, 'resume').length).toBe(1)
  expect(off.rec.on).toBe(false)
  expect(off.rec.job).toBe(null)
  // 压缩后到下一次响应之前读不到用量：不提醒、不压缩、层都已清零
  const after = run(a.rec, [
    { kind: 'resumeDone', seq },
    { kind: 'submit', origin: COMPOSER },
    { kind: 'turnStart', turnId: T2 },
    { kind: 'stop', active: false },
    { kind: 'turnComplete', turnId: T2, reason: 'answer', isAborted: false },
  ], cfg)
  expect(contexts(after.all)).toEqual([])
  expect(ofType(after.all, 'compact')).toEqual([])
  expect(after.rec.levels).toEqual({ remind: false, urge: false })
})

test('compact window: the user\'s /clear runs before the queued /compact; the new conversation gets the handoff at once and is resumed whether the /compact succeeds or fails', () => {
  const cfg = CFG_COMPACT
  const { rec, seq } = clearing(cfg)
  const moved = migrateRecord(run(rec, [{ kind: 'userCommand', command: 'clear' }], cfg).rec, NOW)
  const ss = run(moved, [{ kind: 'sessionStart', source: 'clear' }], cfg)
  expect(contexts(ss.all)[0]).toContain(`Handoff file: "${HANDOVER}"`)
  expect(ss.rec.job?.stage).toBe('compacting')
  expect(ss.rec.job?.ctxGiven).toBe(true)
  expect(ofType(ss.all, 'log')[0]!.text).toBe('a /clear not run by AutoHandoff started a new conversation while /compact is queued; it gets the handoff now')
  // 自家 /compact 随后在新对话上成功：照常续接（压缩又抹掉了 start_context，它的 SessionStart(compact) 再给一次）
  const ok = run(ss.rec, [{ kind: 'sessionStart', source: 'compact' }, { kind: 'resetDone', seq }], cfg)
  expect(contexts(ok.all).length).toBe(1)
  expect(ofType(ok.all, 'resume').length).toBe(1)
  // 自家 /compact 在几乎空的新对话上失败：不告诉模型「重置失败」，照常续接
  const failed = run(ss.rec, [{ kind: 'resetFailed', seq, message: 'autohandoff: $.command.run: Error: Not enough messages to compact.' }], cfg)
  expect(failed.rec.tell).toBe(null)
  expect(ofType(failed.all, 'toast')).toEqual([])
  expect(ofType(failed.all, 'resume').length).toBe(1)
  expect(failed.rec.job?.stage).toBe('resuming')
  // 用户按 Esc 否决：静默作废（交接已经给了新对话）
  expect(run(ss.rec, [{ kind: 'resetFailed', seq, message: VETO }], cfg).rec.job).toBe(null)
  // 没拿到交接的对话里 /compact 失败：照旧作废并告诉模型
  expect(run(rec, [{ kind: 'resetFailed', seq, message: 'Error: prompt is too long' }], cfg).rec.tell).toBe('reset_failed')
  // 用户自己的 /compact 先跑：它的 SessionStart(compact) 已是压缩后的对话，给交接；自家的再跑完才续接，一次
  const own = run(rec, [{ kind: 'userCommand', command: 'compact' }, { kind: 'sessionStart', source: 'compact' }, { kind: 'sessionStart', source: 'compact' }, { kind: 'resetDone', seq }], cfg)
  expect(contexts(own.all).length).toBe(2)
  expect(ofType(own.all, 'resume').length).toBe(1)
  // 热重载后的孤儿 job：用户的 /clear 只给交接，等自家那次 SessionStart(compact) 再续接
  const orphan = run(migrateRecord(run(rec, [{ kind: 'start', queuedHere: true }], cfg).rec, NOW), [{ kind: 'sessionStart', source: 'clear' }], cfg)
  expect(ofType(orphan.all, 'resume')).toEqual([])
  expect(ofType(run(orphan.rec, [{ kind: 'sessionStart', source: 'compact' }], cfg).all, 'resume').length).toBe(1)
})

test('compact window at compact_at (no handoff): messages, /clear, a reload and a second turn while the compaction runs', () => {
  const { rec, seq } = compacting()
  // 人工消息：不提醒（压缩完再说）、不动兜底压缩
  const h = run(rec, [{ kind: 'submit', origin: COMPOSER, tokens: 655_000 }])
  expect(contexts(h.all)).toEqual([])
  expect(h.rec.fallback?.seq).toBe(seq)
  // 用户自己 /clear：新对话不带兜底压缩，它的结果晚到时被忽略
  const moved = migrateRecord(run(rec, [{ kind: 'userCommand', command: 'clear' }]).rec, NOW)
  expect(moved.fallback).toBe(null)
  const late = run(moved, [{ kind: 'resetDone', seq }])
  expect(ofType(late.all, 'log')[0]!.text).toBe(`reset request ${seq} finished, but it is no longer the current one; ignored`)
  // 热重载：兜底压缩丢掉（命令照样在跑，结果被忽略）；之后读不到用量也不会再排一次
  const re = run(rec, [{ kind: 'start', queuedHere: true }, { kind: 'resetDone', seq }])
  expect(re.rec.fallback).toBe(null)
  expect(re.rec.fallbackFails).toBe(0)
  const again = run(re.rec, [{ kind: 'turnStart', turnId: T2 }, { kind: 'stop', active: false }, { kind: 'turnComplete', turnId: T2, reason: 'answer', isAborted: false }])
  expect(ofType(again.all, 'compact')).toEqual([])
  // 压缩完成：SessionStart(compact) 与 resolve 都清零各层，不续接、不给 start_context
  const done = run(rec, [{ kind: 'sessionStart', source: 'compact' }, { kind: 'resetDone', seq }])
  expect(done.rec.levels).toEqual({ remind: false, urge: false })
  expect(contexts(done.all)).toEqual([])
  expect(ofType(done.all, 'resume')).toEqual([])
})

test('Stop block next to other Stop hooks: when another hook already blocked, ours is not added and not counted; the urge still arrives', () => {
  const urged = onRecord({ levels: { remind: true, urge: false } })
  const a = run(urged, [{ kind: 'turnStart', turnId: T1 }, { kind: 'stop', active: false, tokens: 455_000, othersBlocked: true }])
  expect(ofType(a.all, 'block')).toEqual([])
  expect(a.rec.levels.urge).toBe(false)
  expect(a.rec.turn?.blocked).toBe(false)
  expect(ofType(a.all, 'log')[0]!.text).toBe('another Stop hook already asked the model to continue; the urge block was not added')
  // 那个 hook 让模型继续干活：下一次工具调用送完整 urge；之后的 Stop（stop_hook_active）不再 block
  const b = run(a.rec, [{ kind: 'postTool', tokens: 458_000 }, { kind: 'stop', active: true, tokens: 459_000 }])
  expect(contexts(b.all)[0]).toContain('[AutoHandoff: hand off now]')
  expect(ofType(b.all, 'block')).toEqual([])
  // 没有别的 hook：照常 block 一次并记账
  const c = run(urged, [{ kind: 'turnStart', turnId: T1 }, { kind: 'stop', active: false, tokens: 455_000 }])
  expect(ofType(c.all, 'block').length).toBe(1)
  expect(c.rec.levels.urge).toBe(true)
})

test('urge layer and a rejected tool: the turn ends without Stop, so no block; the next message carries the short urge', () => {
  const urged = onRecord({ levels: { remind: true, urge: true } })
  const a = run(urged, [{ kind: 'turnStart', turnId: T1 }, { kind: 'postTool', tokens: 470_000 }, { kind: 'turnComplete', turnId: T1, reason: 'answer', isAborted: false, tokens: 470_000 }])
  expect(ofType(a.all, 'block')).toEqual([])
  expect(ofType(a.all, 'compact')).toEqual([])
  const b = run(a.rec, [{ kind: 'submit', origin: COMPOSER, tokens: 470_000 }])
  expect(contexts(b.all)).toEqual([
    `AutoHandoff: context usage is about 470k tokens, past the 450k handoff threshold, and no handoff is registered. Before ending the turn, write the handoff file and call the ${TOOL_FULL_NAME} tool with its path.`,
  ])
})

test('remind_every_turn: a short reminder on every later message (human or agent) until registered; none when off, while registered, during a compaction or with unknown usage', () => {
  const sent = run(onRecord(), [{ kind: 'turnStart', turnId: T1 }, { kind: 'postTool', tokens: 305_000 }]).rec
  const short = (tokens: number) =>
    `[AutoHandoff] Context usage is about ${tokens / 1000}k tokens, past the first threshold of 300k, and no handoff is registered yet. Before this turn ends, finish the step in progress, write the handoff file, call the ${TOOL_FULL_NAME} tool with its path, and then end the turn.`
  const a = run(sent, [
    { kind: 'submit', origin: COMPOSER, tokens: 306_000 },
    { kind: 'submit', origin: { kind: 'task-notification' }, tokens: 307_000 },
    { kind: 'submit', origin: COMPOSER, tokens: 308_000 },
  ])
  expect(a.steps.map((st) => contexts(st.fx))).toEqual([[short(306_000)], [short(307_000)], [short(308_000)]])
  // 回合中途的 PostToolUse 不附短提醒（只在每条消息上）
  expect(contexts(run(sent, [{ kind: 'postTool', tokens: 309_000 }]).all)).toEqual([])
  // 关掉 remind_every_turn
  expect(contexts(run(sent, [{ kind: 'submit', origin: COMPOSER, tokens: 306_000 }], cfgWith({ remind_every_turn: false })).all)).toEqual([])
  // 登记中、兜底压缩中、读不到用量、引擎 meta 消息：都不附
  expect(contexts(run({ ...sent, job: armed().rec.job }, [{ kind: 'submit', origin: { kind: 'task-notification' }, tokens: 306_000 }]).all)).toEqual([contexts(run(armed().rec, [{ kind: 'submit', origin: { kind: 'task-notification' }, tokens: 306_000 }]).all)[0]])
  expect(contexts(run({ ...sent, fallback: { seq: 1, since: NOW } }, [{ kind: 'submit', origin: COMPOSER, tokens: 306_000 }]).all)).toEqual([])
  expect(contexts(run(sent, [{ kind: 'submit', origin: COMPOSER }]).all)).toEqual([])
  expect(contexts(run(sent, [{ kind: 'submit', origin: { kind: 'unclassified' }, isMeta: true, tokens: 306_000 }]).all)).toEqual([])
})

test('restart versus hot reload with a queued reset: a restart cancels and tells the model (no queued toast, no resume); a reload or an unreadable $.state keeps the orphan', () => {
  const { rec } = clearing()
  const restart = run(rec, [[{ kind: 'start', queuedHere: false }, NOW + 3 * MIN]])
  expect(restart.rec.job).toBe(null)
  expect(restart.rec.tell).toBe('reload')
  expect(ofType(restart.all, 'toast')).toEqual([{ type: 'toast', text: 'AutoHandoff: handoff cancelled (AutoHandoff was restarted or reloaded before the reset)' }])
  expect(ofType(restart.all, 'log')[0]!.text).toBe('restarted: /clear (request 1) was queued by a process that has ended')
  // 重启后用户自己 /clear：不再被当成「排队中」吞掉，新对话里没有续接、没有交接
  const cleared = migrateRecord(run(restart.rec, [{ kind: 'userCommand', command: 'clear' }]).rec, NOW + 4 * MIN)
  const ss = run(cleared, [{ kind: 'sessionStart', source: 'clear' }])
  expect(contexts(ss.all)).toEqual([])
  expect(ofType(ss.all, 'resume')).toEqual([])
  // 重启后第一条消息告诉模型作废了
  const told = run(restart.rec, [{ kind: 'submit', origin: COMPOSER, tokens: 320_000 }])
  expect(contexts(told.all)[0]).toContain('cancelled (AutoHandoff was restarted or reloaded before the reset)')
  for (const queuedHere of [true, undefined]) {
    const r = run(rec, [{ kind: 'start', queuedHere }])
    expect(r.rec.job?.orphan).toBe(true)
    expect(ofType(r.all, 'toast')).toEqual([])
  }
})

test('after the reset (resuming), a further /clear or /compact by the user gets the start context too; only a queued job waits for its own kind', () => {
  const cfg = CFG_COMPACT
  const { rec, seq } = clearing(cfg)
  const resuming = run(rec, [{ kind: 'resetDone', seq }], cfg).rec
  const a = run(migrateRecord(resuming, NOW), [{ kind: 'sessionStart', source: 'clear' }], cfg)
  expect(contexts(a.all)[0]).toContain(`Handoff file: "${HANDOVER}"`)
  expect(ofType(a.all, 'log').map((l) => l.text).some((t) => t.includes('while /compact is queued'))).toBe(false)
  expect(a.rec.job?.stage).toBe('resuming')
})

// ───────── 交接文件超长（PLAN §0 第 30 条） ─────────

test('oversize: an oversize handoff file is still registered; its size travels with the job across /clear and the new conversation is asked to tidy it first', () => {
  const big: Ev = { kind: 'register', verdict: { ok: true, value: HANDOVER }, fileTokens: 39_373 }
  const a = run(onRecord(), [{ kind: 'submit', origin: COMPOSER, tokens: 296_000 }, { kind: 'turnStart', turnId: T1 }, { kind: 'postTool', tokens: 301_900 }, big])
  const reg = a.steps[3]!
  expect(reg.accepted).toBe(true)
  // 回给模型的话和以前一样（这时不宜逼它大改），只在 debug 里记一笔
  expect(reg.reply).toBe(
    `Handoff registered: "${HANDOVER}". End your turn now: no more tool calls, no questions, no summary. When the turn ends, the conversation is reset with /clear and continued from this file.`,
  )
  expect(ofType(reg.fx, 'log').map((l) => l.text)).toContain(
    'handoff file is about 39k tokens, over handoff_max_tokens (20k); the next conversation will be asked to tidy it',
  )
  expect(a.rec.job?.tokens).toBe(39_373)
  // /autohandoff status 显示大小
  const st = run(a.rec, [{ kind: 'toggle', args: 'status', tokens: 309_000 }])
  expect(ofType(st.all, 'log')[0]!.text).toContain(`Handoff: "${HANDOVER}" (armed, about 39k tokens (over the 20k limit; the next conversation tidies it first)).`)

  const b = run(a.rec, [{ kind: 'stop', active: false, tokens: 318_400 }, DONE])
  const moved = migrateRecord(b.rec, NOW)
  expect(moved.job?.tokens).toBe(39_373)
  const c = run(moved, [{ kind: 'resetDone', seq: lastSeq(b.all) }, { kind: 'sessionStart', source: 'clear' }])
  const sc = contexts(c.steps[1]!.fx)
  expect(sc.length).toBe(1)
  expect(sc[0]).toContain(`Handoff file: "${HANDOVER}"`)
  expect(sc[0]).toContain('[AutoHandoff: tidy the handoff file first] The handoff file named above is about 40k tokens, over the 20k limit')
  // 续接正文不带整理段（只在 start_context 里说一次）
  expect(ofType(c.steps[0]!.fx, 'resume')[0]!.text).not.toContain('tidy')
})

test('oversize: under the limit, size unknown (the file could not be read) or the check off: start_context as before', () => {
  const plain = (fileTokens: number | undefined, cfg = defaultConfig()) => {
    const reg: Ev = { kind: 'register', verdict: { ok: true, value: HANDOVER }, ...(fileTokens === undefined ? {} : { fileTokens }) }
    const a = run(onRecord(), [{ kind: 'turnStart', turnId: T1 }, { kind: 'postTool', tokens: 301_900 }, reg], cfg)
    expect(a.steps[2]!.accepted).toBe(true)
    const b = run(a.rec, [{ kind: 'stop', active: false, tokens: 318_400 }, DONE], cfg)
    const c = run(migrateRecord(b.rec, NOW), [{ kind: 'resetDone', seq: lastSeq(b.all) }, { kind: 'sessionStart', source: 'clear' }], cfg)
    return contexts(c.steps[1]!.fx)[0]!
  }
  for (const text of [plain(11_200), plain(undefined), plain(64_000, cfgWith({ handoff_max_tokens: 0 })), plain(64_000, cfgWith({ handoff_max_tokens: 80_000 }))]) {
    expect(text).toContain(`Handoff file: "${HANDOVER}"`)
    expect(text).not.toContain('tidy the handoff file')
  }
})

test('oversize: action compact gives the tidy section at SessionStart(compact); re-registering a trimmed file drops it', () => {
  const cfg = cfgWith({ action: 'compact' })
  const big: Ev = { kind: 'register', verdict: { ok: true, value: HANDOVER }, fileTokens: 52_000 }
  const trimmed: Ev = { kind: 'register', verdict: { ok: true, value: HANDOVER }, fileTokens: 9_800 }
  const a = run(onRecord(), [{ kind: 'turnStart', turnId: T1 }, { kind: 'postTool', tokens: 301_900 }, big], cfg)
  expect(a.rec.job?.tokens).toBe(52_000)
  // 模型在同一回合里精简后重新登记：以新的大小为准
  const a2 = run(a.rec, [trimmed], cfg)
  expect(a2.rec.job?.tokens).toBe(9_800)
  const b = run(a.rec, [{ kind: 'stop', active: false, tokens: 318_400 }, DONE], cfg)
  expect(b.rec.job?.stage).toBe('compacting')
  const c = run(b.rec, [{ kind: 'sessionStart', source: 'compact' }], cfg)
  expect(contexts(c.all)[0]).toContain('is about 52k tokens, over the 20k limit')
  const b2 = run(a2.rec, [{ kind: 'stop', active: false, tokens: 318_400 }, DONE, { kind: 'sessionStart', source: 'compact' }], cfg)
  expect(contexts(b2.all)[0]).not.toContain('tidy the handoff file')
})
