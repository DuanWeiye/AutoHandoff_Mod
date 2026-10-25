# AutoHandoff 改写为 Mod：可行性实测报告

- 日期：2026-10-25（JST），Claude Code 2.1.310，Linux（arm64），测试模型 sonnet
- 探针代码：`mod-probe/`（`.claude-plugin/plugin.json`、`hooks/hooks.json`、`hooks/register.js`）
- 原始证据：`mod-probe/evidence/`
  - `probe.jsonl`：mod 侧事件和操作日志，每行带毫秒时间戳 `t` 和当时的 session id `sid`
  - `settings-hooks.jsonl`：`--settings` 挂的 SessionStart、UserPromptSubmit、Stop、SessionEnd 命令 hook 收到的 stdin
  - `probe-p*.jsonl`：`claude -p` 实验的日志
- 隔离方式：
  - 独立 tmux server（`tmux -L modprobe`），cwd 用 scratchpad 下的空目录
  - 启动命令：`claude --plugin-dir mod-probe --settings <临时 json> --debug-file <临时 log> --model sonnet`
  - 结束后已 kill-server，并删除测试 cwd 对应的 `~/.claude/projects/...` 目录，以及这些会话的 ctx、session-env、security 残留文件
  - 全局设置、已装的 autohandoff 插件、其它对话都没有动

## 探针怎么用

探针用 JS 写，写了一个按行追加的日志函数，用 `$.process.run` 调 `sh -c 'printf … >> file'` 实现，原因是 `$.fs` 没有 append。

它记录这些事件：
- `session.start` / `session.end`
- `classic.SessionStart`
- `prompt.submit`（入参和结果）
- `command.run`
- `turn.start` / `turn.step` / `turn.complete`

注册了四个命令触发动作：

| 命令 | 作用 |
|---|---|
| `/probe <op> [text]` | 立即执行。用 `void` 跑，脱离 hook，不 await |
| `/probe-after <秒> <op> [text]` | 用 `$.clock.after` 定时执行，用来在回合进行中调用 |
| `/probe-arm <op> [text]` | 下一次主循环 `turn.complete` 时用 `void` 执行，也就是产品要用的时机 |
| `/probe-arm-await <op>` | 下一次 `turn.complete` 时在 hook 里 `await` 执行 |

可用的 op：
- `usage`、`agents`、`read`
- `clear`
- `submit`（带 `asUser:true`）、`submitframed`（不带）
- `cs`：先 clear，再 submit asUser，前后各记一次 `$.agent.list()` 和 `$.prompt.read()`

`claude -p` 下没法敲命令，改用环境变量 `PROBE_ARM="<op> [text]"` 预先挂好动作。

---

## 1. 能否用 `--plugin-dir` 加载

**结论**：能。

**证据**：
- `claude plugin validate mod-probe` 通过，只有 author/icon 两条无关警告。输出：
  ```
  ❯ ./register.js hooks: session.start, session.end, classic.SessionStart, prompt.submit, command.run, turn.start, turn.step, turn.complete, command.run{command=probe}, …
  ❯ ./register.js answers its own command: command.run{command=probe} …
  ❯ ./register.js gating hook without .catch: classic.SessionStart / prompt.submit / command.run
  ❯ ./register.js calls: $.agent.list (via runOp), $.clock.after, $.clock.now, $.command.register, $.command.run (via runOp), $.env.get, $.process.run (via log), $.prompt.read, $.prompt.submit (via runOp), $.session.id, $.session.usage, $.ui.log
  ❯ ./register.js env reads: PROBE_LOG
  ```
- debug log 里的加载行：`hooks module mod-probe@inline loaded (worker, environment 1, tier user); events: session.start,session.end,classic.SessionStart,prompt.submit,command.run,turn.start,turn.step,turn.complete`
- `/plugin` 页签顶部显示 `1 mod active · mod-probe`。
- 编辑 `register.js` 后，回合结束时 transcript 出现一行 `● mod-probe: reloaded (8 hooks: …)`。

**注意**：
- 新目录在接受 workspace trust 之前不会加载 mod，debug log 里是这行：`hooks modules not loaded until workspace trust is accepted: mod-probe, …`。
- 加载时引擎会往 mod 目录里写东西：`.claude-plugin/types/`（自带 `.gitignore: *`）和根目录的 `tsconfig.json`。正式仓库要考虑是否把 `tsconfig.json` 加入 `.gitignore`。

## 2. `$.session.usage()` 是否可靠

**结论**：可靠，而且正好是现在 handoff.py 从 transcript 算出来的那个数。在 `turn.complete` 里 `await next(e)` 之后读，拿到的是刚结束这一回合最后一次请求的输入侧合计。

**证据**（第一回合有一次 Bash 调用，共两次请求）：

| 来源 | 数值 |
|---|---|
| transcript 最后一条 assistant 的 usage | input 2 + cache_creation 105 + cache_read 41582 = **41689** |
| `turn.complete` 里读的 `$.session.usage().context` | `{"tokens":41689,"window":1000000,"percent":4}` |
| 状态栏 | `CTX: 42k / 1m (4% used)` |

**对设计的含义**：
- **`turn.complete` 的 `e.usage` 不能当上下文用**。它是本回合所有请求加总：`{"input_tokens":4,"cache_creation_input_tokens":41687,"cache_read_input_tokens":41582,…}`。
- **`context.window` 是模型窗口（1,000,000），不是 autoCompactWindow**。要引用压缩点，仍得自己读设置，可以用 `$.settings.read`，也可以沿用现有的优先级逻辑。
- `/clear` 之后 `tokens` 和 `percent` 不存在，直到新对话的第一个响应：`{"startedAt":…629671,"context":{"window":1000000},…,"cost":{"usd":0}}`。同时 `startedAt` 变成 clear 的时刻，`cost` 归零。
- Esc 中断的回合之后，`tokens` 仍然有值（41760），是被中断那次请求的输入。
- 读 usage 是免费的。不带 `breakdown` 时不发请求。

## 3. `$.command.run({command:'clear'})` 对内置 /clear 是否生效

**结论**：生效，效果和人手敲 `/clear` 一样。

**证据**：
- 会 end 掉旧 session：`session.end`，`{"reason":"clear","sessionId":"<旧>","resume":{"id":"<旧>"}}`。
- 会 start 一个新 session：`classic.SessionStart`，`source:"clear"`，带新的 `session_id` 和新的 `transcript_path`，新的 `.jsonl` 文件确实生成了。
- settings 命令 hook 按顺序触发：`SessionEnd clear <旧sid>` → `SessionStart clear <新sid>`（见 `settings-hooks.jsonl`）。
- 已安装的 autohandoff 的 `SessionEnd:clear` hook 也照常跑了。
- 新 transcript 里有一条 `/clear` 的 user 记录，`"origin":{"kind":"plugin","name":"mod-probe"}`，还有一条 `system/local_command` 记录，带 `"commandRun":{"command":"clear","args":""}`。

