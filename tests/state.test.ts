// 状态机：按真实会话里的事件顺序驱动 transition()，检查记录与副作用。不需要 `$` 打桩。
import { expect, test } from 'claude-code/testing'
import {
  FALLBACK_MAX_FAILS,
  HELD_NOTE,
  HELD_TEXT,
  QUEUED_TOAST,
  RESUME_STUCK_MS,
  TOOL_FULL_NAME,
  defaultConfig,
  localStamp,
  migrateRecord,
  newRecord,
  noteLine,
  transition,
  type Ev,
  type Rec,
} from '../hooks/core.js'
import { FILE_OK, HANDOVER, MIN, NOW, REPO, cfgWith, contexts, lastSeq, ofType, onRecord, run } from './helpers.js'

const T1 = 'f0b6c7a2-6d1e-4c2a-9a51-1f3e0c9b7d10'
const T2 = '3a9e1d44-0c5b-4f7e-8b2d-6c1a9f0e2b77'
const COMPOSER = { kind: 'composer' }
// 没给路径材料（run 的 note 缺省，相当于读工程目录出错）时提醒末尾追加的泛指句
const NO_NOTE = `\n\n${noteLine(undefined)}`
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
    `[AutoHandoff] Context usage is about 312k tokens, past the first threshold of 300k, and no handoff is registered yet. Before this turn ends, finish the step in progress, write the handoff file for the next conversation at the path below, call the ${TOOL_FULL_NAME} tool with that path, and then end the turn.${NO_NOTE}`,
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

test('a rejected reset command: an Esc veto of the queued reset is shown and the model is told, and AutoHandoff pauses until the user\'s next input; other failures are reported as before', () => {
  const { rec, seq } = clearing()
  // Esc 打断了排在 /clear 前面的回合，命令被移出队列：人就在跟前，只 toast，不发通知；也不重新排队
  const a = run(rec, [{ kind: 'resetFailed', seq, message: 'the command was removed from the queue before it ran' }])
  expect(a.rec.job).toBe(null)
  expect(a.rec.tell).toBe('interrupted')
  expect(a.rec.held).toBe(true)
  expect(ofType(a.all, 'toast')).toEqual([{ type: 'toast', text: 'AutoHandoff: handoff cancelled (the queued reset was called off by Esc)' }])
  expect(ofType(a.all, 'notify')).toEqual([])
  expect(ofType(a.all, 'clear')).toEqual([])
  expect(ofType(a.all, 'status')).toEqual([{ type: 'status', text: 'paused until your next input (stopped with Esc)' }])
  // 此前按过 Esc、还没再输入，/clear 一发出就被拒：那次 Esc 可能是几小时前的，人不在跟前，toast 加通知，说法也不同
  const s = run(rec, [{ kind: 'resetFailed', seq, message: VETO }])
  const said = "AutoHandoff: handoff cancelled (the session was stopped with Esc earlier, and Claude Code runs no reset until the user's next input)"
  expect(s.rec.job).toBe(null)
  expect(s.rec.tell).toBe('stopped')
  expect(s.rec.held).toBe(true)
  expect(ofType(s.all, 'toast')).toEqual([{ type: 'toast', text: said }])
  expect(ofType(s.all, 'notify')).toEqual([{ type: 'notify', text: said }])
  expect(ofType(s.all, 'clear')).toEqual([])
  // 别的失败不是否决：不挂起
  const b = run(rec, [{ kind: 'resetFailed', seq, message: 'autohandoff: $.command.run: unknown command "clear"' }])
  expect(b.rec.tell).toBe('reset_failed')
  expect(b.rec.held).toBe(false)
  expect(ofType(b.all, 'toast').length).toBe(1)
})

