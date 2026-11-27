#!/usr/bin/env node
// build-dist.mjs — generate dist/ bundles (single-file JS, no runtime deps).
//
//   PU_ESBUILD_DIR=<dir containing node_modules/@esbuild> node bin/build-dist.mjs
//   # or, with esbuild already resolvable: node bin/build-dist.mjs
//
// Writes (all executable, all self-contained except for the tree's own helpers):
//   dist/vault-intake.mjs   one file, subcommands: sheet | form | intake | selftest
//   dist/vault-sheet.mjs    standalone bundles of the same tools
//   dist/vault-form.mjs
//   dist/intake-all.mjs
//   dist/cdp-daemon.mjs     daemon (Chrome wrapper found via CHROME_PATH or ../bin/)
//   dist/cdp-client.mjs     client (auto-starts the daemon next to itself)
//
// esbuild is never installed inside this tree: point PU_ESBUILD_DIR at a
// temporary install (npm i esbuild in /tmp) so no node_modules/ appears here.
// Two build-time patches keep the bundles relocatable (see below); they fail
// loudly if the source lines they target change.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const REPO = path.resolve(new URL("..", import.meta.url).pathname);
const EXT = path.join(REPO, "extensions", "vault-intake");
const DIST = path.join(REPO, "dist");

const esbuild = process.env.PU_ESBUILD_DIR
  ? await import(pathToFileURL(path.join(process.env.PU_ESBUILD_DIR, "node_modules", "esbuild", "lib", "main.js")).href)
  : await import("esbuild");

fs.mkdirSync(DIST, { recursive: true });

// lib.mjs derives HERE/REPO from import.meta.url. In dist/ that lands one level
// above the tree root, so the bundle resolves the real extension dir instead.
const libRootPatch = {
  name: "pu-lib-root",
  setup(build) {
    build.onLoad({ filter: /vault-intake[\\/]lib\.mjs$/ }, (args) => {
      let src = fs.readFileSync(args.path, "utf8");
      const before = `export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.dirname(path.dirname(HERE)); // extensions/vault-intake -> tree root`;
      const after = `export const HERE = (() => {
  const d = path.dirname(fileURLToPath(import.meta.url));
  if (fs.existsSync(path.join(d, "vault-sheet-init.sh"))) return d;
  const up = path.join(path.dirname(d), "extensions", "vault-intake");
  return fs.existsSync(path.join(up, "vault-sheet-init.sh")) ? up : d;
})();
export const REPO = path.dirname(path.dirname(HERE)); // extensions/vault-intake -> tree root`;
      if (!src.includes(before)) throw new Error("lib.mjs HERE/REPO block not found — update the build patch");
      return { contents: src.replace(before, after), loader: "js", resolveDir: path.dirname(args.path) };
    });
  },
};

// The daemon spawns its "Chrome" through bin/chrome-wrapper.sh unless CHROME_PATH
// is set; from dist/ that file is one level up. Its default profile also moves
// under the state dir (bin/run.sh already sets PICKLE_ULTRA_PROFILE).
const daemonWrapperPatch = {
  name: "pu-daemon-wrapper",
  setup(build) {
    build.onLoad({ filter: /bin[\\/]cdp-daemon\.mjs$/ }, (args) => {
      let src = fs.readFileSync(args.path, "utf8");
      const before = "const WRAPPER = process.env.CHROME_PATH || join(HERE, 'chrome-wrapper.sh');\nconst PROFILE = process.env.PICKLE_ULTRA_PROFILE || join(HERE, 'profile');";
      const after = "const WRAPPER = process.env.CHROME_PATH || (() => { const a = join(HERE, 'chrome-wrapper.sh'); if (existsSync(a)) return a; const b = join(HERE, '..', 'bin', 'chrome-wrapper.sh'); return existsSync(b) ? b : a; })();\nconst PROFILE = process.env.PICKLE_ULTRA_PROFILE || join(STATE_DIR, 'profile');";
      if (!src.includes(before)) throw new Error("cdp-daemon WRAPPER/PROFILE lines not found — update the build patch");
      return { contents: src.replace(before, after), loader: "js", resolveDir: path.dirname(args.path) };
    });
  },
};

const dispatcher = `#!/usr/bin/env node
// dist/vault-intake.mjs — single-file bundle of extensions/vault-intake (generated; do not edit).
// Needs the tree around it for agent-vault/vault.py, the gog CLI and the .sh wrappers.
const argv = process.argv.slice(2);
const cmd = argv[0] || "";
const rest = argv.slice(1);
const USAGE = \`usage: vault-intake.mjs <command> [args...]

  sheet  init|status   build / inspect the private intake sheet
      [--from-json FILE] [--agent-name NAME] [--new] [--gog CMD] [--dry-run] [--json] [--no-format]
  form                 write the fill-in form file
      [--from-json FILE] [--out FILE] [--format tsv|csv|xlsx] [--gog CMD]
  intake               read the sheet (or a form file) into the vault, then clear it
      [--source sheet|file] [--file F] [--attachments-dir D] [--gog CMD]
  selftest             end-to-end self-test (needs gog signed in; uses a temp vault)
      [--keep] [--verbose]
\`;

if (!cmd || cmd === "-h" || cmd === "--help" || cmd === "help") {
  process.stdout.write(USAGE);
} else if (cmd === "sheet" || cmd === "form" || cmd === "intake" || cmd === "selftest") {
  process.argv = [process.argv[0], process.argv[1], ...rest];
  if (cmd === "sheet") await import("./vault-sheet.mjs");
  else if (cmd === "form") await import("./vault-form.mjs");
  else if (cmd === "intake") await import("./intake-all.mjs");
  else await import("./selftest-intake.mjs");
} else {
  process.stderr.write(USAGE + \`\\nerror: unknown command: \${cmd}\\n\`);
  process.exitCode = 2;
}
`;

const common = {
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  splitting: false,
  legalComments: "inline",
  logLevel: "warning",
};

await esbuild.build({
  ...common,
  stdin: { contents: dispatcher, resolveDir: EXT, sourcefile: "vault-intake-cli.mjs", loader: "js" },
  outfile: path.join(DIST, "vault-intake.mjs"),
  plugins: [libRootPatch],
});

for (const [src, out] of [
  ["vault-sheet.mjs", "vault-sheet.mjs"],
  ["vault-form.mjs", "vault-form.mjs"],
  ["intake-all.mjs", "intake-all.mjs"],
]) {
  await esbuild.build({
    ...common,
    entryPoints: [path.join(EXT, src)],
    outfile: path.join(DIST, out),
    plugins: [libRootPatch],
  });
}

for (const f of ["cdp-daemon.mjs", "cdp-client.mjs"]) {
  await esbuild.build({
    ...common,
    entryPoints: [path.join(REPO, "bin", f)],
    outfile: path.join(DIST, f),
    plugins: f === "cdp-daemon.mjs" ? [daemonWrapperPatch] : [],
  });
}

for (const f of fs.readdirSync(DIST).sort()) {
  const p = path.join(DIST, f);
  if (!fs.statSync(p).isFile()) continue;
  fs.chmodSync(p, 0o755);
  console.log(`${f}\t${fs.statSync(p).size} bytes`);
}
console.log(`dist/ written to ${DIST}`);
