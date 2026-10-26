#!/bin/bash
# AutoHandoff 4 的端到端测试环境：不装插件、不改全局设置、不打扰其它对话。
#   - 独立 tmux server（tmux -L $SOCK），每个测试会话一个窗口
#   - claude --plugin-dir <本仓库>：只给测试会话加载 mod（store 文件也与安装版分开）
#   - --settings <临时 json>：关掉全局已装的 autohandoff@autohandoff（v3），关 Remote Control，挂几个只写日志的 settings hook
#   - AUTOHANDOFF_CONFIG：mod 读测试目录里的低阈值配置，不碰 ~/.claude/autohandoff.md
#     （init 写五份：autohandoff.md 用 ACTION，autohandoff-compact.md 固定 action: compact，
#      autohandoff-fallback.md 测 compact_at、autohandoff-urge.md 测 Stop block：这两份把阈值压到一次读大文件就越过，
#      并把 remind/urge 提示词换成「不必动作」的说明，模拟不理提醒的模型；
#      autohandoff-chain.md 把 start_context 换成不劝阻再交接的中性说明，让连环交接守卫真正被触发；
#      autohandoff-budget.md 把 handoff_max_tokens 压到 4000（内置提示词，看模型交接时守不守预算）；
#      autohandoff-oversize.md 同样的上限，但 remind/urge 换成 4.1 之前那种不提大小、按工程习惯在顶上加一节的写法
#      （模拟没合并新提示词的旧配置文件），保证登记的交接文件超长，测新对话的整理段；start 时 AH_CONFIG 可指定用哪份）
#   - AUTOHANDOFF_DISABLE=1：万一全局 v3 仍被加载，也让它静默（v4 不读这个变量）
#
# 用法：
#   mod_setup.sh init <工作目录>                 建测试工程、配置、settings（已存在则只刷新配置与 settings）
#   mod_setup.sh start <工作目录> <名字> [参数…]  在 tmux 窗口 <名字> 里起一个测试会话（参数原样加在 claude 命令后；
#                                                环境变量 AH_ENV="K=V K2=V2" 给这个会话另加环境变量（如 fault_proxy 的 ANTHROPIC_BASE_URL）；
#                                                环境变量 AH_CONFIG=<配置文件的绝对路径> 换一份配置；
#                                                PLUGIN_DIR=<插件目录> 换一份插件（热重载场景用工作目录里的副本，改它触发重载）
#   mod_setup.sh stop <工作目录>                  kill 测试用 tmux server
# 环境变量：SOCK（默认 ahmod）、MODEL（默认 sonnet）、REMIND / URGE / COMPACT（默认 52000 / 200000 / 900000；新对话开头约 45k）、
#   ACTION（clear|compact，默认 clear）、DEFAULT_ON（默认 true）、EFFORT（默认 medium）
set -euo pipefail
cmd=${1:?usage: mod_setup.sh init|start|stop <work dir> ...}
S=$(realpath -m "${2:?work dir}")
HERE=$(cd "$(dirname "$0")/.." && pwd)
SOCK=${SOCK:-ahmod}

# 工作目录的标记：drive.py 只在有它的目录里 git clean、删工作目录
MARKER=.ah-e2e-work

# write_config <输出> <action> [remind urge compact [neutral [urge_block [handoff_max]]]]：neutral 非空时 remind/urge/remind_short 换成不必动作的说明
write_config() {
  local out=$1 action=$2 remind=${3:-${REMIND:-52000}} urge=${4:-${URGE:-200000}} compact=${5:-${COMPACT:-900000}} neutral=${6:-} block=${7:-true} hmax=${8:-20000}
  cat >"$out" <<EOF
# AutoHandoff configuration (e2e)

## settings

default_on: ${DEFAULT_ON:-true}
remind_at: $remind
urge_at: $urge
compact_at: $compact
action: $action
fresh_minutes: 10
wait_minutes: 30
urge_block: $block
remind_every_turn: true
handoff_max_tokens: $hmax
EOF
  if [ -n "$neutral" ]; then
    for k in remind urge remind_short; do
      printf '\n## %s\n\n[AutoHandoff e2e] Context note: about {used_k}k tokens are in use. No action is needed in this test.\n' "$k" >>"$out"
    done
  fi
}

