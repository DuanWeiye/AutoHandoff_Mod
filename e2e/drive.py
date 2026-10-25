#!/usr/bin/env python3
"""AutoHandoff 4 的端到端驱动：在 mod_setup.sh 起的隔离 tmux 里开真实的 Claude Code 会话，
像人一样往里打字/按键，然后读三样东西判定结果：
  - mod 的审计行：debug log 里 `[autohandoff] $.ui.log (to debug): …`（以及给用户看的 `$.ui.log: …`）
  - 测试 settings 里只写日志的 hook：每个会话的 <名字>.hooks.jsonl（SessionStart/SessionEnd/UserPromptSubmit/Stop 的 stdin）
  - transcript（hook 给出的 transcript_path）：续接消息的 origin、SessionStart 附加的上下文、模型读没读交接文件

用法：
  drive.py <工作目录> [场景…] [--repeat N] [--keep]
  drive.py <工作目录> --cleanup-only        （--keep 跑过之后清理）
场景：clear draft dialog deny interject notify cmp slash print
      compact fallback ctype agentdialog reload restart esc apierr subreg urge userclear chain（缺省全跑；--repeat N 每个场景跑 N 次并统计）
同一个仓库（worktree）同时只跑一组 drive.py：store 文件被同一插件目录的所有 --plugin-dir 会话共用，清理时要改它。
清理时发现别的 --plugin-dir 会话还在跑、或这次运行期间有别的会话写过记录，就跳过 store 这一步并打印出来。
工作目录要先 `mod_setup.sh init <工作目录>`，且测试工程已接受过 workspace trust（首次 start 时本脚本会自动选 Yes）。
结束时 kill 测试用 tmux server，并清掉本次测试留下的东西（--keep 时全部保留，之后用 --cleanup-only 清）：
  - ~/.claude/projects/<测试工程目录名>/（按测试工程的绝对路径精确拼出，且必须与 transcript 所在目录一致）
  - 测试会话的 sid 名下的 ~/.claude/session-env、file-history、ctx、security 条目
  - ~/.claude/plugins/store/autohandoff_inline-*.json 里只属于测试 sid 的记录
  - 工作目录（有 init 写的标记文件才删）
~/.claude.json 里测试工程的 workspace trust 条目不动（结束时打印出来）。
只发测试工程里的无害命令（ls/python3/touch，建文件用 Write 工具），不改全局设置。
隔离的是插件与 settings，不是用户级指令：测试会话照样加载 ~/.claude/CLAUDE.md（用 CLAUDE_CONFIG_DIR 隔离会丢掉登录）。
靠模型服从度的场景（chain、urge、interject 等）结果会受它影响，换一台机器可能不同；断言尽量查审计行和 transcript 结构。
跑 e2e 期间不要改 hooks/：--plugin-dir 指向的目录一改，测试会话就热重载。
"""
import json
import os
import re
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
SETUP = os.path.join(HERE, "mod_setup.sh")
SOCK = os.environ.get("SOCK", "ahmod")
TOOL = "mcp__autohandoff__register_handoff"
CC = os.path.join(os.path.expanduser("~"), ".claude")
MARKER = ".ah-e2e-work"
SID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
# 测试会话所在 pane 的进程号：清理前等它们都退出（Claude Code 收到 SIGHUP 后还会往 transcript 补写几行）
PANE_PIDS = []
QUEUED_TOAST = "AutoHandoff: the reset is already queued and cannot be withdrawn; the conversation will continue from the handoff file."


def tmux(*args, check=True):
    return subprocess.run(["tmux", "-L", SOCK, *args], capture_output=True, text=True, check=check).stdout


class Session:
    def __init__(self, work, name, extra=(), config=None, plugin=None, ah_env=None):
        self.work, self.name = work, name
        self.debug = os.path.join(work, "logs", f"{name}.debug.log")
        self.hooklog = os.path.join(work, "logs", f"{name}.hooks.jsonl")
        for p in (self.debug, self.hooklog):
            if os.path.exists(p):
                os.remove(p)
        env = None
        if config or plugin or ah_env:
            env = dict(os.environ)
            if config:
                env["AH_CONFIG"] = config
            if plugin:
                env["PLUGIN_DIR"] = plugin
            if ah_env:
                env["AH_ENV"] = ah_env
        subprocess.run([SETUP, "start", work, name, *extra], check=True, capture_output=True, env=env)
        self.target = f"T:{name}"
        pid = tmux("display-message", "-p", "-t", self.target, "#{pane_pid}", check=False).strip()
        if pid.isdigit():
            PANE_PIDS.append(int(pid))
        self._ready()

    # ── 键盘 ──
    def type(self, text):
        tmux("send-keys", "-t", self.target, "-l", text)

    def keys(self, *k):
        tmux("send-keys", "-t", self.target, *k)

    def send(self, text):
        self.type(text)
        time.sleep(0.4)
        self.keys("Enter")

    def pane(self, history=0):
        return tmux("capture-pane", "-p", "-t", self.target, *(["-S", str(-history)] if history else []), check=False)

    def close(self):
        tmux("kill-window", "-t", self.target, check=False)

    def _ready(self):
        # 首次进测试工程会问 workspace trust（默认选中的是 No）：选 Yes
        t0 = time.time()
        while time.time() - t0 < 60:
            p = self.pane()
            if "Yes, I trust this folder" in p:
                self.keys("Down")
                time.sleep(0.3)
                self.keys("Enter")
            elif "manual mode" in p or "? for shortcuts" in p or re.search(r"^❯ ", p, re.M):
                if self.sids():
                    time.sleep(1.5)
                    return
            time.sleep(1)
        raise RuntimeError(f"{self.name}: session did not come up:\n{self.pane()}")

    # ── 观测 ──
    def hooks(self):
        out = []
        if os.path.exists(self.hooklog):
            for line in open(self.hooklog, encoding="utf-8"):
                try:
                    out.append(json.loads(line))
                except ValueError:
                    pass
        return out

    def sids(self):
        """按出现顺序的 session id（SessionStart 的）"""
        seen = []
        for h in self.hooks():
            if h.get("hook_event_name") == "SessionStart" and h["session_id"] not in seen:
                seen.append(h["session_id"])
        return seen

    def transcript(self, sid):
        for h in self.hooks():
            if h.get("session_id") == sid and h.get("transcript_path"):
                return h["transcript_path"]
        return None

    def entries(self, sid):
        p = self.transcript(sid)
        out = []
        if p and os.path.exists(p):
            for line in open(p, encoding="utf-8"):
                try:
                    out.append(json.loads(line))
                except ValueError:
                    pass
        return out

    def audit(self):
        """mod 写的 debug 审计行（多行内容的行在 debug log 里被整体 JSON 引号括起）"""
        out = []
        if not os.path.exists(self.debug):
            return out
        for line in open(self.debug, encoding="utf-8", errors="replace"):
            line = line.rstrip("\n")
            m = re.search(r'\[autohandoff\] \$\.ui\.log \(to debug\): (.*)$', line)
            if m:
                out.append(m.group(1).rstrip('"'))
        return out

    def shown(self):
        """mod 给用户看的 transcript 行（ui.log 非 debug）与 toast"""
        out = []
        if not os.path.exists(self.debug):
            return out
        for line in open(self.debug, encoding="utf-8", errors="replace"):
            m = re.search(r'\[autohandoff\] \$\.ui\.log: (.*)$', line) or re.search(r'\$\.ui\.toast \(autohandoff\): (.*)$', line)
            if m:
                out.append(m.group(1).rstrip('"'))
        return out

    def has(self, text):
        return any(text in a for a in self.audit())

    def count(self, prefix):
        return sum(1 for a in self.audit() if a.startswith(prefix))

    def claude_pid(self):
        """pane 里 claude 进程的 pid：pane 进程本身（sh -c 直接 exec 时）或它的子进程里 argv[0] 是 claude 的那个"""
        pid = tmux("display-message", "-p", "-t", self.target, "#{pane_pid}", check=False).strip()
        if not pid.isdigit():
            return None

        def is_claude(p):
            try:
                argv0 = open(f"/proc/{p}/cmdline", "rb").read().split(b"\0")[0].decode(errors="replace")
            except OSError:
                return False
            return os.path.basename(argv0) == "claude" or "/claude/versions/" in argv0

        if is_claude(pid):
            return int(pid)
        for child in subprocess.run(["pgrep", "-P", pid], capture_output=True, text=True).stdout.split():
            if is_claude(child):
                return int(child)
        return None

    def stops(self, sid=None):
        return [h for h in self.hooks() if h.get("hook_event_name") == "Stop" and (sid is None or h["session_id"] == sid)]

    def working(self):
        return "esc to interrupt" in self.pane()

    def wait(self, cond, timeout, what):
        t0 = time.time()
        while time.time() - t0 < timeout:
            if cond():
                return True
            time.sleep(1)
        raise TimeoutError(f"{self.name}: timed out after {timeout}s waiting for {what}\n--- audit ---\n" + "\n".join(self.audit()[-15:]) + "\n--- pane ---\n" + self.pane())

    def wait_idle(self, timeout=240, settle=4):
        """不在跑回合，且持续 settle 秒"""
        t0 = time.time()
        quiet = None
        while time.time() - t0 < timeout:
            if self.working():
                quiet = None
            elif quiet is None:
                quiet = time.time()
            elif time.time() - quiet >= settle:
                return
            time.sleep(1)
        raise TimeoutError(f"{self.name}: still working after {timeout}s\n" + self.pane())


class Check:
    def __init__(self, name):
        self.name, self.items, self.notes = name, [], []

    def ok(self, cond, what):
        self.items.append((bool(cond), what))
        return bool(cond)

    def note(self, text):
        self.notes.append(text)

    @property
    def passed(self):
        return all(c for c, _ in self.items) and bool(self.items)

    def report(self):
        lines = [f"[{'PASS' if self.passed else 'FAIL'}] {self.name}"]
        lines += [f"    {'ok ' if c else 'NG '} {w}" for c, w in self.items]
        lines += [f"    note: {n}" for n in self.notes]
        return "\n".join(lines)


def proj(work):
    return os.path.join(work, "proj")