**resolve 时机和返回值**：
- 会等 clear 真正做完才 resolve，返回 `{"text":""}`。
- 空闲时调用：耗时 117–193 ms。resolve 之后马上调 `$.session.id()`，拿到的已经是新 id。

**回合进行中调用**：
- 会排队，等到空闲才执行，不会打断当前回合。
- 实测时间线：
  1. 定时器在第 4 秒调用，当时 Bash 还在跑。debug log 记录 `$.command.run (mod-probe): 6 chars queued`。
  2. TUI 的队列区显示 `› Prompt from the mod-probe plugin ❯ /clear`。
  3. 回合 `turn.complete` 之后约 95 ms 执行了 clear。
  4. 调用在发出 17.7 s 后才 resolve。

**在 `turn.complete` hook 里 await 调用**：
- 文档说这类调用在"回合正在等待的 hook 里"会 reject。
- 实测在 `turn.complete` 里先 `await next(e)` 再 `await $.command.run(clear)`，**没有被拒，clear 照常完成**，耗时 132 ms。
- 但文档这么写，参考实现也用 `void`，产品代码还是应该用 `void` 脱离 hook 执行。

## 4. clear 之后 `$.prompt.submit({text, asUser:true})` 的效果

**结论**：会在新对话里开出一个回合，模型把它当成用户本人的话。

**时机和返回值**：
- clear resolve 后约 0.4 s 新回合 `turn.start`，submit 在 turn.start 那一刻 resolve。
- 返回：`{"text":"…","origin":{"kind":"plugin","name":"mod-probe","asUser":true}}`

**transcript 里的记录和人工输入的区别**：

| 字段 | mod 发的 | 人工输入 |
|---|---|---|
| `origin` | `{"kind":"plugin","name":"mod-probe","asUser":true}` | `{"kind":"human"}` |
| `promptSource` | `"system"` | `"typed"` |
| `turnOrigin` | `"system"` | `"human"` |
| `turnPosition` | `{"promptIndex":0,"turnIndex":1}` | |

消息正文就是原文本，没有加 "The mod-probe plugin sent a message" 的前缀。

**界面**：TUI 在这条消息上方显示一行 `› Prompt from the mod-probe plugin`，用户能看出来源。

**模型的反应**：
- 每次都按指令回 `RESUMED…`。
- 问它有没有更早的对话，它回答"看不到更早的对话内容……只有你刚才的这条消息和系统注入的全局设定"。说明 clear 真的清干净了，CLAUDE.md 照常加载。

**其它**：
- settings 的 `UserPromptSubmit` 命令 hook 会对这条 submit 触发，所以 handoff.py 现有的 UserPromptSubmit 逻辑也会看到它。
- mod 自己的 `prompt.submit` / `command.run` hook **看不到本 mod 在 hook 返回之后发起的调用**。debug log：`hooks module mod-probe@inline command.run skipped: re-entry (the plugin's own code raised it; origin mod-probe)`。在 hook 内部 await 发起的调用，自家的其它 hook 能看到（log 里是 nested）。

## 5. 边界情况

### 5a. 输入框里有未发送的草稿

**结论**：草稿保留，不会被清空，也不会被发出去。

**证据**：
- 先输入 `my unsent draft XYZ` 不回车，6 秒后定时器触发 `cs`。
- clear 后 `$.prompt.read()` 返回 `{"text":"my unsent draft XYZ","cursor":19}`。
- 续接回合跑完后，输入框里仍是这段草稿。

**含义**：用户正在打字时 mod 照样会 clear，而且是有草稿也当空闲执行。参考实现用"handoff 期间用户发过新 prompt 计数"来避开竞态。"用户刚好在回合结束瞬间按回车"这种竞态本次**未验证**。

### 5b. AskUserQuestion 对话框开着

**结论**：clear 排队，等回答完、回合结束后才执行，然后续接。

**证据**：
- 定时器在问题框显示期间调用，队列区出现 `/clear`。
- 选了 blue 之后，回合以 `answer:"blue"` 结束，约 120 ms 后 clear，再续接。
- 补充：该回合 `durationMs` 只有 4653，实际墙钟约 32 s。说明 `durationMs` 不含等用户的时间。

### 5c. 权限弹窗开着

在 manual 模式下让模型调 Write，弹出权限框后定时器调用。

**结论**：和 5b 一样排队。选"No"拒绝之后，回合以 `reason:"answer", isAborted:false` 结束（answer 为空），排队的 clear 和续接**照常执行**。也就是说，拒绝权限不算 Stop。

**未完全弄清**：拒绝到回合真正结束之间隔了约 18 s，debug log 中间只有 Remote Control 的 bridge 活动。可能是"No"选项还要再确认一次，原因未查明，不影响结论。

### 5d. 有后台 subagent 在跑时 clear

**结论**：**clear 不会结束后台 subagent，它的汇报会送进 clear 之后的新对话。**

**证据**：
- clear 前 `$.agent.list()` 返回 `[{"id":"a5461212399d01c0a","description":"Background sleep task","type":"general-purpose","status":"running"}]`，clear 之后再查还是同样的 `running`。
- TUI 显示 `Waiting for 1 background agent to finish`。
- 约 37 s 后，它的 hand-back 进了新对话：`prompt.submit`，`origin:{"kind":"peer"}`，正文是 `<agent-message from="a5461212399d01c0a">[Subagent hand-back]…`。
- 随后几条 `task-notification` 也进来了：`origin:{"kind":"task-notification"}`。
- 每条都在新对话里开了一个回合，新对话的模型对这些汇报没有上下文（"新上下文里没有已派出的 subagent 记录"）。
- subagent 自己的回合也会触发 `turn.start` / `turn.complete`，带 `agentId`。

**含义**：
- 自动 clear 前必须用 `$.agent.list()` 检查 `pending`、`running`、`waiting` 状态，有就推迟。参考实现也是这么做的。
- 或者把在跑的 agent 写进交接，让新对话知道这些汇报会来。
- 参考实现的注释写"A /clear ends every agent still working"，与本次实测**不符**。
- `turn.complete` 的 hook 必须过滤 `e.agentId !== undefined`。

## 6. `turn.complete` 的字段和 Esc 后的拒绝行为

**主循环 `turn.complete` 的字段**：
- `durationMs`、`isAborted`、`turnId`、`reason`（`answer|aborted|refusal|error`）
- `usage`：本回合各请求的加总
- `answer`：最终文本
- `agentId`：只有 subagent 的回合才有

