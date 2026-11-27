#!/usr/bin/env bash
# test-intake-file.sh — the file intake path, end to end, without Google.
#
#   bash tests/test-intake-file.sh
#
# Builds a throwaway vault + home, writes the intake form from a JSON login list,
# fills the password cell the way the user would, runs `intake.sh --source file`,
# and checks that: the value lands in the vault, the form is shredded, no value
# appears in the output, and the file was 0600 while it existed.
# (The Google Sheet path is extensions/vault-intake/selftest-intake.sh, which
# needs a connected Google account and is SKIPped here.)
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TREE="$(dirname "$HERE")"
. "$TREE/bin/pu-config.sh"
NODE="$(pu_node || true)"
[ -n "$NODE" ] || { echo "test-intake-file: node not found" >&2; exit 1; }

T="$(mktemp -d "$TMPDIR/intake-XXXXXX")" || exit 1
trap 'rm -rf "$T"' EXIT
export PICKLE_ULTRA_HOME="$T/home"
export PU_VAULT_DIR="$T/vault"
mkdir -p "$PICKLE_ULTRA_HOME" "$PU_VAULT_DIR"
python3 "$TREE/agent-vault/vault.py" init >/dev/null 2>&1 || { echo "test-intake-file: vault init failed"; exit 1; }

NP=0; NF=0
ok() { NP=$((NP+1)); printf 'PASS  %-18s %s\n' "$1" "$2"; }
no() { NF=$((NF+1)); printf 'FAIL  %-18s %s\n' "$1" "$2"; }

cat > "$T/logins.json" <<'JSON'
[{"site":"example.test","username":"me@example.test","password":true,"method":"password"},
 {"site":"second.test","username":"me2@example.test","password":false,"method":"oauth"}]
JSON

out=$(bash "$TREE/extensions/vault-intake/vault-form.sh" --from-json "$T/logins.json" --out "$T/form.tsv" 2>&1)
case "$out" in *"ok form="*"mode=600"*) ok form-created "0600, $(printf '%s' "$out" | sed -n 's/.*rows=\([0-9]*\).*/rows=\1/p')" ;; *) no form-created "$out" ;; esac
grep -q 'me@example.test' "$T/form.tsv" && ok prefill "username pre-filled" || no prefill "no username in the form"

SECRET="intake-secret-$RANDOM$RANDOM"
python3 - "$T/form.tsv" "$SECRET" <<'PY'
import sys
p, secret = sys.argv[1], sys.argv[2]
rows = open(p, encoding="utf-8").read().split("\n")
cells = rows[1].split("\t")
cells[2] = secret
rows[1] = "\t".join(cells)
open(p, "w", encoding="utf-8").write("\n".join(rows))
PY

out=$(bash "$TREE/extensions/vault-intake/intake.sh" --source file --file "$T/form.tsv" 2>&1); rc=$?
case "$out" in *"ok site=example.test"*"cleared=yes"*) ok intake "stored and cleared (exit $rc)" ;; *) no intake "$out" ;; esac
case "$out" in *"shredded file="*"removed=yes"*) ok shred "form shredded" ;; *) no shred "$out" ;; esac
if printf '%s' "$out" | grep -q "$SECRET"; then no no-echo "the value appeared in output"; else ok no-echo "value never printed"; fi
if [ -e "$T/form.tsv" ]; then no file-gone "form still exists"; else ok file-gone "form removed"; fi
python3 "$TREE/agent-vault/vault.py" list 2>/dev/null | grep -q '^example.test' && ok vault-entry "entry stored under the site" || no vault-entry "no entry in the vault"

# The vault stores a *login payload*: username TAB password (that is what intake
# passes on), so `use` must return exactly that pair.
val=$(python3 "$TREE/agent-vault/vault.py" use example.test -- sh -c 'printf %s "$AGENT_VAULT_VALUE"' 2>/dev/null)
printf '%s' "$val" > "$T/value.txt"
if python3 - "$T/value.txt" "$SECRET" <<'PY'
import sys
val = open(sys.argv[1], encoding="utf-8").read()
secret = sys.argv[2]
user, _, pw = val.partition("\t")
sys.exit(0 if user == "me@example.test" and pw == secret else 1)
PY
then ok round-trip "use returns user<TAB>password"
else no round-trip "got ${#val} chars, not user<TAB>password"
fi

echo "----"
echo "test-intake-file: PASS=$NP FAIL=$NF"
[ "$NF" -eq 0 ]
