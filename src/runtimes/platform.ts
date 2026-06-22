// Pure, platform-parameterized helpers for cross-platform path/PATH/version handling. Kept free of
// process.* and fs so they can be unit-tested for every OS on any host (pass platform/env/home in).
// install.ts and shared.ts wrap these with the real process values.
import { win32, posix } from "node:path";
import type { HostArch, HostKey, HostPlatform } from "./toolchain-manifest.js";

export function isWindows(platform: NodeJS.Platform): boolean {
  return platform === "win32";
}

export function withExe(platform: NodeJS.Platform, name: string): string {
  return isWindows(platform) && !name.toLowerCase().endsWith(".exe") ? `${name}.exe` : name;
}

// The private, CLI-owned dir where we install pinned toolchain binaries. Deliberately NOT ~/.local/bin:
// that's shared user space, so installing there could alias or overwrite a user's own mise/uv. We keep
// our binaries in an app-namespaced dir (%LOCALAPPDATA%\hello-interview\bin on Windows, the XDG data dir
// elsewhere) and prepend it to PATH only for our own subprocesses. A user's existing tool is still
// reused — via the PATH version probe (systemToolSatisfies/onPath), not by colliding on disk.
export function managedBinDirFor(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, home: string): string {
  if (isWindows(platform)) {
    const base = env.LOCALAPPDATA?.trim() || win32.join(home, "AppData", "Local");
    return win32.join(base, "hello-interview", "bin");
  }
  const base = env.XDG_DATA_HOME?.trim() || posix.join(home, ".local", "share");
  return posix.join(base, "hello-interview", "bin");
}

// Build an env with the managed bin dir prepended to PATH (using the platform's delimiter) and the
// session token stripped — provisioning/test commands run untrusted seed code and have no business
// seeing the bearer token. Reads PATH or, on Windows, the `Path` casing, and normalizes onto PATH.
export function envWithManagedBinFor(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  home: string,
): NodeJS.ProcessEnv {
  const out = { ...env };
  delete out.HI_TOKEN;
  const dir = managedBinDirFor(platform, env, home);
  // win32.delimiter / posix.delimiter are literal ";" / ":" — NOT node:path's top-level `delimiter`,
  // which is the *host's* and would be wrong when simulating another platform (e.g. tests on Windows CI).
  const sep = isWindows(platform) ? win32.delimiter : posix.delimiter;
  const current = out.PATH ?? out.Path ?? "";
  delete out.Path;
  out.PATH = current.split(sep).includes(dir) ? current : `${dir}${sep}${current}`;
  return out;
}

// The Maven wrapper as an absolute path: mvnw.cmd on Windows, mvnw elsewhere. Both ship in the seed.
export function mvnwPathFor(platform: NodeJS.Platform, repoDir: string): string {
  const join = isWindows(platform) ? win32.join : posix.join;
  return join(repoDir, isWindows(platform) ? "mvnw.cmd" : "mvnw");
}

export function hostKeyFor(platform: NodeJS.Platform, arch: string): HostKey {
  if (platform !== "darwin" && platform !== "linux" && platform !== "win32") {
    throw new Error(`Unsupported platform "${platform}". The AI-coding CLI supports macOS, Linux, and Windows.`);
  }
  if (arch !== "x64" && arch !== "arm64") {
    throw new Error(`Unsupported CPU architecture "${arch}". The AI-coding CLI supports x64 and arm64.`);
  }
  const p: HostPlatform = platform;
  const a: HostArch = arch;
  return `${p}-${a}`;
}

// Compare dotted numeric versions. Negative if a < b, 0 if equal, positive if a > b. Trailing
// non-numeric (pre-release) parts are ignored — enough to gate "system tool new enough to reuse".
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => Number.parseInt(n, 10));
  const pb = b.split(".").map((n) => Number.parseInt(n, 10));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (Number.isNaN(x) || Number.isNaN(y)) return 0;
    if (x !== y) return x - y;
  }
  return 0;
}

export function parseVersion(output: string): string | null {
  return output.match(/(\d+\.\d+\.\d+)/)?.[1] ?? null;
}