**Esc 中断时**：`{"isAborted":true,"reason":"aborted","answer":""}`，被打断时已经流出了部分正文，`answer` 里会带上这部分。

**中断后的拒绝行为与文档一致**：

| 情况 | 结果 |
|---|---|
| 中断时正在队列里的 `$.command.run(clear)` | 被丢弃，reject：`the command was removed from the queue before it ran` |
| 被中断回合的 `turn.complete` 里 `void` 调 clear | 5 ms 内 reject：`mod-probe: $.command.run: the session was stopped and nobody has sent input since` |
| 中断后定时器调 `$.prompt.submit` | 3 ms 内 resolve 为 `{"drop":"the session was stopped and nobody has sent input since"}` |

用户再输入任何东西之后限制解除。实测敲一条 `/probe-arm` 命令就算。

**对设计的含义**：
- 用户 Esc 等于否决这次自动 clear，行为正确。
- 交接文件已写好时，要记下"待 clear"，在用户下次输入后的 `turn.complete` 再试，文档给了重试范例。也可以提示用户手动 `/clear`。
- 判断失败要用错误信息里的这两段字符串。

## 7. `claude -p` 非交互模式

**结论**：mod 会加载，事件也照常触发，但 `$.command.run`、`$.prompt.submit`、`$.agent.list` 都不能用。

**证据**：
- `session.start` 的 `e`：`{"surface":null,"isInteractive":false}`，`$.session.surfaces()` 为 `[]`。
- prompt 的 `origin.kind` 为 `"sdk"`，`turn.complete` 正常触发。
- 三个调用都 reject，错误信息相同：`… is not available in this mode: no session is bound in this process (the REPL has not mounted and no headless session is built); catch it and carry on`。
- 进程退出时 `session.end` 的 `reason:"other"`。

**含义**：和现有插件一样，`-p` 下不支持接管。mod 要在 `session.start` 用 `e.isInteractive` 判断，保持静默。

## 8. 对后续设计有用的事实

**debug log**：
- `claude --debug` 或 `--debug-file <path>` 才会写。
- 关键行：`hooks module <name>@inline loaded …`、`… skipped: re-entry …`、`$.command.run (<name>): N chars queued`。
- 用 `--plugin-dir` 跑交互会话时，hook 失败、模块加载失败、热重载这几类信息，会以暗色行直接出现在 transcript 里。
- 安装版的 mod 只写 debug log。
- 自己写 debug 行：`$.ui.log(text, {to:'debug'})`。

**时限**（来自文档，未实测超时）：

| 对象 | 限制 |
|---|---|
| 单个 hook 自身的执行时间 | 10 s。不算 `next` 和 `$` 调用的等待，但 `$.clock.sleep` 要算 |
| `.catch` 处理器 | 1 s |
| 全部 `session.end` hook 合计 | 1.5 s，从 settings 的 SessionEnd hook 跑完后开始算 |
| `$.process.run` | 默认 30 s，最长 10 min |

超时的 hook 会被跳过。

**`$.store`**：
- 每个 plugin 一个 JSON 文件，放在 `~/.claude/plugins/store/`。
- 本机所有会话共享，总量上限 4 MiB。
- `get` 加 `set` 不是原子操作，多会话同时改同一个 key 时后写覆盖先写。文档建议每项用独立的 key。
- 长时间没人读写会按 `cleanupPeriodDays` 清掉。

**`$.state`**：
- 每个会话一份，热重载后保留。
- `/clear`、`/resume`、`/branch` 会把它重置为默认值，并且 `session.start` 不会再触发。需要在 `classic.SessionStart`（`source=clear`）里重新载入。

**`$.fs.write`**：
- 不是原子写，就地覆盖，别的进程可能读到写了一半的文件。也没有 append 和 rename。
- 多会话共享的状态应该放 `$.store`。
- 交接文件由模型自己写，不受影响。

**模块运行环境**：
- 没有 Node API，没有 `setTimeout`，用 `$.clock.after/every`。
- 模块里不能出现 `import()`。
- 把 `$` 传给 `register` 内部声明的函数会被 validate 拒绝，辅助函数要写在模块顶层。
- 热重载会重置模块变量，定时器也会被取消。

**其它观察**：
- 已安装的 autohandoff（`SessionEnd:clear`、`handoff.py hook`）在测试会话里也加载了。正式切换到 mod 版时，两者共存会重复接管，必须二选一。
- 本机全局开着 Remote Control（`/rc`），测试会话也会挂上 bridge。

---

## Mod 路线可行性总判断

**可行，而且明显比现有方案简单、稳健。** 核心的三步都实测通过：
1. 读用量：`$.session.usage()`，与 transcript 算出的数一致。
2. 清空：`$.command.run({command:'clear'})`，等同人工 `/clear`，SessionEnd/SessionStart 链完整。
3. 续接：`$.prompt.submit({text, asUser:true})`，模型当作用户发言，transcript 里有明确的 plugin 来源可审计。

可以去掉的东西：
- tmux send-keys、Windows 键盘注入、对终端类型的依赖
- 读 transcript 估算用量的逻辑
- "回合是否真正结束"的启发式判断：`turn.complete` 加上 command.run 自带的排队到空闲，已经替我们处理了

### 发现的限制和坑

1. **后台 subagent 不会被 clear 杀掉**，它的汇报和通知会以 `peer`、`task-notification` 来源送进新对话，各开一个回合。clear 前必须检查 `$.agent.list()` 的 busy 状态，并决定推迟还是写进交接。参考实现的"clear 会结束 agent"说法与实测不符。
2. **Esc 之后到用户下次输入之前，所有自启动的 clear 和 submit 都会被拒或丢弃**。这是合理的语义，但需要实现"待 clear"状态，并在下次合适的 `turn.complete` 重试。
3. **`claude -p` 下不可用**，但事件照发。要按 `isInteractive` 保持静默。
4. **`e.usage` 是回合内加总，`context.window` 是模型窗口**，两者都不能直接拿来做阈值和压缩点判断。clear 后到第一个响应之前没有 tokens。
5. **草稿不影响 clear**：草稿会保留，有草稿也当空闲执行。"用户在回合结束瞬间发出新 prompt"与自动 clear 的竞态本次未验证，需要像参考实现那样做计数保护。
6. **自家 hook 看不到自家发起的事件**（re-entry），状态机不能靠自己的 `prompt.submit` hook 识别续接 prompt。来源判断用 `e.origin.kind === 'plugin'`，但这只对其它 mod 有效。
7. **API 仍是 early access**，文档说会变。生成的类型文件随版本变化，正式版要锁定最低版本，并在 `session.start` 检查 `$.session.version()`。
8. **未验证**：
   - VS Code 扩展和桌面端里 `command.run` 的行为
   - Windows 上实际跑 mod
   - `prompt.context` 注入交接内容（参考实现的做法）
   - 用 `$.tool.register` 注册 `mcp__<plugin>__register` 取代 `python3 handoff.py register`
   - 回合中途越过阈值时，用 tool.call 结果提醒模型收尾
   - hook 超时的实际表现

