# AutoHandoff 4 实现笔记（中文，给开发者）

面向使用者的说明见仓库根目录 `README.md`（英文）。设计决定以 `docs/PLAN-mod.zh.md` §0、§0.1 为准（正文 §3–§7 有旧描述），
实测证据在 `docs/mod-feasibility.zh.md`（§1–§8 改写前的可行性实测，§9 第 0 批，§10 第 3 批）。v3（Python + 敲键）已在第 4 批删除，
它的实现笔记见 git 历史（`main` 上 4.0 之前的 `docs/NOTES.zh.md`）。

## 1. 结构

| 文件 | 职责 |
|---|---|
| `hooks/core.ts` | 纯逻辑，不碰 `$`：配置解析与默认文件、模板展开、阈值、来源分类、路径规则、记录与状态转移 `transition(rec, ev, env) → {rec, fx}`、`/autohandoff` 输出 |
| `hooks/prompts.ts` | 11 段内置提示词（英文）与它们在默认配置文件里的说明 |
| `hooks/register.ts` | 接线薄层：只把主对话事件（无 agentId/agent_id）送进 core；按 sid 读写记录；执行副作用；一切错误 catch 后放行 |
| `types/autohandoff.d.ts` | `$.state` 的类型契约（plugin.json 的 `types`），只有 `autohandoff.queued` |
| `commands/autohandoff.md` | 降级说明：mod 没跑时才会走到模型 |

- 事件进 core 的唯一入口是 `dispatch`：串行（模块级 promise 链）地 读记录 → transition → 写回 → 执行副作用。`$.store` 的 get/set 不是原子的，
  同一进程里的事件会交错，所以读-改-写必须串行。只写自己这个 sid 的键 `s:<sid>`。
- 空白记录（开关没动、没收到人工输入……）不写，免得每个会话都在 store 里留一份。30 天没写的记录在 session.start 时删掉。
- 副作用：`context`/`block` 由调用的 hook 放进返回值；`clear`/`compact`/`resume` 带请求序号 `seq`，promise 的结果原样带 seq 回送
  （`resetDone`/`resetFailed`/`resumeDone`），core 只认当前 job 的 seq，晚到的旧结果一律「不是当前请求」忽略。
- 状态行由 core 统一生成：每步比较前后 `statusOf`，变了才发 `status`。

## 2. 关键实现点

- **/clear 换 sid 的记录搬迁**：`session.end(clear)` 把旧 sid 记进模块变量 `clearingFrom`；新 sid 下没有记录时，SessionStart(clear) 或自家重置的回调
  （它知道自己从哪个 sid 发出）把旧记录 `migrateRecord` 过来。两种先后顺序（实测 resolve 比 SessionStart(clear) 早约 180 ms）都对。
  搬迁时清掉 levels、turn、tell、兜底压缩及计数、resumed，job 的 ctxGiven 也清（新对话还没拿到 start_context）；旧 sid 只留开关。
- **重置排队后不可作废**（§0 第 20 条）：clearing/compacting 阶段的用户命令、关开关、teammate 标记、热重载都只记 debug + toast。
  作废只来自命令自己的结果（失败、超时）或进程结束（session.end 非 clear）。
- **热重载 vs 进程重启**（§0 第 24 条）：发重置前在 `$.state` 记 `jobKey = registeredAt:seq`（最近 20 个）。session.start 时记录里有已排队的重置：
  `$.state` 有 → 热重载 → 留作孤儿，按发出时刻重挂 wait_minutes，新对话的 SessionStart 补上续接；没有 → 重启 → 作废并告诉模型；读不到 → 按热重载。
  **写不进 → 不发重置**（第 4 批，与 store 写失败同一规则：记录不写回、停在 armed、toast），`isSet:false` 也算写不进。
  写 `$.state` 在写 store 之前；store 随后写失败时 `$.state` 里多一个 key，无害（同一个 armed 记录下次发出时 key 相同）。
