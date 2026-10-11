"""Ace Python Console backend. Requests are JSON lines on stdin:
  {"id":N,"code":"..."}   run a cell (the last expression statement prints its repr, like the REPL / IPython)
  {"id":N,"check":"..."}  is the text a complete statement?   ->  {"k":"check","status":"complete"|"incomplete"|"invalid","indent":N}
  {"id":N,"vars":true}    ->  {"k":"vars","vars":[{name,type,repr}]}
Output is plain text on stdout (stderr is merged into it, red). Control events use the \x1e##ace: prefix; every request ends with
{"k":"done","id":N}. Uses IPython when it is importable in the interpreter, else the standard library."""
import ast
import codeop
import json
import os
import sys
import traceback

_REAL = sys.__stdout__
_MARK = "\x1e##ace:"
_RED, _RESET = "\x1b[31m", "\x1b[0m"


def ev(kind, **kw):
    kw["k"] = kind
    _REAL.write(_MARK + json.dumps(kw, ensure_ascii=False) + "\n")
    _REAL.flush()


class _Err:
    encoding = "utf-8"

    def write(self, s):
        if s:
            _REAL.write(_RED + s + _RESET if not s.endswith("\n") else _RED + s[:-1] + _RESET + "\n")
            _REAL.flush()
        return len(s)

    def flush(self):
        _REAL.flush()

    def isatty(self):
        return False


sys.stderr = _Err()
sys.path.insert(0, os.getcwd())

_ipy = None
if not os.environ.get("ACE_NO_IPYTHON"):
    try:
        from IPython.core.interactiveshell import InteractiveShell

        _ipy = InteractiveShell.instance()
        _ipy.run_line_magic("colors", "nocolor")
    except Exception:
        _ipy = None

_ns = {"__name__": "__main__", "__doc__": None}
_compile = codeop.CommandCompiler()


def run_std(code):
    try:
        tree = ast.parse(code, "<console>", "exec")
    except SyntaxError:
        traceback.print_exc(limit=0)
        return
    body = tree.body
    try:
        if body and isinstance(body[-1], ast.Expr):
            last = body.pop()
            exec(compile(ast.Module(body, []), "<console>", "exec"), _ns)
            exec(compile(ast.Interactive([last]), "<console>", "single"), _ns)
        else:
            exec(compile(tree, "<console>", "exec"), _ns)
    except SystemExit:
        raise
    except KeyboardInterrupt:
        sys.stderr.write("KeyboardInterrupt\n")
    except BaseException:
        et, e, tb = sys.exc_info()
        traceback.print_exception(et, e, tb.tb_next if tb else tb)


def run(code):
    if _ipy is not None:
        _ipy.run_cell(code, store_history=True)
    else:
        run_std(code)


def check(code):
    if _ipy is not None:
        status, indent = _ipy.input_transformer_manager.check_complete(code)
        return status, len(indent or "")
    try:
        c = _compile(code, "<console>", "exec")
        return ("incomplete" if c is None else "complete"), 0
    except (SyntaxError, ValueError, OverflowError):
        return "invalid", 0


def variables():
    ns = _ipy.user_ns if _ipy is not None else _ns
    out = []
    for k, v in list(ns.items()):
        if k.startswith("_") or k in ("In", "Out", "exit", "quit", "get_ipython", "open") or type(v).__name__ in ("module", "builtin_function_or_method"):
            continue
        try:
            r = repr(v)
        except Exception:
            r = "<unprintable>"
        out.append({"name": k, "type": type(v).__name__, "repr": r[:300]})
    return sorted(out, key=lambda d: d["name"])


def main():
    print("Python %s on %s%s" % (sys.version.split()[0], sys.platform, " (IPython %s)" % __import__("IPython").__version__ if _ipy else ""))
    ev("ready", ipython=_ipy is not None, executable=sys.executable, cwd=os.getcwd())
    while True:
        try:
            line = sys.stdin.readline()
        except KeyboardInterrupt:  # Ctrl+C while idle must not kill the console
            continue
        if not line:
            break
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception:
            continue
        rid = req.get("id")
        try:
            if "check" in req:
                status, indent = check(req["check"])
                ev("check", id=rid, status=status, indent=indent)
            elif req.get("vars"):
                ev("vars", id=rid, vars=variables())
            elif "code" in req:
                run(req["code"])
        except SystemExit:
            ev("done", id=rid, exit=True)
            return
        except BaseException:
            traceback.print_exc()
        sys.stdout.flush()
        ev("done", id=rid)


main()
