#!/bin/sh
set -eu
reward_dir="${REWARD_DIR:-/logs/verifier}"
mkdir -p "$reward_dir"
printf "0\n" > "$reward_dir/reward.txt"
python3 "$(dirname "$0")/verify.py"
printf "1\n" > "$reward_dir/reward.txt"
