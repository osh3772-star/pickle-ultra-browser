#!/usr/bin/env node
// pu-config.mjs — per-install configuration for Pickle Ultra Browser.
//
// One JSON file per user/install. Nothing secret goes here: it holds the
// intake sheet id and display names only. Passwords live only in the vault.
//
// Path: ${PU_CONFIG_FILE} or ${XDG_CONFIG_HOME:-~/.config}/pickle-ultra/config.json
// (file mode 0600, directory 0700)
//
// CLI:
//   pu-config.mjs get <key>
//   pu-config.mjs set <key>=<value> [<key>=<value> ...]
//   pu-config.mjs show                     # keys and values (never secrets)

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CONFIG_DIR =
  process.env.PU_CONFIG_DIR ||
  path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "pickle-ultra");
const CONFIG_FILE = process.env.PU_CONFIG_FILE || path.join(CONFIG_DIR, "config.json");

const DEFAULTS = {
  sheet_tab: "in",
  sheet_range: "in!A2:C200",
};

function load() {
  const cfg = { ...DEFAULTS };
  try {
    const data = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
    if (data !== null && typeof data === "object" && !Array.isArray(data)) Object.assign(cfg, data);
  } catch {
    /* absent or unreadable: defaults */
  }
  return cfg;
}

function save(cfg) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(CONFIG_DIR, 0o700);
  } catch {
    /* best effort */
  }
  const tmp = CONFIG_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, CONFIG_FILE);
  try {
    fs.chmodSync(CONFIG_FILE, 0o600);
  } catch {
    /* best effort */
  }
}

function main(argv) {
  if (!argv.length) {
    console.error("usage: pu-config.mjs get <key> | set <key>=<value>... | show");
    return 2;
  }
  const cmd = argv[0];
  if (cmd === "get") {
    if (argv.length < 2) {
      console.error("usage: pu-config.mjs get <key>");
      return 2;
    }
    const val = load()[argv[1]];
    console.log(val === undefined || val === null ? "" : val);
    return 0;
  }
  if (cmd === "set") {
    const cfg = load();
    for (const pair of argv.slice(1)) {
      const eq = pair.indexOf("=");
      if (eq < 0) {
        console.error("error: expected key=value");
        return 2;
      }
      cfg[pair.slice(0, eq).trim()] = pair.slice(eq + 1);
    }
    save(cfg);
    console.log("ok config=" + CONFIG_FILE);
    return 0;
  }
  if (cmd === "show") {
    console.log(JSON.stringify(load(), null, 2));
    console.error("file: " + CONFIG_FILE);
    return 0;
  }
  console.error("error: unknown command " + cmd);
  return 2;
}

process.exitCode = main(process.argv.slice(2));