def reset_project(work):
    """每个场景前把测试工程恢复到初始提交（git 管着的文件复原，notes/ 等新文件删掉）。
    只在 init 建的测试工程里做：工作目录有标记文件，且 proj/.git 是它自己的仓库（不往上找到别的仓库）。"""
    if not (os.path.isfile(os.path.join(work, MARKER)) and os.path.isdir(os.path.join(proj(work), ".git"))):
        raise RuntimeError(f"{work} is not a test work dir made by `mod_setup.sh init` (no {MARKER} or proj/.git); refusing to git clean")
    subprocess.run(["git", "checkout", "-q", "--", "."], cwd=proj(work), check=True)
    subprocess.run(["git", "clean", "-qfd"], cwd=proj(work), check=True)


def text_of(entry):
    m = entry.get("message") or {}
    c = m.get("content")
    if isinstance(c, str):
        return c
    if isinstance(c, list):
        return "\n".join(b.get("text", "") for b in c if isinstance(b, dict) and b.get("type") == "text")
    return ""


def resume_entries(entries):
    out = []
    for e in entries:
        o = e.get("origin") or {}
        if e.get("type") == "user" and o.get("kind") == "plugin" and o.get("name") == "autohandoff":
            if text_of(e).startswith("[AutoHandoff: resume]"):
                out.append(e)
    return out


def resume_entry(entries):
    r = resume_entries(entries)
    return r[0] if r else None


def assistant_text(entries):
    return "\n".join(text_of(e) for e in entries if e.get("type") == "assistant")


def attachments(entries, needle):
    return [e for e in entries if e.get("type") == "attachment" and needle in json.dumps(e.get("attachment", e), ensure_ascii=False)]


def read_handoff(entries, handover):
    """新对话的模型读了交接文件（Read 工具或 cat）"""
    name = os.path.basename(handover)
    for e in entries:
        content = (e.get("message") or {}).get("content")
        if not isinstance(content, list):
            continue
        for b in content:
            if isinstance(b, dict) and b.get("type") == "tool_use" and name in json.dumps(b.get("input", {})):
                return True
    return False


# ───────────────────────── 场景 ─────────────────────────

CLEAR_TASK = (
    "Task, in order: (1) Read data/catalog.md in full with the Read tool; it is background for this task and does not "
    "need to be read again later. (2) Create notes/a.txt containing the word alpha. (3) Create notes/b.txt containing "
    "beta. (4) Create notes/c.txt containing gamma. Create each file with its own Write tool call. "
    "(5) Run `ls notes` with the Bash tool and reply with its output."
)


def scenario_clear(work, tag="clear", draft=None):
    """场景 1（draft 时为场景 3）：越过 remind → 写交接 → 登记 → 回合结束 → /clear → 续接 → 新对话接着做完"""
    reset_project(work)
    c = Check(f"{tag}: remind → handoff → /clear → resume" + (" (draft kept)" if draft else ""))
    s = Session(work, tag)
    handover = os.path.realpath(os.path.join(proj(work), "docs", "HANDOVER.md"))
    try:
        old = s.sids()[0]
        s.send(CLEAR_TASK)
        s.wait(lambda: s.has("remind sent at"), 180, "the remind")
        if draft:
            # 回合还在跑：在输入框里留一段草稿（不回车）
            time.sleep(2)
            s.type(draft)
        s.wait(lambda: s.has("handoff finished") or s.has("handoff cancelled"), 300, "the reset and resume")
        s.wait(lambda: len(s.sids()) >= 2 and s.stops(s.sids()[-1]), 300, "the resumed turn to end")
        s.wait_idle()
        new = s.sids()[1] if len(s.sids()) > 1 else None
        a = s.audit()
        c.ok(any(x.startswith("remind sent at") for x in a), "remind sent once usage passed remind_at")
        c.ok(f"handoff registered: {handover}" in "\n".join(a), f"handoff registered ({handover})")
        n_clear = sum(1 for x in a if re.match(r"turn ended; running /clear \(request \d+\)", x))
        c.ok(n_clear == 1, f"turn ended → /clear queued exactly once ({n_clear})")
        c.ok(len(s.sids()) == 2, f"exactly two sessions ({len(s.sids())})")
        c.ok(any(x == f"record moved from session {old} to {new} after /clear" for x in a), "record moved to the new session id")
        c.ok("handoff finished: resumed" in a, "resume message submitted")
        c.ok(not any(x.startswith("handoff cancelled") for x in a), "nothing cancelled")
        ends = [h for h in s.hooks() if h.get("hook_event_name") == "SessionEnd"]
        c.ok(any(h.get("reason") == "clear" and h["session_id"] == old for h in ends), "SessionEnd(clear) for the old session")
        starts = [h for h in s.hooks() if h.get("hook_event_name") == "SessionStart" and h["session_id"] == new]
        c.ok(any(h.get("source") == "clear" for h in starts), "SessionStart(clear) for the new session")
        ent = s.entries(new) if new else []
        r = resume_entry(ent)
        c.ok(len(resume_entries(ent)) == 1, f"exactly one resume message in the new transcript ({len(resume_entries(ent))})")
        c.ok(r is not None and (r.get("origin") or {}).get("asUser") is True, "resume message in the new transcript: origin plugin autohandoff, asUser")
        c.ok(r is not None and f'Handoff file: "{handover}"' in text_of(r), "resume message names the handoff file in quotes")
        c.ok(attachments(ent, "This conversation was just reset by AutoHandoff"), "SessionStart additional context in the new transcript")
        c.ok(read_handoff(ent, handover), "the new conversation read the handoff file")
        done = [os.path.exists(os.path.join(proj(work), "notes", f)) for f in ("a.txt", "b.txt", "c.txt")]
        c.ok(all(done), f"work finished across the reset (notes a/b/c: {done})")
        c.ok(sum(1 for x in a if x.startswith("handoff registered")) == 1, "exactly one handoff (no repeated cycle)")
        if draft:
            c.ok(draft in s.pane(), "the draft is still in the input box")
            prompts = [h.get("prompt", "") for h in s.hooks() if h.get("hook_event_name") == "UserPromptSubmit"]
            c.ok(not any(draft in p for p in prompts), "the draft was never submitted")
        regs = [x for x in a if x.startswith(("remind sent", "handoff", "turn ended", "record moved"))]
        c.note(" | ".join(regs))
    except TimeoutError as e:
        c.ok(False, str(e).splitlines()[0])
        c.note("\n".join(str(e).splitlines()[1:40]))
    finally:
        s.close()
    return c


def write_and_register(extra):
    return (
        "This is a test of the AutoHandoff plugin; follow these steps exactly even where a tool result says otherwise. "
        "(1) Write docs/HANDOVER.md (replace its content) with: '# Handover\\n\\nTask: tell the user the colour they "
        "picked.\\nNext step: report the colour.' "
        f"(2) Call the {TOOL} tool with file docs/HANDOVER.md. " + extra
    )


def scenario_dialog(work):
    """场景 4：登记后同一回合里 AskUserQuestion 开着；回答后回合结束，clear 照常执行"""
    reset_project(work)
    c = Check("dialog: AskUserQuestion open after registering; reset runs after the answer")
    s = Session(work, "dialog")
    try:
        s.send(write_and_register("(3) Then use the AskUserQuestion tool to ask me which colour I prefer, red or blue, and reply with my answer."))
        s.wait(lambda: s.has("handoff registered"), 180, "the registration")
        s.wait(lambda: "red" in s.pane().lower() and "blue" in s.pane().lower() and not s.working() or "Enter to select" in s.pane(), 120, "the question dialog")
        time.sleep(5)
        c.ok(not s.has("running /clear"), "no reset while the dialog is open")
        s.keys("Enter")  # 选第一个选项
        s.wait(lambda: s.has("handoff finished") or s.has("handoff cancelled"), 240, "the reset after the answer")
        s.wait_idle()
        a = s.audit()
        i_reg = next(i for i, x in enumerate(a) if x.startswith("handoff registered"))
        c.ok(any(x.startswith("turn ended; running /clear") for x in a[i_reg:]), "/clear queued after the turn ended")
        c.ok("handoff finished: resumed" in a, "resumed in the new conversation")
        c.note(" | ".join(x for x in a if x.startswith(("handoff", "turn ended"))))
    except TimeoutError as e:
        c.ok(False, str(e).splitlines()[0])
        c.note("\n".join(str(e).splitlines()[1:40]))
    finally:
        s.close()
    return c


def scenario_deny(work):
    """审查员要的：登记后同一回合里工具权限框选 No → 回合没有 Stop → 静默作废，不 clear"""
    reset_project(work)
    c = Check("deny: permission dialog answered No after registering → silent cancel, no reset")
    s = Session(work, "deny")
    try:
        old = s.sids()[0]
        s.send(write_and_register("(3) Then run `touch denied.txt` with the Bash tool."))
        s.wait(lambda: s.has("handoff registered"), 180, "the registration")
        s.wait(lambda: "touch denied.txt" in s.pane() and ("Do you want" in s.pane() or "No" in s.pane()), 120, "the permission dialog")
        # 选 "No"（选项文字因版本而异：按编号选最后一项）。选项可能晚一点才画出来：等几秒；实在找不到就按 Esc
        # （Esc 是中断，走的是「回合被中断」的静默作废，也不该 clear）
        nums = []
        for _ in range(10):
            time.sleep(1)
            nums = re.findall(r"(\d)\. No", s.pane())
            if nums:
                break
        s.keys(nums[-1] if nums else "Escape")
        time.sleep(1)
        if "Do you want" in s.pane():
            s.keys("Enter")
        s.wait(lambda: s.has("handoff cancelled") or s.has("running /clear"), 120, "the turn to end")
        s.wait_idle()
        time.sleep(5)
        a = s.audit()
        want = "handoff cancelled: the turn ended without a Stop event (a tool call was rejected)" if nums else "handoff cancelled: the turn was interrupted"
        c.ok(want in a, f"cancelled silently: {want[len('handoff cancelled: '):]}" + ("" if nums else " (the No option was not found; Esc pressed)"))
        c.ok(not any(x.startswith("turn ended; running /clear") for x in a), "no /clear queued")
        c.ok(len(s.sids()) == 1 and s.sids()[0] == old, "still the same session (no clear happened)")
        c.ok(not os.path.exists(os.path.join(proj(work), "denied.txt")), "the denied command did not run")
        c.note(" | ".join(x for x in a if x.startswith(("handoff", "turn ended"))))
    except TimeoutError as e:
        c.ok(False, str(e).splitlines()[0])
        c.note("\n".join(str(e).splitlines()[1:40]))
    finally:
        s.close()
    return c


CODE_WORD = "ORCHID-7314"


