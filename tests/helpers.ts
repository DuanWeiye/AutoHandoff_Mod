// 单测共用的夹具：贴近真实会话的路径、stat 结果、配置文本，以及按事件序列驱动状态机的小工具。

import {
  defaultConfig,
  newRecord,
  transition,
  type Config,
  type Effect,
  type Env,
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
handoff_max_tokens: 30_000

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

/**
 * 依次送入事件；每个事件的时刻可以用 [ev, at] 指定，否则用 NOW。
 * note：生成本轮交接文件路径的材料（register.ts 只给 submit、postTool、stop 带，这里同样只给这三种）；缺省不带，提醒末尾就没有路径
 */
export function run(start: Rec, events: (Ev | [Ev, number])[], cfg: Config = defaultConfig(), note?: Env['note']): Trace {
  let rec = start
  const steps: Step[] = []
  for (const item of events) {
    const [ev, at] = Array.isArray(item) ? item : [item, NOW]
    const wants = ev.kind === 'submit' || ev.kind === 'postTool' || ev.kind === 'stop'
    const st = transition(rec, ev, { cfg, now: at, note: wants ? note : undefined })
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

// ───────── 交接文件大小（token 估算）用的合成文本 ─────────

/**
 * 一份按「每次交接在顶上加一个日期小节、从不移走」习惯长出来的交接文档（合成内容，中英混排）。
 * sections：日期小节数；每节约 18 行。zh=false 时全英文。
 */
export function growingHandover(sections: number, zh = true): string {
  const out: string[] = [zh ? '# 交接文档（最新在最前）' : '# Handover (newest first)', '']
  for (let i = 0; i < sections; i++) {
    const day = 26 - Math.floor(i / 8)
    const hh = String(23 - (i % 8) * 2).padStart(2, '0')
    const hash = (0x5a3c19f + i * 7919).toString(16).slice(0, 7)
    if (zh) {
      out.push(
        `## 2026-10-${day} ${hh}:15 JST — 第 ${sections - i} 批：上传状态机重构`,
        '',
        `- 已完成：\`src/Core/Upload/CommitLanded.cs\` 改成显式状态机，单测 ${40 + i}/${40 + i} 通过（commit ${hash}）。`,
        '- 进行中：Windows 验收脚本 `tests/accept/run-b2.ps1` 第 3 段（断网复制）还在跑，日志写到 `logs/accept-b2.log`。',
        `- 后台代理：Opus 审查员 agent-a${hash}f 在审 \`git diff ${hash}..HEAD\`，回来后按 Major/Minor 处理。`,
        '- 待主人定：原子上传默认开还是关？大文件（> 4 GiB）是否分块续传？',
        '- 下一步：补复现用例 → 重跑验收 → 发回同一审查员二审。',
        '',
        '说明：落地判定原来散在三个调用点，各自重传整份文件；现在统一走 CommitLandedAsync，改动方只提交差异块，服务端按版本号核对后才覆盖，避免两个客户端同时改同一文件时后写覆盖先写。断网时暂存到本地队列，恢复后按顺序重放，重放前先重列目标目录确认没有被别处删掉。',
        '',
        '| 场景 | 结果 | 备注 |',
        '|---|---|---|',
        `| 断网复制 | 通过 | 重试 ${i % 5} 次后成功 |`,
        '| 改名覆盖 | 失败 | MOVE 未带 Overwrite:T，已修 |',
        '',
        '```',
        `dotnet test tests/Core.Tests --filter Upload  # ${40 + i} passed`,
        '```',
        '',
      )
    } else {
      out.push(
        `## 2026-10-${day} ${hh}:15 JST - batch ${sections - i}: upload state machine rewrite`,
        '',
        `- Done: \`src/Core/Upload/CommitLanded.cs\` is now an explicit state machine; unit tests ${40 + i}/${40 + i} pass (commit ${hash}).`,
        '- In progress: the Windows acceptance script `tests/accept/run-b2.ps1` part 3 (copy while offline) is running; log in `logs/accept-b2.log`.',
        `- Background agent: reviewer agent-a${hash}f is reviewing \`git diff ${hash}..HEAD\`; handle its Major/Minor findings when it reports.`,
        '- Waiting for the user: atomic upload on or off by default? Resume chunked uploads for files over 4 GiB?',
        '- Next: add the repro test, rerun acceptance, send the fixes back to the same reviewer.',
        '',
        'Why: the landing check used to live in three call sites, each re-uploading the whole file; it now goes through CommitLandedAsync, the client sends only the changed blocks, and the server checks the version before overwriting, so two clients editing the same file no longer lose an update. Offline writes wait in a local queue and are replayed in order once the share is back, after listing the target folder again to make sure nothing deleted it meanwhile.',
        '',
        '| Case | Result | Note |',
        '|---|---|---|',
        `| copy while offline | pass | succeeded after ${i % 5} retries |`,
        '| rename over existing | fail | MOVE lacked Overwrite:T; fixed |',
        '',
        '```',
        `dotnet test tests/Core.Tests --filter Upload  # ${40 + i} passed`,
        '```',
        '',
      )
    }
  }
  return out.join('\n')
}

/** 字符构成与给定统计相同的文本：lines 行、ASCII 字符 ascii 个（含换行）、非 ASCII 字符 nonAscii 个。只用来对估算做回归。 */
export function textWithCounts(ascii: number, nonAscii: number, lines: number): string {
  const letters = ascii - (lines - 1)
  const body = 'a'.repeat(letters) + '中'.repeat(nonAscii)
  return body + '\n'.repeat(lines - 1)
}
