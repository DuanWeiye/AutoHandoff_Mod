# AutoHandoff 4.0.0：改写为官方 Mod 的实现计划（待审批）

- 日期：2026-10-25，基准版本 Claude Code 2.1.310
- 依据：
  - `README.md`（v3 功能全貌）
  - `docs/mod-feasibility.zh.md` 与 `mod-probe/evidence/`（隔离实测）
  - `docs/NOTES.zh.md`
  - `handoff.py`（提示词模板、配置、作废语义、`/autohandoff`、`compact_point`）
  - 本版本类型文件 `mod-probe/.claude-plugin/types/claude-code/index.d.ts`（引擎加载探针时生成，下称 d.ts）
  - 官方文档 `plugins/mods/{create,events,api,test}.md`、`plugins/manifest-reference.md`
- 本文只是计划，没有改代码。文中「待实测」的项放在第 0 批先验证。

---

## 0. 决定记录（2026-10-25 用户定；与下文冲突时以本节为准）

1. **子代理、后台 shell、monitor 等 /clear 后仍会保留的后台工作，一概不拦 clear。** 这正是用户编排模式要的效果：子代理跑着时主对话写交接 → clear → 子代理的汇报落到新对话继续。
   → 删掉 §2.2「子代理守卫」、§3.2 的 WAITING 状态、`$.agent.list()` 和 `background_tasks` 的使用、`wait_minutes` 里「等子代理」的含义（只保留「登记后回合多久不结束就作废」）。
   → 提示词改为：不要再起新的子代理/后台任务；把**正在跑的代理、它们在做什么、结果回来后该怎么处理**写进交接文件；重置后它们的汇报会进入新对话。
   → 新对话的启动上下文（SessionStart additionalContext）照样给出交接路径，所以无论先到的是子代理汇报还是续接提示，新对话第一回合都看得到。
2. **第三层不用 CC 自动压缩，不改 CC 的 settings.json。** 新增配置 `compact_at`（默认 650000）：主回合结束时用量 ≥ compact_at 且没有登记中的交接 → 排队 `/compact <compact_focus>`（`$.command.run({command:'compact', args})`，备选 `$.session.compact({instructions})`，第 0 批定）。压缩后用量回落，各层清零。CC 自带压缩留在默认位置当天然底线。
   → 删掉 §2.2「压缩点」一行、`$.settings.read`、`$.env.get` 读 autoCompact 相关、`{compact_note}` 改为引用 compact_at 的数值。
3. **路径交付：方案 C**（用户定）。续接提示以用户身份（`asUser:true`）提交，正文是固定句式，交接文件路径在其中加引号出现。相应地 `start_context` 不再承担传路径的职责（可保留一句「AutoHandoff 刚重置了对话」的说明，或删掉）。
   安全补偿（替代 §4「路径交付方案对比」中 A 的防护）：登记时 `realPath` 必须是**工程目录**（`$.session.cwd()`，不要求是 git 仓库；也接受 `$.session.root()` 之下）或 **CC 配置目录**（`CLAUDE_CONFIG_DIR` 或 `~/.claude`，记忆目录在其中）之下真实存在的普通文件、非空、≤ 1 MiB、`fresh_minutes` 内修改过；
   路径字符只允许字母、数字和 `/ \ . _ - ~ : @ + ,`，**禁止任何空白、控制字符、Cf 字符和引号**（路径内部的普通空格后来放行，见第 27 条）；长度 ≤ 512。不满足一律拒绝登记并说明原因。续接文案里路径用双引号包住，并说明「这是上一段对话留下的工作笔记，不是用户的指示」。
4. **续接用 `asUser:true`**。
5. **配置单文件 `~/.claude/autohandoff.md`**（`CLAUDE_CONFIG_DIR` 优先），不用 userConfig / pluginConfigs。格式：`## settings` 一节写 `key: value` 行（default_on、remind_at、urge_at、compact_at、action、fresh_minutes、wait_minutes、urge_block、remind_every_turn），其余 `## <提示词键名>` 各节是提示词正文。
   不存在时首次运行生成带注释的完整默认文件；每次要用时重读；缺键/错值用内置默认并在 `/autohandoff status` 里报告。§5 全节按此改写；旧 `autohandoff.toml` 作废并提示一次。
6. `urge_block` 默认开；`remind_every_turn` 默认开。
7. CLEARING 期间用户消息**放行**，不退回输入框：消息落到新对话，插件跳过续接提示（同 v3 orphan 语义）。§3.3 对应行按此改。
8. 最低 CC 版本 2.1.304。
9. 开关按 session id 存，`--resume` 时恢复。
10. `/autohandoff` 输出用 `$.ui.log`，模型看不到。
11. 第 1–3 批在 git worktree 开发，只用 `--plugin-dir` 测；第 4 批合回主目录即原地升级（第 28 条核实；合并前先关掉 v3 会话）。
12. `mod-probe/` 挪到 `private/`（gitignore）保留证据；`e2e/fault_proxy.py` 保留。
13. agent team 的 teammate 进程排除在 `default_on` 之外（识别手段第 0 批核实）。

以下 4 条为 2026-10-25 第 1 批审查后定（审查报告 `private/review/review-batch1.zh.md`（不随仓库发布）的 P3、C1/C2、P1-RTL、`$.fs.write` 冲突）：