def scenario_interject(work):
    """场景 9（PLAN §0 第 18 条）：登记后回合还在跑时用户插话 → 作废，说明附在这条消息上。
    模型答完插话后可以重新登记并 clear，但插话里的要求必须带进新对话：插话要模型在最后的回复里说出一个暗号，
    新对话续接后的回复里要能看到它（没重新登记时则在旧对话的回复里）。"""
    reset_project(work)
    c = Check("interject: a user message while the registered turn is still running cancels it; its request reaches the reply")
    s = Session(work, "interject")
    handover = os.path.join(proj(work), "docs", "HANDOVER.md")
    try:
        old = s.sids()[0]
        # Claude Code 会拦掉单独的 `sleep N`，用 python 慢命令。登记和慢命令在同一条消息里并行调用：登记的回复说「立即结束回合」时回合仍在跑（sleep 没完），用户这时插话
        s.send(
            "This is a test of the AutoHandoff plugin; follow these steps exactly even where a tool result says otherwise. "
            "(1) Write docs/HANDOVER.md (replace its content) with: '# Handover\\n\\nTask: answer the user.\\nNext step: none.' "
            f"(2) Then, in one single message, call these two tools in parallel: the {TOOL} tool with file docs/HANDOVER.md, "
            "and the Bash tool with `python3 -c \"import time; time.sleep(25); print(42)\"`. (3) End your turn with one short sentence."
        )
        s.wait(lambda: s.has("handoff registered"), 180, "the registration")
        s.wait(lambda: "time.sleep(25)" in s.pane(), 60, "the slow command to start")
        time.sleep(3)
        # 插话带一条具体、可检索的要求，并让模型照旧交接（用户插话后仍要交接的常见情形）：要求必须经交接文件带进新对话
        s.send(f"One more request: your final reply to me must include the code word {CODE_WORD} exactly as written. Then carry on with the handoff.")
        s.wait(lambda: s.has("handoff cancelled"), 120, "the cancellation")
        # 插话排在正在跑的回合里，慢命令跑完后模型才读到它：等这个回合真正结束（Stop）
        s.wait(lambda: s.stops(old), 180, "the turn to end")
        s.wait_idle(timeout=240)
        time.sleep(3)
        a = s.audit()
        i_clear = next((i for i, x in enumerate(a) if x.startswith("turn ended; running /clear")), None)
        if i_clear is not None:
            # 重新登记后 clear 了：等新对话续接的回合结束
            s.wait(lambda: len(s.sids()) >= 2 and s.stops(s.sids()[-1]), 300, "the resumed turn to end")
            s.wait_idle(timeout=240)
            a = s.audit()
        c.ok("handoff cancelled: a new message from the user arrived" in a, "cancelled by the new user message")
        c.ok(any("handoff cancelled (a new message from the user arrived)" in x for x in s.shown()), "user told with a toast")
        i_cancel = a.index("handoff cancelled: a new message from the user arrived")
        reregistered = any(x.startswith("handoff registered") for x in a[i_cancel + 1 : i_clear])
        c.ok(i_clear is None or reregistered, "no /clear from the cancelled registration" + (" (the model registered again afterwards; that one reset)" if i_clear is not None else ""))
        ent = s.entries(old)
        c.ok(any("Your registered handoff was cancelled (a new message from the user arrived)" in json.dumps(e, ensure_ascii=False) for e in ent),
             "the model got the cancellation note with that message")
        if i_clear is None:
            c.ok(len(s.sids()) == 1 and s.sids()[0] == old, "still the same session")
            c.ok(CODE_WORD in assistant_text(ent), f"the reply in the same conversation carries the interjected request ({CODE_WORD})")
        else:
            sids = s.sids()
            # 旧对话只重置一次，新对话不得自己再交接（连环交接，PLAN §0 第 22 条）：恰好两个 sid、恰好一次 /clear
            n_clear = s.count("turn ended; running /clear")
            c.ok(n_clear == 1, f"reset exactly once ({n_clear})")
            c.ok(len(sids) == 2, f"exactly two sessions, no chained handoff ({len(sids)})")
            refused = [x for x in a if x.startswith("registration refused: this conversation has just been continued")]
            if refused:
                c.note(f"the resumed conversation tried to hand off again and was refused ({len(refused)}x)")
            c.ok(CODE_WORD in open(handover, encoding="utf-8").read(), f"the handoff file was updated with the interjected request ({CODE_WORD})")
            new_ent = s.entries(sids[1])
            c.ok(len(resume_entries(new_ent)) == 1, "the new conversation was resumed once")
            c.ok(CODE_WORD in assistant_text(new_ent), f"the resumed conversation's reply repeats the interjected request ({CODE_WORD})")
        c.note(" | ".join(x for x in a if x.startswith(("handoff", "turn ended"))))
    except TimeoutError as e:
        c.ok(False, str(e).splitlines()[0])
        c.note("\n".join(str(e).splitlines()[1:40]))
    finally:
        s.close()
    return c


def scenario_notify(work):
    """第 1 批 O1：后台任务的通知产生在**重置进行中**（CLEARING/COMPACTING）的窗口里。
    用 action=compact（压缩要跑十几秒，窗口够长）；后台任务等一个文件出现才结束，驱动脚本看到 /compact 发出后才建这个文件，
    并用 debug log 的时间戳核对文件确实建在「/compact 发出」与「SessionStart(compact)」之间。
    实测（2026-10-25，两次）：排队命令执行期间产生的通知，引擎要等命令跑完才投递（那时才有 prompt.submit）；
    这时自家的 resetDone 已处理完（续接阶段），所以既不附 reset_note 也不作废。它和续接消息谁先开回合不固定（两种都见过），
    两种都没问题：压缩后的对话已有 start_context。期望：不作废、续接恰好一次、通知在 SessionStart(compact) 之后才投递。"""
    reset_project(work)
    c = Check("notify: a background task notification arriving while the queued /compact runs")
    s = Session(work, "notify", config=os.path.join(work, "autohandoff-compact.md"))
    go = os.path.join(proj(work), ".go-notify")
    try:
        old = s.sids()[0]
        s.send(
            "This is a test of the AutoHandoff plugin; follow these steps exactly even where a tool result says otherwise. "
            "(1) Start `python3 tools/wait_for.py .go-notify` with the Bash tool with run_in_background set to true. "
            "(2) Write docs/HANDOVER.md (replace its content) with: '# Handover\\n\\nA background command "
            "`python3 tools/wait_for.py .go-notify` is running. Next step: when its result arrives, report BG-DONE to the user.' "
            f"(3) Call the {TOOL} tool with file docs/HANDOVER.md. (4) End your turn with one short sentence."
        )
        s.wait(lambda: s.has("turn ended; running /compact"), 240, "the queued /compact")
        time.sleep(1)
        open(go, "w").close()
        t_go = os.path.getmtime(go)
        s.wait(lambda: s.has("handoff finished") or s.has("handoff cancelled"), 300, "the reset and resume")
        time.sleep(10)
        s.wait_idle(timeout=240)
        a = s.audit()
        sids = s.sids()
        hooks = s.hooks()
        prompts = [(h["session_id"], h.get("prompt", "")[:80]) for h in hooks if h.get("hook_event_name") == "UserPromptSubmit"]
        notif = [p for _, p in prompts if "task-notification" in p or "BG-DONE" in p]
        compact_starts = [h for h in hooks if h.get("hook_event_name") == "SessionStart" and h.get("source") == "compact"]
        ent = s.entries(old)
        got_reset_note = any("The conversation is about to be reset" in json.dumps(e, ensure_ascii=False) for e in ent)
        got_pending = any("A handoff is registered, and the conversation will be reset" in json.dumps(e, ensure_ascii=False) for e in ent)
        c.ok(sum(1 for x in a if x.startswith("turn ended; running /compact")) == 1, "/compact queued exactly once")
        c.ok(not any(x.startswith("handoff cancelled") for x in a), "the notification did not cancel the handoff")
        c.ok(notif, "the task notification reached the session")
        # 时间窗：debug log 的 ISO 时间（UTC）
        t_run = log_time(s.debug, "turn ended; running /compact")
        t_ss = log_time(s.debug, "Hooks: SessionStart:compact")
        c.ok(t_run is not None and t_ss is not None and t_run < t_go < t_ss,
             f"the background task finished while the compaction ran ({fmt_t(t_run)} < {fmt_t(t_go)} < {fmt_t(t_ss)})")
        seq = [(h.get("hook_event_name"), h.get("source", ""), h.get("prompt", "")[:20]) for h in hooks if h.get("hook_event_name") in ("SessionStart", "UserPromptSubmit")]
        i_ss = next((i for i, x in enumerate(seq) if x[:2] == ("SessionStart", "compact")), None)
        i_notif = next((i for i, x in enumerate(seq) if "task-notif" in x[2]), None)
        i_resume = next((i for i, x in enumerate(seq) if x[2].startswith("[AutoHandoff: resu")), None)
        c.ok(i_ss is not None and i_notif is not None and i_ss < i_notif, "the notification was delivered only after the compaction finished")
        c.note(f"delivered {'before' if i_notif is not None and i_resume is not None and i_notif < i_resume else 'after'} the resume message")
        c.ok(len(sids) == 1, f"compact keeps the session id (sessions: {len(sids)})")
        c.ok(len(compact_starts) == 1, f"one SessionStart(compact) ({len(compact_starts)})")
        c.ok(len(resume_entries(ent)) == 1, "resumed once after the compaction")
        c.ok(any(x.startswith("handoff finished") for x in a), "the handoff finished")
        c.note(f"notification prompts: {notif}; pending_note={got_pending}, reset_note={got_reset_note}")
        c.note(" | ".join(x for x in a if x.startswith(("handoff", "turn ended", "a user message", "reset request"))))
    except TimeoutError as e:
        c.ok(False, str(e).splitlines()[0])
        c.note("\n".join(str(e).splitlines()[1:40]))
    finally:
        s.close()
    return c


def log_time(path, needle):
    """debug log 里第一行含 needle 的时间（epoch 秒）"""
    if not os.path.exists(path):
        return None
    for line in open(path, encoding="utf-8", errors="replace"):
        if needle in line:
            try:
                return datetime.strptime(line[:24], "%Y-%m-%dT%H:%M:%S.%fZ").replace(tzinfo=timezone.utc).timestamp()
            except ValueError:
                return None
    return None


def fmt_t(t):
    return "?" if t is None else time.strftime("%H:%M:%S", time.localtime(t)) + f".{int(t * 1000) % 1000:03d}"