- **store 写失败**（dispatch）：要发重置的那一步不发（结果要靠存下的 seq 认领）；登记那一步改回「Not registered」；其它步骤副作用照常（续接比记全状态要紧）。
- **回合结束判定**：只认 `reason==='answer'` 且本回合（登记之后）见过主对话的 `classic.Stop`。工具被拒的回合 reason 也是 answer 但没有 Stop → 静默作废。
  登记时把 `stopSeen` 清掉：之前的 Stop 可能是自家的 urge block。
- **Stop block**：`await next(e)` 之后看 `r.block`，链上别的 hook（排在后面的模块、普通 settings Stop hook）已经 block 了就不叠加、不记账（§0 第 25 条）；
  managed 的 block 会直接结束链，我们根本不会被调用。没有工具调用的回合里用量可能一步跨过 urge_at，Stop 时按同样规则补置 urge 层。
- **连环交接守卫**（§0 第 22 条）：afterReset 时 `resumed = !userTook`；越过 remind_at（levels.remind 置位）或收到人工消息解除；任务通知、代理消息、
  引擎 meta 不解除；用户自己 /clear 出来的对话不带（migrate 清掉）。`/autohandoff status` 显示这一行（第 4 批）。
- **compact 窗口**（§0 第 23 条）：用户的 /clear 先跑完时立即给 start_context（`ctxGiven`），自家 /compact 随后成功或失败都续接，Esc 静默作废。
  孤儿 job 遇到这种情况只给 start_context，等自家那次 SessionStart(compact)。
- **v3 残留**（§0 第 26 条，4.0.1 起）：`autohandoff.toml`、`autohandoff-state` 不读、不迁移、不删，也不再提示；README 的 Upgrading from version 3 写明手动删。
- **配置**：每次要用时重读（`readConfig`）；不存在时写一次默认文件（唯一的 `$.fs.write`）。`AUTOHANDOFF_CONFIG` 只认绝对路径，因为 `$.fs` 会把相对路径解析到工程目录下。
  配置目录：`CLAUDE_CONFIG_DIR` 优先；主目录取盘符形式的 USERPROFILE 优先（Git Bash 会把 HOME 设成 `/c/Users/x`，而 CC 用 `os.homedir()`），否则 HOME。
- **本轮交接文件**（§0 第 30 条，4.1.0）：`Rec.note` 存本轮要写的路径，`withNote` 在第一次要用时（remind、urge、短提醒、Stop block）用
  `handoffNotePath(dir, sid, now)` 生成并追加 `noteLine` 一句到这四种提醒末尾。dir 来自 register.ts 的 `noteDir`：root、cwd、repo 根的 realPath 依次过
  `usableRoots`（与登记白名单同一规则），取第一个，按进程缓存（session.start 清掉）；都不可用时只给文件名，`noteLine` 改说放进自动记忆目录。
  只有 submit、postTool、stop 三种事件带 `Env.note`（查不到就不带，提醒不加路径）。`clearLevels` 把各层与 note 一起清掉（afterReset、finish、
  migrateRecord、sessionStart(clear/compact)、用量回落到 remind_at 以下、兜底压缩完成）；cancelTold 只退一层，不清 note，所以作废后重新登记仍用同一路径。
  本地时间用 `new Date(now)` 的本地分量（mod 运行时的时区即 CC 进程的时区；e2e clear 里生成的时刻与本机 JST 相差 26 s）。mod 不写这个文件，目录与文件由模型的 Write 工具建。
