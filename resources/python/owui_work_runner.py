"""Run a Work mode script under a guard.

Usage: python owui_work_runner.py <script.py> [args...]

The desktop runs every agent script through this file.  A PEP 578 audit
hook (which Python code cannot remove) enforces the project's limits:

* writes, deletes and renames only inside the project folder (or the temp
  folder); in read-only projects only the temp folder is writable
* no reading of other files in the user's home folder — only the project,
  the skill folders, this Python installation and the temp folder
* no child processes and no network connections

This protects against scripts that go wrong or were talked into doing
something by a document.  It is not a sandbox against deliberately
malicious native code (ctypes / C extensions can bypass audit hooks).

Environment:
  OWUI_WORK_ROOT        project folder (also the working directory)
  OWUI_WORK_WRITE       "1" if the project allows changes
  OWUI_WORK_READ_ROOTS  JSON list of extra readable folders
"""

import json
import os
import runpy
import sys
import tempfile
import threading

_CASE_INSENSITIVE = os.name == "nt" or sys.platform == "darwin"


def _norm(p):
    if isinstance(p, int):  # file descriptor
        return None
    try:
        p = os.fspath(p)
    except TypeError:
        return None
    if isinstance(p, bytes):
        p = os.fsdecode(p)
    p = os.path.realpath(os.path.abspath(p))
    return os.path.normcase(p) if _CASE_INSENSITIVE else p


def _inside(path, roots):
    for root in roots:
        if not root:
            continue
        try:
            if os.path.commonpath([path, root]) == root:
                return True
        except ValueError:  # different drives on Windows
            continue
    return False


ROOT = _norm(os.environ["OWUI_WORK_ROOT"])
WRITE = os.environ.get("OWUI_WORK_WRITE") == "1"
TEMP = _norm(tempfile.gettempdir())
HOME = _norm(os.path.expanduser("~"))
PYTHON = [_norm(p) for p in {sys.prefix, sys.base_prefix, sys.exec_prefix}]
READ_ROOTS = [_norm(p) for p in json.loads(os.environ.get("OWUI_WORK_READ_ROOTS") or "[]")]

HELPERS = _norm(os.path.dirname(os.path.abspath(__file__)))  # owui_work lives here

WRITABLE = ([ROOT] if WRITE else []) + [TEMP]
READABLE = [ROOT, TEMP, HELPERS] + PYTHON + READ_ROOTS

_WRITE_FLAGS = 0
for _name in ("O_WRONLY", "O_RDWR", "O_CREAT", "O_APPEND", "O_TRUNC"):
    _WRITE_FLAGS |= getattr(os, _name, 0)

_PATH_WRITE_EVENTS = {
    "os.remove": (0,),
    "os.rmdir": (0,),
    "os.mkdir": (0,),
    "os.chmod": (0,),
    "os.chown": (0,),
    "os.truncate": (0,),
    "os.utime": (0,),
    "os.rename": (0, 1),
    "os.link": (0, 1),
    "os.symlink": (0, 1),
    "shutil.rmtree": (0,),
    "shutil.copyfile": (1,),
    "shutil.copytree": (1,),
    "shutil.move": (0, 1),
    "shutil.chown": (0,),
    "shutil.make_archive": (0,),
    "shutil.unpack_archive": (1,),
}

_BLOCKED_EVENTS = {
    "subprocess.Popen": "starting other programs",
    "os.system": "starting other programs",
    "os.exec": "starting other programs",
    "os.spawn": "starting other programs",
    "os.posix_spawn": "starting other programs",
    "os.startfile": "opening files in other programs",
    "os.fork": "starting other processes",
    "os.forkpty": "starting other processes",
    "os.kill": "signalling other processes",
    "socket.connect": "network access",
    "socket.bind": "network access",
    "socket.getaddrinfo": "network access",
    "socket.gethostbyname": "network access",
    "urllib.Request": "network access",
    "webbrowser.open": "opening a web browser",
}

_state = threading.local()


def _deny(message):
    raise PermissionError(f"Blocked by Work mode: {message}")


def _check_write(target):
    path = _norm(target)
    if path is None:
        return
    if not _inside(path, WRITABLE):
        where = "the project is read-only" if not WRITE and _inside(path, [ROOT]) else "outside the project folder"
        _deny(f"cannot change {os.fspath(target)!s} ({where})")


def _check_read(target):
    path = _norm(target)
    if path is None:
        return
    # System locations (fonts, shared libraries) stay readable; only the
    # user's own files outside the project are off limits.
    if _inside(path, [HOME]) and not _inside(path, READABLE):
        _deny(f"cannot read {os.fspath(target)!s} (outside the project folder)")


def _hook(event, args):
    if getattr(_state, "busy", False):
        return
    _state.busy = True
    try:
        if event == "open":
            target, mode, flags = (list(args) + [None, None, None])[:3]
            writing = (isinstance(mode, str) and any(c in mode for c in "wax+")) or (
                isinstance(flags, int) and flags & _WRITE_FLAGS
            )
            if writing:
                _check_write(target)
            else:
                _check_read(target)
        elif event in ("os.listdir", "os.scandir"):
            if args and args[0] is not None:
                _check_read(args[0])
        elif event in _PATH_WRITE_EVENTS:
            for index in _PATH_WRITE_EVENTS[event]:
                if index < len(args) and args[index] is not None:
                    _check_write(args[index])
        elif event in _BLOCKED_EVENTS:
            _deny(_BLOCKED_EVENTS[event] + " is not allowed")
    finally:
        _state.busy = False


def main():
    if len(sys.argv) < 2:
        print("usage: owui_work_runner.py <script.py> [args...]", file=sys.stderr)
        sys.exit(2)
    script = os.path.abspath(sys.argv[1])
    # Helpers (owui_work) live next to this file
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    os.chdir(os.environ["OWUI_WORK_ROOT"])
    sys.argv = [script] + sys.argv[2:]
    sys.addaudithook(_hook)
    runpy.run_path(script, run_name="__main__")


if __name__ == "__main__":
    main()