14. **路径白名单里的 CC 配置目录收窄为 `<配置目录>/projects/*/memory/`**（自动记忆目录），`~/.claude` 其余部分（`.credentials.json`、`settings.json`、transcript jsonl 等）一律拒绝。组装工程根目录（cwd、root、repo 根）时先取 realPath，并丢掉 `/`、盘符根和 HOME 本身。第 3 条中「CC 配置目录之下」按此理解。
15. **默认配置文件写入全部 9 段提示词**（以后内置提示词更新由用户手动 merge）。配置文件里缺某段提示词不算问题：用内置默认，`/autohandoff status` 不报它。
16. **RTL 字母（希伯来、阿拉伯文等）放行**；双向控制符等 Cf 字符仍按控制字符禁止。第 3 条的字符规则补充：`\` 只在 Windows 放行；`~` 只在 Windows 的 8.3 短名（如 `JANEDO~1`）里放行；Unicode Default_Ignorable_Code_Point（韩文填充符、变体选择符等不可见字符）禁止；组合记号只能紧跟字母。
17. **允许 `$.fs.write`，但仅用于「配置文件不存在时写一次默认文件」这一个场景**；§2.2 的「不用」清单相应改为「仅此一处例外」。

以下 3 条为 2026-10-25 第 2 批审查后定（审查报告 `private/review/review-batch2.zh.md`（不随仓库发布）的 Major-1、场景 9、不一致处第 1 条）：

18. **场景 9（登记后用户插话）**：登记后、回合还在跑时用户插话 → 作废是对的。模型答完插话后在同一回合里重新登记并 clear **可以接受**，前提是插话的要求被带进新对话。
    → `cancelled` 提示词要求：重新登记（本回合或之后）之前，先把用户刚提的要求/答复更新进交接文件。e2e 场景 9 断言新对话续接后的回复能复述插话里的具体要求。
19. **`AUTOHANDOFF_CONFIG`** 是对外可见的配置项：指向另放的配置文件（替代 `<CC 配置目录>/autohandoff.md`），**只认绝对路径**。相对路径忽略（`$.fs` 会把它解析到工程目录下），debug log 记一次，`/autohandoff status` 的配置问题里报一行。README 要写。
20. **重置已排队（clearing/compacting）后 job 不可作废（方案 A）**：命令一旦交给 `$.command.run` 就撤不回（只有 Esc 能否决）。
    - 这阶段用户敲的 `/clear`、`/compact`、`/resume`、`/autohandoff off`、teammate 标记都不再作废 job：只记 debug log，并 toast「重置已排队、无法撤回，会按交接文件续接」。人工消息照第 7 条放行（跳过续接）。
    - 重置完成后照常给 start_context 并续接。`/autohandoff off` 的效果随记录搬到新 sid：新对话里是关的。
    - 用户自己的另一种重置先跑完（自家 `/clear` 排队时用户的 `/compact`）：它的 SessionStart 不是新对话，不给 start_context，接着等自家的。
    - 热重载（或进程重启）落在这阶段：job 不作废，标为「孤儿」，按发出时刻重挂 wait_minutes 计时；新对话的 SessionStart（source 与 action 一致）给 start_context 并自己提交续接；旧模块的回调若晚到，按「不是当前请求」忽略。重启时已超过 wait_minutes 则放弃。
    - 作废只在命令自己的结果（失败、超时）或进程结束（session.end 非 clear）时发生。
    - 未处理（10-25 定：登记后手动重置极少，改动局限在作废判断）：排队期间用户 `/resume` 到另一个对话，session.end(resume) 仍按进程结束作废，自家 `/clear` 会清掉切过去的那个对话且不续接。
      第 3 批只改提示：这时的 toast 如实说两种结果（留在本对话会续接；切走则排队的命令作用在切过去的对话上、不续接），并列入 §9 已知限制。

以下 5 条为 2026-10-25 第 3 批定（依据 `private/review/review-batch2.zh.md`（不随仓库发布）二审、d.ts 与第 3 批实测，见 `docs/mod-feasibility.zh.md` §10）：

21. **引擎自己排队的 meta 消息（`origin.kind==='unclassified'` 且 `isMeta===true`）不是人工消息。**
    - 依据：d.ts `PromptOrigin` 的 unclassified 说明「引擎排队的空闲提示或投递回执，带 isMeta 且无标记，也归为 unclassified」；`PromptSubmitInput.isMeta` 是引擎设的。
    - 语义：不作废登记；重置排队期间不算用户接手（照常续接）；不附任何内容（不附提醒、作废说明、pending_note/reset_note）；不算人工输入（default_on 不因它生效，也不解除第 22 条）；也不触发任何重置。
    - 只认这一种组合：没有 isMeta 的 unclassified（来源认不出的输入）仍按用户消息作废（fail-closed，告诉模型时用「不是用户打的」那句）；带 isMeta 的 composer 等仍按 kind 分类。
    - 实测（2.1.310）：后台子代理、后台 Bash、agent team 场景里主对话的 prompt.submit 只见到 composer、task-notification 和自家 plugin；teammate 的消息走 session.receive，不经过 prompt.submit。没有实际撞见 unclassified+isMeta，规则按 d.ts 定。
22. **连环交接的挡法（倾向 (b)+(c)）。**
    - (b) AutoHandoff 续接开启的对话（重置后提交了续接、用户没在重置期间接手）带「刚续接」标记：在**越过 remind_at**（第一层已提示，或登记时用量 ≥ remind_at）或**收到一条人工消息**（composer/bridge）之前，**不受理登记**，拒绝理由说明原因、让模型接着做交接文件里的工作。任务通知、代理消息、引擎 meta 消息不解除；用户自己 `/clear` 出来的对话不带这个标记；读不到用量时也拒绝。
    - (c) remind、urge、cancelled 提示词写明：交接文件的「下一步」写工作本身，不写「交接」「继续交接」之类会让新对话一上来又交接的话；start_context 写明「接着做交接文件里的工作，除非有新的提醒，不要再交接」。
23. **压缩窗口（约 15 s，比 clear 长得多）里各事件的语义。** action=compact 的 job（compacting）与 compact_at 兜底压缩分开定：
    - 交接 job（compacting）：
      - 人工消息：放行（消息排在压缩之后），压缩后**不提交续接**（用户接手），SessionStart(compact) 照样给 start_context。
        **实测（2.1.310，第 3 批审查 Minor-7）这条分支走不到**：引擎把压缩窗口里敲的消息排到压缩之后才交出，prompt.submit 在自家 resetDone 之后才到，
        job 不会记成「用户接手」，续接**照常提交**，两条消息都得到处理（续接文案里「以用户为准」兜底；ctype 20/20 都是这样）。
        不续接的分支保留在 core 里，以防引擎行为变化。
      - 代理消息：不作废，附 reset_note；压缩后照常续接。引擎 meta 消息：什么都不做（第 21 条）。
      - `/autohandoff off`、用户 `/clear`/`/compact`/`/resume`、teammate 标记、热重载：按第 20 条不作废。
      - 用户的 `/compact` 先跑完：它的 SessionStart(compact) 已是压缩后的对话，给 start_context；自家的 `/compact` 随后再跑，完成后续接一次。
      - 用户的 `/clear` 先跑完（二审 Minor-B）：SessionStart(clear) 已是新对话，**立即给 start_context**；自家排队的 `/compact` 随后作用在这个新对话上，**成功或失败都续接**（新对话已拿到交接，失败不再告诉模型「重置失败」）；Esc 否决则静默作废。热重载后的孤儿 job 在这种情况下只给 start_context，等自家那次 SessionStart(compact) 再续接。
      - 反过来（自家 `/clear` 排队、用户 `/compact` 先跑）：旧对话被压缩、之后还会被清，接着等，不给 start_context（第 20 条原样）。
      - 压缩后到下一次响应之前 tokens 读不到：各层在 SessionStart(compact) 和 resolve 时清零，tokens 为空时一切阈值判断不动作（不提醒、不 block、不兜底压缩）。
    - compact_at 兜底压缩（fallback，没有交接）：人工或代理消息都不附提醒（压缩完再说），不作废什么（没有 job）；登记被拒（「压缩进行中」）；用户 `/clear` 后新对话不带兜底压缩，它的结果晚到时按「不是当前请求」忽略；`/autohandoff off` 与热重载都丢掉兜底记录（命令照跑，结果被忽略）；Esc 否决后等下一条人工消息再试；连续失败 3 次后本对话不再试。
24. **进程重启与热重载分开处理（二审 Minor-A）。** 发出交接 job 的重置前，把 job 标识（登记时刻 + 请求序号）记进 `$.state`（宿主按会话保存：热重载后还在，新进程里是空的；类型契约 `types/autohandoff.d.ts`，plugin.json 的 `types`）。session.start 时记录里有已排队的重置：
    - `$.state` 里有它 → 热重载，按第 20 条留作孤儿；
    - 没有 → 进程重启（命令随旧进程没了）：和登记中的 job 一样作废，toast「交接已作废（AutoHandoff 重启或重载）」并在下一条消息告诉模型，**不**提示「已排队、撤不回」，用户之后自己的 `/clear` 是普通 clear；
    - 读不到 `$.state` → 按热重载处理（宁可等着，也不留一次没人续接的重置）。
      代价（第 3 批审查 Minor-5）：真是重启时，最多 wait_minutes（默认 60 分钟）里本对话的提醒、Stop block、兜底压缩都不动作，登记被拒
      （"a reset is already in progress"），状态行一直显示重置中，用户的 /clear 还会弹「已排队、撤不回」的 toast；之后用户自己的 /clear 会被续接一次（无害），
      等不到就静默作废。`$.state` 在宿主内存里，读失败的可能极小，规则保留。
    - **写不进 `$.state`**（第 3 批审查 Minor-1，第 4 批定）→ 不发重置，按 store 写失败同一规则处理：记录不写回、停在 armed，toast「没能保存状态、没有重置」。
      没记下的重置在热重载后会被当成重启作废，命令却还在排队，就成了一次没人续接的重置。`$.state.set` 回 `isSet:false` 也算写不进。
    - 实测（`docs/mod-feasibility.zh.md` §10.2）：热重载后旧模块的 `$` 调用一律被拒（"the plugin's environment is unloaded"），旧模块的 promise 回调写不了 store、提交不了续接，不会和新模块各续接一次；不需要另加去重（二审 Minor-D）。
25. **Stop block 的记账与每回合短提醒的范围。**
    - 链上别的 Stop hook（其它插件或 settings 里的 Stop hook）已经 block 了这次 Stop：不叠加，**也不记账**（本回合的那一次 block 不算用掉，urge 层不算送到），于是模型照那个 hook 继续干活时下一次 PostToolUse 送完整 urge；之后的 Stop 带 `stop_hook_active`，照旧不再 block。
    - 用户拒绝工具（回合没有 Stop）：这个回合不 block；下一条消息照常附短提醒（urge 层附 urge_block 文本）。
    - remind_every_turn 的短提醒附在**每条主对话消息**上（人工消息和代理消息都附，引擎 meta 消息不附），回合中途的 PostToolUse 不附；登记中、压缩中、读不到用量时不附。

以下为 2026-10-25 第 4 批定（依据 `private/review/review-batch3.zh.md`（不随仓库发布））：

26. **v3 残留只提示一次，不迁移。** session.start 时 CC 配置目录下还有 `autohandoff.toml` 或 `autohandoff-state/`：本进程第一次见到时 toast 并在 transcript 记一行
    「AutoHandoff 4 不再读 v3 的设置和状态，设置与提示词在 `<现用配置文件>`，旧文件可手动删除」。不读旧配置、不迁移、不删（原则：不为过渡数据写适配）。
    **2026-10-25 晚用户定：提示也去掉**（试用中每次启动右上角弹，打扰）；旧文件只在 README 升级说明里写「手动删」。
    提示标记放模块变量：热重载后会再提示一次（升级插件时才有热重载，可以接受）。

27. **路径内部的普通空格放行**（2026-10-25 第 3 批审查后定；改第 3 条的「禁止任何空白」）。Windows 的用户目录常带空格（`C:\Users\Jane Doe\…`），
    旧规则下这类机器上所有登记都会失败（8.3 短名也会被 realPath 展开成长名再被拒）。
    - 允许路径**内部**的 U+0020；**首尾**的空格拒绝（不替模型去掉：首尾带空格的是另一个文件名）；
      其它空白（Tab、换行、NBSP U+00A0、全角空格 U+3000 等）、控制符、Cf 与不可见字符、引号照旧禁止。realPath 同一规则。
    - 续接文案和 start_context 里路径本来就在双引号里，空格不会让路径和后面的句子混在一起。

28. **本地目录 marketplace 的加载与升级（2026-10-25 第 4 批审查后核实；补充第 11 条与 §8「开发位置」）。** 第 4 批审查认为本机安装版从
    `~/.claude/plugins/cache/autohandoff/autohandoff/<版本>/` 加载、合并后须 `plugin update`。在 CC 2.1.310 上隔离实测（独立 `CLAUDE_CONFIG_DIR`）结论相反：
    - 来源是本地目录的 marketplace，`claude plugin list` 显示 `Read from: <目录>`；debug log 里 hooks.json、mod 模块都从该目录读；
      经典 command hook 的 `CLAUDE_PLUGIN_ROOT` 也是该目录。改代码或改版本号后不做任何 update，下一次启动就用新代码。
    - `install` / `update` 仍会把整个目录（含未跟踪文件）拷进 cache 的 `<版本>/` 目录，但这份拷贝不被加载；
      `claude plugin update` 对这种来源回答「read from its folder: nothing to update」。
    - 所以「合并即原地升级」成立。**代价**：正在跑的 v3 会话的 hook 命令指向仓库里的 `handoff.py`，合并后该文件消失，
      `python3` 找不到文件退出码为 2（UserPromptSubmit、Stop、PreCompact 上的退出码 2 会拦截）。合并前须先让 v3 会话结束手上的交接并关掉。
    - README 的 Updating 节按此写：从 GitHub 装的用 `claude plugin marketplace update autohandoff` + `claude plugin update autohandoff@autohandoff`
      再重启会话或 `/reload-plugins`；本地克隆就地读取，`claude plugin list` 没有 `Read from:` 行时才按 GitHub 的办法更新。

29. **发布方式改为独立仓库（2026-10-25 晚用户定；取代第 11 条、第 28 条里「合回 main 原地升级」的部分）。** v3 继续留在
    `DuanWeiye/AutoHandoff`（仓库与本地目录都不动），v4 另发 public/MIT 仓库 **`DuanWeiye/AutoHandoff_Mod`**，压成 1 个 commit 发布
    （开发历史含个人信息，只存本地 `mod` 分支）。marketplace 名与插件名都保持 `autohandoff`（命令、配置文件、工具名不变），
    所以同一台机器上只能装一个：换用 v4 = 关掉所有会话 → `plugin uninstall autohandoff@autohandoff` + `marketplace remove autohandoff`
    → add/install 新仓库（dgx 用本地克隆 `~/Documents/dgx/autohandoff-mod`，就地读取）。不再做 merge、不碰 v3 会话。

以下为 2026-10-26 定（4.1.0）：

30. **交接文件超长：提示词给阅读预算，登记时估大小，超限由新对话先整理（不拦登记）。** 起因：有的工程每次交接都在交接文件里加一个日期小节、从不移走，
    文件长到新对话 Read 一次读不完（Read 工具单次上限 25000 token），重要的长期约定被挤到截断点之后。用户定：不改用户的 CLAUDE.md，工具兼容各种交接文档习惯。
    - 新设置 `handoff_max_tokens`（默认 20000；0 关掉检测与提示词里那句；非 0 时至少 1000，否则按错值回落默认）。目标值不另设：取上限的 3/4（默认 15k）。
    - remind、urge 默认提示词加 `{handoff_note}`（检测关掉时为空），**只给预算、不规定格式**（2026-10-26 需求修改：起初写的是「不要每次在顶上追加新日期小节、就地改写」，
      改为格式中立。追加、最新在前是模型的稳定习惯，也常是用户自己的约定；交接时刻上下文已满，重写整份文档费力且易丢信息；流水账本身有价值，问题只在新对话要读的部分太长）：
      格式随工程习惯；要让下个对话能在约 `{handoff_k}`k token 内读完；快超过时把较早、已完结的条目原样（不改写）移到旁边的存档文件；
      长期约定、等用户定的事项、在跑的代理留在文件前部、在预算内，不随旧条目移走、不被挤到后面。另有 `{handoff_k}` `{handoff_max_k}` 供自写提示词用。
    - 登记时（路径与 stat 校验通过后）`$.fs.read` 读一次交接文件，`estimateReadTokens` 估算 Read 工具报告的 token 数（含行号前缀，常数往高取，校准见 NOTES §2）。
      这是 `$.fs.read` 的新用途（§2.2 原来只用它读配置文件）：只数字符，不解析、不把正文放进任何文本；读失败（被删、被别的插件拒绝）只记 debug，不影响登记，这次不做检测。
    - 超过上限**不拦登记**（交接时上下文已在 300k 以上，不宜逼模型大改）：估算值记进 job（`job.tokens`，随记录跨 /clear 搬迁），debug 记一行；
      重置后新对话的 start_context 在路径句后面追加新段 `oversize`（配置文件里没有这一节就用内置默认，已生成配置文件的用户不用合并就生效）：
      交接文件约 N k token，超过上限 M k；先整理再继续：不必通读，按标题把较早、已完结的条目原样剪到旁边的存档文件（建议用脚本按标题切），保持文件自己的格式；
      长期约定、待用户决定的事项、在跑的代理留在文件前部；整理到约目标值以内后再按交接文件继续。续接正文（resume）不变。
    - 同一回合里重新登记以新登记的估算为准；检测只在登记时做一次，回合结束时的复查只看文件还在不在。`/autohandoff status` 显示登记文件的估算大小。

### 0.1 第 0 批验证结论带来的修正（2026-10-25，详见 `docs/mod-feasibility.zh.md` §9）
- 回合中途用量：**不用 `turn.step`**，在 `classic.PostToolUse` 时读 `$.session.usage().context.tokens`（数值相同且不更晚）。
- 命令：**不要 `$.command.register('autohandoff')`**（会被 md 命令占名拒绝）。保留 `commands/autohandoff.md`，其真名是 `autohandoff:autohandoff`；用 `on('command.run', {command:'autohandoff:autohandoff'}, …)` 拦截，返回 `{}` 并用 `$.ui.log` 输出（返回 `{text}` 模型下一回合会读到）。
- 用户拒绝工具（权限框 Esc/No）时 `turn.complete` 是 `reason:'answer'`、`isAborted:false`，与正常结束无异；区别是该回合**没有触发 `classic.Stop`**。§3.3 加一行：ARMED 时回合结束但本回合没见到 Stop → 静默作废（视同用户中断）。
- `command.run('clear')` 的 promise 比 `classic.SessionStart(clear)` 早约 180 ms resolve：状态切换以 resolve 为准；SessionStart 只负责附 start_context。
- 压缩后到下一次响应之前 `tokens` 读不到：各层清零在 compact resolve（或 SessionStart(compact)）时直接做；`tokens` 为空时不动作。
- `$.session.root()` 是启动目录不是 git 根：路径白名单 = `cwd()`、`root()`、`$.session.repo()?.root`、CC 配置目录 四者之下。`~` 不展开 → 含 `~` 直接拒绝。悬空符号链接 stat 不报错 → 需另查 realPath 存在且 isFile。
- teammate 无现成字段：`default_on` 改为**在本会话第一次收到人工输入（`prompt.submit` 的 origin 为 composer/bridge）之后才生效**；teammate 进程最先收到的是 `session.receive`（`teammate` 字段为 `team-lead`），从不收到人工输入，自然被排除。
- `urge_block` 的 reason 用户会以 `Stop hook error: …` 形式看到，措辞要中性；`$.ui.status` 自带 ⚠ 前缀。
- 已证实可用：SessionStart/PostToolUse 的 `additionalContext: string[]`、prompt.submit 的 `context`、`tool.call` 结果里的 `context`（备选）；登记工具全名 `mcp__autohandoff__register_handoff`，主对话无 agentId、子代理与 fork 有，manual/auto 权限模式都不弹框；Stop block 生效、第二次 `stop_hook_active=true`、turn.complete 只在最后触发一次；`command.run(compact)` 回合中排队、压缩完才 resolve、focus 进摘要（`$.session.compact` 回合中立即 reject，不用）；带引号路径的 asUser 续接成功；热重载时 `session.start` 再触发、模块变量丢、`$.store` 保留、`$.clock.every` 停。
- 未验证：Windows 路径/realPath；/clear 后权限模式与 plan mode。

第 0 批验证清单按本节调整（已完成）：删去 background_tasks、pluginConfigs/`/config` 两项；新增「`$.command.run({command:'compact', args})` 与 `$.session.compact` 的行为」「`asUser` 续接正文含引号路径时模型的反应」「`$.session.cwd()`/`root()` 在非 git 目录下的值」「`$.fs.stat` 的 realPath 在 Windows/符号链接下的形态」「teammate 进程如何识别」。

---

## 1. 目标与范围

### 做
- 只保留 Mod 这一种实现（进程内 JS/TS 模块）。各种形态的 CC 通用，不依附 tmux 或 PowerShell，不注入按键。版本号 4.0.0。
- 功能语义尽量与 v3 一致：
  - 两级阈值 remind/urge，提示词可配置
  - 交接文件 + 显式登记（模型写完交接后主动登记）
  - `/autohandoff on|off|status`
  - `action = clear|compact`
  - 按对话开关，`default_on`
  - 取消语义：用户发新消息作废；Esc 后等用户下一条；API 错误作废后当前层重新生效
  - `fresh_minutes`、等待上限
  - 第三层交给 CC 自己的自动压缩（提示词里引用压缩点，读不到就不写数值）
- 闭合 Opus 审查的 5 条 Major，并提升模型服从率（每回合短提醒、Stop block）。
- 出错一律往「不动作」方向：判断不确定就不 clear、不 submit，只通知用户。

### 不做
- 不保留 settings-hook + 敲键的旧实现：删除 `handoff.py`、`win_io.py`、`test_handoff.py`、`fixtures/`、`win/`、`e2e/` 里的敲键脚本、`hooks/hooks.json` 里的命令 hook。
- 不支持 `claude -p` 和 SDK（实测不可用，见可行性报告 §7）。
- 不读 transcript，不读屏，不判断草稿或空闲。
- 不改 CC 的 settings（只读）。

---

## 2. 架构

### 2.1 文件布局

```
.claude-plugin/
  plugin.json          name=autohandoff, version=4.0.0, userConfig（见 §5）
  marketplace.json     不变
