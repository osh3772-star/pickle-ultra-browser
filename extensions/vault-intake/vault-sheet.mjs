#!/usr/bin/env node
// vault-sheet.mjs — build the per-user intake sheet from the vault's login list.
//
// What it does (one run per install, idempotent):
//
//   1. reads the user's saved logins as METADATA only — site, username,
//      whether a password exists, and the sign-in method. A password or TOTP
//      value is never read, decrypted or printed; the vault CLI does not print
//      those either.
//   2. creates a PRIVATE spreadsheet titled "<agent> 인입 (자동 파쇄)" with tab
//      "in", header 사이트 / 아이디 / 비밀번호, one row per site, and the
//      username already typed into column B.
//   3. leaves column C empty: that is the only cell the user ever fills in.
//   4. rows whose login has no password of its own (social sign-in) keep B
//      empty and are listed in a note cell beside the header, so the user can
//      see which sites sign in with e.g. kakao instead of a password.
//
// Idempotent: an existing sheet is reused, only missing sites are appended,
// and a column B value that is already there is never overwritten.
//
// Usage:
//   vault-sheet.mjs init [--from-json FILE] [--agent-name NAME] [--new]
//                        [--gog gog] [--dry-run] [--json] [--no-format]
//   vault-sheet.mjs status [--json]
//
//   --from-json   read logins from a JSON file instead of the vault CLI
//                 (list of {site, username, password, method}); used for
//                 testing and for agents without a vault command
//   --new         create a fresh sheet even if the config already has one
//
// Environment:
//   PU_VAULT_CLI   command that prints login metadata (default: vault)
//                  must accept `logins`; output is JSON
//   PU_GOG         Google CLI used for Sheets (default: gog)
//
// Output (one line, values never printed):
//   ok sheet_id=<id> url=<url> created=yes|no rows=<n> added=<n> prefilled=<n> verify=<ok|mismatch|unreadable> format=<ok|fail:...>
//   skip ...      nothing to do
//   fail code=<vault|gog|read|write|config|empty> ...

import fs from "node:fs";
import {
  applyVisuals,
  findScalar,
  isoLocalNow,
  loadConfig,
  loadLogins,
  loadLoginsFromJson,
  normalizeSite,
  planRows,
  readSheet6,
  readFormRows,
  runGog,
  saveConfig,
  tabTitle,
  updateRange,
  inboxPath,
  parseArgs,
} from "./lib.mjs";

const USAGE =
  "vault-sheet.mjs [init|status] [--from-json FILE] [--agent-name NAME] [--new] " +
  "[--gog gog] [--dry-run] [--json] [--no-format]";