---

## 9. 第 0 批验证（2026-10-25）

- 环境：Claude Code 2.1.310，Linux（arm64），测试模型 sonnet。
- 探针：`mod-probe/p2/`，插件名就叫 `autohandoff`，带一份 `commands/autohandoff.md`，用来测同名命令。行为开关放在 `PROBE_CFG` 指向的 JSON 文件里，每个事件都重读一次，所以改开关不用热重载。
- 原始证据在 `mod-probe/evidence/p2/`：
  - `probe-*.jsonl`：各会话的事件日志
  - `debug-*.excerpt.log`：debug log 里和本插件有关的行
  - `transcript-resume.excerpt.jsonl`：续接对话 transcript 的元数据摘录
  - `ui-capture.txt`：tmux 截屏
- 隔离方式：
  - 独立 tmux server `tmux -L modprobe2`，`--settings` 用临时 json 关掉全局已装的 `autohandoff@autohandoff`，并设 `AUTOHANDOFF_DISABLE=1`。
  - 工作目录是 scratchpad 下的 git 目录、非 git 目录、通往非 git 目录的符号链接、git 子目录。
  - 会话 A、B、C、E 用 `--permission-mode default`（manual），E 用 auto；D 走 `e2e/fault_proxy.py`。
- 收尾：已 kill-server，停掉 fault_proxy，删掉测试会话的 projects、ctx、session-env、security、tasks 残留和探针的 store 文件；全局设置和已装插件都没动。

### 9.1 classic.SessionStart 的 additionalContext

**结论**：能送到模型。正确写法是 `string[]`：

```js
const r = await next(e)
return { ...r, additionalContext: [...(r.additionalContext ?? []), text] }
```

写成错误形状时，这个 hook 会被跳过，前面 `next()` 的结果照常生效，模型什么也收不到。

**证据**：
- 自家 `command.run('clear')` 之后：
  - `classic.SessionStart` 照常触发，`source:"clear"`，带新的 sid。
  - 新对话里问模型，它原样复述了 `PROBE-SS-CTX token=SS1: …`。
  - transcript 里记成 `attachment {type:"hook_additional_context", hookName:"SessionStart"}`。
- 时序（`probe-A.jsonl`）：
  - clear 的 promise 在 69 ms 时 resolve。
  - **resolve 之后约 180 ms** 才到 `classic.SessionStart`。
  - 再过约 230 ms，续接回合开始。
- compact 之后也会触发 `classic.SessionStart`，`source:"compact"`。
- 返回 `additionalContext: "字符串"`（错误形状）时：
  - debug：`[ERROR] hook failed: autohandoff: errorKind=HooksError … (classic.SessionStart; skipped; its last next() run's result stands)`
  - transcript 里出现一行暗色字：`classic.SessionStart hook skipped: returned the wrong shape (additionalContext of the wrong type)`
  - 模型收不到任何内容。

**对实现的含义**：
- **不能假设 SessionStart 先于 clear resolve 到达**。迁移 store 记录、切换状态时，两边都要能处理，谁先到就由谁来做。
- compact 后同样可以用 SessionStart 给出 start_context。

### 9.2 登记工具

**结论**：五个子问题全部符合预期。

| 子项 | 结果 | 证据 |
|---|---|---|
| (e) 全名 | `mcp__autohandoff__register_handoff`。`--plugin-dir` 加载时也是这个名字，不带 `@inline` | `$.tool.register` 返回 `{tool:"mcp__autohandoff__register_handoff"}`，约 100 ms 后可见；模型自述的全名相同；TUI 显示 `autohandoff - register_handoff (MCP)(file: …)` |
| (a) 主对话调用 | `e` 里**没有** `agentId` 键 | `e` 的键只有 `file`、`tool`、`tool_use_id` |
| (b) general-purpose 子代理调用 | `e.agentId = "a904d9323568546da"` | 与 `turn.start`/`turn.complete` 的 agentId 一致，也与 Stop 的 `background_tasks[].id` 一致（本机设置下子代理被放到后台跑） |
| (c) fork（`subagent_type:"fork"`）调用 | `e.agentId = "a6f62f9cbae16cf2b"` | fork 的 PostToolUse 里 `agent_type:"fork"` |
| (d) 是否弹权限框 | manual 和 auto 模式下都**不弹** | debug：`tool.call mcp__autohandoff__register_handoff …: resolved by a hooks module (result)` |

**补充**：
- 由 hook 直接作答的工具调用**不会触发 `classic.PostToolUse`**。
- 热重载后再注册同一个工具时，debug 记 `unchanged and listed; not re-registered`。

**对实现的含义**：§6.1 ① 的做法成立，按 `e.agentId !== undefined` 拒绝即可。

### 9.3 classic.Stop 的 block

**结论**：可以用。返回 `{ ...r, block: '<理由>' }`，模型会接着写一步。第二次 Stop 时 `stop_hook_active:true`。

**单次回合内的顺序**：
1. `turn.step`（第 0 步）
2. `classic.Stop`（block）
3. `turn.step`（第 1 步）
4. `classic.Stop`（`stop_hook_active:true`）
5. `turn.complete`

- `turn.complete` **只在最后触发一次**，`answer` 只有最后一步的文字（`"STOP-BLOCK-SEEN"`，不含第一步的「你好」）。
- 每次都是 Stop 比 turn.complete 早 10–25 ms。

**用户能看到什么**：TUI 显示 `Stop hook error: <理由>`，而且挂在另一个插件的 Stop 命令行下面（`Ran 1 stop hook … sg-python.sh`）。用户能看到全文，文字上还标着 "error"。

**以下情况不触发 classic.Stop**：
- Esc 中断
- API 错误
- 安全拒绝（refusal）
- 权限被拒，无论是在弹窗上按 Esc 还是选 No

**`background_tasks` 的形态**：`[{"id":"a904…","type":"subagent","status":"running","description":"…","agent_type":"general-purpose"}]`；`session_crons:[]`。

**另外**：每个主回合结束后，引擎内部的 fork（`agent_type:""`）都会触发一次 `classic.SubagentStop`。

**对实现的含义**：
- `urge_block` 的文案要写成「给用户看到也没关系」的样子，因为它会以 "Stop hook error" 的形式显示出来。
- 「本回合是否触发过 Stop」本身可以当作信号用，见 9.12。

### 9.4 classic.PostToolUse 的 additionalContext

