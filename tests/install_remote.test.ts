/**
 * install-remote.sh tells a network failure apart from a missing release (#600).
 *
 * On a DNS failure, a refused connection or a timeout, curl's `-w '%{url_effective}'`
 * still prints the URL it was asked for. The installer used to treat that URL as the
 * tag and report "Release tag 'https://…' does not look like a tag", which sends the
 * reader after the wrong problem. A failed download said nothing past curl's own line.
 *
 * These tests run the REAL script with a stub `curl` (and `uname`, to pin the
 * platform) first on PATH and HOME pointed at a temp dir, so nothing touches the
 * network, the host's ~/.local/bin or its ~/.claude.json. The stub answers the
 * releases/latest lookup and the binary download separately, from env vars, and
 * logs every URL it was asked for. It exits 2 if the script stops passing the -f,
 * -L, -o or -w format its parsing depends on.
 *
 * Not `node:fs`: sibling files install a partial, process-global `fs` mock (#456,
 * lib/test-support/mock-fs.ts), and this file would get it whenever it loads after
 * them. Bun globals and subprocesses have no module specifier to intercept.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";

const SCRIPT = resolve(import.meta.dir, "..", "scripts", "install-remote.sh");
const BASE = "https://github.com/Wave-Engineering/mcp-server-sdlc";
const LATEST = `${BASE}/releases/latest`;
const download = (tag: string) => `${BASE}/releases/download/${tag}/sdlc-server-linux-x64`;
const CDN = "https://release-assets.githubusercontent.com/github-production-release-asset/1/2";

const CURL_STUB = `#!/usr/bin/env bash
argv="$*" out="" url="" fmt="" fail=0 follow=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    -o) out="$2"; shift 2 || shift ;;
    -w) fmt="$2"; shift 2 || shift ;;
    --*) shift ;;
    -*) [[ "$1" == *f* ]] && fail=1; [[ "$1" == *L* ]] && follow=1; shift ;;
    http://*|https://*) url="$1"; shift ;;
    *) shift ;;
  esac
done
echo "$url" >> "$STUB_LOG"
# Fail loudly if the script's side of the contract drifts: -f turns an HTTP error
# into exit 22, -L follows github.com's redirects, and the -w format is what the
# script splits into status and URL.
if [[ "$fail$follow" != 11 || "$fmt" != '%{http_code} %{url_effective}' || -z "$out" ]]; then
  echo "curl stub: unexpected argv: $argv" >&2
  exit 2
fi
if [[ "$url" == */releases/latest ]]; then
  printf '%s' "$RESOLVE_OUT"
  exit "\${RESOLVE_EXIT:-0}"
fi
if [[ "\${DOWNLOAD_EXIT:-0}" -eq 0 ]]; then
  printf '#!/bin/sh\\n' > "$out"
else
  # A transfer cut short (curl exit 18/56) leaves a partial file, so the
  # no-temp-file checks below exercise the script's EXIT trap.
  printf 'partial' > "$out"
