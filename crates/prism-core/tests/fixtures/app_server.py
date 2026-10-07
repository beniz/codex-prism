#!/usr/bin/env python3
"""Local deterministic protocol fixture; never contacts a model or credential store."""
import json
import os
from pathlib import Path
import sys

base = Path(__file__).parent
if "--version" in sys.argv:
    print("prism-test-server 1")
    sys.exit(0)
(base / "server.pid").write_text(str(os.getpid()))
root = None
mode = ""
def send(value):
    print(json.dumps(value), flush=True)
def event(method, params):
    send({"method": method, "params": params})
def complete():
    event("turn/completed", {"threadId":"thread-1", "turn":{"id":"turn-1"}})
for line in sys.stdin:
    request = json.loads(line)
    with (base / "requests.jsonl").open("a") as log:
        log.write(json.dumps(request) + "\n")
    method = request.get("method")
    args = request.get("params", {})
    if method is None:
        if request.get("id") == 900:
            (root / "main.tex").write_text("approved edit")
            event("serverRequest/resolved", {"threadId":"thread-1", "requestId":900})
            complete()
        continue
    if "id" not in request:
        continue
    result = {}
    if method == "account/read":
        result = {"account":None,"requiresOpenaiAuth":False}
    elif method == "model/list":
        result = {"data":[]}
    elif method in ("thread/start", "thread/resume"):
        root = Path(args["cwd"])
        if (root / "fail-start").exists():
            send({"id":request["id"],"error":{"message":"fixture start rejected"}})
            continue
        result = {"thread":{"id":"thread-1"}}
    elif method == "turn/start":
        mode = args["input"][0]["text"]
        if mode == "exit":
            sys.exit(7)
        if mode == "hang-request":
            continue
        result = {"turn":{"id":"turn-1"}}
    elif method == "thread/read":
        result = {"thread":{"id":"thread-1","turns":[]}}
    send({"id":request["id"],"result":result})
    if method == "turn/start":
        event("turn/started", {"threadId":"thread-1","turn":{"id":"turn-1"}})
        event("item/agentMessage/delta", {"threadId":"thread-1","delta":"hello"})
        if mode == "approval":
            send({"id":900,"method":"item/commandExecution/requestApproval","params":{"threadId":"thread-1","turnId":"turn-1","command":"fixture"}})
        else:
            (root / "main.tex").write_text("running edit")
    elif method == "turn/interrupt":
        complete()