**结论**：
- 主对话里（`e.agent_id` 不存在）返回 `additionalContext:[…]`，能送到模型。模型读到的是 `PostToolUse:Bash hook additional context: …`。
- fork 里的 PostToolUse 有 `agent_id:"a6f6…"`、`agent_type:"fork"`。

**新发现：另一条通道**。在 `tool.call` 里先 `await next(e)`，再返回 `{ ...r, context:[…] }`，模型同样能收到，读到的是 `tool.call hook additional context: …`。用户在 TUI 里两者都看不到。

**副作用**：在子代理或 fork 的 hook 里调 `$.session.usage()`，拿到的是**主对话**的用量（45537，等于主对话上一次请求的值）。

### 9.5 prompt.submit

**context 能不能送到、用户看不看得到**：
- `next({...e, context:[…]})` 能随这条消息送到模型。模型读到的是 `prompt.submit hook additional context: …`。
- 用户看不到。
- 给 `task-notification` 来源的消息附加 context 同样生效。

**各来源的 `origin.kind`**：

| 来源 | origin.kind | 备注 |
|---|---|---|
| 人工输入 | `composer` | 斜杠命令也是 composer，这时 `e.command={name,args}` |
| 后台子代理的完成通知 | `task-notification` | |
| 子代理 SendMessage 回报 | `peer` | §5d 已有 |
| 自家 `$.prompt.submit` | 不适用 | 自家 hook **看不到**。debug：`prompt.submit skipped: re-entry`。transcript 里 `origin:{kind:"plugin",name:"autohandoff",asUser:true}`，`promptSource:"system"` |
| teammate 发给 lead 的消息 | 不适用 | **不经过 prompt.submit**，走 `session.receive`，`origin:{kind:"peer",teammate:"scout2",isVerified:false}` |

另外，`$.prompt.submit` 的参数里**没有 context**（d.ts `PromptSubmitArgs` 把它排除了）。

**对实现的含义**：
- 自家续接回合无法附加 context。方案 C 把路径放在正文里，正好绕开了这个限制。
- 代理类消息附 `pending_note` 的做法可行。
- teammate 消息不会让 lead 的登记作废。

### 9.6 compact 的两条路

两种调用方式都会触发 `classic.PreCompact`、`classic.SessionStart(source=compact)`、`classic.PostCompact`，focus 文字也都进了摘要。其余行为如下：

| | `$.command.run({command:'compact', args})` | `$.session.compact({instructions})` |
|---|---|---|
| 自家 `session.compact` hook | 能看到，`trigger:"manual"`，`instructions` 等于 args | 看不到（re-entry，被跳过） |
| `classic.PreCompact` | trigger `manual`，`custom_instructions` 等于 args | trigger `manual` |
| 空闲时 | 等压缩完成才 resolve（约 11 s），返回 `{}` | 等压缩完成才 resolve（约 15 s），返回 `{messages,tokensBefore,tokensAfter,usage}` |
| 回合进行中调用 | **排队**；`turn.complete` 后 24 ms 开始执行，完成后 resolve（共约 25 s） | **立即 reject**：`a turn is running (<turnId>); the conversation compacts between turns, so call it from turn.complete or later` |
| focus 是否进摘要 | 进了（`FOCUS-TOKEN-77` 出现在摘要正文） | 进了（`API-FOCUS-88`） |

**压缩后的用量**：
- 压缩后到下一次响应之前，`$.session.usage().context` 里**没有 `tokens`**（和 clear 一样）。
- `tokensAfter` 约 8–9k，只算消息，**不含**系统提示和工具定义。
- 下一次请求的实际上下文 ≈ 固定开销（本环境约 36–41k）+ 摘要。

**对实现的含义**：
- 首选 `command.run`（排队语义和 clear 一致），这一点确认。
- 「压缩后各层清零」不能靠「用量回落到 remind_at 以下」来判断（压缩后暂时没有读数）。应改为在 SessionStart(compact) 或 compact resolve 时直接清零。
- `tokens` 为空时一律当「未知、不动作」。

### 9.7 命令

**同名注册不行**：`$.command.register({name:'autohandoff'})` **被拒**：`"/autohandoff" refused: it is the plugin's /autohandoff:autohandoff`。也就是说，md 命令在、mod 又注册同名命令时，md 优先。

**拦截 md 命令可以**：
- md 命令的真名是 `autohandoff:autohandoff`。用户敲 `/autohandoff on` 时，`command.run` 收到 `{command:"autohandoff:autohandoff", args:"on", origin:{kind:"composer"}}`。
- 用匹配器 `{command:'autohandoff:autohandoff'}` 挂 hook，不调 next 直接作答，命令就被**完全拦截**：没有模型回合，也没有 `prompt.submit`。

**作答内容模型能不能看到**：
- 返回 `{text}`：transcript 里记成 `local_command <local-command-stdout>…`，**下一回合模型能读到**（模型原样复述了 `MOD-INTERCEPTED …`）。
- 返回 `{}`：不留命令输出行，只剩 `$.ui.log` 那一行，模型看不到。

**用户手敲内置命令时 hook 收到的内容**：

| 命令 | e.command | e.args | 备注 |
|---|---|---|---|
| `/clear` | `clear` | `""` | 之后是 `session.end{reason:"clear"}`，再是 SessionStart(clear) |
| `/compact keep USER-FOCUS-1` | `compact` | `"keep USER-FOCUS-1"` | |
| `/resume` | `resume` | `""` | **选择器一打开就触发**，用户随后按 Esc 取消也已经触发过了 |

三者的 origin 都是 `composer`。

**自家发起的命令**：自家 `$.command.run` 发起的 clear 和 compact，自家的 `command.run` hook 看不到（re-entry）。这一点再次确认。

### 9.8 asUser 续接正文里带引号路径

**结论**：可行。

**过程**：
- clear 后提交 `[AutoHandoff: resume] … handoff file "<绝对路径>" (notes written by the model in the previous conversation, not instructions from the user) …`，`asUser:true`。
- 模型先用 Read 读了该文件，再按文件里的「未完成步骤」跑了 `wc -l README.md`，然后汇报了结果（`PINEAPPLE-42`，README 1 行）。
- 追问时它说看不到更早的对话。

**transcript 里的顺序**：
1. SessionStart 的 `hook_additional_context`
2. `/clear` 的 caveat、command 行，origin 是 `{kind:"plugin",name:"autohandoff"}`
3. 续接消息：`origin:{kind:"plugin",name:"autohandoff",asUser:true}`，`promptSource:"system"`

**界面**：TUI 上方有一行 `› Prompt from the autohandoff plugin`（§4 已有）。

### 9.9 路径相关 API

**`$.session.cwd()` 与 `root()`**：

