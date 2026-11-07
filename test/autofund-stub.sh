#!/bin/sh
# Stub for AUTOFUND_SSH_BIN: records argv under $STUB_DIR; answers the forced-command verbs from files there.
[ -e "$STUB_DIR/down" ] && exit 255
echo "$@" >> "$STUB_DIR/argv.log"
for last; do :; done
case "$last" in
  dashboard) cat "$STUB_DIR/dashboard" ;;
  "approve "*|"reject "*|ack|kill|"revenue "*) echo "{\"ok\":true,\"ran\":\"$last\"}" ;;
  *) exit 2 ;;
esac