hooks/
  hooks.json           { "description": "...", "modules": ["./register.ts"] }
  register.ts          事件接线（薄层）：每个 on(...) 只做取状态 → 调 core → 执行副作用
  core.ts              纯逻辑，不碰 $：状态转移函数、阈值判定、来源分类、路径规则、配置合并与校验、
                       压缩点计算、模板展开
  prompts.ts           默认提示词（英文常量），以及 Markdown 覆盖文件的解析
commands/
  autohandoff.md       降级用：mods 没加载时（版本低、被远程关闭、--safe-mode）才会走到模型这里，
                       让模型回一句「AutoHandoff 需要 CC ≥ X 且启用了 mods」
tests/
  core.test.ts         纯逻辑单测
  flow.test.ts         用 claude-code/testing 打桩 $，按事件序列测状态机
  helpers.ts           通用桩：store、session.id、agent.list、usage、command.run、prompt.submit 等
e2e/
  mod_setup.sh         独立 tmux server + --plugin-dir + --settings（pluginConfigs 压低阈值）+ --debug-file
  drive.py             测试驱动（允许 send-keys 模拟人输入），读 debug log 和 transcript 判定结果
  fault_proxy.py       保留，用于注入 API 错误
tsconfig.json          自己提交一份（extends .claude-plugin/types/tsconfig.json），免得引擎写一份进来
README.md              英文、中性
docs/NOTES.zh.md       改写为 Mod 版已核实事实；v3 的事实移到文末「历史」
docs/PLAN-mod.zh.md    本文
```

- 用 `.ts`：引擎直接加载，不需要构建；测试本来就是 `.ts`；有类型检查。
- `.gitignore` 加 `.claude-plugin/types/`。
- `mod-probe/` 在第 4 批删除或移到 `private/`（待定，见 §8）。

### 2.2 事件与 API 选用表

| 功能 | 事件 / 方法 | 理由 | 依据 |
|---|---|---|---|
| 进程启动、加载 | `session.start`：判断 `e.isInteractive`；读 `$.session.version()`；注册命令和工具；清理旧 store 键 | 只在交互会话工作；`-p` 下静默 | 实测 §7；d.ts SessionStartInput |
| 回合中途的上下文用量 | 首选 `turn.step` 结果的 `usage`（只看主循环 `agentId === undefined`，取 input + cache_read + cache_creation）；备选在 PostToolUse 时读 `$.session.usage().context.tokens`（第 0 批比较两者是否同步） | 去掉 transcript 写盘滞后造成的「晚一个工具调用」限制 | events.md「Follow a turn」；实测 §2 |
| 回合中途递提醒 | `classic.PostToolUse`（`e.agent_id` 为空）返回 `additionalContext: [...]` | `turn.step` 不能往请求里加消息（只能改 model/effort，消息数是固定的），所以仍用 PostToolUse | d.ts ClassicResultFields；NOTES §3（v3 已证实能送到模型） |
| 新回合开头附提醒、附作废说明 | `prompt.submit` 返回 `next({...e, context:[...]})` | 官方「只给模型看」的附加通道，用户看不到 | events.md「Rewrite or add to a prompt」 |
| urge 层兜底 | `classic.Stop`：未登记、本回合没 block 过、`!e.stop_hook_active` 时返回 `{ block: 短 urge 文本 }` | 模型想结束回合时被要求先交接，防止忽略提醒 | d.ts ClassicResult.block；StopHookInput.stop_hook_active |
| 后台工作快照 | `classic.Stop` 的 `e.background_tasks`（shell/subagent/monitor/workflow） | `$.agent.list()` 看不到后台 shell，这里能看到 | d.ts StopHookInput |
| 回合结束、作废判定 | `turn.complete`（主循环）：`isAborted` / `reason`（answer/aborted/refusal/error） | 取代 Stop、StopFailure、stop_hook_summary、hookErrors 那一套 | 实测 §6；d.ts TurnCompleteInput |
| 登记 | `$.tool.register({name:'register_handoff', inputSchema:{file}, isDeferred:false})` + `tool.call` 匹配 `mcp__autohandoff__register_handoff` 直接作答，不调 next | 取代 `python3 handoff.py register`；`e.agentId` 能区分主对话和子代理/fork；作答不调 next 时不弹权限框 | api.md「Add a tool」；d.ts AgentLoop |
| 子代理守卫 | `$.agent.list()`：状态 ∈ {pending, running, waiting} 就算忙 | 实测 clear 不会结束后台子代理 | 实测 §5d；d.ts AgentStatus |
| 重置（clear） | 在 `turn.complete` 里 `await next(e)` 之后，`void` 执行 `$.command.run({command:'clear'})` | 排队到空闲才执行；等 clear 真正完成才 resolve | 实测 §3 |
| 重置（compact） | 首选 `$.command.run({command:'compact', args: compact_focus})`（与 clear 同样排队）；备选 `$.session.compact({instructions})`（回合进行中会 reject，返回明确结果）。第 0 批定 | 两条路都要实测 SessionStart(compact) 是否触发、何时 resolve | d.ts session.compact |
| 把交接文件交给新对话 | `classic.SessionStart`（source=clear/compact，且状态是我们的 clearing/compacting）返回 `additionalContext:[start_context]` | 路径只进上下文，不进「用户说的话」 | NOTES §3、§17；实测 §3（自家这个 hook 会触发） |
| 续接 | `$.prompt.submit({text: 固定续接文案, asUser:true})` | 开一个新回合；transcript 里能看出插件来源 | 实测 §4 |
| 识别用户的 /clear、/compact、/resume、/autohandoff | `command.run`（origin=composer；自家发起的命令自家 hook 看不到） | 用户手动重置时作废登记 | 实测 §4（re-entry 规则） |
| 会话结束 | `session.end`（reason≠clear 时作废） | | d.ts SessionEndInput |
| 读配置 | `register(on, options)`（userConfig）+ `$.fs.read`（提示词覆盖文件） | 官方机制；/config 里能改 | d.ts PluginOptions |
| 压缩点 | `$.env.get`（DISABLE_COMPACT、DISABLE_AUTO_COMPACT、CLAUDE_CODE_AUTO_COMPACT_WINDOW）+ `$.settings.read({key})`（autoCompactEnabled、autoCompactWindow、modelSettings）+ `usage().context.window` 取小 | 引擎自己的合并结果，不再手写约 160 行分层逻辑；顺带修掉「模型窗口比 autoCompactWindow 小时压缩点报错」 | d.ts settings.read |
| 通知 | `$.ui.status`（常驻一行状态）、`$.ui.toast`（短提示）、`$.ui.notify`（需要用户注意）、`$.ui.log`（transcript 暗色行，模型看不到；`{to:'debug'}` 给 e2e 用） | 各平台都有统一的显示位置 | api.md「Show something without starting a turn」 |
| 持久状态 | `$.store`，一个 session 一个键 | 跨热重载、跨 /clear（迁移键）、多会话不冲突 | 实测 §8 |

用到的 `$` 调用（`claude plugin validate` 的 `calls:` 行应正好是这些；第 3 批按实际代码更新）：
- `$.session.{usage,id,version,cwd,root,repo,surfaces}`
- `$.command.run`、`$.tool.register`、`$.prompt.submit`
- `$.store.{get,set,keys,delete}`、`$.state.{get,set}`（只有 `autohandoff.queued`，§0 第 24 条）、`$.fs.{read,stat,exists,write}`（write 见下）
- `$.env.get`（全部用字面量名：AUTOHANDOFF_CONFIG、CLAUDE_CONFIG_DIR、HOME、USERPROFILE）
- `$.ui.{status,toast,notify,log}`、`$.clock.{now,after}`

**不用**：`$.process.*`、`$.http.*`、`$.model.*`、`$.env.set`、`$.prompt.fill`。`$.fs.write` 仅此一处例外：配置文件不存在时写一次默认文件（§0 第 17 条）。这样审计面最小。
`$.fs.read` 除了读配置文件，4.1.0 起还在登记时读一次交接文件估大小（§0 第 30 条；只数字符，路径已过白名单）。

---

## 3. 状态机（每个对话一份）

### 3.1 记录结构
`$.store` 的键是 `s:<sessionId>`，值：

```
{
  on,
  levels: { remind, urge },          // 本对话各层是否已提示
  job: null | { id, file, real, stage, registeredAt, regTurnId },
  tell,                              // 待告诉模型的作废原因
  blockedTurn,                       // 本回合已用过 Stop block 的 turnId
  t                                  // 最后写入时间
}
```
- 模块变量 `rec` 做缓存，store 是事实来源。
- 每次改动只写自己这个键（实测 `$.store` 的 get/set 不是原子的）。

### 3.2 状态和转移

| 状态 | 进入条件 | 离开的触发 |
|---|---|---|
| OFF | `on=false` | `/autohandoff on` 或开关切换 → ON |
| ON | `on=true`，没有 job | 用量 ≥ remind_at 且该层没提示过 → 送 remind（PostToolUse 或 prompt.submit），`levels.remind=true`；用量 ≥ urge_at → 送 urge，`levels.urge=true`（一次跨两层只送 urge）；用量回落到 remind_at 以下（压缩后）→ 两层都清零 |
| ON + remind 已提示、未登记 | | 之后每个主对话回合都附短提醒（`prompt.submit` context），直到登记 |
| ON + urge 已提示、未登记 | | `classic.Stop` 时若本回合未 block 且 `!stop_hook_active` → `{block}` 一次；之后的回合附短 urge |
| ARMED | 工具登记成功（只认主循环） | 主回合 `turn.complete`：成功结束 → 检查守卫；被中断、出错、拒绝、有新消息、超时 → 作废 |
| WAITING | 回合已结束，但有子代理（pending/running/waiting）或后台 shell/workflow 在跑 | 之后每个主回合 `turn.complete` 和 `$.clock.every(10s)` 轮询（只在没有回合进行时）复查守卫；空闲 → CLEARING；超过 `wait_minutes` → 作废（告诉模型 + notify） |
| CLEARING / COMPACTING | 守卫通过；再 stat 一次文件仍在且非空；先写状态，再 `void command.run` | `classic.SessionStart(source=clear\|compact)` → 返回 start_context，记录迁移到新 sid → RESUMING；command.run reject（「session was stopped」或「removed from the queue」）→ 静默作废；60 s 内 SessionStart 没来 → 作废并通知 |
| RESUMING | 重置完成 | `void prompt.submit(resume)` resolve：带 text → 完成（job 清空，levels 清零，status 清掉，`ui.log` 记一笔）；返回 `{drop}` → notify「已重置，交接文件路径已在上下文里，请发一条消息继续」，然后结束 |

### 3.3 取消条件（对应 v3 语义）

| 触发 | 处理 | 告诉模型？ | 当前层重新生效？ | 通知用户？ |
|---|---|---|---|---|
| 用户消息（origin 是 composer、bridge、sdk、channel、slack-ping、coordinator、projects-relay、scheduled-trigger、unclassified、不认识的值）在 ARMED/WAITING 时到达 | 作废；作废说明直接附在这条消息的 context 里 | 是 | 是 | toast |
| 代理类消息（peer、peer-send-message、task-notification、observer*、auto-continuation）在 ARMED/WAITING 时到达 | **不作废**；在这一回合 context 附「交接已登记，回合结束且无后台任务时重置；如有变化请更新交接文件（可再次登记）」；等这回合跑完再查守卫 | 附说明 | — | — |
| CLEARING 期间收到用户消息（与排队中的 clear 竞争的那约 100 ms） | 推荐：`{drop}` 把消息退回输入框，并提示「正在重置，请在重置后重新发送」；之后跳过续接（用户接手），SessionStart 照样给出交接路径（同 v3 的 orphan 语义）。待定，见 §8 | 否 | 否 | 是 |
| RESUMING 期间用户先发了消息 | 我们的 submit 已排队、无法撤回 → 续接文案里写「如果用户已在本对话给出别的指示，以用户为准」 | — | — | — |
| `turn.complete isAborted`（Esc） | 静默作废，等用户下一条；remind 层的每回合短提醒在用户下一条消息时自然恢复 | 否 | 否 | 否 |
| `turn.complete reason=error` | 作废 | 是（下一次能递话时） | 是 | notify |
| `turn.complete reason=refusal` | 作废 | 是 | 是 | toast |
| 用户手动 `/clear`、`/compact`、`/resume`（command.run，origin=composer） | 作废 | 否 | 否 | 否 |
| `/autohandoff off` | 作废，`tell` 清空 | 否 | — | — |
| `session.end`（reason≠clear） | 作废 | 否 | — | — |
| 等待超过 `wait_minutes`（从登记算起） | 作废 | 是 | 是 | notify |
| 模块热重载、userConfig 改动后 `session.start` 再触发，而当时有 job | 作废（无法确认回合状态，宁可不动） | 是 | 是 | toast |
| 交接文件在重置前消失或变空 | 作废 | 是 | 是 | toast |

### 3.4 开关的持久性
- `on` 存在 `s:<sid>` 里，跨 /clear（迁移到新 sid）、跨热重载。
- 新进程且 store 里没有记录时用 `default_on`。
- 因为按 sid 存，`--resume` 回到某个对话时开关会恢复（与 v3 按进程不同，待定）。
- 清理：`session.start` 时删掉 `t` 早于 30 天的 `s:*` 键，`$.store` 本身也会按 `cleanupPeriodDays` 清理。

---

## 4. 提示词与注入点

| 键 | 注入点 | 能用的占位符 | 是否含模型可控内容 |
|---|---|---|---|
| `remind` | PostToolUse 的 additionalContext，或 prompt.submit 的 context（首次越线时） | `{used_k} {remind_k} {urge_k} {compact_note} {tool} {action}` | 否 |
| `remind_short`（新增） | 之后每个主回合的 prompt.submit context | 同上 | 否 |
| `urge` | 同 remind | 同上 | 否 |
| `urge_block`（新增） | classic.Stop 的 block 理由 | 同上 | 否 |
| `cancelled` | 作废那条消息的 context，或下一次 PostToolUse/prompt.submit | `{reason} {tool}`（reason 只取固定的几种原因） | 否 |
| `pending_note`（新增） | ARMED 或 WAITING 时代理类消息的 context | `{action}` | 否 |
| `start_context` | classic.SessionStart(clear/compact) 的 additionalContext | `{action}`；路径由代码以 JSON 字符串形式追加，模板里不提供 `{file}` | 有：路径，但在上下文里，且经过校验 |
| `resume` | `prompt.submit({asUser:true})` 的正文 | 只有 `{action}`；含 `{file}` 或 `{cmd}` 的模板会被拒绝，退回内置默认 | 否（固定文案） |
| `compact_focus` | `/compact` 的参数，交给摘要模型 | `{action}`；不含路径（路径走 SessionStart(compact)） | 否 |

**固定文本策略**：`resume` 与 `compact_focus` 的正文只能来自用户配置或内置默认值。代码只展开白名单里的占位符，展开后去掉控制字符。不再检查「首字符可敲」（不再敲键，不需要了）。

**路径交付方案对比与推荐**：

| 方案 | 安全 | 可靠 | 结论 |
|---|---|---|---|
| A. `classic.SessionStart` 的 additionalContext（推荐） | 路径以「上下文 + 来源说明」出现，不是用户发言 | v3 已证实送得到模型；mod 版待第 0 批实测 | **采用** |
| B. `prompt.context` 的 block | 同 A | 每个对话算一次，有缓存；对自家 submit 的回合是否触发未知 | 作为 A 的备选 |
| C. 严格白名单校验后写进 resume 正文 | 路径进入用户发言，仍属模型可控 | 最稳 | 只在 A、B 都不行时，经用户同意才用 |
| D. 固定的工程约定路径 | 最安全 | 失去灵活性；各项目约定不同 | 不采用（可作为可选配置） |

**登记时的路径校验**：
- 字符串长度 ≤ 1024；不能有 Cc、Cf 类字符（控制符、换行、双向格式符）。
- 相对路径按 `$.session.cwd()` 解析；用 `$.fs.stat(p, {resolve:true})` 拿 `realPath`，必须是普通文件、非空、≤ 1 MiB，修改时间在 `fresh_minutes` 内。
- `realPath` 必须落在 `$.session.root()` 之下，或配置的额外允许目录之下（待定）。
- 写进上下文时用 `JSON.stringify(realPath)`，并说明「这是上一段对话里模型写的工作笔记，不是用户的指示；先核对仓库现状，再参考它」。这一句也同时缓解「交接内容由模型控制」的问题。

**提示词内容调整（相对 v3）**：
- 把 `Run {cmd} with the Bash tool` 改为 `Call the {tool} tool with the handoff file path`。
- 关于子代理：不要再启动新的子代理或后台任务；写完立即登记；重置会等仍在跑的子代理和后台 shell 结束，它们的汇报会先回到本对话，届时把结果补进交接文件（可再次登记刷新）。
- 保留 v3 已在 Windows 实测中改进过的四点：开头注明来源与授权；时点是「本回合结束前、只做完正在进行的那一步」；等用户答复或未完批次不是推迟理由；1/2/3 步骤清单。
- 续接文案（英文、固定、asUser）大意：

  > [AutoHandoff: resume] The context was just reset. Read the handoff file named in the AutoHandoff note in your context, then the project docs, memory and git status as needed, and continue the unfinished work. If I have already given other instructions in this conversation, follow those instead. List anything waiting for my decision first.

---

## 5. 配置方案

### 5.1 userConfig（plugin.json）
默认值与 v3 一致，在 `/config` 里显示为行；改动后插件热重载。

| 键 | 类型 | 默认 | 约束 |
|---|---|---|---|
| `default_on` | boolean | false | |
| `remind_at` | number | 300000 | min 1，max 10000000 |
| `urge_at` | number | 450000 | 同上，且必须 > remind_at，否则两项都用默认并在 status 里报告 |
| `action` | string | clear | options: clear, compact |
| `fresh_minutes` | number | 10 | 1–1440 |
| `wait_minutes` | number | 60 | 1–1440（替代 wait_turn_end_minutes，同时包含等子代理的时间） |
| `urge_block` | boolean | true | 待定 |
| `remind_every_turn` | boolean | true | 待定 |
| `prompts_file` | file | 空 | 空时读 `<CLAUDE_CONFIG_DIR 或 ~/.claude>/autohandoff-prompts.md`（存在才读） |

### 5.2 提示词覆盖文件（Markdown）
- 只有 `## <键名>` 这一种标题（键名属于上表 9 个之一）开启一节，节内原样保留，其他标题当正文。
- 缺的键用内置默认；模板非法（未知占位符、resume 含 `{file}`）就用内置默认，并在 `/autohandoff status` 里报告。
- 每次要用时都重读，改了立刻生效，与 v3 一致。
- 不用 TOML（JS 没有内置解析）；JSON 写长文本要转义 `\n`，不方便。

