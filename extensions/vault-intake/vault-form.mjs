#!/usr/bin/env node
// vault-form.mjs — write the intake form as a local file the user can fill in.
//
// Used when the agent's Google account is not connected: the sheet cannot be
// created or read, so the same three columns travel as a file instead.
//
//   1. reads the saved logins as METADATA only (site, username, whether a
//      password exists, the sign-in method). No password or TOTP value is read
//      or printed; the vault CLI does not print them either.
//   2. writes a table with header 사이트 / 아이디 / 비밀번호, one row per site,
//      and the username already filled into the second column.
//   3. leaves the third column empty: that is the only cell the user fills in,
//      on their own phone, and they send the file back through chat.
//
// The file is written with mode 0600. Re-running keeps rows that are already in
// the file (a value the user typed is never overwritten) and only appends sites
// that are missing.
//
// Usage:
//   vault-form.mjs [--from-json FILE] [--format tsv|csv|xlsx] [--out PATH]
//                  [--vault-cli CMD] [--agent-name NAME] [--json]
//
//   --from-json   read logins from a JSON file instead of the vault CLI
//   --format      tsv (default), csv (utf-8 with BOM, opens in any phone app),
//                 or xlsx (needs python3 + 'openpyxl'; fails cleanly without it)
//   --out         path (default: $PICKLE_ULTRA_INBOX or $PICKLE_ULTRA_HOME/inbox.tsv)
//
// Output (values never printed):
//   ok form=<path> format=<tsv|csv|xlsx> rows=<n> added=<n> prefilled=<n> mode=<octal>
//   attach=<path>                    -> send this file to the user in chat
//   note social=<site>=<method>,...  -> sites that need no password here
//   skip empty source=no-sites
//   fail code=<vault|write|from-json|read> reason=<...>

import fs from "node:fs";
import path from "node:path";
import {
  formatOf,
  inboxPath,
  loadConfig,
  loadLogins,
  loadLoginsFromJson,
  openpyxlAvailable,
  parseArgs,
  planRows,
  readFormRows,
  writeFormRows,
} from "./lib.mjs";

const USAGE =
  "vault-form.mjs [--from-json FILE] [--format tsv|csv|xlsx] [--out PATH] " +
  "[--vault-cli CMD] [--agent-name NAME] [--json]";

function stem(p) {
  const ext = path.extname(p);
  return ext ? p.slice(0, p.length - ext.length) : p;
}

async function main(argv) {
  const opts = parseArgs(
    argv,
    {
      "from-json": "value",
      format: "value",
      out: "value",
      "vault-cli": "value",
      "agent-name": "value",
      json: "flag",
    },
    USAGE
  );
  if (opts._.length) {
    process.stderr.write(`usage: ${USAGE}\nerror: unrecognized arguments: ${opts._.join(" ")}\n`);
    return 2;
  }
  if (opts.format && !["tsv", "csv", "xlsx"].includes(opts.format)) {
    process.stderr.write(`usage: ${USAGE}\nerror: argument --format: invalid choice: '${opts.format}'\n`);
    return 2;
  }

  const cfg = loadConfig();
  const agent = opts.agent_name || cfg.agent_name || "Pickle Ultra";

  let logins;
  if (opts.from_json) {
    try {
      logins = loadLoginsFromJson(opts.from_json);
    } catch {
      console.log("fail code=from-json reason=unreadable");
      return 1;
    }
  } else {
    const cli = opts.vault_cli || process.env.PU_VAULT_CLI || "vault";
    const got = await loadLogins(cli);
    if (got.error) {
      console.log("fail code=vault reason=login-list-unavailable");
      return 1;
    }
    logins = got.logins;
  }

  const { rows: planned, notes } = planRows(logins);
  if (!planned.length) {
    console.log("skip empty source=no-sites");
    return 0;
  }

  const fmt = opts.format || formatOf(opts.out || inboxPath("tsv"));
  if (fmt === "xlsx" && !(await openpyxlAvailable())) {
    console.log("fail code=write reason=xlsx-unavailable");
    return 1;
  }
  let out = opts.out || inboxPath(fmt);
  if (!out.toLowerCase().endsWith("." + fmt)) {
    out = path.extname(out) ? stem(out) + "." + fmt : out + "." + fmt;
  }

  let existing;
  try {
    existing = await readFormRows(out);
  } catch (err) {
    console.log(`fail code=read reason=${err.reason || "unreadable"}`);
    return 1;
  }
  const merged = [];
  const seen = new Set();
  for (const [site, user, pw] of existing) {
    merged.push([site, user, pw]);
    seen.add(String(site).toLowerCase());
  }
  let added = 0;
  for (const [site, prefill] of planned) {
    if (seen.has(site.toLowerCase())) continue;
    merged.push([site, prefill, ""]);
    seen.add(site.toLowerCase());
    added += 1;
  }
  merged.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

  try {
    await writeFormRows(out, merged, fmt);
  } catch (err) {
    console.log(`fail code=write reason=${err.reason === "xlsx-unavailable" ? "xlsx-unavailable" : "path"}`);
    return 1;
  }

  let mode = "";
  try {
    mode = (fs.statSync(out).mode & 0o777).toString(8);
  } catch {
    mode = "600";
  }
  const prefilled = merged.filter(([, user]) => user).length;
  if (opts.json) {
    console.log(
      JSON.stringify({
        ok: true,
        form: out,
        agent,
        format: fmt,
        rows: merged.length,
        added,
        prefilled,
        mode,
        social: notes,
      })
    );
    return 0;
  }
  console.log(
    `ok form=${out} format=${fmt} rows=${merged.length} added=${added} prefilled=${prefilled} mode=${mode}`
  );
  console.log("attach=" + out);
  if (notes.length) console.log("note social=" + notes.join(","));
  return 0;
}

process.exitCode = await main(process.argv.slice(2));
