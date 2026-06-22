/**
 * Dev-only regenerator for the pinned toolchain checksums in src/runtimes/toolchain-manifest.ts.
 *
 * Run this when bumping TOOLCHAIN_VERSIONS. It fetches the real release checksums for every supported
 * host, prints the (HostKey -> sha256) table to paste into the manifest, and — importantly — does NOT
 * trust-on-first-fetch: for mise it verifies the upstream minisign signature on SHASUMS256.txt before
 * trusting any hash. If the `minisign` CLI isn't installed it loudly refuses rather than silently
 * downgrading to unverified hashes (uv publishes per-asset .sha256 without a separate signature file we
 * can verify here, so those are checksum-only — a deliberate, documented gap, not an oversight).
 *
 *   cd packages/cli && yarn tsx scripts/update-toolchain-manifest.ts
 *
 * This never runs at install time; the committed manifest is the offline source of truth.
 */
import { execa } from "execa";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TOOLCHAIN_VERSIONS, type HostKey } from "../src/runtimes/toolchain-manifest.js";

// mise's minisign public key, published at https://github.com/jdx/mise (verify before trusting this).
const MISE_MINISIGN_PUBKEY = "RWRGa//6SHcr2k7/eRO7Wx6mILtL+/Y0/jGqIyP3LZjpQ4tEzKLcZHBN";

const MISE_ASSETS: Record<HostKey, string> = {
  "darwin-arm64": "mise-VERSION-macos-arm64.tar.gz",
  "darwin-x64": "mise-VERSION-macos-x64.tar.gz",
  "linux-x64": "mise-VERSION-linux-x64.tar.gz",
  "linux-arm64": "mise-VERSION-linux-arm64.tar.gz",
  "win32-x64": "mise-VERSION-windows-x64.zip",
  "win32-arm64": "mise-VERSION-windows-arm64.zip",
};

const UV_ASSETS: Record<HostKey, string> = {
  "darwin-arm64": "uv-aarch64-apple-darwin.tar.gz",
  "darwin-x64": "uv-x86_64-apple-darwin.tar.gz",
  "linux-x64": "uv-x86_64-unknown-linux-gnu.tar.gz",
  "linux-arm64": "uv-aarch64-unknown-linux-gnu.tar.gz",
  "win32-x64": "uv-x86_64-pc-windows-msvc.zip",
  "win32-arm64": "uv-aarch64-pc-windows-msvc.zip",
};

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${url} failed (${res.status})`);
  return res.text();
}

async function minisignAvailable(): Promise<boolean> {
  try {
    await execa("minisign", ["-v"]);
    return true;
  } catch {
    return false;
  }
}

async function fetchMiseChecksums(): Promise<Record<HostKey, string>> {
  const version = TOOLCHAIN_VERSIONS.mise;
  const base = `https://github.com/jdx/mise/releases/download/${version}`;
  const sumsUrl = `${base}/SHASUMS256.txt`;
  const sums = await fetchText(sumsUrl);

  if (!(await minisignAvailable())) {
    throw new Error(
      "minisign is not installed, so the mise SHASUMS256.txt signature can't be verified. Install it " +
        "(`brew install minisign`) and re-run — we don't write unverified hashes into the manifest.",
    );
  }
  const work = await mkdtemp(join(tmpdir(), "mise-verify-"));
  await writeFile(join(work, "SHASUMS256.txt"), sums);
  const sig = await fetchText(`${sumsUrl}.minisig`);
  await writeFile(join(work, "SHASUMS256.txt.minisig"), sig);
  await execa("minisign", ["-Vm", join(work, "SHASUMS256.txt"), "-P", MISE_MINISIGN_PUBKEY], {
    stdio: "inherit",
  });
  console.log("✓ mise SHASUMS256.txt minisign signature verified");

  const map = new Map<string, string>();
  for (const line of sums.split("\n")) {
    const m = line.match(/^([0-9a-f]{64})\s+\.?\/?(.+)$/);
    if (m) map.set(m[2]!.trim(), m[1]!);
  }
  return resolveAssets(MISE_ASSETS, version, (asset) => {
    const sha = map.get(asset);
    if (!sha) throw new Error(`mise SHASUMS256.txt has no entry for ${asset}`);
    return Promise.resolve(sha);
  });
}

async function fetchUvChecksums(): Promise<Record<HostKey, string>> {
  const version = TOOLCHAIN_VERSIONS.uv;
  const base = `https://github.com/astral-sh/uv/releases/download/${version}`;
  return resolveAssets(UV_ASSETS, version, async (asset) => {
    // uv publishes a per-asset .sha256 ("<hash>  <file>" or "<hash> *<file>").
    const text = await fetchText(`${base}/${asset}.sha256`);
    const sha = text.trim().match(/^([0-9a-f]{64})/)?.[1];
    if (!sha) throw new Error(`could not parse ${asset}.sha256`);
    return sha;
  });
}

async function resolveAssets(
  assets: Record<HostKey, string>,
  version: string,
  shaFor: (asset: string) => Promise<string>,
): Promise<Record<HostKey, string>> {
  const out = {} as Record<HostKey, string>;
  for (const [host, template] of Object.entries(assets) as [HostKey, string][]) {
    const asset = template.replace("VERSION", version);
    out[host] = await shaFor(asset);
  }
  return out;
}

function printTable(tool: string, checksums: Record<HostKey, string>): void {
  console.log(`\n// ${tool} ${TOOLCHAIN_VERSIONS[tool as "mise" | "uv"]}`);
  for (const [host, sha] of Object.entries(checksums)) {
    console.log(`  ${host.padEnd(14)} ${sha}`);
  }
}

async function main(): Promise<void> {
  console.log("Regenerating toolchain checksums for:", TOOLCHAIN_VERSIONS);
  const mise = await fetchMiseChecksums();
  const uv = await fetchUvChecksums();
  printTable("mise", mise);
  printTable("uv", uv);
  console.log(
    "\nPaste these SHA-256 values into src/runtimes/toolchain-manifest.ts, then `yarn build` and run the tests.",
  );
}

main().catch((error: unknown) => {
  console.error("update-toolchain-manifest failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
