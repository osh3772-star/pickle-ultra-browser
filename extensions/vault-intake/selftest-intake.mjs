#!/usr/bin/env node
// selftest-intake.mjs — one command that proves the intake harness works for a
// fresh user, with nothing of this install hard-coded.
//
// What it runs (throwaway config, throwaway vault, REAL temporary spreadsheets
// that are moved to the trash at the end):
//
//   profile A   10 sites, email-style usernames, 6 of them with a password
//   profile B    8 sites, student-id usernames + social sign-in, 0 passwords
//
// For each profile:
//   1. `vault-sheet-init.sh` unattended  -> sheet created, usernames pre-filled,
//      header/widths/freeze/borders applied, verify=ok format=ok
//   2. the same command again            -> created=no added=0 (idempotent,
//      an existing column B is not overwritten)
//   3. one new login in the "vault"      -> added=1, only that row appended
//   4. two password cells filled by the user -> `intake-all --source sheet` moves
//      them to the throwaway vault, clears the cells, read-back confirms
//
// Test values are fixed fake tokens, never printed. Cleanup: every sheet to the
// trash, temp directories removed.
//
//   node extensions/vault-intake/selftest-intake.mjs        (or bash .../selftest-intake.sh)
//   node extensions/vault-intake/selftest-intake.mjs --keep # keep the temp dir for inspection
//
// Exit codes: 0 all checks passed · 1 a check failed · 2 skipped (no Google access)

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  HERE,
  REPO,
  findValues,
  parseArgs,
  pythonBin,
  runProcess,
} from "./lib.mjs";

const GOG = process.env.PU_GOG || "gog";
const TOKEN_A = "SelfTestAlpha-7k2q";
const TOKEN_B = "SelfTestBeta-9m4v";

const PROFILE_A = {
  name: "A",
  agent: "Test Agent A",
  logins: [
    { site: "mail.example.com", username: "first.last@example.com", password: true },
    { site: "shop.example.com", username: "first.last@example.com", password: true },
    { site: "news.example.com", username: "first.last@example.com", password: true },
    { site: "bank.example.com", username: "first.last@example.com", password: true },
    { site: "docs.example.com", username: "first.last@example.com", password: true },
    { site: "video.example.com", username: "first.last@example.com", password: true },
    { site: "photo.example.com", username: "first.last@example.com", password: false },
    { site: "travel.example.com", username: "first.last@example.com", password: false },
    { site: "music.example.com", username: "first.last@example.com", password: false },
    { site: "forum.example.com", username: "first.last@example.com", password: false },
  ],
  expect_prefilled: 10,
};

const PROFILE_B = {
  name: "B",
  agent: "Test Agent B",
  logins: [
    { site: "portal.example.ac.kr", username: "2023123456", password: false },
    { site: "lms.example.ac.kr", username: "2023123456", password: false },
    { site: "library.example.ac.kr", username: "2023123456", password: false },
    { site: "chat.example.net", username: "", password: false, method: "kakao" },
    { site: "store.example.net", username: "", password: false, method: "kakao" },
    { site: "map.example.net", username: "", password: false, method: "naver" },
    { site: "grade.example.ac.kr", username: "", password: false, method: "kakao" },
    { site: "club.example.ac.kr", username: "", password: false, method: "naver" },
  ],
  expect_prefilled: 3,
};

// A stand-in for `vault logins` — metadata only, from the throwaway profile.
const STUB_VAULT = `#!${process.execPath}
import fs from "node:fs";
const prof = JSON.parse(fs.readFileSync(process.env.SELFTEST_PROFILE, "utf8"));
if (process.argv[2] === "logins") {
  console.log(JSON.stringify({ ok: true, data: { logins: prof.logins } }));
  process.exit(0);
}
console.log(JSON.stringify({ ok: false, code: "stub" }));
process.exit(2);
`;

async function gog(args, timeout = 120) {
  const p = await runProcess(GOG, args, { timeout });
  if (p.error) return { ok: false, code: "cli" };
  try {
    return JSON.parse(p.stdout);
  } catch {
    return { ok: false, code: "parse" };
  }
}

async function run(cmd, env) {
  const p = await runProcess(cmd[0], cmd.slice(1), { env, cwd: REPO });
  return { rc: p.code === null ? 1 : p.code, out: (p.stdout || "") + (p.stderr || "") };
}