- **超长退回**（§0 第 30 条）：登记时路径通过后 `$.fs.read` 一次、`estimateReadTokens` 估大小，超过 `handoff_max_tokens` 就 deny（说明估算值、上限、
  目标值），不动已有的 armed 登记（与其它 deny 一致）。读失败（估算缺省）照收。上限为 0 时不读文件。
  估算 = ASCII 字符数 / 3 + 非 ASCII 码点数 × 1.65 + 行数 × 3（行数 = 换行数 + 1，与 Read 显示的行数一致），向上取整。
  校准（2026-10-26，CC 2.1.310 的 Read 工具对整份文件报告的 token 数；单测 `calibration points` 只存字符构成）：

  | 文件（构成） | ASCII / 非 ASCII / 行 | 实测 | 估算 | 估/实 |
  |---|---|---|---|---|
  | 中文交接文档 464 行 | 27655 / 14363 / 464 | 33481 | 34310 | 1.025 |
  | 中文交接文档 536 行 | 33347 / 16506 / 536 | 39373 | 39959 | 1.015 |
  | 英文 README ×7 | 172123 / 35 / 2703 | 61621 | 65542 | 1.064 |
  | 中文计划 ×3 | 65325 / 35823 / 1615 | 73531 | 85728 | 1.166 |
  | 带中文注释的 TS ×3 | 172656 / 13200 / 4498 | 90568 | 92826 | 1.025 |
  | 中文笔记 ×2 | 47352 / 16934 / 1445 | 43413 | 48061 | 1.107 |
  | 9001 行极短行 | 71635 / 0 / 9001 | 39280 | 50882 | 1.295 |

  最小二乘拟合是 ASCII 2.86 字符/token、非 ASCII 1.44 token/字、每行 1.65 token，但中文交接文档（含较多箭头、全角符号）实际要 1.6 左右，
  所以三个常数都取高：所有校准点都不低估，常见交接文档高估 1.5–17%。Read 工具超过 25000 token 时，旧版本报错「File content (N tokens) exceeds maximum allowed tokens」，
  2.1.310 改为分页并在页尾报告整份的 token 数，两种说法给的都是整份文件的数。
- **路径规则**（§0 第 3、14、16、27 条）：先查文本（字符白名单、长度、首尾空格（路径内部的普通空格放行）、`~`、`//`/`\\` 开头、盘符相对），再 `stat(resolve:true)` 拿 realPath，realPath 本身也要过字符白名单
  （它会写进续接文案）。根目录 = cwd、root、repo 根三者的 realPath（去掉 `/`、盘符根、HOME 本身），加 `<配置目录 realPath>/projects/*/memory/`。
  Windows 判定看 cwd 是否盘符形式；比较时大小写不敏感、两种分隔符等价。

## 3. 实测得到的 Mod 机制事实（2.1.310，Linux；详见 feasibility）

- **加载**：`--plugin-dir` 加载名为 `autohandoff@inline`，store 文件 `~/.claude/plugins/store/autohandoff_inline-<hash>.json`，和安装版分开；
  装着的同名插件会被 `--plugin-dir` 覆盖（debug log「overrides installed version」）。新目录接受 workspace trust 之前不加载 mod。
  加载时引擎往插件目录写 `.claude-plugin/types/`（gitignore）和根目录 `tsconfig.json`（我们自己提交一份）。
- **热重载**：`--plugin-dir` 的文件一改，空闲时约 1.5–20 s 内重载；session.start 再触发（sid 不变），模块变量丢，`$.store` 与 `$.state` 保留，
  `$.clock` 的定时器被取消。重载后旧模块的 `$` 调用一律被拒（"the plugin's environment is unloaded"），旧回调写不了 store、提交不了续接。
- **用量**：`$.session.usage().context.tokens` 与状态栏、transcript 最后一条 assistant 的输入侧合计一致；PostToolUse 时已是这次请求的值，不比 turn.step 晚。
  `/clear`、`/compact` 之后到下一次响应之前 tokens 不存在。`turn.complete` 的 `e.usage` 是回合加总，`context.window` 是模型窗口，都不能当阈值用。
- **命令**：`$.command.run({command:'clear'})` 等同人工 /clear（SessionEnd(clear) → SessionStart(clear)，新 sid、新 transcript），回合中排队到空闲才执行，
  做完才 resolve；`compact` 带 args 同样排队，压缩约 10–15 s，focus 进摘要。`$.session.compact` 回合中立即 reject，不用。
  被 Esc 否决时 reject 文字含 "the session was stopped" 或 "removed from the queue"（`VETO_MESSAGES`）。
  后台子代理的权限框不挡主对话的命令队列；主对话自己的权限框、AskUserQuestion 会让命令排到框关掉。
- **续接**：`$.prompt.submit({text, asUser:true})` 在 clear 约 0.4 s 后开出新回合，transcript origin 为 `{kind:'plugin', name, asUser:true}`，
  界面显示「Prompt from the autohandoff plugin」。Esc 之后到用户下次输入前，自启动的 submit 返回 `{drop}`。