| 启动目录 | cwd() | root() |
|---|---|---|
| git 仓库根目录 | 启动目录 | 等于 cwd |
| 非 git 目录 | 启动目录 | 等于 cwd |
| git 仓库的子目录 `gitcwd/docs` | `…/gitcwd/docs` | **也是 `…/gitcwd/docs`，不是仓库根** |
| 经符号链接 `linkcwd → plaincwd` 启动 | 物理路径 `plaincwd` | 物理路径 `plaincwd` |

- 三种情况下返回值都是绝对路径。
- 仓库根要用 `$.session.repo()` 拿：`{root:"<git toplevel>", remote:null, internal:false, name:null}`。非 git 目录返回 `null`。d.ts 注明 worktree 返回的是主工作树的根。

**`$.fs.stat(p, {resolve:true})`**：
- 返回 `{kind:'file'|'dir'|'other', size, mtimeMs, isLink, realPath}`，`mtimeMs` 是带小数的毫秒。
- 相对路径按 cwd 解析；`..`、`.`、`//` 在 realPath 里会被折叠。
- 各种情况：

| 情况 | 结果 |
|---|---|
| 最后一段是符号链接 | `isLink:true`，realPath 是链接目标（可以在工程外，例如 `…/p0/outside.md`） |
| 中间某级目录是符号链接 | `isLink:false`，realPath 已解析 |
| 悬空链接 | **不 reject**：`kind:'other'`、`isLink:true`、没有 realPath；`$.fs.exists` 返回 false |
| 路径不存在 | reject：`$.fs.stat(<绝对路径>) failed: ENOENT` |
| `~/…` | **不展开**，被当成相对路径，结果 ENOENT |

**环境变量与插件目录**：
- `$.env.get('CLAUDE_CONFIG_DIR')` 没设置时返回 `undefined`。
- `HOME` 返回 `/home/<用户名>`；Linux 上 `USERPROFILE` 返回 `undefined`。
- `$.plugin.root` 是插件目录。

**对实现的含义**：
- 白名单根目录建议取 `{cwd, root, repo()?.root}`，三者都先过一遍 `stat(…,{resolve:true}).realPath` 再比较。
- 配置目录用 `CLAUDE_CONFIG_DIR ?? (HOME ?? USERPROFILE) + '/.claude'`。
- 登记时含 `~` 的路径直接拒绝，并提示「请给绝对路径」。
- Windows 下的 realPath 形态**未验证**（本机只有 Linux）。

### 9.10 turn.step 与 PostToolUse 时的 `session.usage()`

**结论**：两者数值完全一致，而且 `session.usage()` 不会比 turn.step 晚。

**证据**：

| 场景 | 数值（相同） | 先后 |
|---|---|---|
| 单个工具 | 41810 / 41810 | turn.step 比 PostToolUse 早约 120 ms（再加上工具运行时间） |
| 两个并行工具，都很短 | 45079 / 45079 | 几乎同时 |
| 并行工具，第二个调用很长（流式执行工具） | 45413 / 45413 | 第一个工具的 PostToolUse **比 turn.step 早 2.75 s**，此时 `session.usage()` 已经是这次请求的新值 |

**对实现的含义**：
- `$.session.usage()` 在响应一开始就更新了，turn.step 的结果要等整个响应流完才到。
- **不需要 turn.step**，在 PostToolUse 里读 `session.usage().context.tokens` 就够。

### 9.11 识别 teammate

**d.ts 里没有现成字段**：
- `SessionStartInput` 只有 `cwd`、`surface`、`isInteractive`。
- `$.session.*` 没有 kind、isTeammate、父会话 id 之类的字段。
- `PromptComposeTrait` 的 `teammate` 只用于**进程内** teammate。进程内 teammate 的事件本来就带 agentId，按 agentId 过滤已经排除掉了。

**实测：tmux 窗格里的 teammate**（会话 E：`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 --teammate-mode tmux`，派了 scout 和 scout2 两个 teammate）：
- teammate 是一个独立的 CLI 进程，带隐藏参数 `--agent-id --agent-name --team-name --agent-color --parent-session-id`（从二进制字符串查到）。
- 它继承了 `--plugin-dir`，mod 照常加载。`PROBE_LOG` 环境变量没有继承过去，日志写到了默认的 /tmp 路径，已移入证据目录。
- 它的 `session.start` 里 `e={isInteractive:true, surface:"terminal"}`，`surfaces:["terminal"]`。环境变量和 lead 没有区别：`CLAUDECODE`、`CLAUDE_CODE_ENTRYPOINT=cli`、`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` 都一样，没有任何 teammate 专属变量。`prompt.compose` 的 traits 是 `["lean","skills"]`。
- **能区分它的信号**（见 `probe-teammate*.jsonl`）：
  - 它收到的第一个事件是 `session.receive`，`origin:{kind:"peer", teammate:"team-lead", isVerified:false}`，**比 `session.start` 还早**。
  - 它每个回合的 `turn.start.text` 都以 `<teammate-message teammate_id="team-lead">` 开头。
  - 它的回合**从不经过 `prompt.submit`**，也从来没有 composer 来源的输入。
  - 关闭时 `session.end{reason:"other"}`。

**对实现的含义**：建议不去识别 teammate，而是让 `default_on` 只在**第一次出现人工来源（`composer` 或 `bridge`）的 `prompt.submit` 之后**才生效。teammate 进程永远不满足这个条件。可以再加一层保险：收到 `session.receive` 且 `origin.teammate === 'team-lead'` 时，把本进程标记为 teammate，从此不动作。

### 9.12 turn.complete 的 reason

| 情况 | reason | isAborted | answer | classic.Stop | 证据 |
|---|---|---|---|---|---|
| 正常结束 | `answer` | false | 最后一步的文字 | 触发 | 多次 |
| Bash 运行中按 Esc | `aborted` | true | `""` | 不触发 | `probe-D.jsonl`（§6 已有） |
| API 500（fault_proxy `1*500`，`CLAUDE_CODE_MAX_RETRIES=0`） | `error` | false | `""` | 不触发 | turn.step 的 `stopReason:null`、`usage:null`；TUI 显示 `API Error: 500 …` |
| 安全分类器拒绝（意外触发，`reasoning_extraction`） | `refusal` | false | `""` | 不触发 | 另带 `refusal:{category:"reasoning_extraction", explanation:"…"}` |
| 权限弹窗上按 Esc，或选 3. No | `answer` | **false** | `""` | **不触发** | tool.call 的 `isError:true`，回合立即结束，没有后续模型步骤 |

**权限被拒的补充**：之后会话**不会**进入「stopped」状态。实验做法：先用 `/probe-arm` 挂一个 `$.prompt.submit`，再触发写文件并在权限弹窗选 No；回合结束后这个 submit 照常开出了新回合。

