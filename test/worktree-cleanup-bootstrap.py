"""Test-only engine launcher with deterministic process inventory."""

import argparse
import importlib.util
from pathlib import Path

ENGINE = Path(__file__).resolve().parents[1] / "scripts/worktree-cleanup-engine.py"
SPEC = importlib.util.spec_from_file_location("cleanup_engine", ENGINE)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--process-path", action="append", default=[])
    parser.add_argument("--fail-process-scan", action="store_true")
    arguments = parser.parse_args()

    def process_paths():
        if arguments.fail_process_scan:
            raise PermissionError("Synthetic unreadable same-user process entry")
        return set(arguments.process_path)

    MODULE.active_process_paths = process_paths
    MODULE.main()


if __name__ == "__main__":
    main()
