// Pinned, checksum-verified toolchain binaries. The CLI provisions language toolchains through mise
// (java/typescript/go/csharp) and uv (python). Rather than piping a `curl | sh` installer — which has
// no Windows story and spawns a decompressor child that endpoint-security can SIGKILL — we download the
// official release archive for the host, verify its SHA-256 against the values below, and extract it in
// process. Everything here is public-release metadata, fetched and verified once (see the regenerator at
// scripts/update-toolchain-manifest.ts) so the install hot-path stays fully offline and reviewable.
//
// To bump a version: change TOOLCHAIN_VERSIONS, run `yarn tsx scripts/update-toolchain-manifest.ts`,
// and commit the regenerated table. The generator verifies the upstream signature before trusting hashes.

export type ToolName = "mise" | "uv";
export type HostPlatform = "darwin" | "linux" | "win32";
export type HostArch = "x64" | "arm64";
export type HostKey = `${HostPlatform}-${HostArch}`;

export interface ManifestEntry {
  // The release asset filename, e.g. "mise-v2026.6.10-windows-x64.zip".
  assetName: string;
  // Full https download URL.
  url: string;
  // Lowercase hex SHA-256 of the asset.
  sha256: string;
  format: "tar.gz" | "zip";
  // Exact archive-internal paths of the binaries we want. Each is installed into the managed bin dir
  // under its basename (e.g. "mise/bin/mise" -> "mise", "uv-<triple>/uvx" -> "uvx"). Exact paths (not
  // basenames) so a layout change upstream fails fast instead of grabbing the wrong member.
  members: string[];
}

// The single source of truth for which toolchain versions the CLI installs. Imported by mise.ts /
// python.ts so a version lives in exactly one place.
export const TOOLCHAIN_VERSIONS = {
  mise: "v2026.6.10",
  uv: "0.11.21",
} as const;

const MISE_BASE = `https://github.com/jdx/mise/releases/download/${TOOLCHAIN_VERSIONS.mise}`;
const UV_BASE = `https://github.com/astral-sh/uv/releases/download/${TOOLCHAIN_VERSIONS.uv}`;

function miseEntry(assetName: string, sha256: string): ManifestEntry {
  const isZip = assetName.endsWith(".zip");
  return {
    assetName,
    url: `${MISE_BASE}/${assetName}`,
    sha256,
    format: isZip ? "zip" : "tar.gz",
    members: [isZip ? "mise/bin/mise.exe" : "mise/bin/mise"],
  };
}

function uvEntry(assetName: string, sha256: string): ManifestEntry {
  const isZip = assetName.endsWith(".zip");
  // The Windows zip is flat (uv.exe, uvx.exe); the Unix tarball nests under the triple dir.
  const triple = assetName.replace(/\.(tar\.gz|zip)$/, "");
  return {
    assetName,
    url: `${UV_BASE}/${assetName}`,
    sha256,
    format: isZip ? "zip" : "tar.gz",
    members: isZip ? ["uv.exe", "uvx.exe"] : [`${triple}/uv`, `${triple}/uvx`],
  };
}

// Verified against the upstream checksum files on 2026-06-21 (see scripts/update-toolchain-manifest.ts).
export const TOOLCHAIN_MANIFEST: Record<ToolName, Partial<Record<HostKey, ManifestEntry>>> = {
  mise: {
    "darwin-arm64": miseEntry(
      "mise-v2026.6.10-macos-arm64.tar.gz",
      "44ebccf53eab0843716f73be8c3e10c7b57706bc72f54f87146e5d7c91b4b0fd",
    ),
    "darwin-x64": miseEntry(
      "mise-v2026.6.10-macos-x64.tar.gz",
      "92f4d52e12a1ca12c9aa80bd2f01e8f832a580adc35e14bc292eb1421f4fb770",
    ),
    "linux-x64": miseEntry(
      "mise-v2026.6.10-linux-x64.tar.gz",
      "472e01b40cd35da6178e8e41e213473286f0562b93a14e47d3e847f5035d13af",
    ),
    "linux-arm64": miseEntry(
      "mise-v2026.6.10-linux-arm64.tar.gz",
      "64825f69d63bcf1156f6764ca58f521cf5223009643b440a130a0f136fd26d00",
    ),
    "win32-x64": miseEntry(
      "mise-v2026.6.10-windows-x64.zip",
      "cfdc9d11ceae211220bf68514c1d7fc67374a26cfbfb62ffeed10922cc1f6ec7",
    ),
    "win32-arm64": miseEntry(
      "mise-v2026.6.10-windows-arm64.zip",
      "c7c68b30c475bc5dafd4f692c18b9d73f3da12057839ee5703d7e22989d03dc2",
    ),
  },
  uv: {
    "darwin-arm64": uvEntry(
      "uv-aarch64-apple-darwin.tar.gz",
      "1f921d491ba5ffeea774eb04d6681ecee379101341cbb1500394993b541bf3f4",
    ),
    "darwin-x64": uvEntry(
      "uv-x86_64-apple-darwin.tar.gz",
      "f3c8e5708a84b920c18b691214d54d2b0da6b984789caae95d47c95120cb7765",
    ),
    "linux-x64": uvEntry(
      "uv-x86_64-unknown-linux-gnu.tar.gz",
      "8c88519b0ef0af9801fcdee419bbb12116bd9e6b18e162ae093c932d8b264050",
    ),
    "linux-arm64": uvEntry(
      "uv-aarch64-unknown-linux-gnu.tar.gz",
      "88e800834007cc5efd4675f166eb2a51e7e3ad19876d85fa8805a6fb5c922397",
    ),
    "win32-x64": uvEntry(
      "uv-x86_64-pc-windows-msvc.zip",
      "ace861f360c6de2babedc1607d0f454b6b09a820dbc8182dc15af927e4df9589",
    ),
    "win32-arm64": uvEntry(
      "uv-aarch64-pc-windows-msvc.zip",
      "74e443f8004022dde57a1bd0d10c097830f9ea8feb4ec927db52cd5d805c2f48",
    ),
  },
};

export function lookupManifest(tool: ToolName, host: HostKey): ManifestEntry {
  const entry = TOOLCHAIN_MANIFEST[tool][host];
  if (!entry) {
    throw new Error(
      `No pinned ${tool} build for ${host}. Supported: ${Object.keys(TOOLCHAIN_MANIFEST[tool]).join(", ")}.`,
    );
  }
  return entry;
}
