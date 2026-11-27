#!/usr/bin/env python3
"""agent-vault: encrypted credential store for agent use.

Design rules (see SECURITY.md in the repository root):
- Values are Fernet-encrypted at rest; the key file lives separately
  from the encrypted entries.
- Values enter ONLY via stdin or a file the user placed themselves.
  There is deliberately NO command-line option for a value: argv would
  leak into shell history and the process list.
- store() disposes of the incoming copy (source file is shredded)
  as part of the same procedure.
- use() decrypts in memory only and hands the value to a child
  command via its environment or stdin. The value is never printed,
  logged, or included in any message this tool produces.
- list() shows metadata only (name / purpose / stored date).
"""

import argparse
import json
import os
import re
import subprocess
import sys
from datetime import datetime

def _fernet():
    """Import cryptography only where a value is encrypted or decrypted.

    `list` (and every metadata-only caller, e.g. bin/vault-match.py from
    chain.sh) then costs ~12 ms instead of ~55 ms, and the vault still works
    the same way. Nothing about the format or the key changes.
    """
    from cryptography.fernet import Fernet, InvalidToken
    return Fernet, InvalidToken

# PU_VAULT_DIR lets a deployment (or the test suite) keep the store outside the
# tree. It never changes the format or the permission rules.
BASE = os.environ.get("PU_VAULT_DIR") or os.path.dirname(os.path.abspath(__file__))
KEY_PATH = os.path.join(BASE, "keys", "vault.key")
ENTRY_DIR = os.path.join(BASE, "entries")
META_PATH = os.path.join(BASE, "meta.json")

NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
DEFAULT_ENV_NAME = "AGENT_VAULT_VALUE"


class VaultError(Exception):
    """Error whose message is safe to show (never contains a value)."""


def _mkdir_private(path):
    os.makedirs(path, mode=0o700, exist_ok=True)
    os.chmod(path, 0o700)


def _write_private(path, data: bytes):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        os.write(fd, data)
        os.fsync(fd)
    finally:
        os.close(fd)
    os.chmod(path, 0o600)


def shred_file(path):
    """Overwrite a file with random bytes, fsync, then unlink."""
    try:
        size = os.path.getsize(path)
        with open(path, "r+b", buffering=0) as f:
            remaining = size
            while remaining > 0:
                chunk = os.urandom(min(65536, remaining))
                f.write(chunk)
                remaining -= len(chunk)
            f.flush()
            os.fsync(f.fileno())
    except OSError:
        pass
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass


def ensure_layout():
    _mkdir_private(os.path.join(BASE, "keys"))
    _mkdir_private(ENTRY_DIR)
    if not os.path.exists(META_PATH):
        _write_private(META_PATH, b"{}\n")


def load_key() -> bytes:
    try:
        with open(KEY_PATH, "rb") as f:
            return f.read().strip()
    except OSError:
        raise VaultError("vault key not found; run: vault.py init")