// ---------------------------------------------------------------- commands
async function cmdInit(opts) {
  const cfg = loadConfig();
  if (opts.agent_name) cfg.agent_name = opts.agent_name;
  const agent = cfg.agent_name || "Pickle Ultra";
  const gogBin = opts.gog || process.env.PU_GOG || "gog";

  let logins;
  if (opts.from_json) {
    try {
      logins = loadLoginsFromJson(opts.from_json);
    } catch {
      console.log("fail code=vault reason=from-json");
      return 1;
    }
  } else {
    const cli = process.env.PU_VAULT_CLI || "vault";
    const got = await loadLogins(cli);
    if (got.error) {
      console.log("fail code=vault reason=login-list-unavailable");
      return 1;
    }
    logins = got.logins;
  }

  const { rows, notes } = planRows(logins);
  if (!rows.length) {
    console.log("skip empty source=no-sites");
    return 0;
  }
  if (opts.dry_run) {
    console.log(
      `dry-run rows=${rows.length} prefilled=${rows.filter(([, u]) => u).length} ` +
        `notes=${notes.length} sheet=${cfg.sheet_id || "new"}`
    );
    return 0;
  }

  let sheetId = opts.new ? "" : cfg.sheet_id || "";
  let created = "no";
  let existing = [];
  let anchor = 2;
  if (sheetId) {
    const got = await readSheet6(sheetId, `${cfg.sheet_tab || "in"}!A1:F200`, gogBin);
    if (got.code) {
      sheetId = "";
    } else {
      existing = got.rows;
      anchor = Math.max(2, existing.length + 1);
      // never append over a row that already has a site
      for (let i = 1; i < existing.length; i++) {
        const row = existing[i];
        if (!(row && (row[0] || "").trim())) {
          anchor = i + 1;
          break;
        }
      }
    }
  }
  if (!sheetId) {
    const title = `${agent} 인입 (자동 파쇄)`;
    const got = await runGog(["sheets", "create", title], gogBin);
    if (got.code) {
      console.log("fail code=gog reason=create");
      return 1;
    }
    sheetId = findScalar(got.obj, ["spreadsheetId", "id"]) || "";
    if (!sheetId) {
      console.log("fail code=gog reason=create-no-id");
      return 1;
    }
    created = "yes";
    Object.assign(cfg, {
      sheet_id: sheetId,
      sheet_tab: "in",
      sheet_range: "in!A2:C200",
      sheet_title: title,
      agent_name: agent,
    });
    saveConfig(cfg);
    const old = await tabTitle(sheetId, gogBin);
    if (old && old !== "in") {
      await runGog(["sheets", "rename-tab", sheetId, old, "in"], gogBin);
    }
    await updateRange(sheetId, "in!A1:C1", [["사이트", "아이디", "비밀번호"]], gogBin);
    anchor = 2;
  }

  const known = new Set();
  for (const row of existing.slice(1)) {
    const site = normalizeSite(row ? row[0] : "");
    if (site) known.add(site);
  }

  const toAdd = rows.filter(([s]) => !known.has(s));
  let added = 0;
  let filled = 0;
  let rowNo = anchor;
  for (const [site, prefill] of toAdd) {
    const err = await updateRange(sheetId, `in!A${rowNo}:C${rowNo}`, [[site, prefill, ""]], gogBin);
    if (err) {
      console.log(`fail code=write row=${rowNo} site=${site}`);
      return 1;
    }
    if (prefill) filled += 1;
    added += 1;
    rowNo += 1;
  }

  // fill a blank column B for sites already listed (never overwrite a value)
  const wanted = new Map(rows);
  for (let i = 1; i < existing.length; i++) {
    const row = existing[i];
    const site = normalizeSite(row ? row[0] : "");
    const want = wanted.get(site) || "";
    if (site && want && !(row.length > 1 ? (row[1] || "").trim() : "")) {
      const err = await updateRange(sheetId, `in!B${i + 1}`, [[want]], gogBin);
      if (err) {
        console.log(`fail code=write row=${i + 1} col=B`);
        return 1;
      }
      filled += 1;
    }
  }

  if (notes.length) {
    const note = "간편로그인(비밀번호 없음): " + notes.join(", ");
    await updateRange(sheetId, "in!E1", [["참고"]], gogBin);
    await updateRange(sheetId, "in!F1", [[note]], gogBin);
  }

  // visual layout: widths, frozen header, row heights, header band, borders,
  // grey pre-filled column, highlighted password column
  const lastRow = Math.max(anchor + added - 1, existing.length || 2, 2);
  let fmtOk = true;
  let fmtFailed = [];
  if (!opts.no_format) {
    const fmt = await applyVisuals(sheetId, gogBin, cfg.sheet_tab || "in", lastRow);
    fmtOk = fmt.ok;
    fmtFailed = fmt.failed;
  }
  const formatStatus = fmtOk ? "ok" : "fail:" + fmtFailed.join(",");

  // verify by reading back
  let verify = "ok";
  let prefilled = 0;
  let listed = 0;
  const back = await readSheet6(sheetId, "in!A2:C200", gogBin);
  if (back.code) {
    verify = "unreadable";
  } else {
    for (const row of back.rows) {
      if (row && (row[0] || "").trim()) {
        listed += 1;
        if (row.length > 1 && (row[1] || "").trim()) prefilled += 1;
        if (row.length > 2 && (row[2] || "").trim()) verify = "mismatch"; // must stay empty at init
      }
    }
  }

  const url = `https://docs.google.com/spreadsheets/d/${sheetId}/edit`;
  Object.assign(cfg, {
    sheet_id: sheetId,
    sheet_url: url,
    sheet_tab: "in",
    agent_name: agent,
    sites: rows.map((r) => r[0]),
  });
  saveConfig(cfg);

  if (opts.json) {
    console.log(
      JSON.stringify({
        ok: true,
        sheet_id: sheetId,
        url,
        created,
        rows: rows.length,
        added,
        prefilled,
        listed,
        verify,
        format: formatStatus,
        format_failed: fmtFailed,
      })
    );
  } else {
    console.log(
      `ok sheet_id=${sheetId} url=${url || "-"} created=${created} rows=${rows.length} ` +
        `added=${added} prefilled=${prefilled} verify=${verify} format=${formatStatus}`
    );
  }
  return 0;
}