write_settings() {
  python3 - "$S/settings.json" "${EFFORT:-medium}" <<'EOT'
import json, sys
out, effort = sys.argv[1:3]
# 只把 stdin 的 JSON 追加成一行（文件由每个会话的 AH_HOOKLOG 指定），供驱动脚本判断会话 id、回合结束等
rec = "python3 -c 'import os,sys,json; d=json.load(sys.stdin); open(os.environ[\"AH_HOOKLOG\"],\"a\").write(json.dumps(d)+chr(10))'"
hook = [{"hooks": [{"type": "command", "command": rec, "timeout": 10}]}]
d = {
    "enabledPlugins": {"autohandoff@autohandoff": False},
    "remoteControlAtStartup": False,
    "autoCompactEnabled": False,
    "effortLevel": effort,
    "permissions": {
        "defaultMode": "default",
        # 测试会话拿的是真实 HOME 和凭据：Bash 只放行场景里用得到的命令；touch 要问（权限框选 No 的场景用它），
        # 其余没列的命令也会弹框（场景会因等不到结果而超时，看得出来）。带输出重定向的命令（printf x > f）不算 printf 前缀，
        # 也会弹框：场景里建文件一律用 Write 工具
        "allow": ["Read", "Write", "Edit", "Bash(printf:*)", "Bash(mkdir:*)", "Bash(ls:*)", "Bash(cat:*)", "Bash(head:*)",
                  "Bash(wc:*)", "Bash(echo:*)", "Bash(sleep:*)", "Bash(python3 -c:*)", "Bash(python3 tools/wait_for.py:*)",
                  "Bash(git status:*)", "Bash(git log:*)", "Bash(git diff:*)",
                  # 整理交接文件（oversize/budget 场景）：按标题切文件用得到的命令（Read/Write/Edit 本来就全放行，不加 mv、rm）
                  "Bash(grep:*)", "Bash(sed:*)", "Bash(awk:*)", "Bash(tail:*)"],
        "ask": ["Bash(touch:*)"],
    },
    "hooks": {e: hook for e in ["SessionStart", "SessionEnd", "UserPromptSubmit", "Stop"]},
}
json.dump(d, open(out, "w"), indent=1)
EOT
}

init_project() {
  mkdir -p "$S/proj" "$S/logs"
  touch "$S/$MARKER"
  cd "$S/proj"
  if [ ! -d .git ]; then
    git init -q
    mkdir -p src docs data
    cat >CLAUDE.md <<'EOF'
# Inventory service (test project)

- Code lives in src/. Keep functions small and add a docstring to each.
- Handoff notes go in docs/HANDOVER.md (newest state at the top): what is done, what is next, open questions.
- data/catalog.md is a large reference file; read it only when a task says so.
EOF
    printf 'def stock_level(item):\n    """Return the stock level of an item."""\n    return 0\n' >src/stock.py
    printf '# Handover\n\n(no handoff yet)\n' >docs/HANDOVER.md
    # 后台任务用：等到某个文件出现再结束（驱动脚本决定任务通知什么时候到）
    mkdir -p tools
    printf 'import os, sys, time\nwhile not os.path.exists(sys.argv[1]):\n    time.sleep(0.3)\nprint("BG-DONE")\n' >tools/wait_for.py
    # 约 60 KB 的参考资料：读一次就让上下文越过 remind_at
    python3 - <<'EOT'
import random
random.seed(7)
words = ("warehouse shelf pallet supplier order invoice reorder threshold barcode carrier shipment batch expiry "
         "audit count variance location zone picker route forecast demand lead time safety stock").split()
lines = ["# Catalog reference", ""]
for i in range(1, 801):
    lines.append(f"- SKU-{i:05d}: " + " ".join(random.choice(words) for _ in range(9)) + f"; reorder at {random.randint(5, 90)} units.")
open("data/catalog.md", "w").write("\n".join(lines) + "\n")
EOT
    git add -A
    git -c user.name=e2e -c user.email=e2e@example.invalid commit -qm init
  fi
}

