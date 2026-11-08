#!/bin/sh
# Stub for AUTOFUND_SSH_BIN: records argv under $STUB_DIR; answers the forced-command verbs from files there.
[ -e "$STUB_DIR/down" ] && exit 255
echo "$@" >> "$STUB_DIR/argv.log"
for last; do :; done
case "$last" in
  dashboard) cat "$STUB_DIR/dashboard" ;;
  "approve "*|"reject "*|ack|kill|"revenue "*) echo "{\"ok\":true,\"ran\":\"$last\"}" ;;
  "secret "*)
    # The value arrives on stdin only; record it for the test and answer like the relay would.
    name=${last#secret }
    cat > "$STUB_DIR/stdin-$name"
    if [ "$(cat "$STUB_DIR/stdin-$name")" = "refuse-me" ]; then
      echo '{"ok":false,"error":"invalid format"}'
      exit 2
    fi
    echo "{\"ok\":true,\"name\":\"$name\",\"fingerprint\":\"ab12cd34\",\"stored_at\":\"2026-11-08T00:00:00+00:00\"}" ;;
  secrets) cat "$STUB_DIR/secrets" ;;
  "session "*)
    file="$STUB_DIR/session-${last#session }"
    if [ -f "$file" ]; then cat "$file"; else echo '{"ok":false,"status":404}'; exit 1; fi ;;
  *) exit 2 ;;
esac
