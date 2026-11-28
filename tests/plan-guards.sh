#!/usr/bin/env bash
# tests/plan-guards.sh — the pre-flight gate refuses a bad plan before Chrome
# is opened. No site skill, no account and no network are needed: every case
# writes a throwaway skill folder under a temp dir with a reserved-TLD origin
# (example.test), so the suite proves the runner's own guard.
#
#   bash tests/plan-guards.sh
#
# What it proves:
#   * a step URL on another origin        -> cross_origin
#   * a step URL outside skill.scope.paths -> path_not_allowlisted
#   * riskClass other than READ_ONLY      -> risk_class_not_read_only
#   * a missing skill folder / --help      -> clean exit 2 / 0 with a hint
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"
. "$ROOT/bin/pu-config.sh"
NODE="$(pu_node || true)"
[ -n "$NODE" ] || { echo "plan-guards: node not found" >&2; exit 1; }

T="$(mktemp -d /tmp/plan-guards-XXXXXX)" || exit 1
trap 'rm -rf "$T"' EXIT
ORIGIN="https://example.test"
NP=0; NF=0

ok() { NP=$((NP+1)); printf 'PASS  %-26s %s\n' "$1" "$2"; }
no() { NF=$((NF+1)); printf 'FAIL  %-26s %s\n' "$1" "$2"; }

# write_skill <dir> <step-url> [riskClass]
write_skill() {
  local dir="$1" url="$2" risk="${3:-READ_ONLY}"
  mkdir -p "$dir"
  cat > "$dir/skill.json" <<EOF
{"schemaVersion":1,"skillId":"test.guard","version":"1.0.0","origins":["$ORIGIN"],"riskClass":"$risk","scope":{"paths":["/"],"methods":["GET"],"writes":false},"auth":{"loginUrl":"$ORIGIN/login"}}
EOF
  cat > "$dir/plan.json" <<EOF
{"schemaVersion":1,"planId":"test.guard","origin":"$ORIGIN","riskClass":"$risk","steps":[{"id":"x","op":"fetch_extract","url":"$url","extractor":"page"}]}
EOF
  cat > "$dir/extractors.mjs" <<'EOF'
export const page = (html) => ({ title: (html.match(/<title>([^<]*)/) || [])[1] || '' });
EOF
}

# expect_reject <label> <url> <expected fragment> [riskClass]
expect_reject() {
  local label="$1" url="$2" want="$3" risk="${4:-READ_ONLY}" out code
  local dir="$T/case-$RANDOM"
  write_skill "$dir" "$url" "$risk"
  out="$("$NODE" "$ROOT/bin/plan-replay.mjs" "$dir" 2>&1)"; code=$?
  if [ "$code" -eq 1 ] && case "$out" in *"$want"*) true ;; *) false ;; esac; then
    ok "$label" "exit=1, $want"
  else
    no "$label" "exit=$code: ${out:0:220}"
  fi
}

expect_reject "cross-origin step"     "https://evil.example/steal" "cross_origin"
expect_reject "path not allowlisted"  "/admin/secret.php"          "path_not_allowlisted"
expect_reject "write risk class"      "/"                          "risk_class_not_read_only" "WRITE"

# a fetch has no same-origin context until the tab is on the origin
D="$T/nogoto"; write_skill "$D" "/"
cat > "$D/plan.json" <<JSON
{"schemaVersion":1,"planId":"test.nogoto","origin":"$ORIGIN","riskClass":"READ_ONLY","steps":[{"id":"x","op":"fetch_extract","url":"/","extractor":"page"}]}
JSON
out="$("$NODE" "$ROOT/bin/plan-replay.mjs" "$D" 2>&1)"; code=$?
if [ "$code" -eq 1 ] && case "$out" in *"fetch_without_prior_goto"*) true ;; *) false ;; esac; then
  ok "fetch before goto" "exit=1, fetch_without_prior_goto"
else
  no "fetch before goto" "exit=$code: ${out:0:220}"
fi

# ---- clean CLI failures (no browser, no skill on disk)
out="$("$NODE" "$ROOT/bin/plan-replay.mjs" "$T/does-not-exist" 2>&1)"; code=$?
if [ "$code" -eq 2 ] && case "$out" in *"no skill.json"*) true ;; *) false ;; esac; then
  ok "missing skill" "exit=2 with a hint"
else
  no "missing skill" "exit=$code: ${out:0:220}"
fi

out="$("$NODE" "$ROOT/bin/plan-replay.mjs" --help 2>&1)"; code=$?
if [ "$code" -eq 0 ] && case "$out" in *"usage:"*) true ;; *) false ;; esac; then
  ok "help" "exit=0, usage printed"
else
  no "help" "exit=$code: ${out:0:220}"
fi

mkdir -p "$T/empty"
out="$("$NODE" "$ROOT/bin/plan-replay.mjs" --list --skills-dir "$T/empty" 2>&1)"; code=$?
if [ "$code" -eq 0 ] && case "$out" in *"no skills in"*) true ;; *) false ;; esac; then
  ok "list empty" "exit=0, says there are no skills"
else
  no "list empty" "exit=$code: ${out:0:220}"
fi

echo "----"
echo "plan-guards: PASS=$NP FAIL=$NF"
[ "$NF" -eq 0 ]