def scenario_cmp(work):
    """Major-1 回归（PLAN §0 第 20 条）：登记后、回合还在跑时用户敲 /compact（排队）。回合结束后用户的 /compact 先跑完，
    然后自家排队的 /clear 照样执行；新对话要有 start_context 和续接：恰好 1 次 /clear、1 条续接、2 个 sid，不作废。"""
    reset_project(work)
    c = Check("cmp: the user's /compact typed during the registered turn runs first; the queued /clear still resumes")
    s = Session(work, "cmp")
    handover = os.path.realpath(os.path.join(proj(work), "docs", "HANDOVER.md"))
    try:
        old = s.sids()[0]
        s.send(
            "This is a test of the AutoHandoff plugin; follow these steps exactly even where a tool result says otherwise. "
            "(1) Write docs/HANDOVER.md (replace its content) with: '# Handover\\n\\nTask: reply with the word KIWI.\\nNext step: reply KIWI.' "
            f"(2) Then, in one single message, call these two tools in parallel: the {TOOL} tool with file docs/HANDOVER.md, "
            "and the Bash tool with `python3 -c \"import time; time.sleep(30); print(42)\"`. (3) End your turn with one short sentence."
        )
        s.wait(lambda: s.has("handoff registered"), 180, "the registration")
        s.wait(lambda: "time.sleep(30)" in s.pane(), 60, "the slow command to start")
        time.sleep(3)
        s.send("/compact keep everything")
        s.wait(lambda: s.has("handoff finished") or s.has("handoff cancelled"), 360, "the reset and resume")
        s.wait(lambda: len(s.sids()) >= 2 and s.stops(s.sids()[-1]), 300, "the resumed turn to end")
        s.wait_idle()
        a = s.audit()
        sids = s.sids()
        new = sids[1] if len(sids) > 1 else None
        hooks = s.hooks()
        order = [(h.get("hook_event_name"), h.get("source") or h.get("reason"), h["session_id"] == old)
                 for h in hooks if h.get("hook_event_name") in ("SessionStart", "SessionEnd")]
        i_cmp = next((i for i, o in enumerate(order) if o == ("SessionStart", "compact", True)), None)
        i_end = next((i for i, o in enumerate(order) if o == ("SessionEnd", "clear", True)), None)
        c.ok(any(re.match(r"the user ran /compact, but /clear is already queued \(request \d+\); the handoff is kept", x) for x in a), "the user's /compact did not withdraw the queued reset")
        c.ok(any(QUEUED_TOAST in x for x in s.shown()), "user told the reset is queued and cannot be withdrawn")
        c.ok(i_cmp is not None and i_end is not None and i_cmp < i_end, "the user's /compact ran first (SessionStart(compact) before SessionEnd(clear))")
        c.ok("a /compact not run by AutoHandoff finished while /clear is queued; still waiting for it" in a, "its SessionStart(compact) was not taken for the new conversation")
        n_clear = sum(1 for x in a if x.startswith("turn ended; running /clear"))
        c.ok(n_clear == 1, f"/clear queued exactly once ({n_clear})")
        c.ok(len(sids) == 2, f"exactly two sessions ({len(sids)})")
        c.ok(any(x == f"record moved from session {old} to {new} after /clear" for x in a), "record moved to the new session id")
        ent = s.entries(new) if new else []
        c.ok(len(resume_entries(ent)) == 1, f"exactly one resume message in the new transcript ({len(resume_entries(ent))})")
        c.ok(attachments(ent, "This conversation was just reset by AutoHandoff"), "start context in the new conversation")
        c.ok(read_handoff(ent, handover), "the new conversation read the handoff file")
        c.ok("handoff finished: resumed" in a, "resumed")
        c.ok(not any(x.startswith("handoff cancelled") for x in a), "nothing cancelled")
        c.note(f"session events: {order}")
        c.note(" | ".join(x for x in a if x.startswith(("handoff", "turn ended", "record moved", "the user ran", "a /compact", "a user message"))))
    except TimeoutError as e:
        c.ok(False, str(e).splitlines()[0])
        c.note("\n".join(str(e).splitlines()[1:40]))
    finally:
        s.close()
    return c


def scenario_slash(work):
    """场景 13：/autohandoff 各子命令被 mod 拦截：输出只在 transcript 的 ui.log 行，不开模型回合"""
    c = Check("slash: /autohandoff status|off|(toggle)|bad argument are answered by the mod, no model turn")
    s = Session(work, "slash")
    try:
        sid = s.sids()[0]
        for arg, expect in [
            ("status", "AutoHandoff is on for this conversation (default_on: true)."),
            ("off", "AutoHandoff is off for this conversation."),
            ("", "AutoHandoff is on for this conversation. Reminders at 52k"),
            ("sometimes", "Usage: /autohandoff [on|off|status] (no argument toggles)"),
        ]:
            n0 = len(s.shown())
            s.send(f"/autohandoff {arg}".rstrip())
            try:
                s.wait(lambda: len(s.shown()) > n0, 20, f"/autohandoff {arg} output")
            except TimeoutError:
                pass
            new = s.shown()[n0:]
            c.ok(any(x.startswith(expect) for x in new), f"/autohandoff {arg or '(no argument)'} → {expect[:60]}")
            time.sleep(1)
        pane = s.pane(history=200)
        c.ok("● autohandoff: AutoHandoff is off for this conversation." in pane, "shown in the transcript as an autohandoff line")
        c.ok(not s.stops(sid), "no model turn ran")
        c.ok(not any(e.get("type") == "assistant" for e in s.entries(sid)), "no assistant message in the transcript")
    except TimeoutError as e:
        c.ok(False, str(e).splitlines()[0])
    finally:
        s.close()
    return c


def scenario_print(work):
    """场景 14：claude -p 下 mod 加载但不工作（不注册工具、不提醒、不写配置）"""
    c = Check("print: claude -p keeps the mod silent")
    dbg = os.path.join(work, "logs", "print.debug.log")
    if os.path.exists(dbg):
        os.remove(dbg)
    # 和 tmux 一样用干净环境：从 Claude Code 会话里跑驱动时，父会话的 CLAUDECODE 等变量不能带进去
    env = {k: os.environ[k] for k in ("HOME", "PATH", "USER", "SHELL", "LANG", "TERM") if k in os.environ}
    env.update(AUTOHANDOFF_DISABLE="1", AUTOHANDOFF_CONFIG=os.path.join(work, "autohandoff.md"),
               AH_HOOKLOG=os.path.join(work, "logs", "print.hooks.jsonl"))
    r = subprocess.run(
        ["claude", "-p", "--plugin-dir", os.path.dirname(HERE), "--settings", os.path.join(work, "settings.json"),
         "--debug-file", dbg, "--model", "sonnet",
         "Read data/catalog.md with the Read tool, then run `ls src` with Bash, and reply with the number of SKU lines you saw."],
        cwd=proj(work), env=env, capture_output=True, text=True, timeout=300,
    )
    log = open(dbg, encoding="utf-8", errors="replace").read() if os.path.exists(dbg) else ""
    c.ok(r.returncode == 0, f"claude -p exited 0 (stdout: {r.stdout.strip()[:80]!r})")
    c.ok("hooks module autohandoff@inline loaded" in log, "the mod was loaded")
    c.ok("inactive: it does not work in non-interactive sessions" in log, "the mod reported itself inactive")
    c.ok("$.tool.register (autohandoff)" not in log, "no tool registered")
    c.ok("remind sent" not in log and "[autohandoff] $.ui.log:" not in log, "no reminder, no output")
    return c


# ───────────────────────── 第 3 批场景 ─────────────────────────

TEST_INTRO = "This is a test of the AutoHandoff plugin; follow these steps exactly even where a tool result says otherwise. "


def handoff_in_context(entries, handover):
    """压缩后的对话拿到了交接文件：模型自己读了，或压缩把最近读写过的它作为文件附件带了过来（实测会带）"""
    if read_handoff(entries, handover):
        return True
    return any(e.get("type") == "attachment" and (e.get("attachment") or {}).get("type") == "file"
               and (e.get("attachment") or {}).get("filename") == handover for e in entries)


def after_compact(entries):
    """transcript 里最后一次压缩之后的记录（压缩不换 sid，前后都在同一个文件里）"""
    idx = [i for i, e in enumerate(entries) if e.get("type") == "system" and e.get("subtype") == "compact_boundary"]
    return entries[idx[-1] + 1:] if idx else []


def hook_index(s, pred):
    for i, h in enumerate(s.hooks()):
        if pred(h):
            return i
    return None


def compact_starts(s):
    return [h for h in s.hooks() if h.get("hook_event_name") == "SessionStart" and h.get("source") == "compact"]


def stopped_after_compact(s):
    i = hook_index(s, lambda h: h.get("hook_event_name") == "SessionStart" and h.get("source") == "compact")
    return i is not None and any(h.get("hook_event_name") == "Stop" for h in s.hooks()[i + 1:])


def kiwi_task(extra=""):
    return (TEST_INTRO + "(1) Read data/catalog.md in full with the Read tool (it is background only). "
            "(2) Write docs/HANDOVER.md (replace its content) with: '# Handover\\n\\nTask: reply to the user with the word KIWI.\\n"
            "Next step: reply KIWI.' " + f"(3) Call the {TOOL} tool with file docs/HANDOVER.md. " + extra +
            "End your turn with one short sentence.")


