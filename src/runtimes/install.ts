import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rename, rm, stat, writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { execa } from "execa";
import * as tar from "tar";
import yauzl from "yauzl";
import { lookupManifest, TOOLCHAIN_VERSIONS, type ManifestEntry, type ToolName } from "./toolchain-manifest.js";
import {
  compareVersions,
  envWithManagedBinFor,
  hostKeyFor,
  managedBinDirFor,
  parseVersion,
  withExe as withExeFor,
} from "./platform.js";

// Bounds the toolchain download so a stalled socket can't hang setup forever; overridable for slow links.
function transferTimeoutMs(): number {
  const override = Number.parseInt(process.env.HI_TRANSFER_TIMEOUT_MS ?? "", 10);
  return Number.isInteger(override) && override > 0 ? override : 120_000;
}

// Thrown when a downloaded archive's SHA-256 doesn't match the pinned manifest value. Typed so a
// tampered/corrupt/proxy-mangled download is distinguishable from a plain network error in telemetry.
export class ChecksumError extends Error {
  constructor(
    readonly tool: ToolName,
    readonly expected: string,
    readonly actual: string,
  ) {
    super(`checksum mismatch for ${tool}: expected ${expected}, got ${actual}`);
    this.name = "ChecksumError";
  }
}

const WINDOWS = process.platform === "win32";

export function detectHost(): { key: ReturnType<typeof hostKeyFor> } {
  return { key: hostKeyFor(process.platform, process.arch) };
}

// Where we install pinned toolchain binaries. A private, per-user dir — we never touch the system
// install or global PATH. ~/.local/bin on unix coexists with mise/uv's own default location.
export function managedBinDir(): string {
  return managedBinDirFor(process.platform, process.env, homedir());
}

function withExe(name: string): string {
  return withExeFor(process.platform, name);
}

// Resolve a toolchain command to a runnable path: prefer our managed pinned binary, otherwise fall back
// to the bare name so a system install on PATH still works (cross-spawn resolves it, with PATHEXT on
// Windows).
export function resolveBin(binary: string): string {
  const managed = join(managedBinDir(), withExe(binary));
  return existsSync(managed) ? managed : binary;
}

// Build an env with the managed bin dir prepended to PATH and the session token stripped. Provisioning
// and test commands run untrusted seed code; none of them have any business seeing the bearer token.
export function envWithManagedBin(): NodeJS.ProcessEnv {
  return envWithManagedBinFor(process.platform, process.env, homedir());
}

// True if the binary is runnable — present in the managed dir, or resolvable on PATH and answering
// `--version`. The probe both locates and validates (a present-but-broken tool won't false-positive),
// and works identically on every OS, so we never shell out to `which`/`where`.
export async function onPath(binary: string): Promise<boolean> {
  if (existsSync(join(managedBinDir(), withExe(binary)))) return true;
  try {
    await execa(binary, ["--version"], { env: envWithManagedBin() });
    return true;
  } catch {
    return false;
  }
}

function managedBin(tool: ToolName): string {
  return join(managedBinDir(), withExe(tool));
}

function versionSentinel(tool: ToolName): string {
  return join(managedBinDir(), `.${tool}.version`);
}

// Pinned version without the leading "v" (mise tags as "v2026.6.10" but `mise --version` prints
// "2026.6.10"; uv is "0.11.21" both ways).
function pinnedVersion(tool: ToolName): string {
  return TOOLCHAIN_VERSIONS[tool].replace(/^v/, "");
}

// Accept an existing system tool only if it's at least the pinned version — presence alone is the wrong
// gate for a "pinned, reviewed toolchain". An older or unparseable system tool is bypassed in favor of
// installing the pinned build into the managed dir.
async function systemToolSatisfies(tool: ToolName): Promise<boolean> {
  try {
    const { stdout, exitCode } = await execa(tool, ["--version"], { reject: false });
    if (exitCode !== 0) return false;
    const found = parseVersion(stdout);
    return found !== null && compareVersions(found, pinnedVersion(tool)) >= 0;
  } catch {
    return false;
  }
}

async function downloadToFile(url: string, dest: string): Promise<void> {
  if (new URL(url).protocol !== "https:") {
    throw new Error(`Refusing to download a toolchain over a non-https URL: ${url}`);
  }
  const res = await fetch(url, { signal: AbortSignal.timeout(transferTimeoutMs()) });
  if (!res.ok || !res.body) {
    throw new Error(`toolchain download failed (${res.status}) for ${url}`);
  }
  // Stream to disk rather than buffering a multi-MB archive in memory.
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
}

async function verifySha256(file: string, expected: ManifestEntry["sha256"], tool: ToolName): Promise<void> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(file), hash);
  const actual = hash.digest("hex");
  if (actual !== expected) throw new ChecksumError(tool, expected, actual);
}

// Reject any archive member that escapes the extraction dir (zip-slip / tar traversal). Belt-and-
// suspenders: the SHA-256 already pins the exact artifact, but we never trust an archive's own paths.
function safeJoin(intoDir: string, member: string): string {
  const dest = resolve(intoDir, member);
  if (dest !== intoDir && !dest.startsWith(intoDir + sep)) {
    throw new Error(`Refusing archive member that escapes the extraction dir: ${member}`);
  }
  return dest;
}

async function extractTarGz(archive: string, members: string[], intoDir: string): Promise<string[]> {
  const wanted = new Set(members);
  // tar enforces its own traversal/symlink safety; the filter limits extraction to our exact members.
  await tar.x({ file: archive, cwd: intoDir, filter: (path) => wanted.has(path) });
  return members.map((m) => safeJoin(intoDir, m));
}