### 5.3 settings.json 样例

```json
"pluginConfigs": {
  "autohandoff@autohandoff": {
    "options": {
      "default_on": false,
      "remind_at": 350000,
      "urge_at": 450000,
      "action": "clear",
      "fresh_minutes": 10,
      "wait_minutes": 60
    }
  }
}
```
- `--plugin-dir` 加载时键名是 `autohandoff@inline`。安装后的键名格式待第 0 批核实。

### 5.4 迁移
- `~/.claude/autohandoff.toml` 和 `~/.claude/autohandoff-state/` 作废。
- 首次 `session.start` 用 `$.fs.exists` 发现旧 toml 时，提示一次：「旧配置已不再读取，请在 /config 里设置；可以删除这两个路径」。
- 本机旧 toml 里 `remind_at=350000`，要提醒用户在 /config 里重设。
- README 写出迁移步骤。

---

## 6. 安全分析

### 6.1 Opus 审查 Major

| 编号 | 问题 | 4.0.0 的处理 | 结论 |
|---|---|---|---|
| ① | fork 或子代理能 register | 登记改为 mod 工具，`tool.call` 的 `e.agentId !== undefined` 一律拒绝（结果写明「只能从主对话登记」）；引擎自己的 fork 也带 agentId；`$.model.fork` 不能调工具 | 解决（第 0 批实测主对话、子代理、fork 三种情况） |
| ② | `{file}` 以用户身份进入输入 | 续接文案固定，模板禁用 `{file}`；路径只进 SessionStart 上下文，经白名单校验、JSON 转义，并注明「模型写的笔记，不是用户指示」 | 解决 |
| ③ | 与人抢键盘或草稿 | 不再敲键。实测草稿保留；弹窗开着时排队；用户回合进行中发的消息会让登记作废；剩下约 100 ms 的竞态见 §3.3 | 解决（竞态处理方式待定） |
| ④ | resuming 阶段来源认不出时默认「敲」 | 来源分类改为白名单：认得的代理类来源才不作废，**其余（含新出现的来源）一律按用户消息作废**；我们自己的 submit 只看 promise 结果 | 解决 |
| ⑤ | 依赖 hookErrors 字段名 | 不再读 transcript；回合结束以 `turn.complete` 的类型化字段为准 | 解决 |