function parseLine(out) {
  for (const line of out.split("\n")) {
    if (!line.startsWith("ok ")) continue;
    const fields = {};
    for (const part of line.split(/\s+/).slice(1)) {
      if (!part.includes("=")) continue;
      const eq = part.indexOf("=");
      fields[part.slice(0, eq)] = part.slice(eq + 1);
    }
    return fields;
  }
  return {};
}

async function sheetRows(sheetId) {
  const obj = await gog(["--readonly", "sheets", "get", sheetId, "in!A1:C200"]);
  if (obj.ok !== true) return [];
  const values = findValues(obj);
  return Array.isArray(values) ? values : [];
}

class Runner {
  constructor() {
    this.npass = 0;
    this.nfail = 0;
    this.skipped = false;
    this.sheets = [];
  }

  check(label, cond, detail = "") {
    if (cond) {
      this.npass += 1;
      console.log("PASS  " + label.padEnd(34) + " " + detail);
    } else {
      this.nfail += 1;
      console.log("FAIL  " + label.padEnd(34) + " " + detail);
    }
    return cond;
  }
}

async function profileCycle(r, prof, root) {
  const tag = "profile" + prof.name;
  const work = path.join(root, tag);
  fs.mkdirSync(work, { recursive: true });
  const conf = path.join(work, "config");
  const profPath = path.join(work, "profile.json");
  fs.writeFileSync(profPath, JSON.stringify(prof), { encoding: "utf8" });

  const stub = path.join(work, "vault-stub");
  fs.writeFileSync(stub, STUB_VAULT, { encoding: "utf8" });
  fs.chmodSync(stub, 0o700);

  const env = {
    ...process.env,
    PU_CONFIG_DIR: conf,
    PU_VAULT_CLI: stub,
    SELFTEST_PROFILE: profPath,
    PU_GOG: GOG,
    PICKLE_ULTRA_HOME: work,
  };

  // 1) unattended build
  let got = await run(
    ["bash", path.join(HERE, "vault-sheet-init.sh"), "--gog", GOG, "--agent-name", prof.agent],
    env
  );
  let fields = parseLine(got.out);
  if (!fields.sheet_id) {
    const failLine = got.out.split("\n").find((l) => l.startsWith("fail")) || "";
    console.log("SKIP  " + (tag + " create").padEnd(34) + " " + (failLine || "no sheet id"));
    r.skipped = true;
    return;
  }
  const sheetId = fields.sheet_id;
  r.sheets.push(sheetId);
  const rowsExpected = prof.logins.length;
  r.check(
    tag + " create+prefill",
    got.rc === 0 &&
      fields.created === "yes" &&
      fields.rows === String(rowsExpected) &&
      fields.prefilled === String(prof.expect_prefilled),
    `rows=${fields.rows} prefilled=${fields.prefilled} (expected ${rowsExpected}/${prof.expect_prefilled}) created=${fields.created}`
  );
  r.check(
    tag + " verify+format",
    fields.verify === "ok" && fields.format === "ok",
    `verify=${fields.verify} format=${fields.format}`
  );

  // 2) idempotent re-run
  got = await run(
    ["bash", path.join(HERE, "vault-sheet-init.sh"), "--gog", GOG, "--agent-name", prof.agent],
    env
  );
  const fields2 = parseLine(got.out);
  r.check(
    tag + " idempotent",
    fields2.sheet_id === sheetId &&
      fields2.created === "no" &&
      fields2.added === "0" &&
      fields2.verify === "ok",
    `sheet reused=${fields2.sheet_id === sheetId} added=${fields2.added} verify=${fields2.verify}`
  );

  // 3) a new login appears -> only that row is appended
  const profNew = JSON.parse(JSON.stringify(prof));
  profNew.logins.push({ site: "new.example.org", username: "new.user@example.org", password: true });
  fs.writeFileSync(profPath, JSON.stringify(profNew), { encoding: "utf8" });
  got = await run(
    ["bash", path.join(HERE, "vault-sheet-init.sh"), "--gog", GOG, "--agent-name", prof.agent],
    env
  );
  const fields3 = parseLine(got.out);
  r.check(
    tag + " append only new",
    fields3.added === "1" && fields3.rows === String(rowsExpected + 1),
    `added=${fields3.added} rows=${fields3.rows}`
  );

  // 4) the user fills two password cells, then intake
  const rows = await sheetRows(sheetId);
  const targets = [];
  for (let i = 1; i < rows.length && targets.length < 2; i++) {
    const row = rows[i];
    if (row.length > 1 && row[1] && !(row.length > 2 && row[2])) targets.push([i + 1, row[0]]);
  }
  if (targets.length < 2) {
    r.check(
      tag + " fill+intake",
      false,
      `no pre-filled rows to fill (rows_read=${rows.length} prefilled=${rows.slice(1).filter((row) => row.length > 1 && row[1]).length})`
    );
    return;
  }
  const tokens = [TOKEN_A, TOKEN_B];
  for (let k = 0; k < targets.length; k++) {
    await gog([
      "sheets",
      "update",
      sheetId,
      `in!C${targets[k][0]}`,
      "--values-json",
      JSON.stringify([[tokens[k]]]),
      "--input",
      "RAW",
    ]);
  }

  const vaultDir = path.join(work, "vault");
  fs.mkdirSync(vaultDir, { recursive: true });
  const vaultPy = path.join(vaultDir, "vault.py");
  fs.copyFileSync(path.join(REPO, "agent-vault", "vault.py"), vaultPy);
  await runProcess(pythonBin(), [vaultPy, "init"], { timeout: 60 });

  const envIntake = { ...env, PICKLE_ULTRA_VAULT: vaultPy };
  got = await run(
    [
      process.execPath,
      path.join(HERE, "intake-all.mjs"),
      "--source",
      "sheet",
      "--sheet-id",
      sheetId,
      "--range",
      "in!A2:C200",
      "--gog",
      GOG,
    ],
    envIntake
  );
  const okLines = got.out.split("\n").filter((l) => l.startsWith("ok site="));
  const fails = got.out.split("\n").filter((l) => l.startsWith("fail"));
  const good = okLines.filter((l) => l.includes("cleared=yes"));
  r.check(
    tag + " intake round trip",
    got.rc === 0 && okLines.length === 2 && good.length === 2,
    `rows=${okLines.length} cleared=yes=${good.length} exit=${got.rc}${fails.length ? " " + fails[0] : ""}`
  );

  const after = await sheetRows(sheetId);
  const dirty = [];
  for (const [rowNo] of targets) {
    const row = after[rowNo - 1] || [];
    const cells = row.map((c) => (typeof c === "string" ? c : String(c === null || c === undefined ? "" : c)));
    if ([TOKEN_A, TOKEN_B].some((t) => cells.join(" ").includes(t))) dirty.push(rowNo);
    if (cells.length > 2 && String(cells[2] || "").trim()) dirty.push(rowNo);
  }
  r.check(tag + " cells cleared on read-back", dirty.length === 0, `rows_still_holding=${dirty.length}`);

  const listing = await runProcess(pythonBin(), [vaultPy, "list"], { timeout: 60 });
  const stored = (listing.stdout || "")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => l.split("\t")[0]);
  r.check(tag + " values in vault", stored.length === 2, `items=${stored.length}`);
}

async function main(argv) {
  const opts = parseArgs(argv, { keep: "flag" }, "selftest-intake.mjs [--keep]");

  const r = new Runner();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pu-selftest-intake-"));
  console.log(`selftest-intake: Pickle Ultra Browser — ${REPO}`);
  console.log(`selftest-intake: gog=${GOG} work=${root}`);
  try {
    for (const prof of [PROFILE_A, PROFILE_B]) await profileCycle(r, prof, root);
  } finally {
    for (const sid of r.sheets) await gog(["drive", "delete", sid, "--force"]);
    if (r.sheets.length) console.log(`cleanup: sheets to trash=${r.sheets.length}`);
    if (!opts.keep) fs.rmSync(root, { recursive: true, force: true });
    else console.log(`kept: ${root}`);
  }

  console.log("----");
  if (r.skipped && r.npass === 0) {
    console.log("selftest-intake: SKIP reason=no-google (use extensions/vault-intake/vault-form.sh instead)");
    return 2;
  }
  console.log(`selftest-intake: PASS=${r.npass} FAIL=${r.nfail}`);
  return r.nfail === 0 ? 0 : 1;
}

process.exitCode = await main(process.argv.slice(2));
