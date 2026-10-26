# AutoHandoff 4 Windows 上机测试清单

在 Windows 机器上照着测。Linux 上 e2e 全过，但 Windows 上的路径形态、进程与热重载行为一次都没实测过（PLAN §0.1「未验证」、§9）。
来源：第 3、4 批审查的 Windows 部分（审查报告不随仓库发布）。

## 0. 准备

- Claude Code ≥ 2.1.304（记下 `claude --version`）。在 Windows Terminal 里开（另测一次 VS Code 集成终端更好）。
- **记下 claude 是从哪个 shell 启动的**（PowerShell、cmd、Git Bash）：三者的环境变量写法和 HOME 形态不同，下面几项的结果会跟着变。
  本清单里的 `%USERPROFILE%`、`%TEMP%` 是 cmd 写法；PowerShell 里写 `$env:USERPROFILE`、`$env:TEMP`；Git Bash 里是 `$USERPROFILE`、`$TEMP`（`$HOME`、`$TEMP` 等可能是 MSYS 形态，如 `/c/Users/<你>`）。
- 先停掉 v3：`/plugin` 里关掉或卸载旧的 autohandoff；`D:\Claude\AutoHandoff` 是手动拷贝的话整目录换成 v4（`mod` 分支的内容）。
- 单会话试用：
  - PowerShell：`claude --plugin-dir D:\Claude\AutoHandoff_Mod --debug-file $env:TEMP\ah-debug.log`
  - cmd：`claude --plugin-dir D:\Claude\AutoHandoff_Mod --debug-file %TEMP%\ah-debug.log`
  `/plugin` 页签顶部应显示 `1 mod active · autohandoff`。debug log 里搜 `[autohandoff]` 能看到审计行（`handoff registered`、`turn ended; running /clear` 等）。
- 测试工程放一个**不重要的 git 仓库**里，先接受 workspace trust。为了快，在配置文件里把阈值压低（见第 2 节，例如 `remind_at: 40000`、`urge_at: 60000`、`compact_at: 900000`），
  然后 `/autohandoff on`。

每项记下：做了什么、屏上看到什么（toast、状态行、transcript 暗色行）、debug log 相关几行。失败时 `/autohandoff status` 的输出也贴上。

## 1. 路径（最可能让插件整体不可用，先测）

让模型「把一句话写进 docs\HANDOVER.md，然后用 register_handoff 工具登记它」，或者自己在对话里要求它登记某个路径。看登记工具的答复（「Handoff registered」或「Not registered: <原因>」）。