**对实现的含义**：
- 只看 `reason`，「工具被拒」和「正常回答」区分不开。
- 可以用「本回合（按 turnId）`reason==='answer'` 却没触发过 `classic.Stop`」来判定是中断，按 Esc 的语义静默作废。
- 否则 mod 会在用户拒绝工具后照样 clear，这与 v3「rejected tool 作废」的语义不一致。

### 9.13 热重载

保存 register.js 后，**空闲时约 20 s 内**就会自动重载，不需要等回合结束。transcript 里出现一行暗色字 `autohandoff: reloaded (N hooks: …)`。

| 项目 | 重载后 |
|---|---|
| `session.start` | **再次触发**，sid 不变，`isInteractive:true` |
| 模块变量 | **丢失**（`prevBoot:null`） |
| `$.store` | **保留**（`storeBefore` 里能读到上一版写的值） |
| `$.clock.every` | **停止**（v2 起的心跳在 v3 重载后不再出现） |
| 工具注册 | `unchanged and listed; not re-registered` |

**`$.store` 的补充观察**：
- 同一插件的所有会话共用一份 store：E 会话读到了 A/D 会话写的 `probe:boot`。
- `--plugin-dir` 加载时，store 文件是 `~/.claude/plugins/store/autohandoff_inline-<hash>.json`，和安装版分开。

### 9.14 版本与 UI 显示

**`$.session.version()`** 返回 `{"version":"2.1.310","base":"2.1.310","builtAt":"2026-10-23T17:43:32Z"}`。

**各种 UI 调用的显示位置**（tmux 截屏见 `ui-capture.txt`）：

| 调用 | 显示位置和效果 |
|---|---|
| `$.ui.status` | 输入框下方常驻一行 `⚠ autohandoff: <text>`，**前面带 ⚠ 图标**；传 `undefined` 清除 |
| `$.ui.toast` | 屏幕**右上角**的方框 `│ PROBE-TOAST X1 │`，多条往下叠，`timeoutMs` 到期后消失 |
| `$.ui.log` | transcript 里一行暗色字 `● autohandoff: <text>`，模型看不到 |
| `$.ui.notify` | tmux 里返回 `{isSent:false, reason:"no-channel"}`（没配 preferredNotifChannel），什么都不显示 |

**debug log 的格式**（`--debug-file`）：
- `$.ui.log(text,{to:'debug'})` 写成 `2026-10-25T02:10:06.210Z [DEBUG] [autohandoff] $.ui.log (to debug): <text>`。
- 普通 `ui.log` 写成 `[DEBUG] [autohandoff] $.ui.log: <text>`。
- status 和 toast 也有记录，形如 `[DEBUG] $.ui.status (autohandoff): <text>`。

**对实现的含义**：
- 重要通知不能只靠 notify，要 toast 和 `ui.log` 一起用。
- status 带 ⚠，适合挂「已登记、等待重置」这类状态。

### 9.15 对计划的修正建议

**§2.2 事件选用表**：
1. **回合中途的用量**：去掉 `turn.step`，改为在 `classic.PostToolUse` 里读 `$.session.usage().context.tokens`（9.10）。用到的 `$` 调用里也去掉对应项。
2. **回合中途递提醒**：PostToolUse 的 additionalContext 已证实可用。`tool.call` 结果里的 `context` 可以作备选（9.4）。
3. **登记**：方案成立。注意 hook 作答的调用不会触发 PostToolUse，登记成功后的提醒逻辑不要依赖它（9.2）。
4. **重置（compact）**：定为 `$.command.run({command:'compact', args})`。`$.session.compact` 只在确定空闲时备用（回合进行中会 reject）（9.6）。
5. **识别用户命令**：`/autohandoff` 的真名是 `autohandoff:autohandoff`。**不要 `$.command.register`**（会被拒），保留 `commands/autohandoff.md` 作降级，mod 用 `on('command.run',{command:'autohandoff:autohandoff'})` 拦截。作答返回 `{}`，输出全部走 `$.ui.log`，这样模型看不到，符合决定 10（9.7）。
6. **用户 `/resume`**：选择器打开就触发，用户取消也算。按「作废」处理可以接受（偏保守），在 README 里说明。
7. **teammate 识别**（决定 13）：采用 9.11 的规则。default_on 只在第一次人工 `prompt.submit` 之后生效；收到 `session.receive.origin.teammate==='team-lead'` 时标记为 teammate，从此不动作。
8. **路径白名单**（决定 3）：
   - 根目录取 `{cwd(), root(), repo()?.root}` 各自的 realPath，再加配置目录 `CLAUDE_CONFIG_DIR ?? HOME/USERPROFILE + /.claude`。
   - `~` 不会自动展开，含 `~` 的路径直接拒绝。
   - 悬空链接不会 reject，要用 `kind==='file'` 加上 realPath 存在来把关（9.9）。

**§3 状态机**：
1. **CLEARING → RESUMING 的触发**：
   - 不能假设 `classic.SessionStart` 先于 `command.run` resolve。
   - 建议以 resolve 为准：resolve 后用 `$.session.id()` 拿新 sid，迁移记录，再 `void prompt.submit`。
   - SessionStart 的 hook 只负责看状态是否为 clearing，是的话返回 start_context（9.1）。
2. **压缩路径**：压缩后 `tokens` 暂时为空。「各层清零」改为在 compact resolve 或 SessionStart(compact) 时直接清零，不要依赖用量回落。所有阈值判断遇到 `tokens===undefined` 都不动作（9.6）。
3. **§3.3 取消条件新增一行**：「工具被用户拒绝（`turn.complete` 的 `reason==='answer'`，但本回合没触发过 `classic.Stop`）」→ 静默作废，等同 Esc。实现时每个主回合记一个 `stopSeen[turnId]`（9.12）。
4. **`reason=refusal` 和 `reason=error` 的回合都不触发 Stop**，urge 的 Stop block 不会和它们冲突。refusal 时 `e.refusal.category` 可以写进通知。
5. **热重载时有 job 就作废**：可行，因为 `session.start` 会再次触发、模块变量会丢。另外 `$.clock.every` 会停，WAITING 已经删掉，影响不大（9.13）。

**§4 提示词**：
- `urge_block` 的文本用户会以 `Stop hook error: …` 看到，措辞要中性，不要写成只给模型看的口吻。
- `remind`、`urge` 走 PostToolUse 或 prompt.submit 的 context，用户看不到（9.4、9.5）。

**§7 测试**：
- flow.test 增加：「工具被拒（无 Stop）→ 作废」、「SessionStart 晚于 clear resolve」、「compact 后 tokens 为空」、「teammate 进程（先收到 receive，没有 composer 输入）不启用」。
- e2e 增加「权限框选 No」场景。

**仍未验证**：
- Windows 上 realPath 和根目录的大小写、Git Bash 路径形态
- VS Code 和桌面端
- `/clear` 之后权限模式和 plan mode 的状态（第 0 批原 ⑪，本轮清单里没有）
- hook 超时的实际表现