// Counts only: sites listed, password cells filled, sites still unfilled, and
// when this check ran. Never a value, never a site's username.
async function cmdStatus(opts) {
  const cfg = loadConfig();
  const sheetId = cfg.sheet_id || "";
  const source = sheetId ? "sheet" : "inbox";
  let listed = 0;
  let waiting = 0;
  let file = "";
  if (sheetId) {
    const gogBin = opts.gog || process.env.PU_GOG || "gog";
    const got = await readSheet6(sheetId, `${cfg.sheet_tab || "in"}!A2:C200`, gogBin);
    if (got.code) {
      console.log("fail code=read");
      return 1;
    }
    listed = got.rows.filter((r) => r && (r[0] || "").trim()).length;
    waiting = got.rows.filter((r) => r && (r[0] || "").trim() && r.length > 2 && (r[2] || "").trim()).length;
  } else {
    for (const cand of [inboxPath("tsv"), inboxPath("csv"), inboxPath("xlsx")]) {
      if (cand && fileExists(cand)) {
        file = cand;
        break;
      }
    }
    if (!file) {
      console.log("skip no-form");
      return 0;
    }
    let rows;
    try {
      rows = await readFormRows(file);
    } catch (err) {
      console.log(`fail code=read reason=${err.reason || "unreadable"}`);
      return 1;
    }
    listed = rows.length;
    waiting = rows.filter((r) => (r[2] || "").trim()).length;
  }

  const checkedAt = isoLocalNow();
  cfg.last_status_at = checkedAt;
  saveConfig(cfg);
  const unfilled = Math.max(listed - waiting, 0);
  if (opts.json) {
    console.log(
      JSON.stringify({
        source,
        sheet_id: sheetId,
        path: file,
        url: cfg.sheet_url || "",
        listed,
        waiting,
        unfilled,
        checked_at: checkedAt,
      })
    );
  } else {
    const tail = file ? " path=" + file : sheetId ? " sheet_id=" + sheetId : "";
    console.log(
      `status source=${source} listed=${listed} waiting=${waiting} unfilled=${unfilled} ` +
        `checked_at=${checkedAt}${tail}`
    );
  }
  return 0;
}

function fileExists(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

async function main(argv) {
  const cmd = argv[0];
  if (cmd !== "init" && cmd !== "status") {
    process.stderr.write(`usage: ${USAGE}\n`);
    return 2;
  }
  const spec =
    cmd === "init"
      ? {
          gog: "value",
          json: "flag",
          "from-json": "value",
          "agent-name": "value",
          new: "flag",
          "dry-run": "flag",
          "no-format": "flag",
        }
      : { gog: "value", json: "flag" };
  const opts = parseArgs(argv.slice(1), spec, USAGE);
  if (opts._.length) {
    process.stderr.write(`usage: ${USAGE}\nerror: unrecognized arguments: ${opts._.join(" ")}\n`);
    return 2;
  }
  return cmd === "init" ? cmdInit(opts) : cmdStatus(opts);
}

process.exitCode = await main(process.argv.slice(2));
