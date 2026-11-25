"""Drive a headless Firefox over WebDriver BiDi: load a URL, right-click an element, report state.
Usage: uv run --with websockets tools/ff-bidi.py URL SELECTOR JS_EXPR [JS_SETUP]"""
import asyncio, json, os, shutil, subprocess, sys, tempfile, time
import websockets

URL, SEL, EXPR = sys.argv[1:4]
SETUP = sys.argv[4] if len(sys.argv) > 4 else ""


async def main():
    prof = tempfile.mkdtemp(prefix="ffbidi-")
    port = 9233
    ff = subprocess.Popen(["firefox", "--headless", "--no-remote", "--profile", prof,
                           f"--remote-debugging-port={port}", "--width=1920", "--height=1050"],
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        for _ in range(60):
            try:
                ws = await websockets.connect(f"ws://127.0.0.1:{port}/session", max_size=None)
                break
            except OSError:
                time.sleep(0.5)
        n = 0

        async def cmd(method, params):
            nonlocal n
            n += 1
            await ws.send(json.dumps({"id": n, "method": method, "params": params}))
            while True:
                m = json.loads(await ws.recv())
                if m.get("id") == n:
                    if m.get("type") == "error":
                        raise RuntimeError(m)
                    return m["result"]

        await cmd("session.new", {"capabilities": {}})
        ctx = (await cmd("browsingContext.getTree", {}))["contexts"][0]["context"]
        await cmd("browsingContext.navigate", {"context": ctx, "url": URL, "wait": "complete"})
        await asyncio.sleep(5)

        async def ev(js):
            r = await cmd("script.evaluate", {"expression": js, "target": {"context": ctx}, "awaitPromise": True})
            return r["result"].get("value")

        if SETUP:
            await ev(SETUP)
        rect = json.loads(await ev(f"JSON.stringify(document.querySelector({json.dumps(SEL)}).getBoundingClientRect())"))
        x, y = int(rect["x"] + rect["width"] / 2), int(rect["y"] + rect["height"] / 2)
        await cmd("input.performActions", {"context": ctx, "actions": [{
            "type": "pointer", "id": "mouse", "parameters": {"pointerType": "mouse"},
            "actions": [{"type": "pointerMove", "x": x, "y": y},
                        {"type": "pointerDown", "button": 2}, {"type": "pointerUp", "button": 2}]}]})
        await asyncio.sleep(1.5)
        print("result:", await ev(EXPR))
        await ws.close()
    finally:
        ff.terminate()
        ff.wait(10)
        shutil.rmtree(prof, ignore_errors=True)


asyncio.run(main())