| # | 情况 | 期望 | 结果 |
|---|---|---|---|
| 1a | **用户名或工程路径里有空格**（如 `C:\Users\Jane Doe\proj\docs\HANDOVER.md`） | 受理（PLAN §0 第 27 条：路径内部的普通空格放行）。这条决定整个插件在该机器上能不能用，失败时记下拒绝原因原文 | |
| 1b | 8.3 短名写法（如 `C:\Users\JANEDO~1\proj\docs\HANDOVER.md`） | 受理；看答复里的路径是否被 realPath 展开成带空格的长名（展开了也应受理） | |
| 1c | realPath 是否带 `\\?\` 前缀 | 不该带；带的话会被「网络/设备路径」规则拒掉，拒绝原因里能看到 | |
| 1d | 盘符大小写：工程在 `D:\proj`，登记 `d:\proj\docs\HANDOVER.md` | 受理（比较时大小写不敏感） | |
| 1e | 正斜杠与反斜杠混用：`D:/proj/docs\HANDOVER.md`、相对路径 `docs/HANDOVER.md` 与 `docs\HANDOVER.md` | 都受理 | |
| 1f | 记忆目录：`%USERPROFILE%\.claude\projects\<工程目录名>\memory\handoff.md` | 受理；`%USERPROFILE%\.claude\settings.json` 拒绝 | |
| 1g | 中文路径（如 `D:\项目\docs\交接.md`） | 受理 | |
| 1h | 续接文案里带反斜杠的引号路径：clear 之后新对话的续接消息末尾 `Handoff file: "D:\proj\docs\HANDOVER.md" …` | 模型能直接 Read 到这个文件（transcript 里看它的 Read 调用） | |
| 1i | 工程放在**映射网络盘**（`Z:\proj`）、**subst 盘**（`subst P: D:\proj` 后在 `P:\` 里开）或直接在 **UNC 路径**（`\\server\share\proj`）里 | 记下现象：realPath 可能展开成 `\\server\share\…` 而被 `//` 开头的网络路径规则拒绝，`$.fs` 碰到网络位置也会 reject。subst 盘指向本地盘时应受理 | |
| 1j | **用户目录被重定向到网络共享**（公司/域机器常见，`%USERPROFILE%` 或 `%APPDATA%` 在 `\\server\…`） | 启动后 `register_handoff` 工具仍在（模型能调用它；4.0.0 已改成先注册工具，配置文件读写失败不影响注册）；`/autohandoff status` 正常，可能报配置文件读不到、用内置默认 | |
| 1k | **长路径**：工程或交接文件的完整路径超过 260 字符（深目录） | 记下 realPath 是否带 `\\?\` 前缀；带的话会被拒，拒绝原因原文贴上。路径本身超过 512 字符按规则拒绝 | |
| 1l | **Win32 名称规整**：登记 `docs\HANDOVER.md.`（末尾点）和 `docs\HANDOVER.md `（末尾空格） | 末尾空格：按首尾空格规则拒绝。末尾点：记下是被拒（原因原文）还是受理、答复里的 realPath 是否已去掉末尾点 | |
| 1m | **junction 或符号链接**：工程目录经 `mklink /J` 链到另一个盘（或交接文件是 `mklink` 的符号链接） | 按链接**目标**判断：目标在工程或记忆目录内受理，否则拒绝；记下答复里的 realPath | |
| 1n | **mod 指定的交接文件路径**（4.1.0）：在带空格的工程目录（如 `C:\Users\Jane Doe\proj`）里越过 remind_at | 提醒末尾的 `Handoff file to write: "…"` 是 `C:\Users\Jane Doe\proj\.autohandoff\_AUTOHANDOFF_<本地日期>_<本地时间>_<会话 ID 前 8 位>.md`（反斜杠、时间是本机本地时间）；模型用 Write 建出 `.autohandoff\` 目录与文件，**不弹权限框**，登记受理。记下登记答复里的 realPath | |
| 1o | 同上，但在**用户主目录本身**启动 claude（`cd %USERPROFILE%` 后 `claude`） | 提醒改为让模型把 `_AUTOHANDOFF_…md` 放进自动记忆目录 `%USERPROFILE%\.claude\projects\<工程目录名>\memory\`；登记受理 | |

## 2. 配置文件

| # | 情况 | 期望 | 结果 |
|---|---|---|---|
| 2a | 第一次启动后 | 生成 `%USERPROFILE%\.claude\autohandoff.md`（设了 `CLAUDE_CONFIG_DIR` 时在那个目录），内容是带注释的全部默认值 | |
| 2b | `AUTOHANDOFF_CONFIG=C:/Users/<你>/ah-test.md`（正斜杠） | 读写这个文件；`/autohandoff status` 的 Configuration 行显示它 | |
| 2c | `AUTOHANDOFF_CONFIG=C:\Users\<你>\ah-test.md`（反斜杠） | 同上 | |
| 2d | `AUTOHANDOFF_CONFIG=ah-test.md`（相对路径） | 被忽略，status 里报一行「is not an absolute path; it is ignored」 | |
| 2e | 在 **Git Bash** 里启动 claude，且 `CLAUDE_CONFIG_DIR=/c/Users/<你>/.claude-test`（MSYS 形态） | 看配置文件写到了哪里、记忆目录里的交接文件能不能登记（MSYS 形态可能 stat 失败，记忆目录白名单就失效） | |
| 2f | 在 Git Bash 里启动、不设 `CLAUDE_CONFIG_DIR`（HOME 是 `/c/Users/<你>`） | 配置仍在 `%USERPROFILE%\.claude\autohandoff.md`（取 USERPROFILE） | |
| 2g | `%USERPROFILE%\.claude\autohandoff.toml` 或 `autohandoff-state\` 还在（v3 残留） | 没有任何提示；旧文件原样不动 | |
| 2h | 在 Git Bash 里设 `AUTOHANDOFF_CONFIG=/c/Users/<你>/ah-test.md`（MSYS 形态） | 它以 `/` 开头，会被当成绝对路径；记下实际读写的位置（可能落到 `C:\c\Users\…`），以及 status 的 Configuration 行 | |
| 2i | 配置文件用**记事本**改过保存（CRLF 换行；分别试 UTF-8 带 BOM、ANSI 编码） | status 里没有解析问题，改过的阈值生效；ANSI 下中文注释乱码可以接受，但设置要能读 | |
| 2j | **用户名含非 ASCII 字符**（中文或日文用户名）的用户目录 | 配置文件正常生成和读取；记忆目录里的交接文件能登记 | |

## 3. 主路径

| # | 情况 | 期望 | 结果 |
|---|---|---|---|
| 3a | clear 主路径：越过阈值 → 模型写交接、登记 → 回合结束 | 状态行「handoff registered; /clear when this turn ends」→ 自动 /clear → 新对话出现「Prompt from the autohandoff plugin」的续接消息，模型读交接文件接着做 | |
| 3b | compact 主路径（配置 `action: compact`） | 自动 `/compact <focus>`，压缩完续接一次 | |
| 3c | compact_at 兜底（把 compact_at 压到比当前用量低一点，模型不交接） | 回合结束后 toast「compacting the conversation」并自动压缩 | |
| 3d | 有后台子代理在跑时交接 | 不等它；clear 后它的汇报进入新对话，新对话按交接文件处理 | |

## 4. 否决与作废

| # | 情况 | 期望 | 结果 |
|---|---|---|---|
| 4a | 登记后、回合结束前按 **Esc** | 静默作废：没有 toast，不 clear；debug log `handoff cancelled: the turn was interrupted` | |
| 4b | 回合结束、`/clear` 刚排队时按 Esc（可以让模型登记后再跑一条较长的命令，在它结束的瞬间按） | 静默作废。**重点看** debug log 里 `/clear (request N) was rejected: <错误文字>`：错误文字要含 "the session was stopped" 或 "removed from the queue"，否则会被当成「重置失败」toast 并告诉模型 | |
| 4c | 登记后模型调了一个要批准的工具，在**权限框里选 No** | 静默作废（回合没有 Stop）；debug log `the turn ended without a Stop event (a tool call was rejected)` | |
| 4d | 登记后、回合结束前发一条新消息 | 作废，toast「handoff cancelled (a new message from the user arrived)」，模型在这条消息里收到作废说明 | |

## 5. 进程与热重载

| # | 情况 | 期望 | 结果 |
|---|---|---|---|
| 5a | 登记后（回合还在跑）**关掉 Windows Terminal 的标签页或窗口**，再 `claude --resume` 回到这个对话 | 记下 debug log 里 `session.end` 的 reason（正常退出应走「会话结束」作废，debug `handoff cancelled: the session ended (...)`） | |
| 5b | `/compact`（action: compact）排队或正在跑时，用**任务管理器结束 claude 进程**，再 `claude --resume <sid>` | toast「handoff cancelled (AutoHandoff was restarted or reloaded before the reset)」；没有「already queued」的 toast；之后自己 `/clear` 是普通 clear | |
| 5c | `/compact` 正在跑时改一下插件目录里 `hooks\register.ts`（加一行注释）触发热重载 | 不作废；压缩完由新模块续接**恰好一次** | |
| 5d | 重置**已排队**（action: compact，`/compact` 正在跑）时关掉标签页或窗口，再 `claude --resume` | 与 5a（登记中）对照：记下走的是 session.end 作废，还是被当成进程重启（toast「AutoHandoff was restarted or reloaded before the reset」）；两者都不应续接两次 | |
| 5e | **v3 → v4 升级**：在装着 v3 的机器上不用 `--plugin-dir`，先把 v3 会话手上的交接做完或 `/autohandoff off` 并关掉所有会话，再按 README 的 Upgrading from version 3 操作：先 `claude plugin uninstall autohandoff@autohandoff` + `claude plugin marketplace remove autohandoff` 卸掉 v3（v3 仓库 `D:\Claude\AutoHandoff` 可留着不删），再 add/install 本仓库（`claude plugin list` 没有 `Read from:` 行时用 `claude plugin marketplace update autohandoff` + `claude plugin update autohandoff@autohandoff`），然后开新会话 | v3 的 PowerShell 敲键 hook 不再触发；`/plugin` 显示 `1 mod active · autohandoff` | |

## 6. 回报

把每项的「结果」列填上（通过/失败 + 现象），附 debug log 里 `[autohandoff]` 的相关行。1a/1b/1c 任何一项失败都先停下来回报，后面的路径相关项多半会一起失败。