- **re-entry**：自家 hook 看不到自家在 hook 返回后发起的 command.run/prompt.submit；热重载后新模块在 SessionStart 里提交的续接，自家 prompt.submit 看得到
  （origin plugin+autohandoff 归为 own，不处理）。
- **命令拦截**：`$.command.register('autohandoff')` 会被 md 命令占名拒绝；md 命令真名 `autohandoff:autohandoff`，用 `on('command.run', {command})` 拦截、返回 `{}`、
  输出走 `$.ui.log`（返回 `{text}` 模型会读到）。
- **登记工具**：`$.tool.register` 注册后全名 `mcp__autohandoff__register_handoff`；`tool.call` hook 直接作答、不调 next 时不弹权限框（manual/auto 都一样）；
  主对话无 agentId，子代理与 fork 有。hook 作答的调用不触发 PostToolUse。
- **回合结束**：`turn.complete` 的 reason：正常 answer（有 Stop）、Esc aborted（无 Stop）、API 错误 error（无 Stop）、拒绝 refusal（无 Stop）、
  **工具被拒 answer 但无 Stop**。Stop block 生效后第二次 Stop 带 `stop_hook_active`，turn.complete 只在最后触发一次；用户看到 block 理由时前缀是「Stop hook error:」。
- **消息来源**：主对话实际见到的只有 composer、task-notification（后台子代理与后台 Bash 的通知）、plugin；teammate 发给 lead 的走 `session.receive`。
  `unclassified`+`isMeta` 没实际撞见，规则按 d.ts 定。teammate 进程最先收到 `session.receive`（`origin.teammate==='team-lead'`），从不收到人工输入。
- **后台工作**：/clear 不结束后台子代理、后台 shell；它们的汇报以 task-notification/peer 进入新对话，各开一个回合。
- **路径 API**：`$.session.cwd()`/`root()` 是启动目录的物理路径（不是 git 根），仓库根要用 `$.session.repo()?.root`（非 git 为 null）。
  `$.fs.stat(p,{resolve:true})` 给 `{kind,size,mtimeMs,isLink,realPath}`；相对路径按 cwd；悬空链接不 reject（kind other、无 realPath）；`~` 不展开。
- **`$.state`**：plugin.json 必须给 `types` 并在其中 `declare module 'claude-code' { interface PluginState {…} }`，否则 validate 报未声明；`{plugin,key}` 要写字面量。
  kill -9 后 `--resume` 的新进程里是空的；只关 tmux 窗口（SIGHUP）是正常退出，触发 session.end(other)。
- **UI**：`$.ui.status` 常驻一行且自带 ⚠；toast 在右上角；`ui.log` 是 transcript 暗色行（模型看不到，多行会显示成乱码，所以逐行记）；
  notify 没配通知渠道时什么都不显示（所以总和 toast 一起发）。`ui.log(text,{to:'debug'})` 写进 `--debug-file`，e2e 的审计行就是它。
- **非交互**：`claude -p` 下 mod 加载、事件照发，但 command.run、prompt.submit 都 reject；用 `e.isInteractive`（之前的事件用 surfaces）判定后整体静默。

## 4. 测试

- `claude plugin test .`：`core.test.ts`（纯函数）、`state.test.ts`（transition 的事件序列，含作废矩阵「事件 × 状态」，断言 job 阶段、兜底压缩、tell、userTook）、
  `flow.test.ts`（`claude-code/testing` 打桩宿主：store、state、fs、命令队列、续接提交都由测试 hook 扮演，事件顺序按实测排）。
- 测试工具包的坑：测试 hook 抛错只会被「跳过」，调用落到下一层；store、command.run 没有默认实现，所以抛错能模拟失败，
  `$.state` 有工具包自带的实现，抛错模拟不了写失败，只能回 `isSet:false`。
