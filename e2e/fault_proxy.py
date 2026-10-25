#!/usr/bin/env python3
"""端到端测试用：本地反代到 api.anthropic.com，按 mode 文件往主回合的请求里注入 API 错误。

用法：fault_proxy.py <端口> <mode 文件>
  测试对话起 claude 时加环境变量 ANTHROPIC_BASE_URL=http://127.0.0.1:<端口> CLAUDE_CODE_MAX_RETRIES=0
mode 文件内容（每个请求都重读）：
  pass          原样转发
  500 / 529     返回 500 / 529（overloaded）
  429           服务端限流（不是额度用尽）
  quota[:秒]    额度用尽：429 + anthropic-ratelimit-unified-* 响应头（status=rejected，reset=现在+秒，默认 120），
                CC 会生成和真实一样的错误记录（quotaLimits.status=rejected），并在 reset 后自己续跑
  前面加「N*」只注入接下来的 N 个请求，之后改回 pass（如 1*500）
  after:<工具名>:<mode>  等到某个请求是在交回该工具的结果（最后一条消息里的 tool_result 对应上一条里这个名字的 tool_use），
                只对这一个请求注入一次 mode，之后改回 pass（如 after:mcp__autohandoff__register_handoff:500）
只对带 tools 的请求注入（主回合的请求；起标题之类的旁路请求不带 tools），其余照常转发。不记录请求内容。
"""
import http.server
import json
import sys
import time
import urllib.error
import urllib.request

UPSTREAM = "https://api.anthropic.com"
PORT, MODE_FILE = int(sys.argv[1]), sys.argv[2]
HOP = ("transfer-encoding", "connection", "content-length", "host", "accept-encoding")


def answers_tool(req, name):
    """这个请求是不是在交回工具 name 的结果"""
    msgs = req.get("messages") or []
    if len(msgs) < 2 or not isinstance(msgs[-1].get("content"), list) or not isinstance(msgs[-2].get("content"), list):
        return False
    ids = {b.get("tool_use_id") for b in msgs[-1]["content"] if isinstance(b, dict) and b.get("type") == "tool_result"}
    return any(isinstance(b, dict) and b.get("type") == "tool_use" and b.get("name") == name and b.get("id") in ids for b in msgs[-2]["content"])


def take_mode(req):
    """读 mode；「N*mode」用掉一次，减到 0 写回 pass；「after:工具:mode」对上了才用、用一次。"""
    try:
        with open(MODE_FILE) as f:
            mode = f.read().strip() or "pass"
    except OSError:
        return "pass"
    if mode.startswith("after:"):
        _, name, m = mode.split(":", 2)
        if not answers_tool(req, name):
            return "pass"
        with open(MODE_FILE, "w") as f:
            f.write("pass")
        return m
    if "*" in mode:
        n, m = mode.split("*", 1)
        left = int(n) - 1
        with open(MODE_FILE, "w") as f:
            f.write(f"{left}*{m}" if left > 0 else "pass")
        return m
    return mode


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _error(self, code, etype, msg, headers=()):
        body = json.dumps({"type": "error", "error": {"type": etype, "message": msg}}).encode()
        self.send_response(code)
        for k, v in (("Content-Type", "application/json"), ("Content-Length", str(len(body))),
                     ("request-id", "req_fault_proxy"), *headers):
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        main = False
        req = {}
        try:
            req = json.loads(body)
            main = bool(req.get("tools"))
        except ValueError:
            pass
        mode = take_mode(req) if main and self.path.startswith("/v1/messages") else "pass"
        if mode == "500":
            return self._error(500, "api_error", "Internal server error")
        if mode == "529":
            return self._error(529, "overloaded_error", "Overloaded")
        if mode == "429":
            return self._error(429, "rate_limit_error", "Server is temporarily limiting requests (not your usage limit)",
                               [("retry-after", "30")])
        if mode.startswith("quota"):
            reset = str(int(time.time()) + int(mode.split(":", 1)[1] if ":" in mode else 120))
            return self._error(429, "rate_limit_error", "Rate limited", [
                ("anthropic-ratelimit-unified-status", "rejected"), ("anthropic-ratelimit-unified-reset", reset),
                ("anthropic-ratelimit-unified-5h-status", "rejected"), ("anthropic-ratelimit-unified-5h-reset", reset),
                ("anthropic-ratelimit-unified-representative-claim", "five_hour")])
        self._forward(body)

    def _forward(self, body):
        hdrs = {k: v for k, v in self.headers.items() if k.lower() not in HOP}
        req = urllib.request.Request(UPSTREAM + self.path, body if self.command == "POST" else None, hdrs,
                                     method=self.command)
        try:
            r = urllib.request.urlopen(req, timeout=900)
        except urllib.error.HTTPError as e:
            r = e
        self.send_response(r.status if hasattr(r, "status") else r.code)
        for k, v in r.headers.items():
            if k.lower() not in HOP:
                self.send_header(k, v)
        self.send_header("Transfer-Encoding", "chunked")
        self.end_headers()
        while True:
            chunk = r.read1(65536) if hasattr(r, "read1") else r.read(65536)
            if not chunk:
                break
            self.wfile.write(b"%x\r\n%s\r\n" % (len(chunk), chunk))
            self.wfile.flush()
        self.wfile.write(b"0\r\n\r\n")

    def do_GET(self):
        self._forward(b"")

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    http.server.ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