case "$cmd" in
  init)
    init_project
    write_config "$S/autohandoff.md" "${ACTION:-clear}"
    write_config "$S/autohandoff-compact.md" compact
    # 新对话开头约 45k，读一次 data/catalog.md（约 2 万 token）就越过这几档
    # fallback 另关 urge_block：模型一直不交接，回合在 compact_at 之上结束
    write_config "$S/autohandoff-fallback.md" clear 56000 58000 60000 neutral false
    write_config "$S/autohandoff-urge.md" clear 54000 56000 900000 neutral
    # chain：内置 start_context 里「除非有新提醒，不要再交接」那句会劝住新对话，守卫就测不到；换成中性说明
    write_config "$S/autohandoff-chain.md" clear
    printf '\n## start_context\n\n[AutoHandoff e2e] This conversation was reset by AutoHandoff ({action}). Follow the handoff file.\n' >>"$S/autohandoff-chain.md"
    # budget / oversize：上限压到 4000（目标 3k），一份攒了几十节的交接文件必然超长
    write_config "$S/autohandoff-budget.md" clear "${REMIND:-52000}" "${URGE:-200000}" "${COMPACT:-900000}" "" true 4000
    write_config "$S/autohandoff-oversize.md" clear "${REMIND:-52000}" "${URGE:-200000}" "${COMPACT:-900000}" "" true 4000
    for k in remind urge; do
      printf '\n## %s\n\n[AutoHandoff: hand off] Context usage is about {used_k}k tokens. Finish the step in progress, then hand off before this turn ends: add a new dated section at the top of the handoff file with what is done, what is next and any open question (keep the older sections as they are), call the {tool} tool with its path, and end your turn.\n' "$k" >>"$S/autohandoff-oversize.md"
    done
    write_settings
    echo "initialized $S (config $S/autohandoff.md, settings $S/settings.json)"
    ;;
  start)
    name=${3:?session name}
    shift 3
    mkdir -p "$S/logs"
    # 参数逐个加引号后拼进 tmux 的命令行
    extra=""
    for a in "$@"; do extra+=" $(printf '%q' "$a")"; done
    run="${AH_ENV:+$AH_ENV }AH_HOOKLOG=$(printf '%q' "$S/logs/$name.hooks.jsonl") AUTOHANDOFF_DISABLE=1 AUTOHANDOFF_CONFIG=$(printf '%q' "${AH_CONFIG:-$S/autohandoff.md}") claude --plugin-dir $(printf '%q' "${PLUGIN_DIR:-$HERE}") \
--settings $(printf '%q' "$S/settings.json") --debug-file $(printf '%q' "$S/logs/$name.debug.log") --model ${MODEL:-sonnet}$extra"
    if tmux -L "$SOCK" has-session -t T 2>/dev/null; then
      tmux -L "$SOCK" new-window -t T -n "$name" -c "$S/proj" "$run"
    else
      env -i HOME="$HOME" PATH="$PATH" TERM=xterm-256color LANG=C.UTF-8 SHELL=/bin/bash USER="$USER" \
        tmux -L "$SOCK" -f /dev/null new-session -d -s T -n "$name" -x 200 -y 50 -c "$S/proj" "$run"
    fi
    echo "started $name: tmux -L $SOCK, window T:$name"
    ;;
  stop)
    tmux -L "$SOCK" kill-server 2>/dev/null || true
    echo "stopped tmux server $SOCK"
    ;;
  *)
    echo "unknown command $cmd" >&2
    exit 2
    ;;
esac