- e2e：`e2e/mod_setup.sh` + `e2e/drive.py`（用法见 README Development 与 drive.py 的 docstring）。判定依据是 debug 审计行、`--settings` 里只写日志的 hook、transcript。
  - 隔离：独立 `tmux -L`、`env -i` 起 server；`--plugin-dir` 指向 worktree；`--settings` 关掉已装的 `autohandoff@autohandoff`、关 Remote Control、关 CC 自动压缩、
    收窄 Bash 权限；`AUTOHANDOFF_CONFIG` 指向工作目录里的低阈值配置。`AUTOHANDOFF_DISABLE=1` 只为万一加载了 v3（v4 不读）。
  - v4 作为独立仓库 `AutoHandoff_Mod` 安装后（PLAN §0 第 29 条），`--settings` 里关掉的 `autohandoff@autohandoff` 就是 v4 自己的安装版，`--plugin-dir` 照样覆盖它，隔离不变。
  - 同一 checkout 同时只跑一组（store 文件共用，清理要改它）；跑的时候不要改 `hooks/`（会热重载测试会话）；清理只按精确路径与 sid；`~/.claude.json` 的 trust 条目不动。
  - 测试会话会加载真实的 `~/.claude/CLAUDE.md`，靠模型服从度的场景（chain、urge、interject）会受影响。
  - 模拟「不理提醒的模型」用把 remind/urge 换成「不必动作」的配置（fallback、urge 场景），测的是插件机制不是服从度；chain 场景把 start_context 换成中性说明，
    让 (b) 守卫真正被触发（断言至少拒绝一次）。
  - `clear` 断言交接文件写在 remind 审计行给的路径（`<测试工程>/.autohandoff/_AUTOHANDOFF_<本地时间>_<sid 前 8 位>.md`，时间与本机本地时间相差
    15 分钟内）、登记的就是它、续接与 SessionStart 上下文都指向它、新对话读了它。
  - `limit`（4.1.0）：上限压到 2000（urge_at 也压到读一次 catalog 就越过，直接送 urge 并有 Stop block），remind/urge 要模型在交接文件里抄 120 行参考表，
    争取第一次登记超长；断言退回 → 同一路径压短重登记 → 重置、续接各一次。haiku 有时不照抄（第一次就写短的，测不到退回），有时把提醒当成工具结果里的注入先不理。
  - **`.claude/` 是受保护目录**（2.1.310 实测，default 权限模式）：即使 `Write`、`Edit` 已放行、另加 `Edit(.claude/autohandoff/**)` 之类显式规则，
    往 `<工程>/.claude/…` 写文件（Write）或 `mkdir -p` 它（Bash，「sensitive file」）照样弹框；工程根下的 `.autohandoff/` 不弹。交接文件目录因此定为
    `.autohandoff/`（PLAN §0 第 30 条）。驱动在等待期间记下出现过的权限框（不批准），clear、limit 断言写交接文件时一个框都没有。
  - 测试 settings 的 Bash 放行清单另加 `for`、`test`、`find`、`grep`、`tail`、`sort`、`pwd`：续接后模型核对现状常发
    `git status --short && ls notes && for f in notes/*.txt; do echo "$f: $(cat "$f")"; done` 这类只读复合命令，原清单下会弹框卡住场景。
  - `fault_proxy.py`：本地反代注入 API 错误，`after:<工具名>:<mode>` 只在交回该工具结果的那个请求上注入一次，OAuth 照常。

## 5. 未验证 / 待上机

- Windows：真实 realPath 形态（带空格的用户目录、8.3 短名、`\\?\` 前缀、盘符大小写）、Git Bash 下的 `CLAUDE_CONFIG_DIR`、关标签页时 session.end 的 reason、Esc 否决的错误文字。
  清单见 `docs/windows-checklist.zh.md`。
- `$.state` 是按进程还是按 session id 保存（/clear 换 sid 后还在不在）：文档说 /clear、/resume 会重置它，热重载实测只用了 compact。
  正常路径不受影响，只在 PLAN §9「孤儿 job 遇到用户 /clear 先跑」那类复合窗口里有区别。
- VS Code 扩展、桌面端、WSL、Remote Control 接入时的行为；/clear 之后权限模式与 plan mode 的状态；hook 超时的实际表现。