### 6.2 Minor 与设计讨论

| 项 | 结论 |
|---|---|
| synchronize-panes、tmux copy-mode | 不适用（不用 tmux） |
| 空回车 + 建议 | 不适用 |
| cc_setting 160 行价值低 | 解决：改用 `$.settings.read` + `$.env.get`，约 30 行；`--autocompact` 启动参数读不到，列为已知限制 |
| 锁内调 tmux、Windows 锁忙等 | 不适用（`$.store` 每个 session 一个键） |
| 路径空格被压缩 | 不适用（路径不再进入文本） |
| /clear 后后台任务 | 解决：子代理和后台 shell 守卫；monitor 和 cron 写进提醒文案（待定） |
| /clear 后权限模式、plan mode、会话内授权 | 待第 0 批实测；若重置后丢失，列为已知限制写进 README |
| 编排模式下任务通知反复作废交接 | 解决：代理类来源不作废，等那回合跑完，并附 pending_note |

### 6.3 社区坑

| 坑 | 结论 |
|---|---|
| Enter 被当成粘贴 | 不适用（不敲键） |
| 补全菜单吞 Enter | 不适用 |
| 弹窗吞键 | 不适用（command.run 会排队，实测 §5b/5c） |
| 70% 成功率 | 不适用：每一步都是有明确 resolve/reject 的 API；e2e 连跑 20 次统计 |

