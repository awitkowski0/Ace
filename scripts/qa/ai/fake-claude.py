#!/usr/bin/env python3
"""Fake `claude` for scripts/qa/ai.mjs: never talks to any API. Accepts --settings <file-or-json>, --resume <id>, -c, ...,
prints a banner and then reads commands from stdin (the test types them into the terminal):
  prompt          run the UserPromptSubmit hooks
  stop [text]     append an assistant end_turn record to the transcript, run the Stop hooks
  ask [question]  append an AskUserQuestion tool_use record, run the Notification hooks (permission_prompt)
  perm            run the Notification hooks only (permission request for Bash)
  idle            run the Notification hooks with notification_type idle_prompt
  exit            quit
Hooks run like Claude Code runs them: `sh -c <command>`, JSON payload on stdin, cwd = session cwd."""
import json, os, subprocess, sys, time, uuid

args = sys.argv[1:]
settings = None
sid = None
for i, a in enumerate(args):
    if a == "--settings" and i + 1 < len(args):
        settings = args[i + 1]
    if a in ("--resume", "-r") and i + 1 < len(args):
        sid = args[i + 1]
sid = sid or str(uuid.uuid4())
cfg = {}
if settings:
    cfg = json.loads(settings) if settings.lstrip().startswith("{") else json.load(open(settings))
hooks = cfg.get("hooks", {})
cwd = os.getcwd()
here = os.path.dirname(os.path.realpath(__file__))
root = os.environ.get("ATELIER_CLAUDE_PROJECTS") or os.path.join(here, "transcripts")
folder = "".join(c if c.isalnum() else "-" for c in cwd)
tdir = os.path.join(root, folder)
os.makedirs(tdir, exist_ok=True)
tpath = os.path.join(tdir, sid + ".jsonl")

def now():
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()) + ".%03dZ" % (int(time.time() * 1000) % 1000)

def rec(**kw):
    kw.update(sessionId=sid, cwd=cwd, uuid=str(uuid.uuid4()), timestamp=now())
    with open(tpath, "a") as f:
        f.write(json.dumps(kw) + "\n")

def fire(event, **extra):
    payload = dict(session_id=sid, transcript_path=tpath, cwd=cwd, hook_event_name=event, **extra)
    for group in hooks.get(event, []):
        for h in group.get("hooks", []):
            if h.get("type") == "command":
                subprocess.run(h["command"], shell=True, input=json.dumps(payload, indent=2).encode(), timeout=h.get("timeout", 60))

with open(os.environ.get("ATELIER_FAKE_ARGS") or os.path.join(here, "args.log"), "a") as f:
    f.write(json.dumps({"argv": args, "sid": sid, "env_hook_file": os.environ.get("ATELIER_HOOK_FILE"), "pane": os.environ.get("ATELIER_PANE"), "cwd": cwd}) + "\n")
if not os.path.exists(tpath):
    rec(type="user", message={"role": "user", "content": "fake session " + sid[:8]})
    rec(type="ai-title", aiTitle="Fake session " + sid[:8])
print("FAKE-CLAUDE-START sid=%s hooks=%s" % (sid, ",".join(sorted(hooks))), flush=True)
for line in sys.stdin:
    cmd, _, rest = line.strip().partition(" ")
    if cmd == "prompt":
        rec(type="user", message={"role": "user", "content": rest or "do the thing"})
        fire("UserPromptSubmit", prompt=rest or "do the thing")
    elif cmd == "stop":
        rec(type="assistant", message={"role": "assistant", "stop_reason": "end_turn", "content": [{"type": "text", "text": rest or "All done, tests are green."}]})
        fire("Stop", stop_hook_active=False)
    elif cmd == "ask":
        rec(type="assistant", message={"role": "assistant", "stop_reason": "tool_use", "content": [{"type": "tool_use", "name": "AskUserQuestion", "id": "t1", "input": {"questions": [{"question": rest or "Which database should I use?", "options": []}]}}]})
        fire("Notification", message="Claude needs your permission to use AskUserQuestion", notification_type="permission_prompt")
    elif cmd == "perm":
        fire("Notification", message="Claude needs your permission to use Bash", notification_type="permission_prompt")
    elif cmd == "idle":
        fire("Notification", message="Claude is waiting for your input", notification_type="idle_prompt")
    elif cmd == "exit":
        break
    print("FAKE-CLAUDE-DONE %s" % cmd, flush=True)
