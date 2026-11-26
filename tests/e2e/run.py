#!/usr/bin/env python3
"""Run e2e scenarios in the real a09f desktop app.

    python3 tests/e2e/run.py                 # all scenarios
    python3 tests/e2e/run.py friends rooms   # just these (names from scenarios/)
    python3 tests/e2e/run.py --no-build ...  # skip `cargo build`

How it works (no source files are touched):
  1. `cargo build` builds the debug app with the UI embedded. Debug builds
     have two test hooks (desktop/src-tauri/src/lib.rs): `test_scenario`
     returns the file named by $A09F_TEST_SCENARIO, which app.js runs after
     loading; `test_log` prints "A09F-TEST {json}" to stderr.
  2. For each scenario: prelude.js + scenarios/<name>.js are written to a temp
     file, scenarios/<name>.peer.py (if any) starts as the other people
     (bob, …), and the app is launched with the env var set.
  3. The runner reads the checks from stderr until "done", "error" or the
     timeout, then stops the app and the peer.

The app window is brought to the front on macOS: WebKit slows down timers in
hidden windows, which makes scenarios crawl.

Needs the docker stack and the demo accounts (alice, bob, … / demo-1234).
"""

import json
import os
import subprocess
import sys
import tempfile
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
TAURI = os.path.join(REPO, "desktop", "src-tauri")
APP = os.path.join(TAURI, "target", "debug", "a09f-desktop")
SCEN = os.path.join(HERE, "scenarios")
TIMEOUT = int(os.environ.get("A09F_E2E_TIMEOUT", "420"))


def build():
    os.utime(os.path.join(TAURI, "build.rs"))          # re-embed ui/ (tauri only watches src-tauri)
    r = subprocess.run(["cargo", "build"], cwd=TAURI, capture_output=True, text=True)
    if r.returncode:
        print(r.stderr[-3000:])
        sys.exit("cargo build failed")


def bring_to_front(pid):
    if sys.platform == "darwin":
        subprocess.run(["osascript", "-e",
                        f'tell application "System Events" to set frontmost of (first process whose unix id is {pid}) to true'],
                       capture_output=True)


def run(name):
    print(f"\n=== {name}")
    with open(os.path.join(HERE, "prelude.js")) as f:
        prelude = f.read()
    with open(os.path.join(SCEN, f"{name}.js")) as f:
        body = f.read()
    tmp = tempfile.NamedTemporaryFile("w", suffix=".js", delete=False)
    tmp.write(prelude + "\n(async () => {\ntry {\n" + body +
              "\n} catch (e) { T.log({ type: 'error', text: String(e) + ' ' + (e.stack || '') }); }\n})();\n")
    tmp.close()

    peer = None
    peer_file = os.path.join(SCEN, f"{name}.peer.py")
    if os.path.exists(peer_file):
        env = {**os.environ, "PYTHONPATH": os.path.join(REPO, "tests", "lib")}
        peer = subprocess.Popen([sys.executable, peer_file], env=env,
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        time.sleep(3)                                  # let the peer sign in first

    env = {**os.environ, "A09F_TEST_SCENARIO": tmp.name}
    app = subprocess.Popen([APP], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
    threading.Timer(4, bring_to_front, args=(app.pid,)).start()

    passed = failed = skipped = 0
    result = "timeout"
    deadline = time.time() + TIMEOUT
    try:
        for line in app.stderr:
            if time.time() > deadline:
                break
            if not line.startswith("A09F-TEST "):
                continue
            ev = json.loads(line[len("A09F-TEST "):])
            t = ev.get("type")
            if t == "check":
                ok = ev["ok"]
                passed += ok
                failed += not ok
                print(f"  [{'PASS' if ok else 'FAIL'}] {ev['name']}" + ("" if ok else f"  ({ev.get('detail')})"))
            elif t == "skip":
                skipped += 1
                print(f"  [SKIP] {ev['name']}  ({ev.get('why')})")
            elif t == "note":
                print(f"  …  {ev['text']}")
            elif t == "error":
                print(f"  [ERROR] {ev.get('text')}")
                result = "error"
                break
            elif t == "done":
                result = "done"
                break
    finally:
        app.terminate()
        try:
            app.wait(5)
        except subprocess.TimeoutExpired:
            app.kill()
        if peer:
            peer.terminate()
            out = peer.communicate(timeout=5)[0] if peer.stdout else ""
            if out.strip() and (failed or result != "done"):
                print("  --- peer output ---\n" + "\n".join("  " + l for l in out.strip().splitlines()[-15:]))
        os.unlink(tmp.name)
    ok = result == "done" and failed == 0
    print(f"--- {name}: {passed} passed, {failed} failed, {skipped} skipped" + ("" if result == "done" else f" [{result}]"))
    return ok


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if "--no-build" not in sys.argv:
        build()
    names = args or sorted(f[:-3] for f in os.listdir(SCEN) if f.endswith(".js"))
    results = {n: run(n) for n in names}
    print("\n" + "\n".join(f"{'OK  ' if ok else 'FAIL'} {n}" for n, ok in results.items()))
    sys.exit(0 if all(results.values()) else 1)


if __name__ == "__main__":
    main()