fi
printf '%s' "\${DOWNLOAD_OUT:-200 $url}"
exit "\${DOWNLOAD_EXIT:-0}"
`;

const UNAME_STUB = `#!/bin/sh
case "$1" in -m) echo x86_64 ;; *) echo Linux ;; esac
`;

let root: string;
let home: string;
let log: string;

/** Run a command, throw on a non-zero exit, return its stdout. */
function sh(...argv: string[]): string {
  const p = Bun.spawnSync(argv);
  if (p.exitCode !== 0) throw new Error(`${argv.join(" ")} exited ${p.exitCode}: ${p.stderr.toString()}`);
  return p.stdout.toString();
}

/** What the script left in ~/.local/bin. */
const installed = () => [...new Bun.Glob("*").scanSync({ cwd: join(home, ".local", "bin"), dot: true })];

beforeEach(async () => {
  root = sh("mktemp", "-d", `${process.env.TMPDIR || "/tmp"}/sdlc-install-remote-XXXXXX`).trim();
  home = join(root, "home");
  log = join(root, "curl.log");
  const bin = join(root, "bin");
  sh("mkdir", "-p", home, bin);
  await Bun.write(join(bin, "curl"), CURL_STUB);
  await Bun.write(join(bin, "uname"), UNAME_STUB);
  await Bun.write(log, "");
  sh("chmod", "755", join(bin, "curl"), join(bin, "uname"));
});

afterEach(() => {
  sh("rm", "-rf", root);
});

function run(env: Record<string, string>) {
  const proc = Bun.spawnSync(["bash", SCRIPT, "--skip-probe"], {
    env: { PATH: `${join(root, "bin")}:${process.env.PATH}`, HOME: home, STUB_LOG: log, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
    urls: sh("cat", log).split("\n").filter(Boolean),
  };
}

describe("install-remote.sh: the releases/latest lookup fails", () => {
  for (const exit of [6, 7, 28, 35]) {
    test(`curl exit ${exit} is reported as a network error, not a bad tag`, () => {
      const r = run({ RESOLVE_EXIT: String(exit), RESOLVE_OUT: `000 ${LATEST}` });
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("Network error while resolving the latest release");
      expect(r.stderr).toContain(LATEST);
      expect(r.stderr).toContain(`(curl exit ${exit})`);
      expect(r.stderr).not.toContain("does not look like a tag");
    });
  }

  test("HTTP 404 says the release does not exist and names the URL", () => {
    const r = run({ RESOLVE_EXIT: "22", RESOLVE_OUT: `404 ${LATEST}` });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(`HTTP 404 while resolving the latest release: ${LATEST} does not exist.`);
    expect(r.stderr).not.toContain("Network error");
  });

  test("HTTP 503 names the status and URL without claiming the release is missing", () => {
    const r = run({ RESOLVE_EXIT: "22", RESOLVE_OUT: `503 ${LATEST}` });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("HTTP 503 while resolving the latest release");
    expect(r.stderr).toContain(LATEST);
    expect(r.stderr).toContain("Set SDLC_VERSION to a release tag (e.g. v1.2.3) to skip this lookup.");
    expect(r.stderr).not.toContain("does not exist");
  });

  test("a redirect that lands off a tag page hits the empty-tag guard, naming where it landed", () => {
    const r = run({ RESOLVE_OUT: `200 ${BASE}/releases` });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(`Could not determine release tag: ${LATEST} led to ${BASE}/releases, not a release.`);
    expect(r.stderr).not.toContain("does not look like a tag");
  });
});

describe("install-remote.sh: the binary download fails", () => {
  test("a pin skips the lookup, and a network failure names the download URL and leaves no temp file", () => {
    const r = run({ SDLC_VERSION: "v4.4.1", DOWNLOAD_EXIT: "7", DOWNLOAD_OUT: `000 ${download("v4.4.1")}` });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(`Network error while downloading sdlc-server v4.4.1: could not reach ${download("v4.4.1")} (curl exit 7).`);
    expect(r.urls).toEqual([download("v4.4.1")]);
    expect(installed()).toEqual([]);
  });

  test("a network failure on the asset CDN names the CDN URL, without its signed query", () => {
    const r = run({ SDLC_VERSION: "v4.4.1", DOWNLOAD_EXIT: "7", DOWNLOAD_OUT: `302 ${CDN}?sig=SECRET&se=1` });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(`could not reach ${CDN} (redirected from ${download("v4.4.1")}) (curl exit 7).`);
    expect(r.stderr).not.toContain("SECRET");
    expect(installed()).toEqual([]);
  });

  test("a pinned tag with no asset is HTTP 404, and no temp file is left behind", () => {
    const r = run({ SDLC_VERSION: "v9.9.9", DOWNLOAD_EXIT: "22", DOWNLOAD_OUT: `404 ${download("v9.9.9")}` });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(`HTTP 404 while downloading sdlc-server v9.9.9: ${download("v9.9.9")} does not exist.`);
    expect(installed()).toEqual([]);
  });
});

describe("install-remote.sh: the not-a-tag guard", () => {
  test("a pin that is not a tag fails before anything is fetched", () => {
    const r = run({ SDLC_VERSION: "5.0.0" });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("Release tag '5.0.0' does not look like a tag.");
    expect(r.urls).toEqual([]);
  });
});

describe("install-remote.sh: nothing fails", () => {
  test("the latest tag resolves, downloads and installs", () => {
    const r = run({ RESOLVE_OUT: `200 ${BASE}/releases/tag/v5.0.0` });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Installing sdlc-server v5.0.0 for linux-x64...");
    expect(r.urls).toEqual([LATEST, download("v5.0.0")]);
    expect(installed()).toEqual(["sdlc-server"]);
  });
});
