#!/bin/sh
set -eu
cat > "${TASK_APP:-/app}/stats.py" <<'PYTHON'
def summarize(values):
    if not values:
        return {"count": 0, "minimum": None, "maximum": None, "mean": None}
    return {"count": len(values), "minimum": min(values), "maximum": max(values), "mean": sum(values) / len(values)}
PYTHON