def scenario_compact(work):
    """场景 2：action=compact 主路径。越过 remind → 写交接 → 登记 → 回合结束 → /compact <compact_focus> → 同一个 sid 续接 → 做完"""
    reset_project(work)
    c = Check("compact: remind → handoff → /compact → resume in the same session")
    s = Session(work, "compact", config=os.path.join(work, "autohandoff-compact.md"))
    handover = os.path.realpath(os.path.join(proj(work), "docs", "HANDOVER.md"))
    try:
        s.send(CLEAR_TASK)
        s.wait(lambda: s.has("remind sent at"), 180, "the remind")
        s.wait(lambda: s.has("handoff finished") or s.has("handoff cancelled"), 360, "the compaction and resume")
        s.wait(lambda: stopped_after_compact(s), 300, "the resumed turn to end")
        s.wait_idle()
        a = s.audit()
        ent = s.entries(s.sids()[0])
        post = after_compact(ent)
        c.ok(s.count("remind sent at") == 1, "remind sent once")
        c.ok(s.count("handoff registered") == 1, f"exactly one handoff ({s.count('handoff registered')})")
        c.ok(s.count("turn ended; running /compact") == 1, f"/compact queued exactly once ({s.count('turn ended; running /compact')})")
        c.ok(len(compact_starts(s)) == 1, f"one SessionStart(compact) ({len(compact_starts(s))})")
        c.ok(len(s.sids()) == 1, f"compact keeps the session id ({len(s.sids())})")
        c.ok(sum(1 for e in ent if e.get("isCompactSummary")) == 1, "one compaction summary in the transcript")
        c.ok(any("Keep what is needed to continue the current work" in json.dumps(e, ensure_ascii=False) for e in ent), "/compact ran with the compact_focus text")
        c.ok(len(resume_entries(post)) == 1, f"exactly one resume message after the compaction ({len(resume_entries(post))})")
        c.ok(attachments(post, "This conversation was just reset by AutoHandoff (/compact)"), "start context after the compaction")
        c.ok(handoff_in_context(post, handover), "the compacted conversation has the handoff file (read it, or the compaction attached it)")
        c.ok("handoff finished: resumed" in a, "resumed")
        c.ok(not any(x.startswith("handoff cancelled") for x in a), "nothing cancelled")
        done = [os.path.exists(os.path.join(proj(work), "notes", f)) for f in ("a.txt", "b.txt", "c.txt")]
        c.ok(all(done), f"work finished across the compaction (notes a/b/c: {done})")
        c.note(" | ".join(x for x in a if x.startswith(("remind sent", "handoff", "turn ended"))))
    except TimeoutError as e:
        c.ok(False, str(e).splitlines()[0])
        c.note("\n".join(str(e).splitlines()[1:40]))
    finally:
        s.close()
    return c


def scenario_fallback(work):
    """第三层 compact_at（PLAN §0 第 2 条）：没有登记交接、回合结束时用量 ≥ compact_at → 排队 /compact <compact_focus>，不改 CC 设置。
    配置 autohandoff-fallback.md：remind/urge/compact = 56k/58k/60k，提示词换成「不必动作」、urge_block 关（模拟一直不理提醒的模型），
    读一次 data/catalog.md 就越过 60k。期望：恰好一次兜底压缩、sid 不变、不续接、没有登记；压缩后各层清零，下一条消息不提醒。"""
    reset_project(work)
    c = Check("fallback: no handoff and the turn ends past compact_at → one /compact, no resume")
    s = Session(work, "fallback", config=os.path.join(work, "autohandoff-fallback.md"))
    try:
        sid = s.sids()[0]
        s.send("Read data/catalog.md in full with the Read tool, then reply with the number of SKU lines it lists.")
        s.wait(lambda: s.has("compaction at compact_at done") or s.has("compaction at compact_at did not run"), 360, "the compaction at compact_at")
        s.wait_idle()
        n_before = len(s.audit())
        # 压缩后的一条人工消息：读不到用量或已回落，不提醒、不再压缩；摘要里应还记得刚才的结果
        s.send("Thanks. Which file did you just read, and how many SKU lines did it have? Answer in one sentence without using any tools.")
        s.wait(lambda: len([h for h in s.stops(sid)]) >= 2, 180, "the follow-up turn to end")
        s.wait_idle()
        a = s.audit()
        ent = s.entries(sid)
        post = after_compact(ent)
        n_fb = s.count("compact_at reached at")
        c.ok(n_fb == 1, f"compact_at reached → /compact queued exactly once ({n_fb})")
        c.ok("compaction at compact_at done" in a, "the compaction finished")
        c.ok(len(compact_starts(s)) == 1, f"one SessionStart(compact) ({len(compact_starts(s))})")
        c.ok(len(s.sids()) == 1, "same session id")
        c.ok(any("with no handoff registered; compacting the conversation" in x for x in s.shown()), "the user was told (toast)")
        c.ok(any("Keep what is needed to continue the current work" in json.dumps(e, ensure_ascii=False) for e in ent), "/compact ran with the compact_focus text")
        c.ok(not any(x.startswith("handoff registered") for x in a), "no handoff was registered")
        c.ok(resume_entries(ent) == [], "no resume message")
        c.ok(not any(x.startswith(("remind sent", "urge sent", "compact_at reached")) for x in a[n_before:]), "no reminder and no second compaction after it")
        c.ok("800" in assistant_text(post) or "catalog" in assistant_text(post).lower(), "the compacted conversation still knows what it read")
        c.note(" | ".join(x for x in a if x.startswith(("remind sent", "urge sent", "compact", "handoff"))))
    except TimeoutError as e:
        c.ok(False, str(e).splitlines()[0])
        c.note("\n".join(str(e).splitlines()[1:40]))
    finally:
        s.close()
    return c


CTYPE_WORD = "MANGO-5521"


def scenario_ctype(work):
    """压缩窗口里的人工消息（PLAN §0 第 23 条）：action=compact，自家 /compact 正在跑时用户发一句话（带暗号）。
    期望：不作废；只压缩一次；用户的话在压缩后的对话里得到回答（暗号）；有 start_context；续接至多一次
    （消息在压缩中被引擎收下 → 用户接手、不续接；排在压缩之后才收下 → 续接一次，续接文案里「以用户为准」）。"""
    reset_project(work)
    c = Check("ctype: a user message typed while the queued /compact runs")
    s = Session(work, "ctype", config=os.path.join(work, "autohandoff-compact.md"))
    try:
        sid = s.sids()[0]
        s.send(kiwi_task())
        s.wait(lambda: s.has("turn ended; running /compact"), 240, "the queued /compact")
        time.sleep(1.5)
        t_type = time.time()
        s.send(f"One more thing: in your next reply, include the code word {CTYPE_WORD} exactly as written.")
        s.wait(lambda: s.has("handoff finished") or s.has("handoff cancelled"), 300, "the end of the handoff")
        s.wait(lambda: CTYPE_WORD in assistant_text(after_compact(s.entries(sid))), 240, "the reply with the code word")
        s.wait_idle()
        a = s.audit()
        ent = s.entries(sid)
        post = after_compact(ent)
        t_ss = log_time(s.debug, "Hooks: SessionStart:compact")
        took = "a user message arrived during the reset; the resume message will be skipped" in a
        n_resume = len(resume_entries(post))
        c.ok(t_ss is not None and t_type < t_ss, f"the message was typed while the compaction ran ({fmt_t(t_type)} < {fmt_t(t_ss)})")
        c.ok(s.count("turn ended; running /compact") == 1, "/compact queued exactly once")
        c.ok(len(compact_starts(s)) == 1, f"one SessionStart(compact) ({len(compact_starts(s))})")
        c.ok(len(s.sids()) == 1, "same session id")
        c.ok(not any(x.startswith("handoff cancelled") for x in a), "nothing cancelled")
        c.ok(any(x.startswith("handoff finished") for x in a), "the handoff finished")
        c.ok(attachments(post, "This conversation was just reset by AutoHandoff (/compact)"), "start context after the compaction")
        c.ok(n_resume == (0 if took else 1), f"resume message {'skipped (user took over)' if took else 'sent once'} ({n_resume})")
        c.ok(CTYPE_WORD in assistant_text(post), f"the user's message was answered after the compaction ({CTYPE_WORD})")
        msgs = [x for x in a if x.startswith("message: origin")]
        c.note(f"took over: {took}; messages: {msgs}")
        c.note(" | ".join(x for x in a if x.startswith(("handoff", "turn ended", "a user message", "reset request"))))
    except TimeoutError as e:
        c.ok(False, str(e).splitlines()[0])
        c.note("\n".join(str(e).splitlines()[1:40]))
    finally:
        s.close()
    return c


def scenario_agentdialog(work):
    """编排模式：后台子代理的权限框开着时主回合结束、/clear 排队（审查员第 3 批第 4 点）。
    实测这个权限框不会挡住排队的 /clear：主回合一结束就重置，权限框跨过重置留着；用户答复后子代理跑完，汇报落到新对话，
    新对话照交接文件处理它（PLAN §0 第 1 条要的效果）。期望：重置发生在用户答复之前；新对话恰好一次续接；子代理的汇报以
    task-notification 进入新对话；新对话回复 AGENT-REPORTED；不作废。"""
    reset_project(work)
    c = Check("agentdialog: a background subagent's permission dialog is open when the /clear is queued")
    s = Session(work, "agentdialog")
    try:
        old = s.sids()[0]
        s.send(
            TEST_INTRO + "(1) Start one background subagent: Agent tool, subagent_type general-purpose, run_in_background true, with this task: "
            "'Run `python3 tools/wait_for.py .go-agent` with the Bash tool, then run `touch agent-done.txt` with the Bash tool, then reply DONE.' "
            "(2) Write docs/HANDOVER.md (replace its content) with: '# Handover\\n\\nA background subagent is running (it waits for .go-agent, then "
            "touches agent-done.txt). When its report arrives, tell the user AGENT-REPORTED.\\nNext step: wait for the subagent report.' "
            f"(3) Then, in one single message, call these two tools in parallel: the {TOOL} tool with file docs/HANDOVER.md, and the Bash tool with "
            "`python3 tools/wait_for.py .go-main`. (4) End your turn with one short sentence."
        )
        s.wait(lambda: s.has("handoff registered"), 240, "the registration")
        open(os.path.join(proj(work), ".go-agent"), "w").close()
        s.wait(lambda: "touch agent-done.txt" in s.pane() and "Do you want" in s.pane(), 120, "the subagent's permission dialog")
        t_dialog = time.time()
        open(os.path.join(proj(work), ".go-main"), "w").close()
        s.wait(lambda: len(s.sids()) >= 2, 180, "the /clear")
        time.sleep(3)
        dialog_still = "Do you want" in s.pane()
        t_answer = time.time()
        nums = re.findall(r"(\d)\. Yes", s.pane())
        s.keys(nums[0] if nums else "1")
        s.wait(lambda: "AGENT-REPORTED" in assistant_text(s.entries(s.sids()[-1])), 240, "the subagent's report in the new conversation")
        s.wait_idle()
        a = s.audit()
        sids = s.sids()
        new = sids[1] if len(sids) > 1 else None
        ent = s.entries(new) if new else []
        t_end = log_time(s.debug, "SessionEnd:clear")
        i_moved = next((i for i, x in enumerate(a) if x.startswith("record moved")), len(a))
        c.ok(t_end is not None and t_dialog < t_end < t_answer, f"the /clear ran while the dialog was open ({fmt_t(t_dialog)} < {fmt_t(t_end)} < {fmt_t(t_answer)})")
        c.ok(dialog_still, "the permission dialog was still there after the reset")
        c.ok(s.count("turn ended; running /clear") == 1, "/clear queued exactly once")
        c.ok(len(sids) == 2, f"exactly two sessions ({len(sids)})")
        c.ok(len(resume_entries(ent)) == 1, f"exactly one resume message in the new conversation ({len(resume_entries(ent))})")
        c.ok(any(x.startswith("message: origin task-notification") for x in a[i_moved:]), "the subagent's report reached the new conversation as a task notification")
        c.ok(os.path.exists(os.path.join(proj(work), "agent-done.txt")), "the subagent finished after the answer")
        c.ok("AGENT-REPORTED" in assistant_text(ent), "the new conversation handled the report per the handoff file")
        c.ok(not any(x.startswith("handoff cancelled") for x in a), "nothing cancelled")
        c.note(" | ".join(x for x in a if x.startswith(("handoff", "turn ended", "record moved", "message:"))))
    except TimeoutError as e:
        c.ok(False, str(e).splitlines()[0])
        c.note("\n".join(str(e).splitlines()[1:40]))
    finally:
        s.close()
    return c


