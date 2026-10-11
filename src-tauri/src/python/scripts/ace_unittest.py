"""Ace unittest runner (same event protocol as ace_pytest.py).  Usage: python ace_unittest.py [-s DIR] [-p PATTERN] [names...]"""
import inspect
import json
import os
import sys
import time
import traceback
import unittest

_FD = os.dup(1)
_MARK = "\x1e##ace:"


def emit(kind, **kw):
    kw["k"] = kind
    data = (_MARK + json.dumps(kw, ensure_ascii=False) + "\n").encode("utf-8", "replace")
    os.write(_FD, data)


def iter_tests(suite):
    for t in suite:
        if isinstance(t, unittest.TestSuite):
            yield from iter_tests(t)
        else:
            yield t


def info(t):
    cls = type(t)
    mid = getattr(t, "_testMethodName", "")
    try:
        file = inspect.getsourcefile(cls) or ""
    except Exception:
        file = ""
    line = 1
    try:
        line = inspect.getsourcelines(getattr(cls, mid))[1]
    except Exception:
        pass
    rel = os.path.relpath(file) if file else cls.__module__
    return "%s::%s::%s" % (rel, cls.__name__, mid), mid, file, line


class Result(unittest.TextTestResult):
    def startTest(self, test):
        super().startTest(test)
        self._t0 = time.time()
        self._buf_len = 0
        emit("start", id=info(test)[0])

    def _done(self, test, outcome, err=None, reason=""):
        tid, _, file, line = info(test)
        longrepr = "".join(traceback.format_exception(*err)) if err else ""
        message = reason or (str(err[1]).splitlines()[0] if err and str(err[1]) else (err[0].__name__ if err else ""))
        emit("result", id=tid, outcome=outcome, duration=time.time() - self._t0, message=message, longrepr=longrepr,
             output="", file=file, line=line)

    def addSuccess(self, test):
        super().addSuccess(test)
        self._done(test, "passed")

    def addFailure(self, test, err):
        super().addFailure(test, err)
        self._done(test, "failed", err)

    def addError(self, test, err):
        super().addError(test, err)
        self._done(test, "error", err)

    def addSkip(self, test, reason):
        super().addSkip(test, reason)
        self._done(test, "skipped", None, reason)

    def addExpectedFailure(self, test, err):
        super().addExpectedFailure(test, err)
        self._done(test, "xfailed", err)

    def addUnexpectedSuccess(self, test):
        super().addUnexpectedSuccess(test)
        self._done(test, "xpassed")


def main(argv):
    start, pattern, names = None, "test*.py", []
    i = 0
    while i < len(argv):
        if argv[i] == "-s":
            start = argv[i + 1]; i += 2
        elif argv[i] == "-p":
            pattern = argv[i + 1]; i += 2
        else:
            names.append(argv[i]); i += 1
    sys.path.insert(0, os.getcwd())
    loader = unittest.TestLoader()
    if names:
        suite = loader.loadTestsFromNames(names)
    else:
        suite = loader.discover(start or ".", pattern=pattern, top_level_dir=os.getcwd())
    emit("collected", items=[dict(zip(("id", "name", "file", "line"), info(t))) for t in iter_tests(suite)])
    res = unittest.TextTestRunner(resultclass=Result, verbosity=1, stream=sys.stderr).run(suite)
    emit("done", exitstatus=0 if res.wasSuccessful() else 1)
    return 0 if res.wasSuccessful() else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
