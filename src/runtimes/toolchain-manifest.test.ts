import { test } from "node:test";
import assert from "node:assert/strict";
import { lookupManifest, TOOLCHAIN_MANIFEST, type HostKey, type ToolName } from "./toolchain-manifest.js";

const HOSTS: HostKey[] = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64", "win32-x64", "win32-arm64"];
const TOOLS: ToolName[] = ["mise", "uv"];

test("every supported host has a pinned entry for both tools", () => {
  for (const tool of TOOLS) {
    for (const host of HOSTS) {
      const entry = lookupManifest(tool, host);
      assert.ok(entry.url.startsWith("https://"), `${tool} ${host} url must be https`);
      assert.match(entry.sha256, /^[0-9a-f]{64}$/, `${tool} ${host} sha256 must be 64 hex chars`);
      assert.ok(entry.members.length > 0, `${tool} ${host} must name at least one member`);
    }
  }
});

test("format matches the asset extension", () => {
  for (const tool of TOOLS) {
    for (const host of HOSTS) {
      const entry = lookupManifest(tool, host);
      const expected = entry.assetName.endsWith(".zip") ? "zip" : "tar.gz";
      assert.equal(entry.format, expected, `${tool} ${host} format mismatch`);
    }
  }
});

test("mise member is mise/bin/mise[.exe] per platform", () => {
  assert.deepEqual(lookupManifest("mise", "darwin-arm64").members, ["mise/bin/mise"]);
  assert.deepEqual(lookupManifest("mise", "linux-x64").members, ["mise/bin/mise"]);
  assert.deepEqual(lookupManifest("mise", "win32-x64").members, ["mise/bin/mise.exe"]);
});

test("uv members are nested on unix, flat on windows, and include uvx", () => {
  assert.deepEqual(lookupManifest("uv", "darwin-arm64").members, [
    "uv-aarch64-apple-darwin/uv",
    "uv-aarch64-apple-darwin/uvx",
  ]);
  assert.deepEqual(lookupManifest("uv", "linux-x64").members, [
    "uv-x86_64-unknown-linux-gnu/uv",
    "uv-x86_64-unknown-linux-gnu/uvx",
  ]);
  // The Windows zip is flat (uv.exe, uvx.exe).
  assert.deepEqual(lookupManifest("uv", "win32-x64").members, ["uv.exe", "uvx.exe"]);
});

test("lookupManifest throws a clear error for an unsupported host", () => {
  // @ts-expect-error deliberately passing an unsupported host key
  assert.throws(() => lookupManifest("uv", "win32-ia32"), /No pinned uv build/);
});

test("manifest has no accidental duplicate sha256 across distinct assets", () => {
  const seen = new Map<string, string>();
  for (const tool of TOOLS) {
    for (const host of HOSTS) {
      const entry = lookupManifest(tool, host);
      const prior = seen.get(entry.sha256);
      assert.equal(prior, undefined, `duplicate sha256 for ${entry.assetName} and ${prior}`);
      seen.set(entry.sha256, entry.assetName);
    }
  }
  assert.equal(seen.size, TOOLS.length * HOSTS.length);
  // touch TOOLCHAIN_MANIFEST so the import is exercised even if lookupManifest changes.
  assert.ok(TOOLCHAIN_MANIFEST.mise);
});