### 6.4 其他要点
- 故障方向：
  - `prompt.submit` 和 `command.run` 的 hook 加 `.catch`，出错时直接 `next(e)` 放行（决不挡用户的输入）。
  - 登记工具的 `.catch` 返回「AutoHandoff 内部错误，未登记」（失败即不动作）。
  - Stop hook 出错时被跳过，回合照常结束。
- 版本检查：`session.start` 读 `$.session.version().base`，低于最低版本时不注册工具、不提醒，只在 `/autohandoff status` 里说明。mods 根本没加载时，由 `commands/autohandoff.md` 降级说明。

---

## 7. 测试计划

### 7.1 单测（`claude plugin test`，不需要会话和网络）

**core.test.ts**：
- 阈值：首次越线、一次跨两层、回落清零、刚好等于阈值的边界
- 来源分类：每种 origin 的结果；未知来源按用户消息处理
- 路径规则：控制字符、Cf 字符、过长、相对路径、realPath 在根目录外、空文件、过旧、过大
- 配置：缺项、类型错、remind ≥ urge、action 非法
- Markdown 覆盖文件：分节、未知标题、resume 含 `{file}` 被拒
- 压缩点：各种环境变量与设置组合、modelSettings 存在、与模型窗口取小

**flow.test.ts**（用 mock.store、mock.clock、mock.env，以及 `session.id`、`agent.list`、`command.run`、`prompt.submit`、`fs.stat`、`settings.read` 的桩）：
1. 正常 clear 路径：越线 → 登记 → turn.complete → command.run(clear) → SessionStart(clear) 返回 start_context → submit 的正文就是固定续接文案
2. compact 路径
3. 子代理或后台 shell 忙：进入 WAITING，空闲后 clear；超时作废并告诉模型
4. 登记来自子代理（e.agentId 有值）→ 拒绝
5. ARMED 时用户消息 → 作废，context 里有 cancelled；代理类消息 → 不作废，有 pending_note
6. Esc（isAborted）→ 静默作废；reason=error → 作废、告诉模型、该层重新生效
7. command.run 被拒（session was stopped、removed from queue）→ 静默作废
8. submit 返回 drop → 通知
9. Stop block 每回合只一次；`stop_hook_active` 时不再 block
10. 用户手动 /clear → 作废；/autohandoff on|off|status|空参数切换|非法参数
11. 热重载时有 job → 作废
12. 非交互、低版本 → 不注册、不提醒
13. store 键在 clear 时从旧 sid 迁移到新 sid；过期键被清理
14. CLEARING 期间用户消息被 drop 退回

