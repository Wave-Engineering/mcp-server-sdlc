/**
 * Vulnerable dependencies stay fixed (#504).
 *
 * Three HIGH advisories were live here:
 *   fast-uri    CVE-2026-16221  (fixed 3.1.4)
 *   fast-uri    CVE-2026-18446  (fixed 3.1.5)
 *   ip-address  CVE-2026-69192  (fixed 10.3.1)
 *
 * #504 asked for fast-uri 3.1.4, which still leaves CVE-2026-18446 live —
 * the two advisories have different fixed versions and only the later one covers
 * both.
 *
 * **This reads the INSTALLED TREE, not the lockfile.** `trivy` parses `bun.lock`
 * and is therefore structurally blind to a vulnerable copy nested under a parent
 * whose declared range excludes the fix: the top-level entry reads fixed, the
 * scan agrees, and the CVE is live. That is precisely how a bump becomes
 * cosmetic, and `ip-address` was one range away from it here —
 * express-rate-limit <8.6.0 pinned it at EXACTLY 10.1.0, so forcing a fix
 * without also bumping the parent would have produced a private nested copy.
 *
 * The probe is validated against a planted nested copy before its zeroes are
 * trusted: a probe that has only ever run on a clean tree has not been tested.
 */

import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

const REPO = resolve(import.meta.dir, "..");

/**
 * Every installed copy of `pkg`, at any depth, read in a SUBPROCESS.
 *
 * Not `node:fs` in-process, and not `node:child_process` either: this repo has
 * known cross-file `mock.module` leakage (sdlc#456), and BOTH are mocked by
 * other files. An in-process fs walk read a mocked filesystem; importing
 * `spawnSync` then failed outright with "Export named 'spawnSync' not found in
 * module 'node:child_process'" — a partial mock replacing the real module.
 *
 * `Bun.spawnSync` is a GLOBAL, so there is no module specifier to intercept. The
 * question here is about bytes on disk, so it is asked of the disk, from a
 * process nothing has mocked.
 */
function installedVersions(pkg: string): { version: string; path: string }[] {
  const script = `
import json, os, sys
root, want = sys.argv[1], sys.argv[2]
for dirpath, dirnames, filenames in os.walk(root):
    if "package.json" not in filenames:
        continue
    f = os.path.join(dirpath, "package.json")
    try:
        d = json.load(open(f))
    except Exception:
        continue
    # Identity comes from \`name\` IN THE FILE, never from the path: path
    # matching fails in both directions — an absolute prefix containing
    # /node_modules/ makes a top-level copy read as nested, and a package's own
    # benchmark/package.json declares a different version of a similar name.
    if d.get("name") == want and isinstance(d.get("version"), str):
        print(d["version"], f)
`;
  const proc = Bun.spawnSync(["python3", "-c", script, `${REPO}/node_modules`, pkg]);
  if (proc.exitCode !== 0) {
    throw new Error(`probe failed: ${proc.stderr.toString()}`);
  }
  return proc.stdout
    .toString()
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [version, ...rest] = l.split(" ");
      return { version, path: rest.join(" ") };
    });
}

function atLeast(version: string, floor: string): boolean {
  const a = version.split(".").map(Number);
  const b = floor.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) > (b[i] ?? 0)) return true;
    if ((a[i] ?? 0) < (b[i] ?? 0)) return false;
  }
  return true;
}

function readPackageJson(): any {
  const proc = Bun.spawnSync([
    "python3", "-c", "import sys;print(open(sys.argv[1]).read())", `${REPO}/package.json`,
  ]);
  return JSON.parse(proc.stdout.toString());
}

function plant(relPath: string, body: string) {
  Bun.spawnSync([
    "python3", "-c",
    "import os,sys;os.makedirs(os.path.dirname(sys.argv[1]),exist_ok=True);open(sys.argv[1],'w').write(sys.argv[2])",
    `${REPO}/${relPath}`, body,
  ]);
}

function unplant(relDir: string) {
  Bun.spawnSync([
    "python3", "-c", "import shutil,sys;shutil.rmtree(sys.argv[1],ignore_errors=True)",
    `${REPO}/${relDir}`,
  ]);
}

describe("dependency floors (#504)", () => {
  test("the probe can see a NESTED copy", () => {
    // Validate the instrument before trusting its zeroes. Planted at the depth a
    // real nested copy lives at; if this is not found, every assertion below is
    // vacuous rather than reassuring.
    try {
      plant(
        "node_modules/ajv/node_modules/fast-uri/package.json",
        JSON.stringify({ name: "fast-uri", version: "0.0.1-planted" }),
      );
      const hits = installedVersions("fast-uri");
      expect(hits.some((h) => h.version === "0.0.1-planted")).toBe(true);
      expect(hits.length).toBeGreaterThan(1);
    } finally {
      unplant("node_modules/ajv/node_modules");
    }
  });

  for (const [pkg, floor, cves] of [
    ["fast-uri", "3.1.5", "CVE-2026-16221 (3.1.4), CVE-2026-18446 (3.1.5)"],
    ["ip-address", "10.3.1", "CVE-2026-69192"],
  ] as const) {
    test(`${pkg} is at or above ${floor} in EVERY installed copy — ${cves}`, () => {
      const hits = installedVersions(pkg);
      // A zero here would mean the dependency chain vanished rather than that
      // the pin held — chain-absence wearing a pass's clothes.
      expect(hits.length).toBeGreaterThan(0);
      const bad = hits.filter((h) => !atLeast(h.version, floor));
      expect(bad).toEqual([]);
    });
  }

  test("express-rate-limit is new enough to ACCEPT a fixed ip-address", () => {
    // <8.6.0 pinned ip-address at exactly 10.1.0. Overriding ip-address without
    // this bump forces a version the parent does not declare, which is how a
    // private nested copy appears and the fix becomes cosmetic.
    const hits = installedVersions("express-rate-limit");
    expect(hits.length).toBeGreaterThan(0);
    for (const h of hits) expect(atLeast(h.version, "8.6.0")).toBe(true);
  });

  test("the floors are DECLARED, not just currently resolved", () => {
    // A lockfile that happens to resolve high is not a constraint; the next
    // `bun install` can walk it back without anyone noticing.
    const o = readPackageJson().overrides ?? {};
    expect(o["fast-uri"]).toBeDefined();
    expect(o["ip-address"]).toBeDefined();
    expect(o["express-rate-limit"]).toBeDefined();
  });
});
