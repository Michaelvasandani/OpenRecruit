// Assemble a standalone, Electron-free bundle of the backend host for a Linux VM.
//
// The desktop app runs the host as an ELECTRON_RUN_AS_NODE child, but the host
// bundle itself (`out/main/host.js`) uses no Electron API — under plain Node it
// only needs its externalized npm deps. This script lays those pieces out so a
// server can run it with `node app/out/main/host.js`:
//
//   dist-host/
//     package.json          runtime deps only, pinned to app/package.json versions
//     app/out/main/         host.js + its chunks + agent-mcp.js
//     templates/ resources/ agent scaffolds + hooks (found via paths.ts's `__dirname`
//                           candidates, which expect the repo layout — so we mirror it)
//     deploy/               systemd unit + install script
//
// Native modules (better-sqlite3, node-pty) are NOT copied: `npm install` on the
// server fetches/compiles them for that platform's Node ABI.
//
// Run AFTER `electron-vite build`; wired as the `bundle:host` npm script.

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoDir = resolve(appDir, "..");
const outMain = join(appDir, "out", "main");
const dist = join(repoDir, "dist-host");

// ws's optional perf addons: left as guarded runtime requires (see electron.vite.config.ts).
const OPTIONAL = new Set(["bufferutil", "utf-8-validate"]);

if (!existsSync(join(outMain, "host.js"))) {
  console.error("out/main/host.js not found — run `bun run build` first");
  process.exit(1);
}

/** Walk host.js's relative requires; collect the files it needs + its bare imports. */
function trace(entry) {
  const files = new Set();
  const packages = new Set();
  const visit = (file) => {
    if (files.has(file)) return;
    files.add(file);
    for (const [, spec] of readFileSync(file, "utf8").matchAll(/require\(["']([^"']+)["']\)/g)) {
      if (spec.startsWith(".")) {
        const target = resolve(dirname(file), spec.endsWith(".js") ? spec : `${spec}.js`);
        if (existsSync(target)) visit(target);
      } else if (!spec.startsWith("node:") && !builtinModules.includes(spec)) {
        // "@scope/pkg/sub" -> "@scope/pkg"; "pkg/sub" -> "pkg"
        const parts = spec.split("/");
        packages.add(spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]);
      }
    }
  };
  visit(entry);
  return { files, packages };
}

const { files, packages } = trace(join(outMain, "host.js"));
files.add(join(outMain, "agent-mcp.js")); // dependency-free; spawned per agent by the harness

const appPkg = JSON.parse(readFileSync(join(appDir, "package.json"), "utf8"));
const dependencies = {};
for (const name of [...packages].sort()) {
  if (OPTIONAL.has(name)) continue;
  const version = appPkg.dependencies?.[name];
  if (!version) {
    console.error(`host.js requires "${name}" but app/package.json has no version for it`);
    process.exit(1);
  }
  dependencies[name] = version;
}

rmSync(dist, { recursive: true, force: true });
for (const file of files) {
  const target = join(dist, "app", relative(appDir, file));
  mkdirSync(dirname(target), { recursive: true });
  cpSync(file, target);
}
cpSync(join(repoDir, "templates"), join(dist, "templates"), { recursive: true });
cpSync(join(repoDir, "resources"), join(dist, "resources"), { recursive: true });
cpSync(join(repoDir, "deploy"), join(dist, "deploy"), { recursive: true });
// The launcher normally passes the app version via env; under systemd the unit
// reads it from here (the desktop app compares it against its own on connect).
writeFileSync(join(dist, "deploy", "host.env"), `OPENTRADE_VERSION=${appPkg.version}\n`);

writeFileSync(
  join(dist, "package.json"),
  `${JSON.stringify(
    {
      name: "openrecruit-host",
      version: appPkg.version,
      private: true,
      license: appPkg.license,
      engines: { node: ">=22.12" }, // require(esm): nanoid + superjson are ESM-only
      scripts: { start: "node app/out/main/host.js" },
      dependencies,
    },
    null,
    2,
  )}\n`,
);

console.log(`host bundle -> ${relative(process.cwd(), dist) || dist}`);
console.log(`  files: ${files.size}, deps: ${Object.keys(dependencies).join(", ")}`);
