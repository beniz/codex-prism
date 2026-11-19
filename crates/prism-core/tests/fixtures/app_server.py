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
threads = {}
thread_id = "thread-1"
next_thread = 1
approvals = {}
questions = {}
def send(value):
    print(json.dumps(value), flush=True)
def event(method, params):
    send({"method": method, "params": params})
def complete():
    event("turn/completed", {"threadId":thread_id, "turn":{"id":"turn-1"}})
for line in sys.stdin:
    request = json.loads(line)
    with (base / "requests.jsonl").open("a") as log:
        log.write(json.dumps(request) + "\n")
    method = request.get("method")
    args = request.get("params", {})
    if method is None:
        if request.get("id") in questions:
            thread_id = questions.pop(request["id"])
            event("serverRequest/resolved", {"threadId":thread_id, "requestId":901})
            complete()
        if request.get("id") in approvals:
            thread_id = approvals.pop(request["id"])
            root = threads[thread_id]
            (root / "main.tex").write_text("approved edit")
            event("serverRequest/resolved", {"threadId":thread_id, "requestId":900})
            complete()
        continue
    if "id" not in request:
        continue
    if "threadId" in args:
        thread_id = args["threadId"]
        root = threads.get(thread_id, root)
    result = {}
    if method == "account/read":
        result = {"account":None,"requiresOpenaiAuth":False}
    elif method == "collaborationMode/list":
        result = {"data":[{"mode":"plan"}]}
    elif method == "model/list":
        result = {"data":[]}
    elif method in ("thread/start", "thread/resume"):
        root = Path(args["cwd"])
        if (root / "fail-start").exists():
            send({"id":request["id"],"error":{"message":"fixture start rejected"}})
            continue
        if method == "thread/start":
            thread_id = f"thread-{next_thread}"
            next_thread += 1
        threads[thread_id] = root
        result = {"thread":{"id":thread_id}, "model":"fixture-model"}
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
        event("turn/started", {"threadId":thread_id,"turn":{"id":"turn-1"}})
        event("item/agentMessage/delta", {"threadId":thread_id,"delta":"hello"})
        if mode == "plan-question" and args.get("collaborationMode", {}).get("mode") == "plan":
            questions[901] = thread_id
            send({"id":901,"method":"item/tool/requestUserInput","params":{"threadId":thread_id,
                "turnId":"turn-1","itemId":"question-1","isBlocking":True,"autoResolutionMs":None,
                "questions":[{"id":"audience","header":"Audience","question":"Who will read it?",
                "isOther":True,"isSecret":False,"options":[{"label":"Students","description":"Introductory"}]}]}})
        elif mode == "approval":
            approvals[900] = thread_id
            send({"id":900,"method":"item/commandExecution/requestApproval","params":{"threadId":thread_id,"turnId":"turn-1","command":"fixture","sandboxPermissions":"use_default"}})
        else:
            (root / "main.tex").write_text("running edit")
    elif method == "turn/interrupt":
        complete()