### 7.2 端到端（隔离环境；测试驱动允许用 send-keys 模拟人）
- 环境：`tmux -L ahmod` 独立 server，`env -i` 启动；scratchpad 下的工作目录（git 仓库，先接受信任）；`claude --plugin-dir <worktree> --settings <tmp.json> --debug-file <log> --model sonnet`。tmp.json 里用 pluginConfigs 把阈值压低（例如 remind 30k、urge 45k），并设 `autoCompactWindow`。
- 判定依据：debug log 里 `ui.log({to:'debug'})` 写的审计行，加 transcript 的 origin 字段。
- 场景：
  1. 正常 clear：续接回合的 origin 是 plugin + asUser，模型读到 SessionStart 给出的路径
  2. 正常 compact
  3. 输入框有草稿：草稿保留
  4. AskUserQuestion 或权限框开着：排队，回答后执行
  5. 后台子代理在跑：等它汇报完、补进交接后才 clear
  6. 后台 Bash 在跑：同上
  7. 登记后按 Esc：静默作废；之后用户发一条消息，短提醒恢复
  8. API 错误（fault_proxy 注入 `1*500`）：作废并告诉模型
  9. 回合进行中用户插话：作废
  10. 子代理调登记工具：被拒绝
  11. urge 层的 Stop block 生效且只一次
  12. 用户手动 /clear：作废
  13. /autohandoff 各子命令
  14. `claude -p`：静默
  15. 低版本：用 CC 的版本覆盖手段，或在单测里覆盖
  16. 连续 20 次 clear 循环统计成功率
- 隔离与清理：结束后 kill-server，删掉测试 cwd 对应的 `~/.claude/projects/...`、session-env 等残留，以及 store 里的测试键。不动全局设置和已装插件。

### 7.3 Windows（用户上机实测）需验证点
- mods 能加载，`/plugin` 里显示 1 mod active
- 正常 clear 与 compact 的续接
- 登记工具的路径：Windows 路径与 Git Bash 写法（`/d/...`）各自被 stat 如何解析；realPath 大小写与 `$.session.root()` 的比较（要按 Windows 不区分大小写来比）
- Windows Terminal 和 VS Code 集成终端里 status、toast、notify 的显示
- 子代理守卫
- Esc
- 中文路径与含空格的路径

---

## 8. 分批实施

