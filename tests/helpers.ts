// 单测共用的夹具：贴近真实会话的路径、stat 结果、配置文本，以及按事件序列驱动状态机的小工具。

import {
  defaultConfig,
  newRecord,
  transition,
  type Config,
  type Effect,
  type Ev,
  type Rec,
  type StatLike,
  type Step,
} from '../hooks/core.js'

/** 2026-10-25 12:00 JST */
export const NOW = Date.UTC(2026, 9, 25, 3, 0, 0)
export const MIN = 60_000

// 真实形态的目录（Linux 实测：cwd/root 是物理路径，repo() 给 git 根，配置目录是 ~/.claude）
export const HOME = '/home/user'
export const REPO = '/home/user/projects/myproject'
export const CWD = '/home/user/projects/myproject/server'
export const CC_DIR = '/home/user/.claude'
export const HANDOVER = '/home/user/projects/myproject/docs/work/HANDOVER.md'
export const PROJECT_DIR_KEY = '-home-user-projects-myproject'
export const MEMORY_NOTE = `${CC_DIR}/projects/${PROJECT_DIR_KEY}/memory/handoff-2026-10-25.md`
/** 工程根目录（cwd、root、repo 根）；配置目录另传 configDir */
export const ROOTS = [CWD, CWD, REPO]

/** 一个刚写好的交接文件的 stat（resolve:true） */
export function freshStat(realPath: string = HANDOVER, over: Partial<StatLike> = {}): StatLike {
  return { kind: 'file', size: 6_842, mtimeMs: NOW - 2 * MIN + 0.731, realPath, ...over }
}

/** 交接文件已登记好的 Verdict（turnComplete 时 register.ts 复查的结果） */
export const FILE_OK = { ok: true as const, value: HANDOVER }

// 用户真实会改的配置：阈值调高一点、换成 compact、改写 remind 的开头
export const USER_CONFIG = `# AutoHandoff configuration

<!-- my settings for the 1M-context model -->

## settings

default_on: true
remind_at: 350_000
urge_at: 480,000
compact_at: 700000
action: compact
fresh_minutes: 15
wait_minutes: 45
urge_block: false
remind_every_turn: true

## remind

[AutoHandoff] Context is at {used_k}k (first line {remind_k}k).
Finish the current edit, update docs/work/HANDOVER.md, then call {tool}.
Reset happens with {action}.

## resume

[AutoHandoff: resume] Context was reset with {action}. Read the handoff file named below, then git status, and carry on.
`

export function cfgWith(over: Partial<Config['settings']> = {}): Config {
  const c = defaultConfig()
  Object.assign(c.settings, over)
  return c
}

/** 用户已打开开关、收到过人工输入的记录 */
export function onRecord(over: Partial<Rec> = {}): Rec {
  return { ...newRecord(NOW - 30 * MIN), on: true, human: true, ...over }
}

export interface Trace {
  rec: Rec
  steps: Step[]
  /** 全部副作用，按顺序 */
  all: Effect[]
}

/** 依次送入事件；每个事件的时刻可以用 [ev, at] 指定，否则用 NOW */
export function run(start: Rec, events: (Ev | [Ev, number])[], cfg: Config = defaultConfig()): Trace {
  let rec = start
  const steps: Step[] = []
  for (const item of events) {
    const [ev, at] = Array.isArray(item) ? item : [item, NOW]
    const st = transition(rec, ev, { cfg, now: at })
    steps.push(st)
    rec = st.rec
  }
  return { rec, steps, all: steps.flatMap((s) => s.fx) }
}

export function ofType<T extends Effect['type']>(fx: readonly Effect[], type: T): Extract<Effect, { type: T }>[] {
  return fx.filter((f): f is Extract<Effect, { type: T }> => f.type === type)
}

export function contexts(fx: readonly Effect[]): string[] {
  return ofType(fx, 'context').map((f) => f.text)
}

/** 最后一个 clear/compact/resume 副作用带的请求序号（register.ts 回调时要原样带回） */
export function lastSeq(fx: readonly Effect[]): number {
  for (let i = fx.length - 1; i >= 0; i--) {
    const f = fx[i]!
    if (f.type === 'clear' || f.type === 'compact' || f.type === 'resume') return f.seq
  }
  throw new Error('no reset or resume effect in the list')
}
