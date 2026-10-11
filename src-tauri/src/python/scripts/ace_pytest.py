"""Ace pytest reporter plugin. Loaded with `-p ace_pytest` (PYTHONPATH points at its directory): nothing is installed into
the environment. Emits one JSON event per line on the REAL stdout, prefixed with \x1e##ace: , which Ace strips from the console.
Events: collected {items:[{id,name,file,line}]}, start {id}, result {id,outcome,duration,message,longrepr,output,file,line},
collect_error {id,longrepr}, done {exitstatus}."""
import json
import os
import time

_FD = os.dup(1)
_MARK = "\x1e##ace:"
_acc = {}


def _emit(kind, **kw):
    kw["k"] = kind
    try:
        data = (_MARK + json.dumps(kw, ensure_ascii=False) + "\n").encode("utf-8", "replace")
        view = memoryview(data)
        while view:
            n = os.write(_FD, view)
            view = view[n:]
    except Exception:
        pass


def pytest_collection_finish(session):
    items = []
    for it in session.items:
        try:
            path = str(getattr(it, "path", None) or it.fspath)
            line = (it.location[1] or 0) + 1
        except Exception:
            path, line = "", 1
        items.append({"id": it.nodeid, "name": it.name, "file": path, "line": line})
    _emit("collected", items=items)


def pytest_collectreport(report):
    if report.failed:
        _emit("collect_error", id=report.nodeid, longrepr=getattr(report, "longreprtext", str(report.longrepr)))


def pytest_runtest_logstart(nodeid, location):
    _acc[nodeid] = {"duration": 0.0, "outcome": "passed", "message": "", "longrepr": "", "output": []}
    _emit("start", id=nodeid)


def pytest_runtest_logreport(report):
    a = _acc.setdefault(report.nodeid, {"duration": 0.0, "outcome": "passed", "message": "", "longrepr": "", "output": []})
    a["duration"] += getattr(report, "duration", 0.0) or 0.0
    for name, content in getattr(report, "sections", []) or []:
        if content:
            a["output"].append("----- %s -----\n%s" % (name, content))
    if report.when == "setup":
        if report.failed:
            a["outcome"] = "error"
        elif report.skipped:
            a["outcome"] = "skipped"
    elif report.when == "call":
        if report.failed:
            a["outcome"] = "failed"
        elif report.skipped:
            a["outcome"] = "xfailed" if hasattr(report, "wasxfail") else "skipped"
        elif hasattr(report, "wasxfail"):
            a["outcome"] = "xpassed"
    elif report.when == "teardown" and report.failed and a["outcome"] == "passed":
        a["outcome"] = "error"
    if report.failed or report.skipped:
        try:
            a["longrepr"] = a["longrepr"] or report.longreprtext
            lr = report.longrepr
            if isinstance(lr, tuple):  # skipped: (file, line, reason)
                a["message"] = a["message"] or str(lr[2])
            else:
                crash = getattr(lr, "reprcrash", None)
                if crash is not None:
                    a["message"] = a["message"] or crash.message
        except Exception:
            pass
    if report.when == "teardown":
        a = _acc.pop(report.nodeid)
        loc = getattr(report, "location", None) or ("", 0, "")
        _emit("result", id=report.nodeid, outcome=a["outcome"], duration=a["duration"], message=a["message"],
              longrepr=a["longrepr"], output="\n".join(a["output"]), file=loc[0], line=(loc[1] or 0) + 1)


def pytest_sessionfinish(session, exitstatus):
    _emit("done", exitstatus=int(exitstatus))