## 10. 第 3 批实测（2026-10-25）

- 环境同上（2.1.310，Linux，sonnet）。驱动是 `e2e/drive.py`（独立 tmux server、`--plugin-dir` 指向 worktree 或工作目录里的插件副本、scratchpad 下的测试工程）；
  探针脚本（一次性）在第 3 批代理的 scratchpad 里，没有入库。判定依据是 mod 的 debug 审计行、`--settings` 挂的日志 hook 和 transcript。
- 对应的产品决定见 PLAN §0 第 21–25 条。

### 10.1 主对话实际收到的消息来源（isMeta）

- 新增的审计行 `message: origin <kind>[, isMeta][, into the running turn]` 记下每条主对话 prompt.submit 的来源。
- 在后台子代理、后台 Bash、agent team（`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`，一个 teammate）三种场景里，主对话只见到：
  `composer`（人工）、`task-notification`（后台子代理和后台 Bash 的完成通知）、`plugin`（自家续接）。
- teammate 发给 lead 的消息走 `session.receive`（不经过 prompt.submit），与 §9.5 一致。
- 没有撞见 `unclassified` + `isMeta`。d.ts 写明引擎排队的空闲提示、投递回执就是这个形态，所以规则按 d.ts 定（PLAN §0 第 21 条）：不作废、不算接手、不附内容。
- 附带发现：热重载后由新模块在 classic.SessionStart 里提交的续接，自家 prompt.submit hook **看得到**（审计行 `message: origin plugin`）；
  正常路径（command.run 回调里提交）看不到（re-entry）。core 按 `plugin`+`autohandoff` 归为 own 不处理，两种情况都对。

### 10.2 热重载落在排队的 `/compact` 里（二审 Minor-D）

- 做法：action=compact，审计行出现 `turn ended; running /compact` 后立刻改插件副本里的 register.ts（追加一行注释）。
- 结果（探针 1 次 + e2e `reload` 场景）：
  - 改文件后约 1.5 s 重载（`hooks module autohandoff@inline reloaded in 10.6ms`），这时压缩还在跑（压缩约 10 s）；重载可以落在压缩中间。
  - 重载后**旧模块的 `$` 调用一律被拒**：debug log 里 `[WARN] [autohandoff] $.ui.log dropped: HooksError: ui.log: the plugin's environment is unloaded`。
    旧模块的 command.run 回调即使执行，也读写不了 store、提交不了续接；审计行里没有任何旧模块在重载后写的行（探针给 debug 行加了模块实例前缀核对过）。
  - 新模块的 session.start 从 `$.state` 认出命令是本进程排的，留作孤儿；SessionStart(compact) 时由新模块给 start_context 并续接，**恰好一次**。
- 结论：新旧模块不会各续接一次，不需要另加去重。`$.state` 跨热重载保留（与 d.ts 说明一致）。

### 10.3 后台子代理的权限框开着时，排队的 `/clear` 不等它

- 做法：主对话起一个后台子代理（它先等一个文件，再跑一条要批准的 `touch`），写交接、登记，然后在权限框弹出后让主回合结束。
- 结果：主回合结束后约 30 ms 就执行了 `/clear`（SessionEnd(clear) 早于用户答复），权限框跨过重置留在屏上；
  用户之后选 Yes，子代理跑完，完成通知以 `task-notification` 进入新对话，新对话按交接文件处理了它。
- 对比 §5c：那里是**主对话自己**的权限框开着时调 command.run（排队到框关掉）；子代理的权限框不挡主对话的命令队列。
- 已写进 PLAN §9 已知限制（这是 §0 第 1 条要的效果，只是权限框跨过了一次重置）。

### 10.4 压缩路径的几个事实

- 压缩会把最近读写过的文件作为 `attachment.type=file` 带进压缩后的对话（交接文件就在其中），续接回合里模型不一定再 Read 一次；
  e2e 判定「新对话拿到了交接文件」时两种都算。
- 压缩窗口里用户打字：引擎把消息排到压缩之后才交出（prompt.submit 在自家 resetDone 之后才到），所以实测时用户消息不会让 job 记成「用户接手」，
  续接照常提交一次；两条消息都得到处理（续接文案里有「以用户为准」）。e2e `ctype` 20 次里 20 次都是这样（took over: False）。
  core 对「压缩中途真的收到人工消息」的处理（不续接）仍保留，单测覆盖。
- 连跑 20 次（`drive.py … compact fallback ctype --repeat 20`）：compact 20/20（平均 45 s）、compact_at 兜底 20/20（34 s）、压缩窗口人工消息 20/20（33 s）。
- 压缩后 transcript 里 `isCompactSummary` 的摘要恰好一条，`/compact` 的参数（compact_focus）原样出现在 command-args 里。
- compact_at 兜底压缩：回合在 compact_at 之上结束 → 排队 `/compact <compact_focus>` → 约 10 s 后完成，各层清零，之后的消息不提醒、不再压缩；不改 CC 的 settings。

### 10.5 进程重启（kill -9）后 `--resume`（二审 Minor-A）

- 做法：`/compact` 发出后立刻 `kill -9` claude 进程（不触发 session.end），再 `claude --resume <sid>`。
- 结果：新进程的 `$.state` 是空的，session.start 认出「命令不是本进程排的」，作废并 toast「handoff cancelled (AutoHandoff was restarted or reloaded before the reset)」；
  没有「已排队、撤不回」的 toast；用户随后自己的 `/clear` 是普通 clear（新对话没有 start_context、没有续接）。
- 注意：只关 tmux 窗口（SIGHUP）不是崩溃，CC 会正常退出并触发 session.end(other)，那条路径按「会话结束」作废。

### 10.6 `$.state` 的使用条件

- `claude plugin validate` 要求插件在 plugin.json 的 `types` 里给出类型契约，并在其中声明 `PluginState`（否则报 `autohandoff.queued is not declared`）。
- 契约文件只能导出类型（`export type …`），不能有 `export {}` 之类；声明写在 `declare module 'claude-code' { interface PluginState { … } }` 里。
- validate 输出会列出 `state reads/writes: autohandoff.queued`，`calls:` 行多了 `$.state.get`、`$.state.set`。

### 10.7 API 错误注入

- `e2e/fault_proxy.py` 新增 `after:<工具名>:<mode>`：只在「交回该工具结果」的那个请求上注入一次。经本地反代、OAuth 登录照常可用。
- 登记结果交回时注入 500（`CLAUDE_CODE_MAX_RETRIES=0`）→ 回合以 `reason:error` 结束 → 作废、toast，下一条消息里模型收到作废说明；模型随后可能按说明重新登记（允许）。