test('Esc, then nobody types for hours while background agents keep reporting: the first refused reset is announced once, after that no reminder, no registration and no reset until the user\'s next input', () => {
  // 用户早先按 Esc 停过一个回合（与交接无关）后离开。用量已过 remind_at、提醒送过；后台子代理的报告陆续到达，各开一个回合
  const TASK = { kind: 'task-notification' }
  const T3 = '9c2f6a1e-7b3d-4e8f-a1c2-5d6e7f8a9b0c'
  const note = { dirs: [REPO], sid: '5f1c2a9e-3b7d-4c11-9e0a-2d4f6b8c1e33', windows: false }
  const start = onRecord({ levels: { remind: true, urge: false } })
  // 第一条报告：短提醒 → 模型写交接、登记 → 回合结束 → /clear 一发出就被引擎拒绝
  const first = run(
    start,
    [
      { kind: 'submit', origin: TASK, tokens: 318_400 },
      { kind: 'turnStart', turnId: T1 },
      { kind: 'postTool', tokens: 321_000 },
      REG,
      { kind: 'stop', active: false, tokens: 323_000 },
      { ...DONE, tokens: 323_000 },
    ],
    defaultConfig(),
    note,
  )
  expect(contexts(first.steps[0]!.fx)[0]).toStartWith('[AutoHandoff] Context usage is about 318k tokens')
  const seq = lastSeq(first.all)
  const refused = run(first.rec, [{ kind: 'resetFailed', seq, message: VETO }])
  expect(refused.rec.held).toBe(true)
  expect(ofType(refused.all, 'toast').length).toBe(1)
  expect(ofType(refused.all, 'notify').length).toBe(1)
  // 第二条报告：作废说明只送这一次，带一句「先别再交接」；完整提醒不重送；模型若仍去登记，被拒并得知原因和何时恢复；回合结束什么也不发
  const second = run(
    refused.rec,
    [
      { kind: 'submit', origin: TASK, tokens: 323_500 },
      { kind: 'turnStart', turnId: T2 },
      { kind: 'postTool', tokens: 326_000 },
      REG,
      { kind: 'stop', active: false, tokens: 327_000 },
      { kind: 'turnComplete', turnId: T2, reason: 'answer', isAborted: false, tokens: 327_000, file: FILE_OK },
    ],
    defaultConfig(),
    note,
  )
  expect(contexts(second.steps[0]!.fx)).toEqual([
    "[AutoHandoff] Your registered handoff was cancelled (the session was stopped with Esc earlier, and Claude Code runs no reset until the user's next input). Deal with that first. If you register again, in this turn or later, first update the handoff file with everything new since you wrote it, above all what the user has just asked for or answered, so that the next conversation has it (next steps are the work itself, never \"hand off again\"); then call the mcp__autohandoff__register_handoff tool again.\n\n" +
      HELD_NOTE,
  ])
  expect(contexts(second.steps[2]!.fx)).toEqual([])
  expect(second.steps[3]!.accepted).toBe(false)
  expect(second.steps[3]!.reply).toBe(`Not registered: ${HELD_TEXT}`)
  expect(second.rec.job).toBe(null)
  expect(ofType(second.all, 'clear')).toEqual([])
  expect(ofType(second.all, 'toast')).toEqual([])
  // 第三条、别的插件提交的一条（用户类、不是人打的）、过了 urge_at、过了 compact_at：都不附任何内容，不 block，不发兜底压缩
  const quiet = run(
    second.rec,
    [
      { kind: 'submit', origin: TASK, tokens: 327_500 },
      ...oldTurn(T3, 329_000),
      { kind: 'submit', origin: { kind: 'plugin', name: 'scheduler' }, tokens: 329_500 },
      { kind: 'turnStart', turnId: T1 },
      { kind: 'postTool', tokens: 455_000 },
      { kind: 'stop', active: false, tokens: 655_000 },
      { kind: 'turnComplete', turnId: T1, reason: 'answer', isAborted: false, tokens: 655_000 },
    ],
    defaultConfig(),
    note,
  )
  expect(quiet.all.filter((f) => f.type !== 'log')).toEqual([])
  expect(quiet.rec.held).toBe(true)
  expect(quiet.rec.fallback).toBe(null)
  // /autohandoff status 说明在等什么；查看状态本身不解除
  const st = run(quiet.rec, [{ kind: 'toggle', args: 'status', typed: true, tokens: 655_000 }])
  expect(ofType(st.all, 'log')[0]!.text).toContain('Paused: a reset was refused because the session had been stopped with Esc, and Claude Code runs none until your next message or command.')
  expect(st.rec.held).toBe(true)
  // 用户回来发了一句话：挂起解除，这条消息就带完整提醒（用量早过了 urge_at），登记受理，回合结束照常重置
  const back = run(
    second.rec,
    [
      { kind: 'submit', origin: COMPOSER, tokens: 327_500 },
      { kind: 'turnStart', turnId: T3 },
      { kind: 'postTool', tokens: 329_000 },
      REG,
      { kind: 'stop', active: false, tokens: 330_000 },
      { kind: 'turnComplete', turnId: T3, reason: 'answer', isAborted: false, tokens: 330_000, file: FILE_OK },
    ],
    defaultConfig(),
    note,
  )
  expect(back.steps[0]!.rec.held).toBe(false)
  expect(ofType(back.steps[0]!.fx, 'status')).toEqual([{ type: 'status', text: undefined }])
  expect(contexts(back.steps[0]!.fx)[0]).toContain('past the first threshold of 300k')
  expect(back.steps[3]!.accepted).toBe(true)
  expect(ofType(back.all, 'clear').length).toBe(1)
  // 亲手敲一条命令同样解除（引擎也从这时起重新执行自发的命令）；代理消息、引擎 meta、不是亲手敲的 /autohandoff 不解除
  expect(run(second.rec, [{ kind: 'userCommand', command: 'model' }]).rec.held).toBe(false)
  expect(run(second.rec, [{ kind: 'toggle', args: 'on', typed: true }]).rec.held).toBe(false)
  expect(run(second.rec, [{ kind: 'toggle', args: 'on' }]).rec.held).toBe(true)
  expect(run(second.rec, [{ kind: 'submit', origin: { kind: 'peer-send-message' }, tokens: 328_000 }]).rec.held).toBe(true)
  expect(run(second.rec, [{ kind: 'submit', origin: { kind: 'unclassified' }, isMeta: true, tokens: 328_000 }]).rec.held).toBe(true)
  // 去留：用户自己 /clear 出来的新对话、进程重启或热重载、/resume 切回来的对话都不带挂起
  expect(migrateRecord(second.rec, NOW + MIN).held).toBe(false)
  expect(run(second.rec, [{ kind: 'start' }]).rec.held).toBe(false)
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
      text: `AutoHandoff: context usage is about 462k tokens, past the 450k handoff threshold, and no handoff is registered. Before ending the turn, write the handoff file for the next conversation at the path below and call the ${TOOL_FULL_NAME} tool with that path.${NO_NOTE}`,
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

const BRIDGE = { kind: 'bridge' }
/** reset_note_user 的内置文案（action 与预算随配置变），后面跟已登记的交接文件路径 */
const userNote = (action: string, file = HANDOVER) =>
  `[AutoHandoff] The handoff you registered is still in effect: when this turn ends, the conversation is reset with /${action} and continued from the handoff file named below. This message was already waiting when the previous turn ended, so it is answered here, in the conversation that is about to be reset. Answer it as you normally would, but keep this turn short and do not start new work. If it asks for work, changes the plan or settles a question the handoff file lists as open, add that to the handoff file now, so that the next conversation acts on it, and say in your reply that it will be done after the reset; the next conversation continues from that file, not from this exchange. Keep it within about 15k tokens, since the next conversation reads all of it; AutoHandoff does not register a handoff file above 20k. Edit the file in place: do not write another one and do not call the ${TOOL_FULL_NAME} tool again, the registration stands.\n\nRegistered handoff file: "${file}".`
/** 旧对话里为排队消息跑的一个回合（有工具调用，正常结束） */
const oldTurn = (turnId: string, tokens: number): Ev[] => [
  { kind: 'turnStart', turnId },
  { kind: 'postTool', tokens },
  { kind: 'stop', active: false, tokens },
  { kind: 'turnComplete', turnId, reason: 'answer', isAborted: false, tokens },
]

test('a message sent through Remote Control while the model worked is queued ahead of the /clear: answered in the old conversation with a note, and the resume message still follows the reset', () => {
  // 2026-11-12 实例（CC 2.1.322）：用户在回合中从手机发了一句话，它一直排到回合结束；回合一结束引擎先取出它（prompt.submit 这时才到，
  // 自家的 /clear 已排在它后面），在旧对话里跑完一个回合才执行 /clear
  const { rec, seq } = clearing()
  const a = run(rec, [{ kind: 'submit', origin: BRIDGE, tokens: 318_400 }, ...oldTurn(T2, 321_700)])
  expect(contexts(a.steps[0]!.fx)).toEqual([userNote('clear')])
  expect(ofType(a.steps[0]!.fx, 'log').map((f) => f.text)).toEqual([
    'a user message arrived before the queued /clear (request 1); it is answered in this conversation, and the resume message follows the reset',
  ])
  // 这个回合里什么都不再发生：不提醒、不 block、不再发重置；登记被拒（说明里也说了不必再登记）
  expect(contexts(a.all).length).toBe(1)
  expect(ofType(a.all, 'block')).toEqual([])
  expect(ofType(a.all, 'clear')).toEqual([])
  expect(ofType(a.all, 'toast')).toEqual([])
  expect(a.rec.job?.stage).toBe('clearing')
  expect(a.rec.job?.userTook).toBe(false)
  expect(run(a.rec, [REG]).steps[0]!.reply).toBe('Not registered: a reset is already in progress.')
  // /clear 执行：promise 先 resolve（记录已搬到新 sid），再到 SessionStart(clear)。续接照常提交，新对话带连环交接守卫
  const b = run(migrateRecord(a.rec, NOW + 30_000), [
    [{ kind: 'resetDone', seq }, NOW + 30_000],
    [{ kind: 'sessionStart', source: 'clear' }, NOW + 30_200],
  ])
  const resume = ofType(b.all, 'resume')
  expect(resume.length).toBe(1)
  expect(resume[0]!.seq).toBe(seq)
  expect(resume[0]!.text).toContain(`Handoff file: "${HANDOVER}"`)
  expect(contexts(b.steps[1]!.fx)[0]).toContain(`Handoff file: "${HANDOVER}"`)
  expect(b.rec.job?.stage).toBe('resuming')
  // 人在旧对话里说过话不解除新对话的守卫（与重置排队期间敲的命令同理，PLAN §0 第 22、32 条）
  expect([b.rec.resumed, b.rec.resumedAt]).toEqual([true, NOW + 30_000])
  expect(run(b.rec, [{ kind: 'resumeDone', seq }]).rec.job).toBe(null)
  // 另一种事件顺序（SessionStart(clear) 先到）结果相同
  const c = run(migrateRecord(a.rec, NOW + 30_000), [{ kind: 'sessionStart', source: 'clear' }, { kind: 'resetDone', seq }])
  expect(ofType(c.all, 'resume').length).toBe(1)
  expect(contexts(c.all).length).toBe(1)
})

test('several messages queued ahead of the reset (Remote Control, a scheduled trigger): each gets its turn and the note in the old conversation; one reset, one resume', () => {
  const { rec, seq } = clearing()
  const a = run(rec, [
    { kind: 'submit', origin: BRIDGE, tokens: 318_400 },
    ...oldTurn(T2, 320_100),
    // 定时任务的 prompt 也是「用户类」来源：同样附说明，不算用户接手
    { kind: 'submit', origin: { kind: 'scheduled-trigger' }, tokens: 320_100 },
    ...oldTurn('9c2f6a1e-7b3d-4e8f-a1c2-5d6e7f8a9b0c', 323_900),
    // 后台任务的通知是代理类：附 reset_note
    { kind: 'submit', origin: { kind: 'task-notification' }, tokens: 323_900 },
  ])
  expect(contexts(a.steps[0]!.fx)).toEqual([userNote('clear')])
  expect(contexts(a.steps[5]!.fx)).toEqual([userNote('clear')])
  expect(contexts(a.steps[10]!.fx)[0]).toStartWith('[AutoHandoff] The conversation is about to be reset with /clear')
  expect(contexts(a.all).length).toBe(3)
  expect(ofType(a.all, 'clear')).toEqual([])
  expect(a.rec.job?.stage).toBe('clearing')
  const b = run(migrateRecord(a.rec, NOW + 90_000), [{ kind: 'resetDone', seq }, { kind: 'sessionStart', source: 'clear' }, { kind: 'resumeDone', seq }])
  expect(ofType(b.all, 'resume').length).toBe(1)
  expect(b.rec.job).toBe(null)
})

test('every user-class source queued ahead of the reset is treated alike, typed by a person or not: note in the old conversation, no takeover, resume after the reset', () => {
  // 判断的是「消息落在哪个对话」，不是「是不是人工输入」：定时任务、Telegram 之类的 channel、别的插件、协调会话下发的消息、
  // Slack 提醒、SDK 主机的回合、来源不明的输入，在 clearing/compacting 阶段都不得让续接被跳过
  const origins = [
    { kind: 'composer' },
    { kind: 'bridge' },
    { kind: 'scheduled-trigger' },
    { kind: 'channel', server: 'plugin:telegram:telegram' },
    { kind: 'plugin', name: 'daily-digest' },
    { kind: 'coordinator' },
    { kind: 'projects-relay' },
    { kind: 'slack-ping' },
    { kind: 'sdk' },
    { kind: 'unclassified' },
  ]
  for (const cfg of [defaultConfig(), CFG_COMPACT]) {
    const action = cfg.settings.action
    for (const origin of origins) {
      const { rec, seq } = clearing(cfg)
      const a = run(rec, [{ kind: 'submit', origin, tokens: 318_400 }, ...oldTurn(T2, 320_300)], cfg)
      expect(contexts(a.all)).toEqual([userNote(action)])
      expect(a.rec.job?.userTook).toBe(false)
      const after = action === 'clear' ? migrateRecord(a.rec, NOW + 20_000) : a.rec
      const b = run(after, [{ kind: 'sessionStart', source: action }, { kind: 'resetDone', seq }], cfg)
      expect(ofType(b.all, 'resume').length).toBe(1)
      expect(b.rec.job?.stage).toBe('resuming')
      expect(b.rec.resumed).toBe(true)
    }
  }
})

test('the queued message\'s turn in the old conversation is interrupted with Esc: Claude Code drops the queued /clear with it; the user sees a toast, the model is told with the next message and reminded again, nothing is resumed or queued again', () => {
  const { rec, seq } = clearing()
  const a = run(rec, [
    { kind: 'submit', origin: BRIDGE, tokens: 318_400 },
    { kind: 'turnStart', turnId: T2 },
    { kind: 'postTool', tokens: 318_900 },
    // Esc：这个回合没有 Stop；登记早已不是 armed，回合结束本身什么也不做
    { kind: 'turnComplete', turnId: T2, reason: 'aborted', isAborted: true, tokens: 319_000 },
  ])
  // 模型在这个回合里被告知「登记仍有效，答完就重置」
  expect(contexts(a.steps[0]!.fx)).toEqual([userNote('clear')])
  expect(a.rec.job?.stage).toBe('clearing')
  // 排队的命令随 Esc 被移出队列：交接作废，但不能悄悄地——用户以为马上重置，模型以为登记有效
  const b = run(a.rec, [{ kind: 'resetFailed', seq, message: 'autohandoff: $.command.run: the command was removed from the queue before it ran' }])
  expect(b.rec.job).toBe(null)
  expect(b.rec.stalled).toBe(null)
  expect(b.rec.tell).toBe('interrupted')
  expect(b.rec.held).toBe(true)
  expect(ofType(b.all, 'toast')).toEqual([{ type: 'toast', text: 'AutoHandoff: handoff cancelled (the queued reset was called off by Esc)' }])
  expect(ofType(b.all, 'status')).toEqual([{ type: 'status', text: 'paused until your next input (stopped with Esc)' }])
  expect(ofType(b.all, 'resume')).toEqual([])
  expect(ofType(b.all, 'clear')).toEqual([])
  // 用户的下一条消息（挂起到此为止）：告诉模型登记已作废（不再是那句「登记仍有效」，也不带「先别再交接」），这条消息不解释为新的登记；
  // 之后第一次检查把完整提醒再送一遍（原先送过的那层退回未送），模型可以重新登记，回合结束照常重置
  const c = run(b.rec, [
    { kind: 'submit', origin: BRIDGE, tokens: 319_000 },
    { kind: 'turnStart', turnId: T1 },
    { kind: 'postTool', tokens: 319_600 },
    REG,
    { kind: 'stop', active: false, tokens: 321_000 },
    { ...DONE, tokens: 321_000 },
  ])
  expect(contexts(c.steps[0]!.fx)).toEqual([
    '[AutoHandoff] Your registered handoff was cancelled (the queued reset was called off by Esc). Deal with that first. If you register again, in this turn or later, first update the handoff file with everything new since you wrote it, above all what the user has just asked for or answered, so that the next conversation has it (next steps are the work itself, never "hand off again"); then call the mcp__autohandoff__register_handoff tool again.',
  ])
  expect(contexts(c.steps[2]!.fx)[0]).toContain('past the first threshold of 300k')
  expect(c.steps[3]!.accepted).toBe(true)
  expect(ofType(c.all, 'clear').length).toBe(1)
  expect(c.rec.job?.stage).toBe('clearing')

  // 登记那个回合本身被 Esc 打断是另一回事（命令没发出，用户自己停的）：照旧静默，下一条消息只带短提醒
  const own = run(armed().rec, [{ kind: 'turnComplete', turnId: T1, reason: 'aborted', isAborted: true, tokens: 310_000 }])
  expect(own.rec.job).toBe(null)
  expect(own.rec.tell).toBe(null)
  expect(ofType(own.all, 'toast')).toEqual([])
  expect(contexts(run(own.rec, [{ kind: 'submit', origin: COMPOSER, tokens: 310_000 }]).all)[0]).toStartWith('[AutoHandoff] Context usage is about 310k tokens')
})

test('a user message in the reset conversation before the reset result comes back: the user has taken over, no resume message and no chain guard', () => {
  // SessionStart(clear) 先到（新对话已拿到交接）、promise 还没 resolve 的窗口里用户发了消息：它由新对话处理
  const { rec, seq } = clearing()
  const a = run(migrateRecord(rec, NOW), [{ kind: 'sessionStart', source: 'clear' }, { kind: 'submit', origin: COMPOSER, tokens: 9_000 }, { kind: 'resetDone', seq }])
  expect(contexts(a.steps[0]!.fx)[0]).toContain(`"${HANDOVER}"`)
  // 不附「即将重置」的说明：重置已经发生
  expect(contexts(a.steps[1]!.fx)).toEqual([])
  expect(a.steps[1]!.rec.job?.userTook).toBe(true)
  expect(ofType(a.all, 'resume')).toEqual([])
  expect(a.rec.job).toBe(null)
  expect(a.rec.resumed).toBe(false)
  expect(ofType(a.steps[2]!.fx, 'log').map((f) => f.text)).toEqual(['handoff finished: the user wrote during the reset; resume message skipped'])
  // 代理类消息不算用户接手
  const b = run(migrateRecord(rec, NOW), [{ kind: 'sessionStart', source: 'clear' }, { kind: 'submit', origin: { kind: 'task-notification' } }, { kind: 'resetDone', seq }])
  expect(ofType(b.all, 'resume').length).toBe(1)
})

test('the user\'s own /clear runs first and a queued message is answered in that in-between conversation: our /clear wipes it, so the last conversation is still resumed', () => {
  const { rec, seq } = clearing()
  // 用户的 /clear 先出队：中间这个对话拿到了交接，排队的消息在这里处理（这时看上去像用户接手）
  const mid = run(migrateRecord(rec, NOW + 1_000), [{ kind: 'sessionStart', source: 'clear' }, { kind: 'submit', origin: BRIDGE, tokens: 9_000 }, ...oldTurn(T2, 14_000)])
  expect(mid.rec.job?.stage).toBe('clearing')
  expect(mid.rec.job?.userTook).toBe(true)
  // 自家的 /clear 随后把它清掉：搬迁时「用户接手」作废，最后这个对话照常续接
  const last = run(migrateRecord(mid.rec, NOW + 20_000), [{ kind: 'resetDone', seq }, { kind: 'sessionStart', source: 'clear' }])
  expect(ofType(last.all, 'resume').length).toBe(1)
  expect(contexts(last.steps[1]!.fx)[0]).toContain(`"${HANDOVER}"`)
  expect(last.rec.job?.stage).toBe('resuming')
})

test('action compact, two messages queued ahead of our /compact, and a compaction that is not ours runs in between (Claude Code compacts in the middle of the first message\'s turn, or the user\'s own /compact goes first): the second message is not the user taking over, and the resume still follows our compaction', () => {
  const cfg = CFG_COMPACT
  const { rec, seq } = clearing(cfg)
  const T3 = '9c2f6a1e-7b3d-4e8f-a1c2-5d6e7f8a9b0c'
  const SCHEDULED = { kind: 'scheduled-trigger' }
  // 回合结束前排着两条消息：Remote Control 发来的一条、定时任务的一条。第一条的回合里上下文满了，CC 自动压缩
  // （回合中途的 SessionStart(compact)）：排队的命令要等对话空闲才执行，所以这次不是自家的，不给交接，接着等
  const first = run(
    rec,
    [
      { kind: 'submit', origin: BRIDGE, tokens: 318_400 },
      { kind: 'turnStart', turnId: T2 },
      { kind: 'postTool', tokens: 356_000 },
      { kind: 'sessionStart', source: 'compact' },
      { kind: 'postTool', tokens: 48_000 },
      { kind: 'stop', active: false, tokens: 52_000 },
      { kind: 'turnComplete', turnId: T2, reason: 'answer', isAborted: false, tokens: 52_000 },
    ],
    cfg,
  )
  expect(contexts(first.steps[0]!.fx)).toEqual([userNote('compact')])
  expect(contexts(first.steps[3]!.fx)).toEqual([])
  expect(ofType(first.steps[3]!.fx, 'log').map((f) => f.text)).toEqual(['a /compact not run by AutoHandoff finished while /compact is queued; still waiting for it'])
  expect(first.rec.job?.stage).toBe('compacting')
  expect(first.rec.job?.ctxGiven).toBe(false)
  // 第二条出队，在压缩过的这个对话里处理；自家的 /compact 还排在它后面，所以它和第一条一样被告知「登记仍有效，答完就重置」
  const second = run(first.rec, [{ kind: 'submit', origin: SCHEDULED, tokens: 52_000 }, ...oldTurn(T3, 57_000)], cfg)
  expect(contexts(second.steps[0]!.fx)).toEqual([userNote('compact')])
  expect(second.rec.job?.userTook).toBe(false)
  expect(second.rec.job?.stage).toBe('compacting')
  expect(ofType(second.all, 'compact')).toEqual([])
  // 自家的 /compact 执行：SessionStart(compact) 再给一次交接，promise resolve 后照常续接、带守卫
  const own = run(second.rec, [{ kind: 'sessionStart', source: 'compact' }, { kind: 'resetDone', seq }], cfg)
  expect(contexts(own.steps[0]!.fx)[0]).toContain(`Handoff file: "${HANDOVER}"`)
  expect(ofType(own.all, 'resume').length).toBe(1)
  expect(own.rec.job?.stage).toBe('resuming')
  expect(own.rec.resumed).toBe(true)

  // 用户在第一条的回合里敲了 /compact，它比自家的先执行：结果相同
  const user = run(
    rec,
    [
      { kind: 'submit', origin: BRIDGE, tokens: 318_400 },
      { kind: 'turnStart', turnId: T2 },
      { kind: 'userCommand', command: 'compact' },
      { kind: 'stop', active: false, tokens: 321_000 },
      { kind: 'turnComplete', turnId: T2, reason: 'answer', isAborted: false, tokens: 321_000 },
      { kind: 'sessionStart', source: 'compact' },
      { kind: 'submit', origin: SCHEDULED },
      ...oldTurn(T3, 44_000),
      { kind: 'sessionStart', source: 'compact' },
      { kind: 'resetDone', seq },
    ],
    cfg,
  )
  expect(ofType(user.all, 'resume').length).toBe(1)
  expect(user.rec.resumed).toBe(true)

  // 自家这次压缩的 SessionStart 之后、结果回来之前才到的消息，才是重置后的对话里的消息：仍算用户接手，不续接
  const took = run(second.rec, [{ kind: 'sessionStart', source: 'compact' }, { kind: 'submit', origin: COMPOSER }, { kind: 'resetDone', seq }], cfg)
  expect(ofType(took.all, 'resume')).toEqual([])
  expect(took.rec.job).toBe(null)
  expect(took.rec.resumed).toBe(false)

  // action=clear：回合中途的压缩不是新对话（不给交接），第二条消息照样附说明；/clear 之后续接
  const c = clearing()
  const cl = run(c.rec, [
    { kind: 'submit', origin: BRIDGE, tokens: 318_400 },
    { kind: 'turnStart', turnId: T2 },
    { kind: 'sessionStart', source: 'compact' },
    { kind: 'stop', active: false, tokens: 52_000 },
    { kind: 'turnComplete', turnId: T2, reason: 'answer', isAborted: false, tokens: 52_000 },
    { kind: 'submit', origin: SCHEDULED, tokens: 52_000 },
    ...oldTurn(T3, 57_000),
  ])
  expect(contexts(cl.steps[2]!.fx)).toEqual([])
  expect(contexts(cl.steps[5]!.fx)).toEqual([userNote('clear')])
  const clEnd = run(migrateRecord(cl.rec, NOW + 90_000), [{ kind: 'resetDone', seq: c.seq }, { kind: 'sessionStart', source: 'clear' }])
  expect(ofType(clEnd.all, 'resume').length).toBe(1)
  expect(contexts(clEnd.steps[1]!.fx)[0]).toContain(`Handoff file: "${HANDOVER}"`)
})

test('the queued reset waits behind a long turn in the old conversation: "no result" is counted only while the conversation is idle, from the moment it went idle', () => {
  const { rec, seq } = clearing()
  // 排队的消息让旧对话又干了三个多小时（wait_minutes 是 60）：/clear 还没机会执行，不是没有结果
  const turn = run(rec, [{ kind: 'submit', origin: BRIDGE, tokens: 318_400 }, { kind: 'turnStart', turnId: T2 }])
  const long = run(turn.rec, [
    [{ kind: 'tick' }, NOW + WAIT],
    [{ kind: 'postTool', tokens: 352_000 }, NOW + 2 * WAIT],
    [{ kind: 'tick' }, NOW + 3 * WAIT],
  ])
  expect(long.rec.job?.stage).toBe('clearing')
  expect(long.rec.stalled).toBe(null)
  expect(ofType(long.all, 'toast')).toEqual([])
  // 回合结束：对话又空闲，从这一刻重新计时；/clear 执行，照常续接
  const end = NOW + 3 * WAIT + 5 * MIN
  const done = run(long.rec, [
    [{ kind: 'stop', active: false, tokens: 371_000 }, end],
    [{ kind: 'turnComplete', turnId: T2, reason: 'answer', isAborted: false, tokens: 371_000 }, end],
  ])
  expect(ofType(done.steps[1]!.fx, 'timer')).toEqual([{ type: 'timer', ms: WAIT }])
  const c = run(migrateRecord(done.rec, end + 300), [[{ kind: 'resetDone', seq }, end + 300], [{ kind: 'sessionStart', source: 'clear' }, end + 500]])
  expect(ofType(c.all, 'resume').length).toBe(1)
  expect(contexts(c.steps[1]!.fx)[0]).toContain(`Handoff file: "${HANDOVER}"`)

  // 回合在 /compact 发出快满一小时的时候才结束：发出时挂的计时 5 秒后到点，这时 /compact 正在执行（压缩要十几秒），
  // 对话才空闲了 5 秒，不算没有结果
  const k = clearing(CFG_COMPACT)
  const late = NOW + WAIT - 5_000
  const e = run(
    k.rec,
    [
      { kind: 'submit', origin: BRIDGE, tokens: 318_400 },
      { kind: 'turnStart', turnId: T2 },
      [{ kind: 'stop', active: false, tokens: 349_000 }, late],
      [{ kind: 'turnComplete', turnId: T2, reason: 'answer', isAborted: false, tokens: 349_000 }, late],
      [{ kind: 'tick' }, NOW + WAIT],
      [{ kind: 'sessionStart', source: 'compact' }, late + 14_000],
      [{ kind: 'resetDone', seq: k.seq }, late + 14_500],
    ],
    CFG_COMPACT,
  )
  expect(e.steps[4]!.rec.job?.stage).toBe('compacting')
  expect(ofType(e.all, 'toast')).toEqual([])
  expect(contexts(e.steps[5]!.fx)[0]).toContain(`Handoff file: "${HANDOVER}"`)
  expect(ofType(e.all, 'resume').length).toBe(1)
  expect(e.rec.job?.stage).toBe('resuming')
})

test('a reload in the middle of the turn that runs ahead of the queued /clear: however long that turn takes, the next conversation still gets the handoff', () => {
  const { rec } = clearing()
  // 排队的消息在旧对话里开了回合；回合进行中插件更新、模块热重载（回合状态和计时器都没了）
  const reload = NOW + 10 * MIN
  const a = run(rec, [{ kind: 'submit', origin: BRIDGE, tokens: 318_400 }, { kind: 'turnStart', turnId: T2 }, [{ kind: 'start', queuedHere: true }, reload]])
  expect(a.rec.job?.orphan).toBe(true)
  // 计时从重载这一刻重新挂满 wait_minutes
  expect(ofType(a.steps[2]!.fx, 'timer')).toEqual([{ type: 'timer', ms: WAIT }])
  const end = reload + WAIT + 20 * MIN
  const turnEnd: (Ev | [Ev, number])[] = [
    [{ kind: 'stop', active: false, tokens: 371_000 }, end],
    [{ kind: 'turnComplete', turnId: T2, reason: 'answer', isAborted: false, tokens: 371_000 }, end],
  ]
  // 回合还在跑：它的下一次工具调用把计时停掉，重载时挂的计时到点不算没有结果
  const busy = run(a.rec, [[{ kind: 'postTool', tokens: 331_000 }, reload + 2 * MIN], [{ kind: 'tick' }, reload + WAIT], ...turnEnd])
  expect(busy.steps[1]!.rec.job?.stage).toBe('clearing')
  expect(ofType(busy.all, 'toast')).toEqual([])
  // 旧模块的回调来不了：/clear 执行后 SessionStart(clear) 给交接并续接
  const ss = run(migrateRecord(busy.rec, end + 400), [[{ kind: 'sessionStart', source: 'clear' }, end + 400]])
  expect(contexts(ss.all)[0]).toContain(`Handoff file: "${HANDOVER}"`)
  expect(ofType(ss.all, 'resume').length).toBe(1)

  // 重载后那个回合一直停在权限框上（没有任何工具调用）超过 wait_minutes：看上去是空闲而没有结果，搁置并告诉用户；
  // 但交接不丢——有人点了权限框、回合结束、/clear 执行后，新对话照常拿到交接并续接
  const quiet = run(a.rec, [[{ kind: 'tick' }, reload + WAIT], ...turnEnd])
  expect(quiet.steps[0]!.rec.job).toBe(null)
  expect(quiet.steps[0]!.rec.stalled?.orphan).toBe(true)
  expect(ofType(quiet.steps[0]!.fx, 'toast').length).toBe(1)
  expect(ofType(quiet.all, 'clear')).toEqual([])
  const quietSs = run(migrateRecord(quiet.rec, end + 400), [[{ kind: 'sessionStart', source: 'clear' }, end + 400]])
  expect(contexts(quietSs.all)[0]).toContain(`Handoff file: "${HANDOVER}"`)
  expect(ofType(quietSs.all, 'resume').length).toBe(1)
  expect(quietSs.rec.job?.stage).toBe('resuming')
  expect(quietSs.rec.stalled).toBe(null)

  // 重载落在 /clear 排队一个多小时之后（那个回合很长）：照样留作孤儿，不因为「早就超时」放弃
  const lateReload = run(rec, [
    { kind: 'submit', origin: BRIDGE, tokens: 318_400 },
    { kind: 'turnStart', turnId: T2 },
    [{ kind: 'start', queuedHere: true }, NOW + WAIT + 5 * MIN],
    ...turnEnd,
  ])
  expect(lateReload.rec.job?.orphan).toBe(true)
  expect(ofType(lateReload.all, 'toast')).toEqual([])
  expect(ofType(run(migrateRecord(lateReload.rec, end + 400), [[{ kind: 'sessionStart', source: 'clear' }, end + 400]]).all, 'resume').length).toBe(1)
})

test('after a hot reload nobody reports what became of the queued reset: an interrupted turn counts as the veto, Claude Code\'s own compaction in the middle of a turn is never taken for the queued /compact, and a queued command that runs after all still resumes', () => {
  // ── 回合被 Esc 打断（action=clear）：排队消息的回合里热重载，随后用户按 Esc。引擎把 /clear 移出队列，旧模块报不回来 ──
  const { rec } = clearing()
  const reload = NOW + 10 * MIN
  const esc = run(rec, [
    { kind: 'submit', origin: BRIDGE, tokens: 318_400 },
    { kind: 'turnStart', turnId: T2 },
    [{ kind: 'start', queuedHere: true }, reload],
    [{ kind: 'postTool', tokens: 321_000 }, reload + MIN],
    [{ kind: 'turnComplete', turnId: T2, reason: 'aborted', isAborted: true, tokens: 321_500 }, reload + 2 * MIN],
  ])
  const last = esc.steps.at(-1)!
  expect(esc.rec.job).toBe(null)
  expect(esc.rec.tell).toBe('interrupted')
  expect(esc.rec.held).toBe(true)
  expect(ofType(last.fx, 'toast')).toEqual([{ type: 'toast', text: 'AutoHandoff: handoff cancelled (the queued reset was called off by Esc)' }])
  expect(ofType(last.fx, 'status')).toEqual([{ type: 'status', text: 'paused until your next input (stopped with Esc)' }])
  // 用户接着对话：第一条消息被告知登记已作废，之后的消息不再附「登记仍有效，回合结束就重置，不要开始新工作」
  const talk = run(esc.rec, [
    [{ kind: 'submit', origin: COMPOSER, tokens: 321_500 }, reload + 3 * MIN],
    ...oldTurn(T1, 324_000).map((ev): [Ev, number] => [ev, reload + 4 * MIN]),
    [{ kind: 'submit', origin: COMPOSER, tokens: 324_000 }, reload + 9 * MIN],
  ])
  expect(contexts(talk.steps[0]!.fx)[0]).toContain('Your registered handoff was cancelled (the queued reset was called off by Esc)')
  expect(contexts(talk.all).join('\n')).not.toContain('still in effect')
  expect(talk.rec.job).toBe(null)
  // 用户想从头来、自己 /clear：是普通的 clear，不给交接、不续接
  const own = run(migrateRecord(run(talk.rec, [{ kind: 'userCommand', command: 'clear' }]).rec, reload + 10 * MIN), [{ kind: 'sessionStart', source: 'clear' }])
  expect(contexts(own.all)).toEqual([])
  expect(ofType(own.all, 'resume')).toEqual([])
  // 「打断 = 命令已不在队列里」是推断。万一命令还在、之后执行了：留着的那份照常认领，新对话拿到交接并续接，挂起也不再成立
  expect(esc.rec.stalled?.orphan).toBe(true)
  const ran = run(migrateRecord(esc.rec, reload + 3 * MIN), [[{ kind: 'sessionStart', source: 'clear' }, reload + 3 * MIN]])
  expect(contexts(ran.all)[0]).toContain(`Handoff file: "${HANDOVER}"`)
  expect(ofType(ran.all, 'resume').length).toBe(1)
  expect(ran.rec.held).toBe(false)
  // 没有热重载时不做这个推断：引擎自己会报 resetFailed
  const plain = run(rec, [
    { kind: 'submit', origin: BRIDGE, tokens: 318_400 },
    { kind: 'turnStart', turnId: T2 },
    { kind: 'turnComplete', turnId: T2, reason: 'aborted', isAborted: true, tokens: 319_000 },
  ])
  expect(plain.rec.job?.stage).toBe('clearing')
  expect(ofType(plain.all, 'toast')).toEqual([])

  // ── action=compact，/compact 排队后热重载；排队消息的回合里上下文满了，CC 自己压缩（回合中途的 SessionStart(compact)）──
  const k = clearing(CFG_COMPACT)
  const mid = run(
    k.rec,
    [
      { kind: 'submit', origin: BRIDGE, tokens: 318_400 },
      { kind: 'turnStart', turnId: T2 },
      [{ kind: 'start', queuedHere: true }, reload],
      // 重载后回合标记没了，回合里的下一次工具调用把它补上
      [{ kind: 'postTool', tokens: 372_000 }, reload + MIN],
      [{ kind: 'sessionStart', source: 'compact' }, reload + 2 * MIN],
      [{ kind: 'postTool', tokens: 51_000 }, reload + 3 * MIN],
      [{ kind: 'stop', active: false, tokens: 53_000 }, reload + 4 * MIN],
      [{ kind: 'turnComplete', turnId: T2, reason: 'answer', isAborted: false, tokens: 53_000 }, reload + 4 * MIN],
    ],
    CFG_COMPACT,
  )
  // 回合中途那次不是排队的 /compact：不给交接、不续接，job 还在等
  expect(contexts(mid.steps[4]!.fx)).toEqual([])
  expect(ofType(mid.all, 'resume')).toEqual([])
  expect(mid.rec.job?.stage).toBe('compacting')
  // 回合结束后自家的 /compact 执行（对话空闲时的 SessionStart(compact)）：孤儿在这里拿到交接并续接
  const ownK = run(mid.rec, [[{ kind: 'sessionStart', source: 'compact' }, reload + 4 * MIN + 14_000]], CFG_COMPACT)
  expect(contexts(ownK.all)[0]).toContain(`Handoff file: "${HANDOVER}"`)
  expect(ofType(ownK.all, 'resume').length).toBe(1)

  // ── 同样的配置，孤儿被搁置之后（命令没有执行、模型也没有重新登记），很久以后的一个回合里 CC 自己压缩 ──
  const idle = run(k.rec, [[{ kind: 'start', queuedHere: true }, reload], [{ kind: 'tick' }, reload + WAIT]], CFG_COMPACT)
  expect(idle.rec.stalled?.orphan).toBe(true)
  const later = reload + 5 * WAIT
  const auto = run(
    idle.rec,
    [
      [{ kind: 'submit', origin: { kind: 'task-notification' }, tokens: 330_000 }, later],
      [{ kind: 'turnStart', turnId: T2 }, later],
      [{ kind: 'postTool', tokens: 395_000 }, later + MIN],
      [{ kind: 'sessionStart', source: 'compact' }, later + 2 * MIN],
      [{ kind: 'postTool', tokens: 58_000 }, later + 3 * MIN],
      [{ kind: 'stop', active: false, tokens: 60_000 }, later + 4 * MIN],
      [{ kind: 'turnComplete', turnId: T2, reason: 'answer', isAborted: false, tokens: 60_000 }, later + 4 * MIN],
    ],
    CFG_COMPACT,
  )
  // 不拿几小时前的交接文件去续接
  expect(contexts(auto.steps[3]!.fx)).toEqual([])
  expect(ofType(auto.all, 'resume')).toEqual([])
  expect(auto.rec.job).toBe(null)
  // 被搁置的那条 /compact 若在对话空闲时终究执行了，照常认领
  const lateRun = run(auto.rec, [[{ kind: 'sessionStart', source: 'compact' }, later + 10 * MIN]], CFG_COMPACT)
  expect(ofType(lateRun.all, 'resume').length).toBe(1)
})

test('"no result" for a queued reset adds up the idle time between turns: a user who keeps working after a reload is not told "still registered" for ever, and a chain of queued messages does not use the time up', () => {
  // 热重载后排队的 /compact 没有执行（比如压缩失败），旧模块报不回来。用户每十分钟发一条消息，回合一分钟
  const k = clearing(CFG_COMPACT)
  const reload = NOW + 5 * MIN
  let rec = run(k.rec, [[{ kind: 'start', queuedHere: true }, reload]], CFG_COMPACT).rec
  let t = reload
  /** 回合结束时挂的计时还剩多久（毫秒）；到点时送 tick */
  let due: number | null = WAIT
  const notes: string[] = []
  let stalledAt: number | null = null
  for (let i = 0; i < 12 && stalledAt === null; i++) {
    const gap = 9 * MIN
    if (due !== null && due <= gap) {
      const tick = run(rec, [[{ kind: 'tick' }, t + due]], CFG_COMPACT)
      rec = tick.rec
      if (rec.stalled) stalledAt = t + due - reload
    }
    t += gap
    const turn = run(
      rec,
      [
        [{ kind: 'submit', origin: COMPOSER, tokens: 319_000 + i * 2_000 }, t],
        [{ kind: 'turnStart', turnId: T2 }, t],
        [{ kind: 'postTool', tokens: 320_000 + i * 2_000 }, t + 30_000],
        [{ kind: 'stop', active: false, tokens: 320_500 + i * 2_000 }, t + MIN],
        [{ kind: 'turnComplete', turnId: T2, reason: 'answer', isAborted: false, tokens: 320_500 + i * 2_000 }, t + MIN],
      ],
      CFG_COMPACT,
    )
    notes.push(contexts(turn.steps[0]!.fx)[0] ?? '')
    rec = turn.rec
    t += MIN
    due = ofType(turn.steps[4]!.fx, 'timer')[0]?.ms ?? null
  }
  // 空闲累计满 60 分钟（6 段 9 分钟加 6 分钟）就搁置；之前的 6 条消息附的是「登记仍有效」，之后那条被告知作废
  expect(stalledAt).toBe(6 * 10 * MIN + 6 * MIN)
  expect(notes.slice(0, 6).every((n) => n.startsWith('[AutoHandoff] The handoff you registered is still in effect'))).toBe(true)
  expect(notes[6]).toContain('Your registered handoff was cancelled (the queued reset did not run within 60 minutes)')
  expect(rec.job).toBe(null)

  // 命令确实还在队列里时空闲累计不起来：回合结束前排了三条消息，每条在旧对话里跑二十多分钟，回合之间只隔几十毫秒
  const q = clearing()
  let r = q.rec
  let at = NOW
  for (let i = 0; i < 3; i++) {
    const turn = run(r, [
      [{ kind: 'submit', origin: BRIDGE, tokens: 318_400 }, at + 30],
      [{ kind: 'turnStart', turnId: T2 }, at + 40],
      [{ kind: 'tick' }, at + 25 * MIN],
      [{ kind: 'stop', active: false, tokens: 330_000 }, at + 25 * MIN],
      [{ kind: 'turnComplete', turnId: T2, reason: 'answer', isAborted: false, tokens: 330_000 }, at + 25 * MIN],
    ])
    r = turn.rec
    at += 25 * MIN
    expect(ofType(turn.steps[4]!.fx, 'timer')).toEqual([{ type: 'timer', ms: WAIT - 40 * (i + 1) }])
  }
  expect(r.job?.stage).toBe('clearing')
  expect(r.stalled).toBe(null)
  const done = run(migrateRecord(r, at + 300), [[{ kind: 'resetDone', seq: q.seq }, at + 300], [{ kind: 'sessionStart', source: 'clear' }, at + 500]])
  expect(ofType(done.all, 'resume').length).toBe(1)
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
  // 误标为 teammate 的进程：人工输入或亲手敲的 /autohandoff 一来就撤销标记（teammate 从不收到这两种）
  const wrong = run(fresh, [{ kind: 'teammate' }, { kind: 'toggle', args: 'on', typed: true }, { kind: 'postTool', tokens: 320_000 }], cfg)
  expect(wrong.rec.teammate).toBe(false)
  expect(contexts(wrong.all)[0]).toContain('[AutoHandoff: reminder]')
  const wrong2 = run(fresh, [{ kind: 'teammate' }, { kind: 'submit', origin: COMPOSER, tokens: 320_000 }], cfg)
  expect(wrong2.rec.teammate).toBe(false)
  expect(contexts(wrong2.all)[0]).toContain('[AutoHandoff: reminder]')
  // SDK 主机或别的插件发的 /autohandoff 不说明人在场：不撤 teammate 标记，也不让 default_on 生效
  const sdkMate = run(fresh, [{ kind: 'teammate' }, { kind: 'toggle', args: 'status' }], cfg)
  expect([sdkMate.rec.teammate, sdkMate.rec.human]).toEqual([true, false])
  const sdkStatus = run(fresh, [{ kind: 'toggle', args: 'status' }, { kind: 'postTool', tokens: 320_000 }], cfg)
  expect(sdkStatus.rec.human).toBe(false)
  expect(contexts(sdkStatus.all)).toEqual([])
  // 亲手敲的 status 算人在场：default_on 生效
  const typedStatus = run(fresh, [{ kind: 'toggle', args: 'status', typed: true }, { kind: 'postTool', tokens: 320_000 }], cfg)
  expect(typedStatus.rec.human).toBe(true)
  expect(contexts(typedStatus.all)[0]).toContain('[AutoHandoff: reminder]')
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
  expect(vetoed.rec.held).toBe(true)
  expect(ofType(vetoed.all, 'toast')).toEqual([])
  const agentTurn = run(vetoed.rec, [
    { kind: 'submit', origin: { kind: 'task-notification' }, tokens: 660_000 },
    { kind: 'turnStart', turnId: T2 },
    { kind: 'stop', active: false, tokens: 662_000 },
    { kind: 'turnComplete', turnId: T2, reason: 'answer', isAborted: false, tokens: 662_000 },
  ])
  expect(ofType(agentTurn.all, 'compact')).toEqual([])
  // 这段时间也不提醒（登记了同样重置不了）
  expect(contexts(agentTurn.all)).toEqual([])
  expect(ofType(run(agentTurn.rec, [{ kind: 'toggle', args: 'status', tokens: 662_000 }]).all, 'log')[0]!.text).toContain('Reminders, registering and the compaction at compact_at wait until then.')
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

test('wait_minutes: the timer cancels a registration whose turn never ended; a queued reset with no result is set aside, the user and the model are told, and the handoff is not lost if it runs after all', () => {
  const a = armed()
  expect(run(a.rec, [[{ kind: 'tick' }, NOW + WAIT - MIN]]).rec.job?.stage).toBe('armed')
  const b = run(a.rec, [[{ kind: 'tick' }, NOW + WAIT]])
  expect(b.rec.job).toBe(null)
  expect(b.rec.tell).toBe('timeout')
  expect(ofType(b.all, 'notify')).toEqual([{ type: 'notify', text: 'AutoHandoff: handoff cancelled (the turn did not end within 60 minutes of registering)' }])
  expect(ofType(b.all, 'toast')).toEqual([{ type: 'toast', text: 'AutoHandoff: handoff cancelled (the turn did not end within 60 minutes of registering)' }])

  // /clear 排队了、对话空闲，却一直没有结果（回调丢了；或热重载后命令被否决，旧模块报不回来）：空闲满 wait_minutes 后搁置
  const issuedLate = run(armed().rec, [[{ kind: 'stop', active: false }, NOW + 50 * MIN], [DONE, NOW + 50 * MIN]])
  expect(issuedLate.rec.job?.stage).toBe('clearing')
  // 登记后 60 分钟的 tick（armed 的计时器）到了：clear 才发出 10 分钟，不动
  expect(run(issuedLate.rec, [[{ kind: 'tick' }, NOW + WAIT]]).rec.job?.stage).toBe('clearing')
  const at = NOW + 50 * MIN + WAIT
  const stuck = run(issuedLate.rec, [[{ kind: 'tick' }, at]])
  // 不再挡着本对话：job 清空、状态行清掉，告诉用户（toast 加通知）和模型；原来的 job 留在 stalled 里
  expect(stuck.rec.job).toBe(null)
  expect(stuck.rec.stalled?.seq).toBe(1)
  expect(stuck.rec.stalled?.file).toBe(HANDOVER)
  expect(stuck.rec.tell).toBe('stalled')
  // 给用户的话说的是搁置，不是作废：交接没有丢
  const said = 'AutoHandoff: the queued /clear did not run within 60 minutes and was set aside; if it still runs, the conversation continues from the handoff file.'
  expect(ofType(stuck.all, 'toast')).toEqual([{ type: 'toast', text: said }])
  expect(ofType(stuck.all, 'notify')).toEqual([{ type: 'notify', text: said }])
  expect(ofType(stuck.all, 'status')).toEqual([{ type: 'status', text: undefined }])
  expect(ofType(stuck.all, 'log').map((f) => f.text)).toEqual([
    '/clear (request 1) set aside: the queued reset did not run within 60 minutes; if it still runs, the conversation continues from the handoff file',
  ])
  expect(ofType(run(stuck.rec, [{ kind: 'toggle', args: 'status', tokens: 318_400 }]).all, 'log')[0]!.text).toContain(
    `An earlier /clear (request 1) was queued but has not run; if it still runs, the conversation continues from "${HANDOVER}".`,
  )
  // 下一条消息告诉模型；之后完整提醒重来，登记又能受理（新的登记取代被搁置的那次）
  const next = run(stuck.rec, [
    [{ kind: 'submit', origin: COMPOSER, tokens: 318_400 }, at + MIN],
    [{ kind: 'turnStart', turnId: T2 }, at + MIN],
    [{ kind: 'postTool', tokens: 319_000 }, at + MIN],
    [REG, at + 2 * MIN],
  ])
  expect(contexts(next.steps[0]!.fx)[0]).toContain('cancelled (the queued reset did not run within 60 minutes)')
  expect(contexts(next.steps[2]!.fx)[0]).toContain('past the first threshold of 300k')
  expect(next.rec.job?.stage).toBe('armed')
  expect(next.rec.stalled).toBe(null)

  // 搁置之后那条 /clear 终究执行了（promise 这时才 resolve，记录已搬到新 sid）：照常续接，SessionStart(clear) 给交接
  const ran = run(migrateRecord(stuck.rec, at + 5 * MIN), [
    [{ kind: 'resetDone', seq: 1 }, at + 5 * MIN],
    [{ kind: 'sessionStart', source: 'clear' }, at + 5 * MIN + 200],
  ])
  expect(ofType(ran.all, 'resume').length).toBe(1)
  expect(contexts(ran.steps[1]!.fx)[0]).toContain(`Handoff file: "${HANDOVER}"`)
  expect(ran.rec.job?.stage).toBe('resuming')
  expect(ran.rec.stalled).toBe(null)
  // /compact 同理（同一个对话，不搬迁）：还没送出的那句作废说明不再送
  const k = clearing(CFG_COMPACT)
  const kStuck = run(k.rec, [[{ kind: 'tick' }, NOW + WAIT]], CFG_COMPACT)
  expect(kStuck.rec.tell).toBe('stalled')
  const kRan = run(kStuck.rec, [[{ kind: 'resetDone', seq: k.seq }, NOW + WAIT + MIN], [{ kind: 'submit', origin: COMPOSER, tokens: 41_000 }, NOW + WAIT + 2 * MIN]], CFG_COMPACT)
  expect(ofType(kRan.all, 'resume').length).toBe(1)
  expect(kRan.rec.tell).toBe(null)
  expect(contexts(kRan.steps[1]!.fx)).toEqual([])

  // 搁置之后才报回来「没执行」（被否决或失败）：认领到此为止，不再通知一遍
  const failed = run(stuck.rec, [{ kind: 'resetFailed', seq: 1, message: 'the command was removed from the queue before it ran' }])
  expect(failed.rec.stalled).toBe(null)
  expect(failed.rec.tell).toBe('stalled')
  expect(ofType(failed.all, 'toast')).toEqual([])
  // 用户自己 /clear：新对话是用户的，不给交接、不续接
  const own = migrateRecord(run(stuck.rec, [{ kind: 'userCommand', command: 'clear' }]).rec, at + MIN)
  expect(own.stalled).toBe(null)
  const ownSs = run(own, [{ kind: 'sessionStart', source: 'clear' }])
  expect(contexts(ownSs.all)).toEqual([])
  expect(ofType(ownSs.all, 'resume')).toEqual([])
  // 会话结束、进程重启（命令随旧进程没了）：丢掉
  expect(run(stuck.rec, [{ kind: 'sessionEnd', reason: 'prompt_input_exit' }]).rec.stalled).toBe(null)
  expect(run(stuck.rec, [{ kind: 'start', queuedHere: false }]).rec.stalled).toBe(null)
  // 热重载：旧模块的 resetDone 不会来了，改由同种重置的 SessionStart 认领；CC 自动压缩的 SessionStart(compact) 不是它
  const reloaded = run(stuck.rec, [{ kind: 'start', queuedHere: true }])
  expect(reloaded.rec.stalled?.orphan).toBe(true)
  const other = run(reloaded.rec, [{ kind: 'sessionStart', source: 'compact' }])
  expect(contexts(other.all)).toEqual([])
  expect(other.rec.stalled?.orphan).toBe(true)
  const claimed = run(migrateRecord(reloaded.rec, at + 5 * MIN), [[{ kind: 'sessionStart', source: 'clear' }, at + 5 * MIN]])
  expect(contexts(claimed.all)[0]).toContain(`Handoff file: "${HANDOVER}"`)
  expect(ofType(claimed.all, 'resume').length).toBe(1)
  // 模型一直不理重来的提醒，用量到了 compact_at：兜底压缩是自己新发出的命令，被搁置的那次不再认领
  const ignored: Rec = { ...stuck.rec, tell: null, levels: { remind: true, urge: true } }
  const fbAfter = run(ignored, bigTurn(652_000, T2).map((ev): [Ev, number] => [ev, at + 30 * MIN]))
  expect(fbAfter.rec.fallback).not.toBe(null)
  expect(fbAfter.rec.stalled).toBe(null)

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

test('a queued reset set aside in a conversation that already has the handoff: the user is told, the model is not (it never registered there), and a later run of the command still resumes', () => {
  // 自家的重置排队时用户自己的 /clear 先跑完：新对话当场拿到交接。随后插件更新、模块热重载，
  // 自家那条命令没有执行（比如被否决），旧模块报不回来；对话空闲满 wait_minutes
  for (const cfg of [CFG_COMPACT, defaultConfig()]) {
    const action = cfg.settings.action
    const q = clearing(cfg)
    const mid = run(
      migrateRecord(run(q.rec, [{ kind: 'userCommand', command: 'clear' }], cfg).rec, NOW + 2_000),
      [
        [{ kind: 'sessionStart', source: 'clear' }, NOW + 2_200],
        [{ kind: 'start', queuedHere: true }, NOW + 5 * MIN],
      ],
      cfg,
    )
    expect(contexts(mid.steps[0]!.fx)[0]).toContain(`Handoff file: "${HANDOVER}"`)
    expect(mid.rec.job?.stage).toBe(action === 'clear' ? 'clearing' : 'compacting')
    expect(mid.rec.job?.ctxGiven).toBe(true)
    const at = NOW + 5 * MIN + WAIT
    const stuck = run(mid.rec, [[{ kind: 'tick' }, at]], cfg)
    expect(stuck.rec.job).toBe(null)
    expect(stuck.rec.stalled?.seq).toBe(q.seq)
    const said = `AutoHandoff: the queued /${action} did not run within 60 minutes and was set aside; if it still runs, the conversation continues from the handoff file.`
    expect(ofType(stuck.all, 'toast')).toEqual([{ type: 'toast', text: said }])
    expect(ofType(stuck.all, 'notify')).toEqual([{ type: 'notify', text: said }])
    // 这个对话的模型没登记过：不告诉它「你的登记作废了」，下一条消息什么也不附（用量也远没到提醒线）
    expect(stuck.rec.tell).toBe(null)
    const next = run(stuck.rec, [[{ kind: 'submit', origin: COMPOSER, tokens: 47_000 }, at + MIN], [{ kind: 'turnStart', turnId: T2 }, at + MIN], [{ kind: 'postTool', tokens: 49_000 }, at + MIN]], cfg)
    expect(contexts(next.all)).toEqual([])
    // 那条命令后来还是执行了（对话空闲时）：孤儿由同种重置的 SessionStart 认领，照常续接
    const ran = run(action === 'clear' ? migrateRecord(stuck.rec, at + 10 * MIN) : stuck.rec, [[{ kind: 'sessionStart', source: action }, at + 10 * MIN]], cfg)
    expect(ofType(ran.all, 'resume').length).toBe(1)
    expect(ran.rec.stalled).toBe(null)
  }

  // 被搁置的 /clear 终究执行、记录搬到新 sid：被清掉的那个对话里的「已拿到交接」「用户已接手」不带过去，新对话照常续接。
  // 经过：用户的 /clear 先跑完，在中间那个对话里发了消息（已拿到交接 → 记用户接手）；自家 /clear 的结果一直不来，空闲满一小时被搁置；
  // 之后它执行了
  const c = clearing()
  const m = run(migrateRecord(run(c.rec, [{ kind: 'userCommand', command: 'clear' }]).rec, NOW + 2_000), [
    [{ kind: 'sessionStart', source: 'clear' }, NOW + 2_200],
    [{ kind: 'submit', origin: COMPOSER, tokens: 44_000 }, NOW + MIN],
    [{ kind: 'turnStart', turnId: T2 }, NOW + MIN],
    [{ kind: 'stop', active: false, tokens: 45_000 }, NOW + 2 * MIN],
    [{ kind: 'turnComplete', turnId: T2, reason: 'answer', isAborted: false, tokens: 45_000 }, NOW + 2 * MIN],
    [{ kind: 'tick' }, NOW + 2 * MIN + WAIT],
  ])
  expect(m.rec.stalled?.userTook).toBe(true)
  expect(m.rec.stalled?.ctxGiven).toBe(true)
  expect(m.rec.tell).toBe(null)
  const late = NOW + 2 * MIN + WAIT + 30 * MIN
  const moved = migrateRecord(m.rec, late)
  expect([moved.stalled?.userTook, moved.stalled?.ctxGiven]).toEqual([false, false])
  const fin = run(moved, [[{ kind: 'resetDone', seq: c.seq }, late], [{ kind: 'sessionStart', source: 'clear' }, late + 200]])
  expect(ofType(fin.all, 'resume').length).toBe(1)
  expect(contexts(fin.steps[1]!.fx)[0]).toContain(`Handoff file: "${HANDOVER}"`)
  expect(fin.rec.job?.stage).toBe('resuming')
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
  // 计时器停了：重挂，从重载这一刻起算满 wait_minutes
  expect(ofType(r.all, 'timer')).toEqual([{ type: 'timer', ms: WAIT }])
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
  // 排在重置前面的消息在旧对话里处理过（附了说明），之后热重载：孤儿 job 照样在 SessionStart(clear) 续接
  const queued = run(rec, [{ kind: 'submit', origin: { kind: 'bridge' }, tokens: 318_400 }, { kind: 'start' }])
  expect(contexts(queued.steps[0]!.fx)[0]).toContain(`Registered handoff file: "${HANDOVER}".`)
  expect(queued.rec.job?.orphan).toBe(true)
  const queuedSs = run(migrateRecord(queued.rec, NOW + 3 * MIN), [[{ kind: 'sessionStart', source: 'clear' }, NOW + 3 * MIN]])
  expect(ofType(queuedSs.all, 'resume').length).toBe(1)
  expect(queuedSs.rec.job?.stage).toBe('resuming')
  // 重载时离发出已过 wait_minutes：命令撤不回，照样留作孤儿（搁置与否由空闲时间决定，见 wait_minutes 那条用例）
  const stale = run(rec, [[{ kind: 'start' }, NOW + WAIT]])
  expect(stale.rec.job?.orphan).toBe(true)
  expect(ofType(run(migrateRecord(stale.rec, NOW + WAIT + MIN), [[{ kind: 'sessionStart', source: 'clear' }, NOW + WAIT + MIN]]).all, 'resume').length).toBe(1)
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

/** 一步之后的形态：job 的阶段（没有 job 为 none）、兜底压缩在不在、挂着的作废说明、用户是否已接手（在重置后的对话里发了消息）、有没有被搁置的重置 */
function shape(r: Rec): string {
  return `${r.job ? r.job.stage : 'none'}${r.fallback ? '+fallback' : ''}${r.tell ? ` tell:${r.tell}` : ''}${r.job?.userTook ? ' took' : ''}${r.stalled ? ' stalled' : ''}${r.held ? ' held' : ''}`
}

test('cancel matrix: every event that can cancel, in every state (PLAN §3.3 and §0 items 20, 21, 23, 24)', () => {
  const S = ['idle', 'armed', 'clearing', 'compacting', 'resuming', 'fallback'] as const
  // 第 4 项（可选）：送事件前先改记录
  type Row = [string, (seq: number) => Ev | [Ev, number], Record<(typeof S)[number], string>, ((r: Rec) => Rec)?]
  const kept = { idle: 'none', armed: 'armed', clearing: 'clearing', compacting: 'compacting', resuming: 'resuming', fallback: 'none+fallback' }
  // 人工消息作废登记时，作废说明当场附在这条消息上（tell 随即清空）；排在已排队的重置前面的消息不作废也不算用户接手
  const cancelsArmed = { ...kept, armed: 'none' }
  // 重置后的对话已拿到交接、自家命令的结果还没回来时到的消息：记下用户已接手
  const tookOver = { ...kept, armed: 'none', clearing: 'clearing took', compacting: 'compacting took' }
  const handoffGiven = (r: Rec): Rec => (r.job ? { ...r, job: { ...r.job, ctxGiven: true } } : r)
  const rows: Row[] = [
    // 消息：人工、来源不明、引擎 meta、代理、自家
    ['human message', () => ({ kind: 'submit', origin: COMPOSER, tokens: 320_000 }), cancelsArmed],
    ['unclassified message without isMeta', () => ({ kind: 'submit', origin: { kind: 'unclassified' }, tokens: 320_000 }), cancelsArmed],
    ['human message, handoff already given to this conversation', () => ({ kind: 'submit', origin: COMPOSER, tokens: 320_000 }), tookOver, handoffGiven],
    ['unclassified message without isMeta, handoff already given', () => ({ kind: 'submit', origin: { kind: 'unclassified' }, tokens: 320_000 }), tookOver, handoffGiven],
    ['task notification, handoff already given', () => ({ kind: 'submit', origin: { kind: 'task-notification' }, tokens: 320_000 }), kept, handoffGiven],
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
    // 计时：登记后 / 发出后（对话一直空闲）/ 续接后都已超时。已排队的重置不丢，只是搁置
    [
      'timer past every limit',
      () => [{ kind: 'tick' }, NOW + 2 * WAIT],
      { ...kept, armed: 'none tell:timeout', clearing: 'none tell:stalled stalled', compacting: 'none tell:stalled stalled', resuming: 'none', fallback: 'none' },
    ],
    // 自家命令的结果
    // 已排队的交接重置被 Esc 否决：告诉模型，并挂起到用户下次输入（兜底压缩被否决不出声，同样挂起，见 compact_at 那条用例）；
    // 认不出的请求（不是当前的）不动
    ['own reset vetoed by Esc', (seq) => ({ kind: 'resetFailed', seq, message: VETO }), { ...kept, clearing: 'none tell:stopped held', compacting: 'none tell:stopped held', fallback: 'none held' }],
    [
      'own reset dropped from the queue by Esc',
      (seq) => ({ kind: 'resetFailed', seq, message: 'the command was removed from the queue before it ran' }),
      { ...kept, clearing: 'none tell:interrupted held', compacting: 'none tell:interrupted held', fallback: 'none held' },
    ],
    ['own reset vetoed by Esc, handoff already given to this conversation', (seq) => ({ kind: 'resetFailed', seq, message: VETO }), { ...kept, clearing: 'none held', compacting: 'none held', fallback: 'none held' }, handoffGiven],
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

test('chain guard: a conversation just continued from a handoff refuses to register until its context grows by resume_guard_tokens, passes remind_at, or the user writes', () => {
  const r = resumed()
  expect([r.resumed, r.resumedAt, r.resumedTokens]).toEqual([true, NOW, null])
  expect(r.job).toBe(null)
  // 续接回合：第一次响应之后的 PostToolUse 给出基准；模型照着交接文件里的「继续交接」又去登记：拒绝
  const a = run(r, [
    [{ kind: 'turnStart', turnId: T2 }, NOW + 1_000],
    [{ kind: 'postTool', tokens: 61_000 }, NOW + 20_000],
    [{ kind: 'register', verdict: FILE_OK, tokens: 63_000 }, NOW + 40_000],
  ])
  expect(a.steps[1]!.rec.resumedTokens).toBe(61_000)
  expect(a.steps[2]!.reply).toBe(
    'Not registered: this conversation was continued from a handoff file less than a minute ago and its context has grown only 2k since (63k now). ' +
      'Carry on with the work the handoff file describes, and hand off only when an AutoHandoff reminder asks for it or the user\'s or the project\'s instructions call for ending this conversation and continuing in a new one (updating a handover or notes document such as HANDOVER.md does not count). Registering works again once the context has grown by about 100k since the resume, passes 300k, or the user sends a message.',
  )
  expect(a.steps[2]!.accepted).toBe(false)
  expect(a.rec.job).toBe(null)
  // 读不到用量时也拒绝（宁可不交接）
  expect(run(a.rec, [{ kind: 'register', verdict: FILE_OK }]).steps[0]!.reply).toStartWith(
    'Not registered: this conversation was continued from a handoff file less than a minute ago, and its context usage cannot be read right now.',
  )
  // 任务通知、会话间消息、引擎 meta 消息不解除
  const notes = run(a.rec, [
    { kind: 'submit', origin: { kind: 'task-notification' }, tokens: 64_000 },
    { kind: 'submit', origin: { kind: 'peer-send-message' }, tokens: 64_000 },
    { kind: 'submit', origin: { kind: 'unclassified' }, isMeta: true, tokens: 64_000 },
    { kind: 'register', verdict: FILE_OK, tokens: 64_000 },
  ])
  expect(notes.steps[3]!.accepted).toBe(false)
  expect(notes.rec.resumedTokens).toBe(61_000)
  // 人工消息解除，续接时刻与基准一起清掉
  const human = run(a.rec, [{ kind: 'submit', origin: COMPOSER, tokens: 64_000 }, { kind: 'register', verdict: FILE_OK, tokens: 64_000 }])
  expect([human.steps[0]!.rec.resumed, human.steps[0]!.rec.resumedAt, human.steps[0]!.rec.resumedTokens]).toEqual([false, null, null])
  expect(human.steps[1]!.accepted).toBe(true)
  // 越过 remind_at 解除（这里第一个带用量的事件就在 remind_at 之上，增量是 0）：送了 remind 之后登记照常受理
  const big = run(r, [{ kind: 'turnStart', turnId: T2 }, { kind: 'postTool', tokens: 305_000 }, { kind: 'register', verdict: FILE_OK, tokens: 306_000 }])
  expect(contexts(big.steps[1]!.fx)[0]).toContain('[AutoHandoff: reminder]')
  expect([big.rec.resumed, big.rec.resumedTokens]).toEqual([false, null])
  expect(big.steps[2]!.accepted).toBe(true)
  // 登记时用量已过 remind_at（提醒还没来得及送）也受理
  expect(run(r, [{ kind: 'register', verdict: FILE_OK, tokens: 301_000 }]).steps[0]!.accepted).toBe(true)
  // compact 路径同样
  expect(resumed(CFG_COMPACT).resumed).toBe(true)
  // 用户在重置后的对话里、自家命令的结果回来之前发了消息（接手了）：不挡
  const { rec, seq } = clearing()
  const took = run(migrateRecord(rec, NOW), [{ kind: 'sessionStart', source: 'clear' }, { kind: 'submit', origin: COMPOSER, tokens: 9_000 }, { kind: 'resetDone', seq }])
  expect([took.rec.resumed, took.rec.resumedAt, took.rec.resumedTokens]).toEqual([false, null, null])
  // 排在重置前面、在旧对话里处理掉的人工消息不算：新对话照常续接、带守卫，人在新对话里再输入一次才解除
  const before = run(rec, [{ kind: 'submit', origin: { kind: 'bridge' }, tokens: 318_400 }, { kind: 'resetDone', seq }])
  expect([before.rec.resumed, before.rec.resumedAt, before.rec.resumedTokens]).toEqual([true, NOW, null])
  expect(run(before.rec, [{ kind: 'submit', origin: { kind: 'bridge' }, tokens: 52_000 }]).rec.resumed).toBe(false)
  // 用户自己 /clear 出来的新对话不带这个标记，基准也不带过去
  expect(migrateRecord({ ...a.rec }, NOW).resumed).toBe(false)
  expect(migrateRecord({ ...a.rec }, NOW).resumedTokens).toBe(null)
})

test('chain guard: the first registration after the resume, before any other usage reading, becomes the growth base and is refused', () => {
  const r = resumed()
  // 续接回合里模型第一件事就是登记（登记工具由 hook 直接作答，不触发 PostToolUse，之前没有带用量的事件）
  const first = run(r, [[{ kind: 'register', verdict: FILE_OK, tokens: 41_000 }, NOW + 30_000]])
  expect(first.steps[0]!.accepted).toBe(false)
  expect(first.steps[0]!.reply).toStartWith(
    'Not registered: this conversation was continued from a handoff file less than a minute ago and its context has grown only 0k since (41k now).',
  )
  expect(first.rec.resumedTokens).toBe(41_000)
  // 基准不因之后的登记而前移：从 41k 涨够 100k 才受理
  const later = run(first.rec, [
    [{ kind: 'register', verdict: FILE_OK, tokens: 140_999 }, NOW + 40 * MIN],
    [{ kind: 'register', verdict: FILE_OK, tokens: 141_000 }, NOW + 41 * MIN],
  ])
  expect(later.steps[0]!.reply).toContain('grown only 99k since (140k now)')
  expect(later.steps[1]!.accepted).toBe(true)
})

test('chain guard: a conversation driven by another session (agent messages only, nobody typing for hours) hands off on its own once its context has grown enough', () => {
  // 主人的实际设置：remind_at 400k；全局规则是约 300k 主动交接。编排会话用会话间消息派活，这个对话里几个小时没人打字
  const cfg = cfgWith({ remind_at: 400_000, urge_at: 450_000, compact_at: 650_000 })
  const PEER = { kind: 'peer-send-message' }
  const T3 = '8c2f4e61-9b0d-4a3c-b5e7-0d1f2a3b4c5d'
  const T4 = 'e1d2c3b4-a596-4877-8a9b-0c1d2e3f4a5b'
  const H = 60 * MIN
  const r = resumed(cfg)
  const t = run(
    r,
    [
      // 续接回合：读交接文件，回报现状
      [{ kind: 'turnStart', turnId: T2 }, NOW + 1_000],
      [{ kind: 'postTool', tokens: 38_400 }, NOW + 9_000],
      [{ kind: 'stop', active: false, tokens: 44_100 }, NOW + 60_000],
      [{ kind: 'turnComplete', turnId: T2, reason: 'answer', isAborted: false, tokens: 44_100 }, NOW + 61_000],
      // 一小时后编排会话派来第一批活
      [{ kind: 'submit', origin: PEER, tokens: 44_100 }, NOW + H],
      [{ kind: 'turnStart', turnId: T3 }, NOW + H],
      [{ kind: 'postTool', tokens: 97_500 }, NOW + H + 20 * MIN],
      // 做完一批，模型想交接（比如把工程规则的时点估早了）：从 38k 只涨了 82k，不受理
      [{ kind: 'register', verdict: FILE_OK, tokens: 121_300 }, NOW + H + 47 * MIN],
      [{ kind: 'stop', active: false, tokens: 122_000 }, NOW + H + 48 * MIN],
      [{ kind: 'turnComplete', turnId: T3, reason: 'answer', isAborted: false, tokens: 122_000 }, NOW + H + 48 * MIN],
    ],
    cfg,
  )
  expect(t.steps[1]!.rec.resumedTokens).toBe(38_400)
  expect(t.steps[7]!.reply).toBe(
    'Not registered: this conversation was continued from a handoff file 107 minutes ago and its context has grown only 82k since (121k now). ' +
      'Carry on with the work the handoff file describes, and hand off only when an AutoHandoff reminder asks for it or the user\'s or the project\'s instructions call for ending this conversation and continuing in a new one (updating a handover or notes document such as HANDOVER.md does not count). Registering works again once the context has grown by about 100k since the resume, passes 400k, or the user sends a message.',
  )
  // 主人这时看 /autohandoff status：守卫那一行给出基准与目前的增量（查看状态不算发话，不解除）。
  // 增量 83,600 取整为 83k，基准按 122k − 83k 显示为 39k（实际 38,400），与 Context 行的 122k 对得上
  const st = run(t.rec, [[{ kind: 'toggle', args: 'status', typed: true, tokens: 122_000, window: 1_000_000 }, NOW + 2 * H]], cfg)
  const lines = ofType(st.all, 'log')[0]!.text.split('\n')
  expect(lines).toContain('Context: 122k of 1000k. Reminders at 400k and 450k, compaction at 650k; reset with /clear.')
  expect(lines).toContain(
    'Just continued from a handoff file about 2 hours ago: a new handoff is not accepted until context has grown by 100k since the resume (from 39k, 83k so far), passes 400k, or you type a message or a command (this stops a reset loop).',
  )
  expect(st.rec.resumed).toBe(true)
  // 第二批：增量差一个 token 时仍挡着，到 100k 解除；之后到 296k 按工程规则（约 300k 主动交接）交接，受理
  const u = run(
    st.rec,
    [
      [{ kind: 'submit', origin: PEER, tokens: 122_000 }, NOW + 3 * H],
      [{ kind: 'turnStart', turnId: T4 }, NOW + 3 * H],
      [{ kind: 'postTool', tokens: 138_399 }, NOW + 3 * H + 5 * MIN],
      [{ kind: 'postTool', tokens: 138_400 }, NOW + 3 * H + 6 * MIN],
      [{ kind: 'postTool', tokens: 296_000 }, NOW + 4 * H],
      [{ kind: 'register', verdict: FILE_OK, tokens: 296_800 }, NOW + 4 * H],
    ],
    cfg,
  )
  expect(u.steps[2]!.rec.resumed).toBe(true)
  expect([u.steps[3]!.rec.resumed, u.steps[3]!.rec.resumedAt, u.steps[3]!.rec.resumedTokens]).toEqual([false, null, null])
  expect(contexts(u.all)).toEqual([])
  expect(u.steps[5]!.accepted).toBe(true)
  expect(u.rec.job?.stage).toBe('armed')
  // 这次交接重置、续接之后，新对话重新挡上：续接时刻是这次的，基准等第一个带用量的事件
  const v = run(u.rec, [[{ kind: 'stop', active: false, tokens: 297_000 }, NOW + 4 * H], [{ ...DONE, turnId: T4, tokens: 297_000 }, NOW + 4 * H]], cfg)
  const w = run(migrateRecord(v.rec, NOW + 4 * H + 5_000), [[{ kind: 'resetDone', seq: lastSeq(v.all) }, NOW + 4 * H + 5_000]], cfg)
  expect([w.rec.resumed, w.rec.resumedAt, w.rec.resumedTokens]).toEqual([true, NOW + 4 * H + 5_000, null])
})

test('chain guard: resume_guard_tokens 0 leaves only remind_at and the user\'s message', () => {
  const cfg = cfgWith({ remind_at: 400_000, urge_at: 450_000, compact_at: 650_000, resume_guard_tokens: 0 })
  const r = resumed(cfg)
  const t = run(
    r,
    [
      [{ kind: 'postTool', tokens: 38_400 }, NOW + 9_000],
      [{ kind: 'submit', origin: { kind: 'peer-send-message' }, tokens: 250_000 }, NOW + 3 * 60 * MIN],
      [{ kind: 'register', verdict: FILE_OK, tokens: 251_000 }, NOW + 3 * 60 * MIN],
    ],
    cfg,
  )
  expect(t.steps[2]!.accepted).toBe(false)
  expect(t.steps[2]!.reply).toBe(
    'Not registered: this conversation was continued from a handoff file about 3 hours ago and its context (251k) is below 400k. ' +
      'Carry on with the work the handoff file describes, and hand off only when an AutoHandoff reminder asks for it or the user\'s or the project\'s instructions call for ending this conversation and continuing in a new one (updating a handover or notes document such as HANDOVER.md does not count). Registering works again once the context passes 400k or the user sends a message.',
  )
  const st = run(t.rec, [[{ kind: 'toggle', args: 'status', tokens: 251_000 }, NOW + 3 * 60 * MIN]], cfg)
  expect(ofType(st.all, 'log')[0]!.text).toContain(
    'Just continued from a handoff file about 3 hours ago: a new handoff is not accepted until context passes 400k or you type a message or a command (this stops a reset loop).',
  )
  // 越过 remind_at：解除，提醒照常
  const big = run(t.rec, [{ kind: 'postTool', tokens: 401_000 }, { kind: 'register', verdict: FILE_OK, tokens: 402_000 }], cfg)
  expect(contexts(big.steps[0]!.fx)[0]).toContain('[AutoHandoff: reminder]')
  expect(big.steps[1]!.accepted).toBe(true)
  // 人工消息：解除
  expect(run(t.rec, [{ kind: 'submit', origin: COMPOSER, tokens: 251_000 }, { kind: 'register', verdict: FILE_OK, tokens: 251_000 }], cfg).steps[1]!.accepted).toBe(true)
})

test('chain guard in /autohandoff status: before the first usage reading after the resume, and when the status check itself is that reading', () => {
  const r = resumed()
  const unread = ofType(run(r, [[{ kind: 'toggle', args: 'status' }, NOW + 4 * MIN]]).all, 'log')[0]!.text
  expect(unread).toContain(
    'Just continued from a handoff file 4 minutes ago: a new handoff is not accepted until context has grown by 100k since the resume (usage after the resume not read yet), passes 300k, or you type a message or a command (this stops a reset loop).',
  )
  const first = run(r, [[{ kind: 'toggle', args: 'status', tokens: 52_300 }, NOW + 4 * MIN]])
  expect(first.rec.resumedTokens).toBe(52_300)
  expect(ofType(first.all, 'log')[0]!.text).toContain('(from 52k, 0k so far), passes 300k, or you type a message or a command')
})

test('chain guard with action compact: set when our /compact resolves; the growth base is the first usage reading after the compaction', () => {
  const { rec, seq } = clearing(CFG_COMPACT)
  // 压缩完成（实测顺序：SessionStart(compact) 先到，随后 /compact 的 promise resolve）：resolve 时置位，基准还没有
  const done = run(rec, [[{ kind: 'sessionStart', source: 'compact' }, NOW + 14_000], [{ kind: 'resetDone', seq }, NOW + 15_000]], CFG_COMPACT)
  expect(ofType(done.all, 'resume').length).toBe(1)
  expect([done.rec.resumed, done.rec.resumedAt, done.rec.resumedTokens]).toEqual([true, NOW + 15_000, null])
  // 压缩后到第一次响应之前读不到用量；续接回合第一次 PostToolUse（摘要 + 续接提示）给出基准
  const t = run(
    done.rec,
    [
      [{ kind: 'resumeDone', seq }, NOW + 16_000],
      [{ kind: 'turnStart', turnId: T2 }, NOW + 16_000],
      [{ kind: 'postTool', tokens: 29_000 }, NOW + 25_000],
      [{ kind: 'register', verdict: FILE_OK, tokens: 31_500 }, NOW + 40_000],
    ],
    CFG_COMPACT,
  )
  expect(t.steps[1]!.rec.resumedTokens).toBe(null)
  expect(t.steps[2]!.rec.resumedTokens).toBe(29_000)
  expect(t.steps[3]!.accepted).toBe(false)
  expect(t.steps[3]!.reply).toContain('continued from a handoff file less than a minute ago and its context has grown only 2k since (31k now).')
  // 从压缩后的 29k 涨够 100k：解除，登记受理（之后重置用的仍是 /compact）
  const u = run(t.rec, [{ kind: 'postTool', tokens: 128_999 }, { kind: 'postTool', tokens: 129_000 }, { kind: 'register', verdict: FILE_OK, tokens: 129_400 }], CFG_COMPACT)
  expect(u.steps[0]!.rec.resumed).toBe(true)
  expect(u.steps[1]!.rec.resumed).toBe(false)
  expect(u.steps[2]!.reply).toContain('reset with /compact')
})

test('chain guard after a hot reload: the orphan job\'s SessionStart(clear) sets it at that moment, with no base yet', () => {
  const { rec, seq } = clearing()
  const reloaded = run(rec, [[{ kind: 'start' }, NOW + 2 * MIN]])
  expect(reloaded.rec.job?.orphan).toBe(true)
  // 旧模块的回调没来：新对话的 SessionStart(clear) 走 afterReset，置位守卫、提交续接
  const ss = run(migrateRecord(reloaded.rec, NOW + 3 * MIN), [[{ kind: 'sessionStart', source: 'clear' }, NOW + 3 * MIN]])
  expect(ofType(ss.all, 'resume').length).toBe(1)
  expect(ss.rec.job?.stage).toBe('resuming')
  expect([ss.rec.resumed, ss.rec.resumedAt, ss.rec.resumedTokens]).toEqual([true, NOW + 3 * MIN, null])
  // 续接回合里的登记照样被挡；基准是续接后第一次读数
  const t = run(ss.rec, [
    [{ kind: 'turnStart', turnId: T2 }, NOW + 3 * MIN],
    [{ kind: 'resumeDone', seq }, NOW + 3 * MIN],
    [{ kind: 'postTool', tokens: 36_000 }, NOW + 3 * MIN + 10_000],
    [{ kind: 'register', verdict: FILE_OK, tokens: 37_000 }, NOW + 4 * MIN],
  ])
  expect(t.rec.resumedTokens).toBe(36_000)
  expect(t.steps[3]!.accepted).toBe(false)
  expect(t.steps[3]!.reply).toContain('continued from a handoff file 1 minute ago and its context has grown only 1k since (37k now).')
})

test('chain guard: a command the user types lifts it like a message (/compact before it runs, /model, /autohandoff on|off); /autohandoff status, a mistyped argument and an untyped /autohandoff do not', () => {
  const cfg = cfgWith({ remind_at: 400_000, urge_at: 450_000, compact_at: 650_000 })
  const g = run(resumed(cfg), [[{ kind: 'postTool', tokens: 70_000 }, NOW + 10_000], [{ kind: 'postTool', tokens: 165_000 }, NOW + 50 * MIN]], cfg).rec
  expect([g.resumed, g.resumedTokens]).toEqual([true, 70_000])
  const lifting: Ev[] = [
    { kind: 'userCommand', command: 'compact' },
    { kind: 'userCommand', command: 'model' },
    { kind: 'toggle', args: 'on', typed: true },
    { kind: 'toggle', args: 'off', typed: true },
    { kind: 'toggle', args: '', typed: true },
  ]
  for (const ev of lifting) {
    const t = run(g, [ev], cfg)
    expect([t.rec.resumed, t.rec.resumedAt, t.rec.resumedTokens]).toEqual([false, null, null])
  }
  const keeping: Ev[] = [
    { kind: 'toggle', args: 'status', typed: true, tokens: 165_000 },
    { kind: 'toggle', args: 'enable', typed: true },
    { kind: 'toggle', args: 'on' },
  ]
  for (const ev of keeping) expect(run(g, [ev], cfg).rec.resumed).toBe(true)
  // 用户的 /compact：压缩之前就解除；压缩后用量回落到 40k，编排会话派来的活里登记照常受理（守卫不会因回落重新挡住）
  const c = run(
    g,
    [
      { kind: 'userCommand', command: 'compact' },
      { kind: 'sessionStart', source: 'compact' },
      // 压缩后到第一次响应之前读不到用量
      { kind: 'submit', origin: { kind: 'peer-send-message' } },
      { kind: 'turnStart', turnId: T2 },
      { kind: 'postTool', tokens: 40_000 },
      { kind: 'register', verdict: FILE_OK, tokens: 41_000 },
    ],
    cfg,
  )
  expect(c.steps[5]!.accepted).toBe(true)
})

test('chain guard and Claude Code\'s own compaction: usage falling below the base counts as no growth; it waits for base + resume_guard_tokens or remind_at', () => {
  // 守卫期间碰到 CC 自动压缩，只在 remind_at 设在 CC 自己的压缩点之上时才会发生（比如 400k 的阈值配了窗口更小的模型）
  const cfg = cfgWith({ remind_at: 400_000, urge_at: 450_000, compact_at: 650_000 })
  const t = run(
    resumed(cfg),
    [
      [{ kind: 'turnStart', turnId: T2 }, NOW + 1_000],
      [{ kind: 'postTool', tokens: 70_000 }, NOW + 10_000],
      [{ kind: 'postTool', tokens: 165_000 }, NOW + 40 * MIN],
      // 回合中 CC 自动压缩，之后用量回落
      [{ kind: 'sessionStart', source: 'compact' }, NOW + 41 * MIN],
      [{ kind: 'postTool', tokens: 40_000 }, NOW + 42 * MIN],
      [{ kind: 'register', verdict: FILE_OK, tokens: 41_000 }, NOW + 43 * MIN],
    ],
    cfg,
  )
  // 基准不因回落重取
  expect(t.rec.resumedTokens).toBe(70_000)
  expect(t.steps[5]!.accepted).toBe(false)
  expect(t.steps[5]!.reply).toContain('continued from a handoff file 43 minutes ago and its context has grown only 0k since (41k now).')
  const st = ofType(run(t.rec, [[{ kind: 'toggle', args: 'status', typed: true, tokens: 41_000 }, NOW + 44 * MIN]], cfg).all, 'log')[0]!.text
  expect(st).toContain('has grown by 100k since the resume (from 70k; the context is below that now), passes 400k, or you type a message or a command')
  // 要涨到基准 + 100k（170k）才解除
  const u = run(
    t.rec,
    [
      { kind: 'postTool', tokens: 169_999 },
      { kind: 'register', verdict: FILE_OK, tokens: 169_999 },
      { kind: 'postTool', tokens: 170_000 },
      { kind: 'register', verdict: FILE_OK, tokens: 170_400 },
    ],
    cfg,
  )
  expect(u.steps[1]!.reply).toContain('grown only 99k since (169k now)')
  expect(u.steps[3]!.accepted).toBe(true)
  // 基准高时 remind_at 先到：基准 350k 的对话压缩后，越过 400k 就解除（不必等 450k）
  const high = run(
    resumed(cfg),
    [{ kind: 'postTool', tokens: 350_000 }, { kind: 'sessionStart', source: 'compact' }, { kind: 'postTool', tokens: 60_000 }, { kind: 'postTool', tokens: 400_000 }],
    cfg,
  )
  expect(high.steps[2]!.rec.resumed).toBe(true)
  expect(high.steps[3]!.rec.resumed).toBe(false)
})

test('chain guard prompts: the handoff instructions say next steps are the work itself, never "hand off again"', () => {
  const p = defaultConfig().prompts
  expect(p.remind).toContain('Under next steps write the work itself; never write "hand off", "write a handoff" or "continue the handoff" there')
  expect(p.urge).toContain('Under next steps write the work itself, not "hand off" or "continue the handoff".')
  expect(p.cancelled).toContain('(next steps are the work itself, never "hand off again")')
  expect(p.start_context).toContain(
    'Do not hand off again right away: hand off again only when a new AutoHandoff reminder asks for it, or when the user\'s or the project\'s instructions call for ending this conversation and continuing in a new one (updating a handover or notes document such as HANDOVER.md does not count).',
  )
})

test('compact window (action compact): a human message, an agent message, /autohandoff off and an engine notice while /compact runs', () => {
  const cfg = CFG_COMPACT
  const { rec, seq } = clearing(cfg)
  expect(rec.job?.stage).toBe('compacting')
  // 排在 /compact 前面的人工消息（回合中从 Remote Control 发来的）：在压缩前的对话里处理，附说明；压缩后照常续接、带守卫
  const h = run(
    rec,
    [{ kind: 'submit', origin: { kind: 'bridge' }, tokens: 318_000 }, ...oldTurn(T2, 319_500), { kind: 'sessionStart', source: 'compact' }, { kind: 'resetDone', seq }],
    cfg,
  )
  expect(contexts(h.steps[0]!.fx)).toEqual([userNote('compact')])
  expect(contexts(h.steps[5]!.fx)[0]).toContain(`Handoff file: "${HANDOVER}"`)
  expect(ofType(h.all, 'resume').length).toBe(1)
  expect(ofType(h.all, 'compact')).toEqual([])
  expect(h.rec.job?.stage).toBe('resuming')
  expect(h.rec.resumed).toBe(true)
  // SessionStart(compact) 之后、promise resolve 之前到的人工消息：由压缩后的对话处理（用户接手），不附说明、不续接
  const h2 = run(rec, [{ kind: 'sessionStart', source: 'compact' }, { kind: 'submit', origin: COMPOSER }, { kind: 'resetDone', seq }], cfg)
  expect(contexts(h2.steps[1]!.fx)).toEqual([])
  expect(ofType(h2.all, 'resume')).toEqual([])
  expect(h2.rec.job).toBe(null)
  expect(h2.rec.resumed).toBe(false)
  // 实测的顺序（压缩窗口里敲的消息要等压缩完才交出，这时已是续接阶段）：续接已提交，消息照常处理
  const h3 = run(rec, [{ kind: 'sessionStart', source: 'compact' }, { kind: 'resetDone', seq }, { kind: 'submit', origin: COMPOSER }], cfg)
  expect(ofType(h3.all, 'resume').length).toBe(1)
  expect(contexts(h3.steps[2]!.fx)).toEqual([])
  expect(h3.rec.job?.stage).toBe('resuming')
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
  // 用户在自己 /clear 出来的新对话里发了消息、模型答了（这个对话已拿到交接：用户已接手），之后自家的 /compact 才在这个对话上执行：
  // 压缩完不再硬塞一条续接，也不置守卫。SessionStart(compact) 与命令结果谁先到都一样
  const inNew = run(
    ss.rec,
    [
      { kind: 'submit', origin: COMPOSER, tokens: 46_000 },
      { kind: 'turnStart', turnId: T2 },
      { kind: 'postTool', tokens: 52_000 },
      { kind: 'stop', active: false, tokens: 54_000 },
      { kind: 'turnComplete', turnId: T2, reason: 'answer', isAborted: false, tokens: 54_000 },
    ],
    cfg,
  )
  expect(contexts(inNew.steps[0]!.fx)).toEqual([])
  expect(inNew.rec.job?.userTook).toBe(true)
  const ssCompact: Ev = { kind: 'sessionStart', source: 'compact' }
  const result: Ev = { kind: 'resetDone', seq }
  for (const order of [[ssCompact, result], [result, ssCompact]]) {
    const end = run(inNew.rec, order, cfg)
    expect(ofType(end.all, 'resume')).toEqual([])
    expect(end.rec.job).toBe(null)
    expect(end.rec.resumed).toBe(false)
  }
  // 自家 /compact 在几乎空的新对话上失败：不告诉模型「重置失败」，照常续接
  const failed = run(ss.rec, [{ kind: 'resetFailed', seq, message: 'autohandoff: $.command.run: Error: Not enough messages to compact.' }], cfg)
  expect(failed.rec.tell).toBe(null)
  expect(ofType(failed.all, 'toast')).toEqual([])
  expect(ofType(failed.all, 'resume').length).toBe(1)
  expect(failed.rec.job?.stage).toBe('resuming')
  // 用户按 Esc 否决：静默作废（交接已经给了新对话，这里的模型没登记过什么，不必告诉它「登记作废了」）
  const vetoed = run(ss.rec, [{ kind: 'resetFailed', seq, message: VETO }], cfg)
  expect(vetoed.rec.job).toBe(null)
  expect(vetoed.rec.tell).toBe(null)
  expect(ofType(vetoed.all, 'toast')).toEqual([])
  expect(ofType(vetoed.all, 'resume')).toEqual([])
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
    `AutoHandoff: context usage is about 470k tokens, past the 450k handoff threshold, and no handoff is registered. Before ending the turn, write the handoff file for the next conversation at the path below and call the ${TOOL_FULL_NAME} tool with that path.${NO_NOTE}`,
  ])
})

test('remind_every_turn: a short reminder on every later message (human or agent) until registered; none when off, while registered, during a compaction or with unknown usage', () => {
  const sent = run(onRecord(), [{ kind: 'turnStart', turnId: T1 }, { kind: 'postTool', tokens: 305_000 }]).rec
  const short = (tokens: number) =>
    `[AutoHandoff] Context usage is about ${tokens / 1000}k tokens, past the first threshold of 300k, and no handoff is registered yet. Before this turn ends, finish the step in progress, write the handoff file for the next conversation at the path below, call the ${TOOL_FULL_NAME} tool with that path, and then end the turn.${NO_NOTE}`
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

// ───────── 本轮交接文件与超长退回（PLAN §0 第 30 条） ─────────

const SID_A = '6f1c2b8e-3a4d-4e5f-9a0b-1c2d3e4f5a6b'
const SID_B = 'b7e9d1c3-5f2a-4b6c-8d0e-2f4a6b8c0d1e'
const NOTE_ENV = { dirs: [REPO], sid: SID_A, windows: false }
const noteAt = (at: number, sid = SID_A, dir = REPO) => `${dir}/.autohandoff/_AUTOHANDOFF_${localStamp(at)}_${sid.slice(0, 8)}.md`
const lineFor = (path: string) => `Handoff file to write: "${path}" (a new file for this handoff; register this path).`
const regAt = (path: string, fileTokens?: number): Ev => ({ kind: 'register', verdict: { ok: true, value: path }, ...(fileTokens === undefined ? {} : { fileTokens }) })

test('handoff file to write: the first reminder fixes the path; short reminders, the urge, the Stop block and registering again after a cancel all use it', () => {
  const P = noteAt(NOW)
  const a = run(
    onRecord(),
    [
      { kind: 'submit', origin: COMPOSER, tokens: 296_000 },
      { kind: 'turnStart', turnId: T1 },
      { kind: 'postTool', tokens: 301_900 },
    ],
    defaultConfig(),
    NOTE_ENV,
  )
  // 越线前不生成；第一次完整提醒末尾带路径，正文里说「末尾给的路径」
  expect(a.steps[0]!.rec.note).toBeNull()
  const remind = contexts(a.steps[2]!.fx)[0]!
  expect(remind.endsWith(`\n\n${lineFor(P)}`)).toBe(true)
  expect(remind).toContain('as a new file at the path given at the end of this message')
  expect(a.rec.note).toBe(P)
  expect(ofType(a.steps[2]!.fx, 'log')[0]!.text).toBe(`remind sent at 301k; handoff file to write: ${P}`)

  // 3 分钟后的下一条消息：短提醒，同一个路径（不按新时刻重算）
  const b = run(a.rec, [[{ kind: 'submit', origin: COMPOSER, tokens: 306_000 }, NOW + 3 * MIN]], defaultConfig(), NOTE_ENV)
  expect(contexts(b.all)[0]!.endsWith(lineFor(P))).toBe(true)

  // 登记后用户插话作废；回合里再送的完整提醒、之后的 urge、Stop block 都还是它
  const c = run(
    b.rec,
    [
      [{ kind: 'turnStart', turnId: T2 }, NOW + 4 * MIN],
      [regAt(P, 6_100), NOW + 5 * MIN],
      [{ kind: 'submit', origin: COMPOSER, tokens: 309_000 }, NOW + 6 * MIN],
      [{ kind: 'postTool', tokens: 311_000 }, NOW + 7 * MIN],
      [{ kind: 'postTool', tokens: 452_000 }, NOW + 9 * MIN],
    ],
    defaultConfig(),
    NOTE_ENV,
  )
  expect(c.steps[1]!.accepted).toBe(true)
  expect(contexts(c.steps[2]!.fx)[0]).toContain('[AutoHandoff] Your registered handoff was cancelled (a new message from the user arrived)')
  expect(contexts(c.steps[3]!.fx)[0]!.endsWith(lineFor(P))).toBe(true)
  expect(contexts(c.steps[4]!.fx)[0]).toContain('[AutoHandoff: hand off now]')
  expect(contexts(c.steps[4]!.fx)[0]!.endsWith(lineFor(P))).toBe(true)
  const d = run(c.rec, [[{ kind: 'turnStart', turnId: T1 }, NOW + 10 * MIN], [{ kind: 'stop', active: false, tokens: 455_000 }, NOW + 11 * MIN]], defaultConfig(), NOTE_ENV)
  expect(ofType(d.all, 'block')[0]!.text.endsWith(lineFor(P))).toBe(true)
  expect(d.rec.note).toBe(P)
  // /autohandoff status 也报这个路径
  const st = run(d.rec, [{ kind: 'toggle', args: 'status', tokens: 455_000 }])
  expect(ofType(st.all, 'log')[0]!.text).toContain(`Handoff: none registered. Second reminder sent. Handoff file to write: "${P}".`)
})

test('handoff file to write: the next conversation after the reset (/clear or /compact) gets a new path at its first reminder', () => {
  for (const action of ['clear', 'compact'] as const) {
    const cfg = cfgWith({ action })
    const P = noteAt(NOW)
    const a = run(onRecord(), [{ kind: 'turnStart', turnId: T1 }, { kind: 'postTool', tokens: 301_900 }, regAt(P, 6_100), { kind: 'stop', active: false, tokens: 318_400 }, DONE], cfg, NOTE_ENV)
    expect(a.rec.job?.file).toBe(P)
    // /clear 换 sid、记录搬过去；/compact 不换 sid
    const rec = action === 'clear' ? migrateRecord(a.rec, NOW + MIN) : a.rec
    const sid = action === 'clear' ? SID_B : SID_A
    const later = NOW + 40 * MIN
    const b = run(
      rec,
      [
        [{ kind: 'resetDone', seq: lastSeq(a.all) }, NOW + MIN],
        [{ kind: 'sessionStart', source: action }, NOW + MIN],
        [{ kind: 'resumeDone', seq: lastSeq(a.all) }, NOW + MIN],
        [{ kind: 'turnStart', turnId: T2 }, later],
        [{ kind: 'postTool', tokens: 303_000 }, later],
      ],
      cfg,
      { dirs: [REPO], sid, windows: false },
    )
    // 新对话拿到的交接是旧路径；它自己的第一轮提醒是新路径（新时刻、/clear 时还是新会话 ID）
    expect(contexts(b.steps[1]!.fx)[0]).toContain(`Handoff file: "${P}"`)
    const next = noteAt(later, sid)
    expect(next).not.toBe(P)
    expect(contexts(b.steps[4]!.fx)[0]!.endsWith(lineFor(next))).toBe(true)
  }
})

test('handoff file to write: two conversations of one project reminded in the same second get different paths; a compaction that drops usage below remind_at starts a new round', () => {
  const remindFor = (sid: string) => run(onRecord(), [{ kind: 'turnStart', turnId: T1 }, { kind: 'postTool', tokens: 301_900 }], defaultConfig(), { dirs: [REPO], sid, windows: false }).rec.note
  expect(remindFor(SID_A)).toBe(noteAt(NOW, SID_A))
  expect(remindFor(SID_B)).toBe(noteAt(NOW, SID_B))
  expect(remindFor(SID_A)).not.toBe(remindFor(SID_B))

  const a = run(onRecord(), [{ kind: 'turnStart', turnId: T1 }, { kind: 'postTool', tokens: 301_900 }], defaultConfig(), NOTE_ENV)
  // Claude Code 自己压缩过：用量回落，路径作废；再越线时按那时的时刻生成
  const b = run(a.rec, [[{ kind: 'sessionStart', source: 'compact' }, NOW + 5 * MIN], [{ kind: 'postTool', tokens: 120_000 }, NOW + 6 * MIN]], defaultConfig(), NOTE_ENV)
  expect(b.rec.note).toBeNull()
  const c = run(b.rec, [[{ kind: 'postTool', tokens: 300_500 }, NOW + 50 * MIN]], defaultConfig(), NOTE_ENV)
  expect(c.rec.note).toBe(noteAt(NOW + 50 * MIN))
  // 没给材料（读工程目录出错）：提醒照送，末尾只泛指放在哪类地方（正文说的「末尾给的路径」不落空），也不定下路径；
  // 下一次拿到材料时再生成
  const d = run(onRecord(), [{ kind: 'turnStart', turnId: T1 }, { kind: 'postTool', tokens: 301_900 }])
  expect(d.rec.note).toBeNull()
  expect(contexts(d.all)[0]!.endsWith(NO_NOTE)).toBe(true)
  expect(NO_NOTE).toContain('a new file in the project folder or the Claude Code auto-memory folder')
  const e = run(d.rec, [[{ kind: 'submit', origin: COMPOSER, tokens: 303_000 }, NOW + 2 * MIN]], defaultConfig(), NOTE_ENV)
  expect(e.rec.note).toBe(noteAt(NOW + 2 * MIN))
  expect(contexts(e.all)[0]!.endsWith(lineFor(noteAt(NOW + 2 * MIN)))).toBe(true)
})

test('oversize: a handoff file over handoff_max_tokens is not registered; the reply gives the estimate, the limit and the size to aim for', () => {
  const P = noteAt(NOW)
  const a = run(onRecord(), [{ kind: 'turnStart', turnId: T1 }, { kind: 'postTool', tokens: 301_900 }, regAt(P, 23_400)], defaultConfig(), NOTE_ENV)
  const refused = a.steps[2]!
  expect(refused.accepted).toBe(false)
  expect(refused.reply).toBe(
    "Not registered: the handoff file is about 24k tokens by AutoHandoff's estimate, over the 20k limit (handoff_max_tokens), and the next conversation reads all of it. Shorten it to about 15k tokens. Keep what is needed to continue (work in progress, next steps, questions waiting for the user, running subagents or background tasks, standing agreements) and leave details to the project's own documents, without cutting those documents for this. Then call the tool again.",
  )
  expect(ofType(refused.fx, 'log')[0]!.text).toStartWith('registration refused: the handoff file is about 24k tokens')
  expect(a.rec.job).toBeNull()
  // 压短后重新登记：受理，路径不变；到下一轮之前提醒照旧用它
  const b = run(a.rec, [regAt(P, 13_900)])
  expect(b.steps[0]!.accepted).toBe(true)
  expect(b.rec.job?.file).toBe(P)
  expect(b.rec.note).toBe(P)
})

test('oversize: at the limit, size unknown, the check off (0) or a raised limit: registered, whatever legal path it is', () => {
  const accepted = (path: string, fileTokens: number | undefined, cfg = defaultConfig()) =>
    run(onRecord(), [{ kind: 'turnStart', turnId: T1 }, { kind: 'postTool', tokens: 301_900 }, regAt(path, fileTokens)], cfg).steps[2]!.accepted
  expect(accepted(noteAt(NOW), 20_000)).toBe(true)
  expect(accepted(noteAt(NOW), 20_001)).toBe(false)
  // 用户自写提示词、登记工程自己的 HANDOVER.md：不超限就照收
  expect(accepted(HANDOVER, 11_200)).toBe(true)
  expect(accepted(HANDOVER, 39_373)).toBe(false)
  // 读不到正文（估算缺省）
  expect(accepted(HANDOVER, undefined)).toBe(true)
  expect(accepted(HANDOVER, 39_373, cfgWith({ handoff_max_tokens: 0 }))).toBe(true)
  expect(accepted(HANDOVER, 39_373, cfgWith({ handoff_max_tokens: 50_000 }))).toBe(true)
})

test('oversize: an oversize file that is not this round\'s path (the project\'s own HANDOVER.md) is left alone; the reply asks for a new file at the path given', () => {
  const P = noteAt(NOW)
  const a = run(onRecord(), [{ kind: 'turnStart', turnId: T1 }, { kind: 'postTool', tokens: 301_900 }, regAt(HANDOVER, 39_373)], defaultConfig(), NOTE_ENV)
  const refused = a.steps[2]!
  expect(refused.accepted).toBe(false)
  expect(refused.reply).toBe(
    `Not registered: the handoff file is about 40k tokens by AutoHandoff's estimate, over the 20k limit (handoff_max_tokens), and the next conversation reads all of it. Do not delete from or shorten "${HANDOVER}" for this; it may be one of the project's own documents. Instead write the handoff as a new file of about 15k tokens that makes sense on its own, at "${P}". Keep what is needed to continue (work in progress, next steps, questions waiting for the user, running subagents or background tasks, standing agreements) and leave details to the project's own documents. Then call the tool with that file's path.`,
  )
  expect(refused.reply).not.toContain('Shorten it')
  // 照办：新写的那份不超限，受理
  const b = run(a.rec, [regAt(P, 9_800)])
  expect(b.steps[0]!.accepted).toBe(true)
  expect(b.rec.job?.file).toBe(P)

  // 这轮还没给过路径（提醒之前就登记，比如用户手动要求交接）：只说另写一份新文件，放在工程目录或记忆目录（与 noteLine(undefined) 同一说法；
  // 从主目录启动时工程目录不可用，只说工程目录会被判在工程外）
  const c = run(onRecord(), [regAt(HANDOVER, 39_373)])
  expect(c.steps[0]!.reply).toContain('Instead write the handoff as a new file of about 15k tokens that makes sense on its own, in the project folder or the Claude Code auto-memory folder.')
  expect(noteLine(undefined)).toContain('in the project folder or the Claude Code auto-memory folder')
  expect(c.steps[0]!.reply).toContain(`Do not delete from or shorten "${HANDOVER}"`)
  // 只给了文件名（放进记忆目录）：登记的正是记忆目录里那个文件 → 压短；别的文件 → 指向那个文件名
  const mem = run(onRecord(), [{ kind: 'turnStart', turnId: T1 }, { kind: 'postTool', tokens: 301_900 }], defaultConfig(), { dirs: [], sid: SID_A, windows: false })
  const name = mem.rec.note!
  expect(name).toBe(`_AUTOHANDOFF_${localStamp(NOW)}_6f1c2b8e.md`)
  const memFile = `/home/jane/.claude/projects/-home-jane/memory/${name}`
  expect(run(mem.rec, [regAt(memFile, 23_400)]).steps[0]!.reply).toContain('Shorten it to about 15k tokens.')
  expect(run(mem.rec, [regAt(HANDOVER, 23_400)]).steps[0]!.reply).toContain(`that makes sense on its own, named "${name}" in the Claude Code auto-memory folder.`)
})

test('a refused registration says an earlier registration still stands (it is not cancelled by the refusal)', () => {
  const P = noteAt(NOW)
  const a = run(onRecord(), [{ kind: 'turnStart', turnId: T1 }, { kind: 'postTool', tokens: 301_900 }, regAt(P, 9_800)], defaultConfig(), NOTE_ENV)
  expect(a.rec.job?.stage).toBe('armed')
  // 之后把文件改大、再登记：被退回，但原来的登记还在
  const b = run(a.rec, [regAt(P, 26_000)])
  expect(b.steps[0]!.accepted).toBe(false)
  expect(b.steps[0]!.reply!.endsWith(` Your earlier registration of "${P}" is still in effect.`)).toBe(true)
  expect(b.rec.job?.file).toBe(P)
  expect(b.rec.job?.stage).toBe('armed')
  // 路径不合规被拒也一样；没有登记时不加这句
  const c = run(a.rec, [{ kind: 'register', verdict: { ok: false, why: 'the file does not exist' } }])
  expect(c.steps[0]!.reply).toBe(`Not registered: the file does not exist. Your earlier registration of "${P}" is still in effect.`)
  expect(run(onRecord(), [{ kind: 'register', verdict: { ok: false, why: 'the file does not exist' } }]).steps[0]!.reply).toBe('Not registered: the file does not exist.')
})
