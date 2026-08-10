#!/usr/bin/env bash
#
# Apply the PM dashboard migrations (0011, 0012, 0013) to production D1.
#
# Production turned out to be AHEAD of the numbered migrations — it was
# shaped by a `prisma db push` at some point — so this checks before it
# writes rather than trusting the files. Every ALTER is guarded: if the
# column is already there the statement is skipped, because SQLite has no
# ADD COLUMN IF NOT EXISTS and a duplicate column aborts the whole file.
#
#   Usage:  cd apps/web && ./scripts/apply-pm-migrations.sh
#           cd apps/web && ./scripts/apply-pm-migrations.sh --dry-run
#
# Requires `wrangler login`. Read-only until it prints the plan.

set -euo pipefail

DB="showpilot-db"
MIGRATIONS="prisma/migrations"
MANIFEST="$MIGRATIONS/applied-remote.txt"
DRY_RUN="${1:-}"

cd "$(dirname "$0")/.."

if [[ ! -f "$MANIFEST" ]]; then
  echo "Run this from apps/web — $MANIFEST not found." >&2
  exit 1
fi

d1() { pnpm exec wrangler d1 execute "$DB" --remote --command "$1" 2>/dev/null; }

# Does a column exist on a table? Used to decide whether an ALTER is safe.
has_column() {
  d1 "SELECT name FROM pragma_table_info('$1')" | grep -qw "$2"
}

echo "Checking what production already has…"
echo

INCIDENT_STATUS=no
RUNDOWN_NAME=no
has_column incident status   && INCIDENT_STATUS=yes
has_column rundown  name     && RUNDOWN_NAME=yes

echo "  incident.status : $INCIDENT_STATUS"
echo "  rundown.name    : $RUNDOWN_NAME"
echo

# 0011 is pure CREATE ... IF NOT EXISTS, so it is always safe.
PLAN=("0011_schema_drift_repair.sql")

# Already satisfied by the live schema. These must still be RECORDED — the
# deploy workflow blocks while any numbered migration is missing from the
# manifest, whether or not it had work to do.
SATISFIED=()

if [[ "$INCIDENT_STATUS" == "yes" ]]; then
  echo "  ! incident.status already exists — 0012's ALTERs would abort the file."
  echo "    Apply 0012 by hand, keeping only the CREATE statements."
else
  PLAN+=("0012_service_assignments.sql")
fi

if [[ "$RUNDOWN_NAME" == "yes" ]]; then
  echo "  ! rundown.name already exists — nothing to apply for 0013."
  SATISFIED+=("0013_rundown_name.sql")
else
  PLAN+=("0013_rundown_name.sql")
fi

echo
echo "Plan:"
for file in "${PLAN[@]}"; do echo "  apply  $file"; done
for file in "${SATISFIED[@]:-}"; do
  [[ -n "$file" ]] && echo "  record $file (already satisfied by the live schema)"
done
echo

if [[ "$DRY_RUN" == "--dry-run" ]]; then
  echo "Dry run — nothing written."
  exit 0
fi

read -r -p "Apply to PRODUCTION $DB? [y/N] " reply
[[ "$reply" == "y" || "$reply" == "Y" ]] || { echo "Aborted."; exit 1; }

for file in "${PLAN[@]}"; do
  echo
  echo "── $file"
  pnpm exec wrangler d1 execute "$DB" --remote --file="$MIGRATIONS/$file"
  # Record it only after it succeeded — set -e means a failure stops here
  # and the manifest keeps telling the truth.
  if ! grep -qx "$file" "$MANIFEST"; then
    echo "$file" >> "$MANIFEST"
    echo "   recorded in applied-remote.txt"
  fi
done

for file in "${SATISFIED[@]:-}"; do
  [[ -n "$file" ]] || continue
  if ! grep -qx "$file" "$MANIFEST"; then
    echo "$file" >> "$MANIFEST"
    echo "   recorded $file (no statements needed)"
  fi
done

echo
echo "Done. Commit the manifest before merging to main —"
echo "the deploy workflow fails while any numbered migration is unrecorded:"
echo
echo "  git add $MANIFEST && git commit -m 'chore(db): record 0011-0013 applied to production'"
