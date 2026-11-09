# Worktree cleanup

Run `console-tool worktrees --repo PATH` to inspect stale Git worktrees. Preview returns a plan ID, eligible paths, retained paths with reasons, and an exact apply recipe.

Apply explicitly selected paths from one plan:

```bash
console-tool worktrees apply --plan PLAN_ID --path /path/to/worktree
console-tool worktrees apply --plan PLAN_ID --path /path/one --path /path/two
console-tool worktrees status --job JOB_ID
```

Apply is limited to an active manual caller thread. Missing, archived, and issue-run callers cannot apply. Preview and status are read-only and remain available to unattended callers.

Cleanup retains recovery material before removing a worktree. Archives contain `files.tar.gz`, `git-metadata/`, and `manifest.json`. The manifest records `recoveryRef`, `snapshot.head`, and `archiveSha256`; verify the archive checksum and recovery ref against those fields before restoring.

Use the backup directory printed in the job result. Set these task-specific paths, then run the recipe:

```bash
set -euo pipefail
WORKTREE_BACKUP_DIR="/private/archive/job/path"
WORKTREE_REPO="/absolute/repository/path"
WORKTREE_RESTORE="/absolute/new/restore/path"
WORKTREE_MANIFEST="$WORKTREE_BACKUP_DIR/manifest.json"
WORKTREE_ARCHIVE="$WORKTREE_BACKUP_DIR/files.tar.gz"
WORKTREE_REF="$(jq -r .recoveryRef "$WORKTREE_MANIFEST")"
WORKTREE_HEAD="$(jq -r .snapshot.head "$WORKTREE_MANIFEST")"
WORKTREE_EXPECTED="$(jq -r .archiveSha256 "$WORKTREE_MANIFEST")"
WORKTREE_ACTUAL="$(sha256sum "$WORKTREE_ARCHIVE" | awk '{print $1}')"
test "$WORKTREE_EXPECTED" = "$WORKTREE_ACTUAL"
test "$(git -C "$WORKTREE_REPO" rev-parse "$WORKTREE_REF")" = "$WORKTREE_HEAD"
while IFS= read -r WORKTREE_META_NAME; do
  WORKTREE_META="$WORKTREE_BACKUP_DIR/git-metadata/$WORKTREE_META_NAME"
  WORKTREE_EXPECTED_META="$(jq -r --arg name "$WORKTREE_META_NAME" '.snapshot.metadata[$name].sha256' "$WORKTREE_MANIFEST")"
  WORKTREE_ACTUAL_META="$(sha256sum "$WORKTREE_META" | awk '{print $1}')"
  test "$WORKTREE_EXPECTED_META" = "$WORKTREE_ACTUAL_META"
done < <(jq -r '.snapshot.metadata | keys[] | select(. == "index" or startswith("local-sharedindex.") or startswith("common-sharedindex."))' "$WORKTREE_MANIFEST")
git -C "$WORKTREE_REPO" worktree add --detach "$WORKTREE_RESTORE" "$WORKTREE_REF"
tar -xzf "$WORKTREE_ARCHIVE" -C "$WORKTREE_RESTORE"
WORKTREE_GITDIR="$(git -C "$WORKTREE_RESTORE" rev-parse --absolute-git-dir)"
WORKTREE_COMMON="$(git -C "$WORKTREE_RESTORE" rev-parse --path-format=absolute --git-common-dir)"
cp -- "$WORKTREE_BACKUP_DIR/git-metadata/index" "$WORKTREE_GITDIR/index"
for WORKTREE_META in "$WORKTREE_BACKUP_DIR/git-metadata"/local-sharedindex.*; do
  test -f "$WORKTREE_META" || continue
  WORKTREE_NAME="${WORKTREE_META##*/}"
  cp -- "$WORKTREE_META" "$WORKTREE_GITDIR/${WORKTREE_NAME#local-}"
done
for WORKTREE_META in "$WORKTREE_BACKUP_DIR/git-metadata"/common-sharedindex.*; do
  test -f "$WORKTREE_META" || continue
  WORKTREE_NAME="${WORKTREE_META##*/}"
  cp -- "$WORKTREE_META" "$WORKTREE_COMMON/${WORKTREE_NAME#common-}"
done
```

`files.tar.gz` excludes `.git`. The detached restore leaves the preserved branch available, and the recovery ref points at the saved `snapshot.head`. The checks above verify the archive and each index file against manifest hashes before creating the restore. Restore only `index` and matching shared-index files into the new worktree's Git directories. Do not copy the saved `HEAD` or old Git directory wholesale. Version one has no restore API.

Plans, reports, and archives live under the Agent Console data directory in `private-state/worktree-cleanup/`.

Symlink protections cover registered checkouts for the selected repository. Historical dynamic commands the tool cannot classify remain retained. These checks do not guarantee safety for every path on the filesystem.

If the CLI wait deadline expires, it returns the job ID and `console-tool worktrees status --job ID`. Check that job; never restart the apply command to resume it.
