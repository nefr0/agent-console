import importlib.util
import json
import os
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "candidate", Path(os.environ.get("TASK_APP", "/app")) / "convert.py"
)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
cases = [
    ("", ""),
    (" \n\n", ""),
    (
        '{"id":"z","value":3}\n{"id":"a"}\n{"id":"z","value":"é","extra":4}\n',
        [{"id": "a", "value": None}, {"id": "z", "value": "é"}],
    ),
    (
        '{"id":"b","value":false}\n{"id":"a","value":0}',
        [{"id": "a", "value": 0}, {"id": "b", "value": False}],
    ),
]
for source, expected in cases:
    actual = module.convert(source)
    if isinstance(expected, list):
        # JSON Unicode escaping is permitted; structure, ordering, spacing and newline are not.
        assert actual.endswith("\n") and len(actual.splitlines()) == len(expected), actual
        assert [json.loads(line) for line in actual.splitlines()] == expected, actual
        assert all(
            line
            == json.dumps(
                json.loads(line), sort_keys=True, separators=(",", ":"), ensure_ascii=False
            )
            or line == json.dumps(json.loads(line), sort_keys=True, separators=(",", ":"))
            for line in actual.splitlines()
        ), actual
    else:
        assert actual == expected, repr(actual)
