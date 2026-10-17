"""Lists the models a Codex app-server offers, the way the chat adapter (codex-acp) sees them.

Starts `<command> app-server`, asks `model/list`, prints the ids and exits. Nothing is
sent to any model provider, so it costs no quota.

    python3 -I docs/plans/tools/codex-model-list.py codex
    EMDASH_CODEX_MODEL_CATALOG=/path/catalog.json \\
      python3 -I docs/plans/tools/codex-model-list.py ~/.codex/emdash-codex-app-server.sh
"""

import json
import subprocess
import sys
import threading
import time

command = [sys.argv[1] if len(sys.argv) > 1 else "codex", "app-server"]
proc = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
assert proc.stdin is not None and proc.stdout is not None
stdin, stdout = proc.stdin, proc.stdout
lines: list[str] = []
threading.Thread(target=lambda: [lines.append(raw.decode()) for raw in stdout], daemon=True).start()


def send(message: dict) -> None:
    stdin.write((json.dumps(message) + "\n").encode())
    stdin.flush()


send({"id": 1, "method": "initialize", "params": {"clientInfo": {"name": "probe", "version": "0"}}})
time.sleep(2)
send({"method": "initialized"})
send({"id": 2, "method": "model/list", "params": {}})
time.sleep(5)
proc.kill()

for line in lines:
    message = json.loads(line)
    if message.get("id") != 2:
        continue
    result = message.get("result") or {}
    models = result.get("data") or result.get("models") or []
    print(json.dumps([model.get("id") or model.get("model") for model in models]))
    break
else:
    print("no model/list answer", file=sys.stderr)
    sys.exit(1)