function extractZip(archive: string, members: string[], intoDir: string): Promise<string[]> {
  const wanted = new Set(members);
  const written: string[] = [];
  return new Promise<string[]>((resolvePromise, reject) => {
    yauzl.open(archive, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return reject(err ?? new Error("could not open zip"));
      zip.on("error", reject);
      zip.on("end", () => resolvePromise(written));
      zip.readEntry();
      zip.on("entry", (entry: yauzl.Entry) => {
        const name = entry.fileName;
        if (name.endsWith("/") || !wanted.has(name)) {
          zip.readEntry();
          return;
        }
        // Reject symlink entries (unix mode is the high 16 bits of externalFileAttributes).
        const unixMode = entry.externalFileAttributes >>> 16;
        if ((unixMode & 0o170000) === 0o120000) {
          return reject(new Error(`Refusing symlink entry in zip: ${name}`));
        }
        const dest = safeJoin(intoDir, name);
        zip.openReadStream(entry, (streamErr, stream) => {
          if (streamErr || !stream) return reject(streamErr ?? new Error("could not read zip entry"));
          mkdir(dirname(dest), { recursive: true })
            .then(() => pipeline(stream, createWriteStream(dest)))
            .then(() => {
              written.push(dest);
              zip.readEntry();
            })
            .catch(reject);
        });
      });
    });
  });
}

async function extractMembers(entry: ManifestEntry, archive: string, intoDir: string): Promise<string[]> {
  const paths =
    entry.format === "zip"
      ? await extractZip(archive, entry.members, intoDir)
      : await extractTarGz(archive, entry.members, intoDir);
  // Fail fast if the archive didn't contain a member we expected — otherwise a layout change upstream
  // (or a missing uvx) would silently install fewer binaries and still write the version sentinel.
  for (const member of entry.members) {
    if (!existsSync(safeJoin(intoDir, member))) {
      throw new Error(`Archive ${entry.assetName} is missing expected member: ${member}`);
    }
  }
  return paths;
}

// Move a file into place atomically (rename is atomic on the same filesystem), then mark it executable
// on unix. The temp extraction dir lives under the same managed parent so the rename stays on one fs.
async function atomicInstall(from: string, to: string): Promise<void> {
  const staging = `${to}.tmp-${process.pid}`;
  await rename(from, staging);
  if (!WINDOWS) await chmod(staging, 0o755);
  await rename(staging, to);
}

// How long to wait for another run's install before giving up on the lock, and how old a lock must be
// before we treat it as abandoned. The actual download is ~1–5s, so a much older lock means the holder
// crashed or was SIGKILLed (one of our motivating failures) — we must not let that wedge later runs.
const LOCK_WAIT_MS = 60_000;
const STALE_LOCK_MS = 60_000;
const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// A coarse per-tool lock so two concurrent `start` runs don't both download into the managed dir. mkdir
// is atomic; if we lose the race we wait for the other run's install to land. Crash-safe: a lock left by
// a killed process is broken once it's older than STALE_LOCK_MS, and if we still can't acquire it in
// LOCK_WAIT_MS we proceed anyway — the final placement is atomic (staged temp + rename), so concurrent
// installs are safe; the lock is an optimization, not a correctness crutch.
async function withInstallLock(tool: ToolName, fn: () => Promise<void>): Promise<void> {
  const lockDir = join(managedBinDir(), `.${tool}.lock`);
  await mkdir(managedBinDir(), { recursive: true });
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (Date.now() < deadline) {
    try {
      await mkdir(lockDir);
    } catch {
      if (existsSync(managedBin(tool))) return; // another run finished while we waited
      try {
        const age = Date.now() - (await stat(lockDir)).mtimeMs;
        if (age > STALE_LOCK_MS) await rm(lockDir, { recursive: true, force: true });
      } catch {
        // lock vanished between mkdir and stat — just retry
      }
      await delay(400);
      continue;
    }
    try {
      await fn();
    } finally {
      await rm(lockDir, { recursive: true, force: true });
    }
    return;
  }
  // Couldn't get the lock in time (holder is very slow, or repeatedly re-taken). Proceed without it;
  // the atomic install keeps the final binary valid even if two installs overlap.
  await fn();
}

async function installPinned(tool: ToolName, entry: ManifestEntry): Promise<void> {
  await withInstallLock(tool, async () => {
    // Re-check under the lock: another run may have installed while we waited.
    if (existsSync(managedBin(tool)) && readInstalledVersion(tool) === pinnedVersion(tool)) return;
    const work = await mkdtemp(join(managedBinDir(), `.${tool}-install-`));
    try {
      const archive = join(work, entry.assetName);
      await downloadToFile(entry.url, archive);
      await verifySha256(archive, entry.sha256, tool);
      const extracted = await extractMembers(entry, archive, work);
      for (const file of extracted) {
        await atomicInstall(file, join(managedBinDir(), basename(file)));
      }
      await writeFile(versionSentinel(tool), `${pinnedVersion(tool)}\n`, "utf8");
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });
}

function readInstalledVersion(tool: ToolName): string | null {
  try {
    return readFileSync(versionSentinel(tool), "utf8").trim();
  } catch {
    return null;
  }
}

// Ensure the pinned toolchain manager is available. Order: reuse our managed pinned binary, else accept
// a recent-enough system install, else download+verify+install the pinned build into the managed dir.
export async function installTool(tool: ToolName): Promise<void> {
  if (existsSync(managedBin(tool)) && readInstalledVersion(tool) === pinnedVersion(tool)) return;
  if (await systemToolSatisfies(tool)) return;
  const entry = lookupManifest(tool, detectHost().key);
  await installPinned(tool, entry);
}