def copy_plugin(work):
    """热重载场景用的插件副本（改它触发重载，不碰仓库本身）"""
    dst = os.path.join(work, "plugin-copy")
    if os.path.exists(dst):
        shutil.rmtree(dst)
    root = os.path.dirname(HERE)
    for d in ("hooks", "commands", ".claude-plugin", "types"):
        shutil.copytree(os.path.join(root, d), os.path.join(dst, d), ignore=shutil.ignore_patterns("types") if d == ".claude-plugin" else None)
    shutil.copy(os.path.join(root, "tsconfig.json"), dst)
    return dst


def scenario_reload(work):
    """热重载落在排队的 /compact 里（PLAN §0 第 20、24 条，二审 Minor-D）：action=compact，「/compact 已排队」后改插件副本触发重载。
    期望：新模块认出命令是本进程排的（$.state），留作孤儿，SessionStart(compact) 由新模块续接，恰好一次；旧模块的回调写不了
    store、提交不了续接（实测旧环境的 $ 调用被拒）；不作废。"""
    reset_project(work)
    c = Check("reload: a hot reload while the queued /compact runs; the new module resumes once")
    plug = copy_plugin(work)
    s = Session(work, "reload", config=os.path.join(work, "autohandoff-compact.md"), plugin=plug)
    reg = os.path.join(plug, "hooks", "register.ts")
    try:
        sid = s.sids()[0]
        s.send(kiwi_task())
        s.wait(lambda: s.has("turn ended; running /compact"), 240, "the queued /compact")
        with open(reg, "a", encoding="utf-8") as f:
            f.write(f"\n// e2e reload {time.time():.0f}\n")
        s.wait(lambda: s.has("handoff finished") or s.has("handoff cancelled"), 300, "the end of the handoff")
        s.wait(lambda: stopped_after_compact(s), 240, "the resumed turn to end")
        s.wait_idle()
        a = s.audit()
        ent = s.entries(sid)
        post = after_compact(ent)
        t_run = log_time(s.debug, "turn ended; running /compact")
        t_reload = log_time(s.debug, "hooks module autohandoff@inline reloaded")
        t_ss = log_time(s.debug, "Hooks: SessionStart:compact")
        c.ok(t_run is not None and t_reload is not None and t_ss is not None and t_run < t_reload < t_ss,
             f"the reload landed while /compact was queued ({fmt_t(t_run)} < {fmt_t(t_reload)} < {fmt_t(t_ss)})")
        c.ok(any(re.match(r"restarted or reloaded while /compact was queued \(request \d+\)", x) for x in a), "kept as an orphan ($.state knew the command)")
        c.ok(not any(x.startswith("restarted: ") for x in a), "not taken for a process restart")
        c.ok(any(re.match(r"reset request \d+ finished after a restart or reload; continuing from the handoff file", x) for x in a), "the new module resumed from SessionStart(compact)")
        c.ok(len(resume_entries(post)) == 1, f"exactly one resume message ({len(resume_entries(post))})")
        c.ok("handoff finished: resumed" in a, "resumed")
        c.ok(not any(x.startswith("handoff cancelled") for x in a), "nothing cancelled")
        c.ok("KIWI" in assistant_text(post), "the resumed conversation did the next step (KIWI)")
        unloaded = sum(1 for l in open(s.debug, errors="replace") if "environment is unloaded" in l)
        c.note(f"old-module $ calls refused after the reload: {unloaded}")
        c.note(" | ".join(x for x in a if x.startswith(("handoff", "turn ended", "restarted", "reset request"))))
    except TimeoutError as e:
        c.ok(False, str(e).splitlines()[0])
        c.note("\n".join(str(e).splitlines()[1:40]))
    finally:
        s.close()
    return c


def scenario_restart(work):
    """进程重启（不是热重载）落在排队的 /compact 里（二审 Minor-A，PLAN §0 第 24 条）：/compact 发出后立刻 kill -9 进程，
    再 `claude --resume <sid>`。期望：新进程认出命令不是它排的（$.state 是空的）→ 作废、toast「已作废」、不提示「已排队」、
    不续接；之后用户自己的 /clear 是普通 clear（新对话没有交接、没有续接）。"""
    reset_project(work)
    c = Check("restart: the process dies while /compact is queued; --resume cancels, no resume, the user's /clear is plain")
    s = Session(work, "restart", config=os.path.join(work, "autohandoff-compact.md"))
    s2 = None
    try:
        sid = s.sids()[0]
        s.send(kiwi_task())
        s.wait(lambda: s.has("turn ended; running /compact"), 240, "the queued /compact")
        pid = s.claude_pid()
        if pid:
            os.kill(pid, 9)
        time.sleep(3)
        compacted_before = len(compact_starts(s))
        s.close()
        s2 = Session(work, "restart-b", extra=["--resume", sid], config=os.path.join(work, "autohandoff-compact.md"))
        s2.wait(lambda: s2.has("handoff cancelled") or s2.has("restarted or reloaded while"), 60, "the restart to be handled")
        time.sleep(2)
        n_sids = len(s2.sids())
        s2.send("/clear")
        s2.wait(lambda: len(s2.sids()) > n_sids, 60, "the user's /clear")
        time.sleep(8)
        a = s2.audit()
        new = s2.sids()[-1]
        ent = s2.entries(new)
        shown = s2.shown()
        c.ok(pid is not None, f"killed the claude process ({pid})")
        c.ok(compacted_before == 0, "the compaction had not finished when the process died")
        c.ok(any(re.match(r"restarted: /compact \(request \d+\) was queued by a process that has ended", x) for x in a), "recognised as a restart")
        c.ok(any("handoff cancelled (AutoHandoff was restarted or reloaded before the reset)" in x for x in shown), "user told the handoff was cancelled")
        c.ok(not any(QUEUED_TOAST in x for x in shown), "no 'already queued' toast")
        c.ok(not any(x.startswith("the user ran /clear, but") for x in a), "the user's /clear was not swallowed as queued")
        c.ok(resume_entries(ent) == [], "no resume message after the user's /clear")
        c.ok(not attachments(ent, "This conversation was just reset by AutoHandoff"), "no start context after the user's /clear")
        c.note(" | ".join(x for x in a if x.startswith(("handoff", "restarted", "the user ran", "record moved"))))
    except TimeoutError as e:
        c.ok(False, str(e).splitlines()[0])
        c.note("\n".join(str(e).splitlines()[1:40]))
    finally:
        s.close()
        if s2:
            s2.close()
    return c


def scenario_esc(work):
    """场景 7：登记后、回合还在跑时按 Esc → 静默作废（不 toast、不 clear）；之后用户发一条消息，短提醒随它送到模型。"""
    reset_project(work)
    c = Check("esc: Esc after registering cancels silently; the next message carries the short reminder")
    s = Session(work, "esc")
    try:
        sid = s.sids()[0]
        s.send(
            TEST_INTRO + "(1) Read data/catalog.md in full with the Read tool (background only). (2) Write docs/HANDOVER.md (replace its content) "
            "with: '# Handover\\n\\nTask: list src.\\nNext step: run ls src.' "
            f"(3) Then, in one single message, call these two tools in parallel: the {TOOL} tool with file docs/HANDOVER.md, "
            "and the Bash tool with `python3 -c \"import time; time.sleep(40); print(42)\"`. (4) End your turn with one short sentence."
        )
        s.wait(lambda: s.has("handoff registered"), 240, "the registration")
        s.wait(lambda: "time.sleep(40)" in s.pane(), 60, "the slow command to start")
        time.sleep(2)
        s.keys("Escape")
        s.wait(lambda: s.has("handoff cancelled"), 60, "the cancellation")
        s.wait_idle()
        n = len(s.audit())
        s.send("Reply with the single word OK.")
        s.wait(lambda: len(s.stops(sid)) >= 1 and s.has("message: origin composer") and len(s.audit()) > n, 120, "the next message")
        s.wait_idle()
        a = s.audit()
        ent = s.entries(sid)
        c.ok("handoff cancelled: the turn was interrupted" in a, "cancelled as interrupted")
        c.ok(not any("handoff cancelled" in x for x in s.shown()), "no toast")
        c.ok(not any(x.startswith("turn ended; running /clear") for x in a[:n]), "no /clear")
        c.ok(attachments(ent, "[AutoHandoff] Context usage is about"), "the next message carried the short reminder")
        c.note(" | ".join(x for x in a if x.startswith(("handoff", "turn ended", "remind", "message:"))))
    except TimeoutError as e:
        c.ok(False, str(e).splitlines()[0])
        c.note("\n".join(str(e).splitlines()[1:40]))
    finally:
        s.close()
    return c


def free_port():
    import socket
    with socket.socket() as so:
        so.bind(("127.0.0.1", 0))
        return so.getsockname()[1]