| 批次 | 内容 | 验收 | 预估改动量 |
|---|---|---|---|
| 0 验证实测（一次性探针，在 mod-probe 或 worktree 里） | 11 项未证实点：<br>① mod 的 classic.SessionStart additionalContext 在自家 clear 后能送到模型<br>② 登记工具：主对话、子代理、fork 三种调用的 agentId；作答时是否弹权限框<br>③ classic.Stop 的 block、stop_hook_active；Stop 与 turn.complete 的先后和次数；background_tasks 的内容<br>④ mod 的 classic.PostToolUse additionalContext<br>⑤ prompt.submit 的 context 对用户消息生效<br>⑥ command.run(compact) 与 session.compact 的行为（是否触发 SessionStart(compact)、何时 resolve）<br>⑦ `commands/autohandoff.md` 与 mod 注册的同名命令能否共存，command.run 能否拦截<br>⑧ pluginConfigs 键名、/config 行显示、改动后热重载<br>⑨ CLEARING 期间 drop 用户消息能否退回输入框<br>⑩ turn.step 的 usage 与 PostToolUse 时 `session.usage()` 是否同步<br>⑪ /clear 后权限模式和 plan mode 的状态 | 报告追加到 `docs/mod-feasibility.zh.md` 的 §9；若推荐方案不成立，回来改计划 | 探针约 150 行 |
| 1 纯逻辑 | core.ts、prompts.ts、core.test.ts | 单测全过；validate 通过 | 约 450 + 300 行 |
| 2 接线与 clear 主路径 | register.ts、plugin.json、hooks.json、降级 md、flow.test 的 1–8、e2e 脚本、e2e 场景 1、3、4、9、13、14 | 单测全过；e2e 主路径连跑 20 次全成功 | 约 300 + 300 行 |
| 3 compact 路径、守卫与服从率 | compact 路径、WAITING、Stop block、每回合短提醒、作废全集；flow.test 其余用例；e2e 其余场景 | 全部场景通过 | 约 150 + 200 行 |
| 4 清理与发布 | 删除旧代码；README（英文）与 NOTES 改写；版本 4.0.0；迁移提示；Opus 审查；用户在 Windows 实测；本机原地升级 | 审查无 Major；Windows 验证点全过；push 前问用户（公开仓库） | 删约 3000 行，文档约 300 行 |

**开发位置**：全局安装的是本地目录 marketplace，**直接读仓库目录**。工作目录一改，正在用的真实对话下次启动或 `/reload-plugins` 时就会加载半成品。因此第 1–3 批在 git worktree（独立分支）里开发，只用 `--plugin-dir` 测；第 4 批合并回主目录，就等于原地升级（§0 第 28 条核实；正在跑的 v3 会话要在合并前关掉，否则它们的 hook 找不到 `handoff.py`）。Windows 上 `D:\Claude\AutoHandoff` 是手动拷贝，需要整目录替换。若用户想先停用旧版，可以 `/plugin` 里关掉，或卸载后再装新版。

### 需要用户决定的问题
1. 路径交付：推荐方案 A。额外允许哪些目录（只限项目根目录，还是加上记忆目录或自定义目录）？
2. 续接用 `asUser`，还是带插件名的框架式？
3. 提示词覆盖文件用 Markdown 还是 JSON；放在哪里？
4. 哪些后台工作挡住 clear：子代理在 pending/running/waiting 时、后台 shell、workflow 挡；monitor、cron、空闲 teammate 不挡。同意吗？
5. `urge_block` 默认开吗？
6. `remind_every_turn` 默认开吗？
7. CLEARING 期间的用户消息：退回输入框，还是放行？
8. 最低 CC 版本：2.1.287、2.1.304 还是 2.1.310？
9. 开关按 sid 保存，`--resume` 时恢复，可以吗？
10. `/autohandoff` 输出用 `ui.log`（模型看不到），还是作为命令输出（模型能读到）？
11. 开发是否在 worktree 里做，最后原地升级？
12. `mod-probe/` 删除还是移到 `private/`；`e2e/fault_proxy.py` 是否保留？
13. agent team 的 teammate 进程是否排除在 `default_on` 之外？

---

## 9. 风险与已知限制
- **Mods API 仍是早期版本**：d.ts 自称会无预告变动。处理：锁最低版本；README 写明已测版本；`session.start` 检查版本；把 validate 和单测放进发布检查。
- **mods 可能被远程关闭，或被 `--safe-mode`、`--bare`、`disableAllHooks`、托管策略禁用**：这时插件什么都不做，`/autohandoff` 会走到降级 md 命令给出说明。新目录在接受 workspace trust 之前也不会加载 mod。
- **未验证的环境**：VS Code 扩展、桌面端、WSL（据报不加载插件）、Remote Control 接入时的行为。README 写明「只在终端 CLI 上测过」。
- **`claude -p` 和 SDK 下不可用**（实测）。
- **压缩点读不到 `--autocompact` 启动参数**；`modelSettings` 按模型设的窗口当作未知（不写数值）。
- **模型可能仍不服从**：Stop block 只是兜底，最后一层是 compact_at 的兜底压缩（§0 第 2 条），再往后才是 CC 自带的自动压缩。
- **用户在重置完成后、续接回合开始前的约 0.4 s 内发消息**：续接会排在用户回合之后，由续接文案里「以用户为准」来兜。
- **热重载或配置改动时**正在进行的登记会作废，需要模型重新登记（已排队的重置不受影响，见 §0 第 20、24 条）。
- **重置排队期间用户 `/resume` 切到别的对话**（§0 第 20 条）：排队的 `/clear`（或 `/compact`）撤不回，会作用在切过去的那个对话上，且不续接；那个对话的 transcript 还在，再 `/resume` 一次就回来。用户 `/resume` 时的 toast 如实说明这一点。
- **后台子代理的权限框开着时，排队的 `/clear` 不会等它**（实测，见 feasibility §10.3）：主回合一结束就 clear，权限框留着；用户之后答复，子代理接着跑完，汇报落到新对话。这正是 §0 第 1 条要的效果，只是用户要知道权限框跨过了一次重置：屏上的权限框属于上一段对话里的子代理，照常答复即可。
- **压缩窗口里敲的消息照常续接**（§0 第 23 条）：实测引擎把它排到压缩之后，续接也会提交，两条都得到处理，以用户为准。
- **action=clear 的孤儿 job 遇到「用户 /clear 先跑」**（第 3 批审查 Minor-2）：用户的 /clear 排在自家 /clear 前面、且热重载正好落在两次 clear 之间时，
  用户那次的 SessionStart(clear) 与自家的分不开（compact 可以靠 source 区分），续接会提交进中间那个对话，随后自家的 /clear 再清一次，最后那个对话拿不到续接
  （交接文件还在，手动让模型读即可）。窗口是亚秒级（clear 排队约 30 ms 就执行）且要叠上热重载，不改代码。
- **同一对话被两个进程同时打开**（第 3 批审查 Minor-3）：进程 A 的重置已排队时用户在另一个终端 `claude --resume <同一 sid>`，B 的 `$.state` 是空的，判为重启并作废；
  A 随后完成 clear 却没有续接。两个进程开同一对话本来就不正常，不处理。
- **兜底压缩成功但用量仍 ≥ compact_at**（第 3 批审查 Minor-4）：只有失败才计数，压缩「成功」却没降到 compact_at 以下（compact_at 配得很低、CLAUDE.md 或压缩附件很大）时，
  之后每个在阈值之上结束的回合都会再压一次。默认 650k 下碰不到；遇到时把 compact_at 调高。
- **读不到 `$.state` 时按热重载处理的代价**（第 3 批审查 Minor-5）：见 §0 第 24 条。
- **`$.state` 跨 /clear 的行为未验证**：文档说 /clear、/resume 会把它重置；热重载实测只用了 compact（不换 sid）。正常路径不受影响，只在 Minor-2 那类复合窗口里有区别。
- **Windows 未经 e2e**：路径规则只有单测，真实的 realPath、`$.session.cwd()` 形态、进程与热重载行为待上机实测（`docs/windows-checklist.zh.md`）。
