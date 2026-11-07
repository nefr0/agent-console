import importlib.util
import os
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "candidate", Path(os.environ.get("TASK_APP", "/app")) / "stats.py"
)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
for values, expected in [
    ([], (0, None, None, None)),
    ([-7, -2, -9], (3, -9, -2, -6)),
    ([0], (1, 0, 0, 0)),
    ([4, -4, 9, 3], (4, -4, 9, 3)),
]:
    actual = module.summarize(values)
    assert actual == dict(zip(("count", "minimum", "maximum", "mean"), expected, strict=True)), (
        values,
        actual,
    )