def scenario_apierr(work):
    """场景 8：登记后回合以 API 错误结束（fault_proxy 在交回登记结果的那个请求上注入 500，CLAUDE_CODE_MAX_RETRIES=0）
    → 作废、toast、不 clear；下一条消息带作废说明，当前层重新生效。"""
    reset_project(work)
    c = Check("apierr: an API error ends the registered turn → cancelled, told, no reset")
    port = free_port()
    mode = os.path.join(work, "logs", "fault.mode")
    with open(mode, "w") as f:
        f.write(f"after:{TOOL}:500")
    proxy = subprocess.Popen([sys.executable, os.path.join(HERE, "fault_proxy.py"), str(port), mode], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    s = None
    try:
        time.sleep(1)
        s = Session(work, "apierr", ah_env=f"ANTHROPIC_BASE_URL=http://127.0.0.1:{port} CLAUDE_CODE_MAX_RETRIES=0")
        sid = s.sids()[0]
        s.send(TEST_INTRO + "(1) Write docs/HANDOVER.md (replace its content) with: '# Handover\\n\\nTask: list src.\\nNext step: run ls src.' "
               f"(2) Call the {TOOL} tool with file docs/HANDOVER.md. (3) End your turn with one short sentence.")
        s.wait(lambda: s.has("handoff registered"), 240, "the registration")
        s.wait(lambda: s.has("handoff cancelled") or s.has("running /clear"), 120, "the turn to end")
        s.wait_idle()
        n = len(s.audit())
        s.send("What happened? Answer in one sentence.")
        s.wait(lambda: len(s.audit()) > n and not s.working(), 120, "the next message")
        s.wait_idle()
        a = s.audit()
        ent = s.entries(sid)
        c.ok(open(mode).read().strip() == "pass", "the 500 was injected on the request returning the registration")
        c.ok("handoff cancelled: the turn ended with an API error" in a, "cancelled by the API error")
        c.ok(any("handoff cancelled (the turn ended with an API error)" in x for x in s.shown()), "user told (toast)")
        c.ok(not any(x.startswith("turn ended; running /clear") for x in a[:n]), "no /clear from the cancelled registration")
        c.ok(any("cancelled (the turn ended with an API error)" in json.dumps(e, ensure_ascii=False) for e in ent if e.get("type") == "attachment"),
             "the next message told the model")
        if any(x.startswith("handoff registered") for x in a[n:]):
            c.note("the model registered again after being told (allowed: the cancelled prompt asks it to)")
        c.note(" | ".join(x for x in a if x.startswith(("handoff", "turn ended"))))
    except TimeoutError as e:
        c.ok(False, str(e).splitlines()[0])
        c.note("\n".join(str(e).splitlines()[1:40]))
    finally:
        if s:
            s.close()
        proxy.kill()
    return c


def scenario_subreg(work):
    """场景 10：子代理调登记工具 → 拒绝（只认主对话）；不登记、不重置。"""
    reset_project(work)
    c = Check("subreg: a subagent calling the register tool is refused")
    s = Session(work, "subreg")
    try:
        sid = s.sids()[0]
        s.send(TEST_INTRO + "(1) Write docs/HANDOVER.md (replace its content) with: '# Handover\\n\\nTask: list src.' "
               "(2) Use the Agent tool (subagent_type general-purpose, in the foreground, not in the background) with this task: "
               f"'Call the {TOOL} tool with file docs/HANDOVER.md and reply with the tool's result word for word.' "
               "(3) Reply with what the subagent reported. Do not call that tool yourself.")
        s.wait(lambda: s.has("registration refused"), 240, "the refused registration")
        s.wait_idle()
        time.sleep(3)
        a = s.audit()
        c.ok("registration refused: only the main conversation can register a handoff; subagents and forks cannot." in a, "refused: only the main conversation")
        c.ok(not any(x.startswith("handoff registered") for x in a), "nothing registered")
        c.ok(not any(x.startswith("turn ended; running") for x in a), "no reset")
        c.ok(len(s.sids()) == 1, "same session")
        c.note(" | ".join(x for x in a if x.startswith(("handoff", "registration", "turn ended"))))
    except TimeoutError as e:
        c.ok(False, str(e).splitlines()[0])
        c.note("\n".join(str(e).splitlines()[1:40]))
    finally:
        s.close()
    return c


def scenario_urge(work):
    """场景 11：urge 层的 Stop block 生效且每回合只一次。配置 autohandoff-urge.md：remind/urge 54k/56k，提示词换成「不必动作」
    （模型不会因提醒交接），urge_block 照开、用内置文本。读一次大文件越过 urge 后模型想结束回合 → block 一次 → 模型写交接、登记 →
    clear → 续接。期望：旧对话只 block 一次，第二次 Stop 带 stop_hook_active 且不再 block；交接与续接各一次。"""
    reset_project(work)
    c = Check("urge: the Stop block asks for a handoff once per turn")
    s = Session(work, "urge", config=os.path.join(work, "autohandoff-urge.md"))
    try:
        old = s.sids()[0]
        s.send("Read data/catalog.md in full with the Read tool, then reply with the number of SKU lines it lists.")
        s.wait(lambda: s.has("Stop blocked once"), 240, "the Stop block")
        s.wait(lambda: s.has("handoff finished") or s.has("handoff cancelled") or (len(s.stops(old)) >= 2 and not s.working() and not s.has("running /clear")), 300, "the end of the turn")
        if s.has("running /clear"):
            s.wait(lambda: len(s.sids()) >= 2 and s.stops(s.sids()[-1]), 300, "the resumed turn to end")
        s.wait_idle()
        a = s.audit()
        i_moved = next((i for i, x in enumerate(a) if x.startswith("record moved")), len(a))
        old_stops = s.stops(old)
        blocks = sum(1 for x in a[:i_moved] if x.startswith("Stop blocked once"))
        c.ok(blocks == 1, f"blocked exactly once in the old conversation ({blocks})")
        c.ok(len(old_stops) >= 2 and old_stops[0].get("stop_hook_active") is False and any(h.get("stop_hook_active") for h in old_stops[1:]),
             "the next Stop came with stop_hook_active and was not blocked")
        ent_old = s.entries(old)
        c.ok(any("past the 56k handoff threshold" in json.dumps(e, ensure_ascii=False) for e in ent_old), "the block reason reached the model")
        c.ok(s.count("handoff registered") == 1, f"the model handed off after the block ({s.count('handoff registered')})")
        sids = s.sids()
        c.ok(len(sids) == 2 and len(resume_entries(s.entries(sids[-1]))) == 1, f"reset and resumed once ({len(sids)} sessions)")
        c.note(" | ".join(x for x in a if x.startswith(("Stop blocked", "urge", "remind", "handoff", "turn ended"))))
    except TimeoutError as e:
        c.ok(False, str(e).splitlines()[0])
        c.note("\n".join(str(e).splitlines()[1:40]))
    finally:
        s.close()
    return c


def scenario_userclear(work):
    """场景 12（按 PLAN §0 第 20 条改）：登记后、回合还在跑时用户敲 /clear（排队）。回合结束后用户的 /clear 先跑（OLD → MID），
    再跑自家排队的 /clear（MID → NEW）：交接跟到最后那个对话，恰好一次续接、有 start_context，不作废。"""
    reset_project(work)
    c = Check("userclear: the user's /clear typed during the registered turn; the queued /clear still resumes in the last conversation")
    s = Session(work, "userclear")
    handover = os.path.realpath(os.path.join(proj(work), "docs", "HANDOVER.md"))
    try:
        s.send(TEST_INTRO + "(1) Write docs/HANDOVER.md (replace its content) with: '# Handover\\n\\nTask: reply with the word KIWI.\\nNext step: reply KIWI.' "
               f"(2) Then, in one single message, call these two tools in parallel: the {TOOL} tool with file docs/HANDOVER.md, "
               "and the Bash tool with `python3 -c \"import time; time.sleep(30); print(42)\"`. (3) End your turn with one short sentence.")
        s.wait(lambda: s.has("handoff registered"), 180, "the registration")
        s.wait(lambda: "time.sleep(30)" in s.pane(), 60, "the slow command to start")
        time.sleep(3)
        s.send("/clear")
        s.wait(lambda: s.has("handoff finished") or s.has("handoff cancelled"), 240, "the end of the handoff")
        s.wait(lambda: len(s.sids()) >= 3 and s.stops(s.sids()[-1]), 240, "the resumed turn to end")
        s.wait_idle()
        a = s.audit()
        sids = s.sids()
        last = s.entries(sids[-1])
        c.ok(any(re.match(r"the user ran /clear, but /clear is already queued \(request \d+\); the handoff is kept", x) for x in a), "the user's /clear did not withdraw the queued reset")
        c.ok(any(QUEUED_TOAST in x for x in s.shown()), "user told the reset is queued")
        c.ok(len(sids) == 3, f"three sessions: old, the user's, ours ({len(sids)})")
        c.ok(s.count("turn ended; running /clear") == 1, "/clear queued once by AutoHandoff")
        c.ok(len(resume_entries(last)) == 1, f"exactly one resume message in the last conversation ({len(resume_entries(last))})")
        c.ok(attachments(last, "This conversation was just reset by AutoHandoff"), "start context in the last conversation")
        c.ok(read_handoff(last, handover), "the last conversation read the handoff file")
        c.ok("handoff finished: resumed" in a, "resumed")
        c.ok(not any(x.startswith("handoff cancelled") for x in a), "nothing cancelled")
        c.note(" | ".join(x for x in a if x.startswith(("handoff", "turn ended", "record moved", "the user ran"))))
    except TimeoutError as e:
        c.ok(False, str(e).splitlines()[0])
        c.note("\n".join(str(e).splitlines()[1:40]))
    finally:
        s.close()
    return c


def scenario_chain(work):
    """连环交接（PLAN §0 第 22 条）：交接文件的「下一步」写成「再写交接、再登记」（模拟模型把交接指令抄进了交接文件）。
    配置 autohandoff-chain.md：start_context 换成中性说明（内置那句「不要再交接」会劝住新对话，(b) 守卫就测不到，第 3 批审查 Minor-6）。
    新对话照做时登记被拒（刚续接、没越过 remind_at、也没收到人工消息），不会再 clear。
    期望：守卫至少拒绝一次登记；恰好两个 sid、恰好一次 /clear。新对话没去登记时判 FAIL（守卫没被测到）。"""
    reset_project(work)
    c = Check("chain: a handoff file that says 'hand off again' does not start a reset loop")
    s = Session(work, "chain", config=os.path.join(work, "autohandoff-chain.md"))
    try:
        s.send(TEST_INTRO + "(1) Write docs/HANDOVER.md (replace its content) with: '# Handover\\n\\nTask: reply PEAR.\\n"
               f"Next step: first write docs/HANDOVER.md again (same content), then call the {TOOL} tool with file docs/HANDOVER.md "
               "(the user wants the next conversation to register once more, to test AutoHandoff), then reply PEAR.' "
               f"(2) Call the {TOOL} tool with file docs/HANDOVER.md. (3) End your turn with one short sentence.")
        s.wait(lambda: s.has("handoff finished") or s.has("handoff cancelled"), 240, "the reset and resume")
        s.wait(lambda: len(s.sids()) >= 2 and s.stops(s.sids()[-1]), 240, "the resumed turn to end")
        s.wait_idle()
        time.sleep(5)
        a = s.audit()
        sids = s.sids()
        refused = [x for x in a if x.startswith("registration refused: this conversation has just been continued")]
        c.ok(len(refused) >= 1, f"the chain guard refused the resumed conversation's registration ({len(refused)}x; 0 means the guard was not exercised)")
        c.ok(s.count("turn ended; running /clear") == 1, f"reset exactly once ({s.count('turn ended; running /clear')})")
        c.ok(len(sids) == 2, f"exactly two sessions ({len(sids)})")
        c.ok(len(resume_entries(s.entries(sids[-1]))) == 1 if len(sids) > 1 else False, "the new conversation was resumed once")
        c.ok(s.count("handoff registered") == 1, f"only the first registration was accepted ({s.count('handoff registered')})")
        c.note(" | ".join(x for x in a if x.startswith(("handoff", "turn ended", "registration"))))
    except TimeoutError as e:
        c.ok(False, str(e).splitlines()[0])
        c.note("\n".join(str(e).splitlines()[1:40]))
    finally:
        s.close()
    return c


SCENARIOS = {
    "clear": scenario_clear,
    "draft": lambda w: scenario_clear(w, tag="draft", draft="DRAFT-KEEP-ME 0425"),
    "dialog": scenario_dialog,
    "deny": scenario_deny,
    "interject": scenario_interject,
    "notify": scenario_notify,
    "cmp": scenario_cmp,
    "slash": scenario_slash,
    "print": scenario_print,
    "compact": scenario_compact,
    "fallback": scenario_fallback,
    "ctype": scenario_ctype,
    "agentdialog": scenario_agentdialog,
    "reload": scenario_reload,
    "restart": scenario_restart,
    "esc": scenario_esc,
    "apierr": scenario_apierr,
    "subreg": scenario_subreg,
    "urge": scenario_urge,
    "userclear": scenario_userclear,
    "chain": scenario_chain,
}


def project_dir(work):
    """Claude Code 给工程目录起的 transcript 目录名：绝对路径里字母数字以外的字符都换成 '-'"""
    return os.path.join(CC, "projects", re.sub(r"[^A-Za-z0-9]", "-", os.path.realpath(proj(work))))


def test_sids(work):
    """本次测试会话的 sid：hook 日志里出现过的，加上测试工程 transcript 目录里的文件名"""
    sids = set()
    logs = os.path.join(work, "logs")
    if os.path.isdir(logs):
        for f in os.listdir(logs):
            if f.endswith(".hooks.jsonl"):
                for line in open(os.path.join(logs, f), encoding="utf-8"):
                    try:
                        sids.add(json.loads(line).get("session_id", ""))
                    except ValueError:
                        pass
    pd = project_dir(work)
    if os.path.isdir(pd):
        sids.update(f[:-6] for f in os.listdir(pd) if f.endswith(".jsonl"))
    return {x for x in sids if SID_RE.match(x)}


RUN_STARTED = time.time()


def is_autohandoff_dir(d):
    try:
        return json.load(open(os.path.join(d, ".claude-plugin", "plugin.json"), encoding="utf-8")).get("name") == "autohandoff"
    except (OSError, ValueError):
        return False


def other_plugin_dir_sessions(work):
    """本脚本以外、还活着的 `claude --plugin-dir <某份 autohandoff>` 进程（store 文件名不随插件目录变，所有这样的会话共用一份）"""
    mine = set(PANE_PIDS)
    found = []
    for pid in os.listdir("/proc"):
        if not pid.isdigit() or int(pid) in mine:
            continue
        try:
            argv = open(f"/proc/{pid}/cmdline", "rb").read().split(b"\0")
        except OSError:
            continue
        args = [a.decode(errors="replace") for a in argv]
        # 两种写法：--plugin-dir <路径>、--plugin-dir=<路径>
        dirs = [args[i + 1] for i, a in enumerate(args[:-1]) if a == "--plugin-dir"]
        dirs += [a.split("=", 1)[1] for a in args if a.startswith("--plugin-dir=")]
        if any(is_autohandoff_dir(d) for d in dirs):
            found.append(int(pid))
    return found


def wait_exited(pids, timeout=30):
    t0 = time.time()
    while time.time() - t0 < timeout:
        alive = []
        for p in pids:
            try:
                os.kill(p, 0)
                alive.append(p)
            except ProcessLookupError:
                pass
            except PermissionError:
                alive.append(p)
        if not alive:
            return []
        time.sleep(0.5)
    return alive


def cleanup(work, keep):
    """清掉本次测试留在 ~/.claude 下的东西和工作目录（只按精确的路径和 sid，不用通配删除）"""
    out = []
    alive = wait_exited(PANE_PIDS)
    if alive:
        out.append(f"warning: test session processes still running: {alive}")
    time.sleep(1)
    sids = test_sids(work)
    pd = project_dir(work)
    # transcript 必须都在拼出来的那个目录里；不一致就不删 projects 目录，交给人看
    tdirs = set()
    logs = os.path.join(work, "logs")
    if os.path.isdir(logs):
        for f in os.listdir(logs):
            if f.endswith(".hooks.jsonl"):
                for line in open(os.path.join(logs, f), encoding="utf-8"):
                    try:
                        t = json.loads(line).get("transcript_path")
                    except ValueError:
                        continue
                    if t:
                        tdirs.add(os.path.dirname(t))
    if tdirs - {pd}:
        out.append(f"NOT removed: transcripts outside {pd}: {sorted(tdirs - {pd})}")
    elif os.path.isdir(pd):
        shutil.rmtree(pd)
        out.append(f"removed {pd}")
    for sid in sorted(sids):
        for p in (os.path.join(CC, "session-env", sid), os.path.join(CC, "file-history", sid), os.path.join(CC, "ctx", f"{sid}.json"),
                  os.path.join(CC, "security", f"security_warnings_state_{sid}.json"), os.path.join(CC, "security", f"security_warnings_state_{sid}.lock")):
            if os.path.isdir(p):
                shutil.rmtree(p)
                out.append(f"removed {p}")
            elif os.path.exists(p):
                os.remove(p)
                out.append(f"removed {p}")
    store_dir = os.path.join(CC, "plugins", "store")
    others = other_plugin_dir_sessions(work)
    for f in sorted(os.listdir(store_dir)) if os.path.isdir(store_dir) else []:
        if not (f.startswith("autohandoff_inline-") and f.endswith(".json")):
            continue
        path = os.path.join(store_dir, f)
        d = json.load(open(path, encoding="utf-8"))
        gone = [k for k in d if k[:2] in ("s:", "c:") and k[2:] in sids]
        # 这个 store 文件被同一插件目录的所有 --plugin-dir 会话共用：别的会话还在跑（或这次运行期间写过别的记录）时，
        # 读-改-写会和它的写入互相覆盖，所以这一步跳过，留给人手动清
        foreign = [k for k, v in d.items() if k.startswith("s:") and k[2:] not in sids and isinstance(v, dict) and v.get("t", 0) >= RUN_STARTED * 1000]
        if gone and (others or foreign):
            out.append(f"NOT cleaned: {path} ({len(gone)} test records) — other --plugin-dir sessions are running {others} "
                       f"or wrote records during this run {foreign[:3]}")
            continue
        if gone:
            for k in gone:
                del d[k]
            tmp = path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as fh:
                json.dump(d, fh)
            os.chmod(tmp, os.stat(path).st_mode & 0o777)
            os.replace(tmp, path)
            out.append(f"removed {len(gone)} test records from {path}")
    try:
        trust = json.load(open(os.path.join(os.path.expanduser("~"), ".claude.json"), encoding="utf-8")).get("projects", {})
        if os.path.realpath(proj(work)) in trust:
            out.append(f"left as is: ~/.claude.json projects[\"{os.path.realpath(proj(work))}\"] (workspace trust)")
    except (OSError, ValueError):
        pass
    if not keep:
        if os.path.isfile(os.path.join(work, MARKER)):
            shutil.rmtree(work)
            out.append(f"removed {work}")
        else:
            out.append(f"NOT removed: {work} (no {MARKER})")
    return out


def main():
    args = sys.argv[1:]
    if not args:
        print(__doc__)
        return 2
    work = os.path.realpath(args.pop(0))
    repeat = 1
    if "--repeat" in args:
        i = args.index("--repeat")
        repeat = int(args[i + 1])
        del args[i : i + 2]
    keep = "--keep" in args
    if keep:
        args.remove("--keep")
    if "--cleanup-only" in args:
        # 之前用 --keep 跑过：按工作目录里的日志把 ~/.claude 下的残留和工作目录清掉
        subprocess.run([SETUP, "stop", work], capture_output=True)
        for line in cleanup(work, False):
            print(f"  {line}")
        return 0
    names = args or list(SCENARIOS)
    results = []
    try:
        for name in names:
            for k in range(repeat):
                t0 = time.time()
                c = SCENARIOS[name](work)
                c.name += f"  [{time.time() - t0:.0f}s]" + (f" run {k + 1}/{repeat}" if repeat > 1 else "")
                print(c.report(), flush=True)
                results.append(c)
    finally:
        subprocess.run([SETUP, "stop", work], capture_output=True)
        if keep:
            # 留着工作目录和 ~/.claude 下的 transcript 等着看；看完用 --cleanup-only 清
            print(f"\nkept {work} and the test transcripts; clean up later with: drive.py {work} --cleanup-only")
        else:
            print("\ncleanup:")
            for line in cleanup(work, keep):
                print(f"  {line}")
    if repeat > 1:
        for name in names:
            mine = [c for c in results if c.name.startswith(f"{name}:")]
            print(f"{name}: {sum(c.passed for c in mine)}/{len(mine)} passed")
    print(f"\n{sum(c.passed for c in results)}/{len(results)} scenarios passed")
    return 0 if all(c.passed for c in results) else 1


if __name__ == "__main__":
    sys.exit(main())