def load_meta() -> dict:
    try:
        with open(META_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def save_meta(meta: dict):
    tmp = META_PATH + ".tmp"
    payload = (json.dumps(meta, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    _write_private(tmp, payload)
    os.replace(tmp, META_PATH)
    os.chmod(META_PATH, 0o600)


def entry_path(name: str) -> str:
    return os.path.join(ENTRY_DIR, name + ".enc")


def check_name(name: str):
    if not NAME_RE.match(name or ""):
        raise VaultError("invalid entry name (allowed: A-Za-z0-9 . _ -, max 64 chars)")


def now_iso() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


# ---------------------------------------------------------------- commands

def cmd_init(_args):
    ensure_layout()
    if os.path.exists(KEY_PATH):
        print("already initialized (key exists; left untouched)")
        return 0
    Fernet, _ = _fernet()
    _write_private(KEY_PATH, Fernet.generate_key())
    print("initialized: key created (0600), entries dir ready, vault is empty")
    return 0


def _read_incoming(args) -> bytes:
    if args.from_file:
        try:
            with open(args.from_file, "rb") as f:
                raw = f.read()
        except OSError:
            raise VaultError("could not read the incoming file")
    else:
        raw = sys.stdin.buffer.read()
    # A trailing newline is a file/typing artifact, not part of a credential.
    return raw.rstrip(b"\r\n")


def cmd_store(args):
    check_name(args.name)
    ensure_layout()
    key = load_key()
    meta = load_meta()
    if args.name in meta and not args.force:
        raise VaultError("entry already exists; use --force to replace it")
    value = bytearray(_read_incoming(args))
    if not value:
        raise VaultError("empty value; nothing stored")
    Fernet, _ = _fernet()
    token = Fernet(key).encrypt(bytes(value))
    for i in range(len(value)):
        value[i] = 0
    _write_private(entry_path(args.name), token)
    meta[args.name] = {
        "purpose": args.purpose,
        "stored_at": now_iso(),
    }
    save_meta(meta)
    if args.from_file:
        shred_file(args.from_file)
        print(f"stored '{args.name}' (incoming file shredded and removed)")
    else:
        print(f"stored '{args.name}'")
    return 0


def _decrypt(name: str) -> bytearray:
    check_name(name)
    key = load_key()
    try:
        with open(entry_path(name), "rb") as f:
            token = f.read()
    except OSError:
        raise VaultError(f"no such entry: {name}")
    try:
        Fernet, InvalidToken = _fernet()
        return bytearray(Fernet(key).decrypt(token))
    except InvalidToken:
        raise VaultError("decryption failed (key mismatch or corrupted entry)")


def cmd_use(args):
    command = getattr(args, "command", []) or []
    if not command:
        raise VaultError("no command given after '--'")
    value = _decrypt(args.name)
    try:
        if args.via == "env":
            env = dict(os.environ)
            env[args.env_name] = bytes(value).decode("utf-8")
            proc = subprocess.run(command, env=env)
        else:  # stdin
            proc = subprocess.run(command, input=bytes(value))
        return proc.returncode
    finally:
        for i in range(len(value)):
            value[i] = 0


def cmd_list(_args):
    meta = load_meta()
    if not meta:
        print("(empty)")
        return 0
    for name in sorted(meta):
        info = meta[name]
        print(f"{name}\t{info.get('purpose', '')}\t{info.get('stored_at', '')}")
    return 0


def cmd_delete(args):
    check_name(args.name)
    meta = load_meta()
    if args.name not in meta and not os.path.exists(entry_path(args.name)):
        raise VaultError(f"no such entry: {args.name}")
    if os.path.exists(entry_path(args.name)):
        shred_file(entry_path(args.name))
    meta.pop(args.name, None)
    save_meta(meta)
    print(f"deleted '{args.name}'")
    return 0


def build_parser():
    p = argparse.ArgumentParser(
        prog="vault.py",
        description="Encrypted credential store for agent use. "
        "Values are accepted only via stdin or --from-file, never as arguments.",
    )
    sub = p.add_subparsers(dest="cmd", required=True)

    ip = sub.add_parser("init", help="create layout and key (vault starts empty)")
    ip.set_defaults(func=cmd_init)

    s = sub.add_parser("store", help="encrypt and store a value; disposes of the incoming copy")
    s.add_argument("name")
    s.add_argument("--purpose", required=True, help="what this credential is for (metadata only)")
    s.add_argument("--from-file", metavar="PATH", help="read value from this file, then shred it")
    s.add_argument("--force", action="store_true", help="replace an existing entry")
    s.set_defaults(func=cmd_store)

    u = sub.add_parser("use", help="decrypt in memory and pass the value to a command")
    u.add_argument("name")
    u.add_argument("--via", choices=["env", "stdin"], default="env")
    u.add_argument("--env-name", default=DEFAULT_ENV_NAME,
                   help=f"environment variable name for --via env (default {DEFAULT_ENV_NAME})")
    # The command to run is split off at the first '--' in main() before
    # argparse runs: argparse.REMAINDER would swallow this subcommand's
    # own options (--via/--env-name) into the command list.
    u.set_defaults(func=cmd_use)

    lp = sub.add_parser("list", help="list entry names, purposes, stored dates (never values)")
    lp.set_defaults(func=cmd_list)

    d = sub.add_parser("delete", help="shred and remove an entry")
    d.add_argument("name")
    d.set_defaults(func=cmd_delete)
    return p


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    command = []
    if argv and argv[0] == "use" and "--" in argv:
        idx = argv.index("--")
        command, argv = argv[idx + 1 :], argv[:idx]
    args = build_parser().parse_args(argv)
    if args.cmd == "use":
        args.command = command
    try:
        return args.func(args)
    except VaultError as e:
        print(f"error: {e}", file=sys.stderr)
        return 2
    except BrokenPipeError:
        return 1
    except Exception:
        # Deliberately generic: an exception message must never be a
        # channel through which a value could leak.
        print("error: internal failure", file=sys.stderr)
        return 3


if __name__ == "__main__":
    sys.exit(main())
