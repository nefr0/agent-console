#!/bin/sh
set -eu
cat > "${TASK_APP:-/app}/convert.py" <<'PYTHON'
import json

def convert(lines):
    records = {}
    for line in lines.splitlines():
        if line.strip():
            record = json.loads(line)
            records[record["id"]] = {"id": record["id"], "value": record.get("value")}
    return "".join(json.dumps(records[key], sort_keys=True, separators=(",", ":"), ensure_ascii=False) + "\n" for key in sorted(records))
PYTHON
