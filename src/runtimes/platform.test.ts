import { test } from "node:test";
import assert from "node:assert/strict";
import {
  compareVersions,
  envWithManagedBinFor,
  hostKeyFor,
  managedBinDirFor,
  mvnwPathFor,
  parseVersion,
  withExe,
} from "./platform.js";

test("managedBinDirFor: unix uses an app-namespaced XDG data dir (not shared ~/.local/bin)", () => {
  assert.equal(
    managedBinDirFor("darwin", {}, "/Users/evan"),
    "/Users/evan/.local/share/hello-interview/bin",
  );
  assert.equal(managedBinDirFor("linux", {}, "/home/evan"), "/home/evan/.local/share/hello-interview/bin");
  // Honors XDG_DATA_HOME when set.
  assert.equal(
    managedBinDirFor("linux", { XDG_DATA_HOME: "/data" }, "/home/evan"),
    "/data/hello-interview/bin",
  );
});

test("managedBinDirFor: windows uses %LOCALAPPDATA%", () => {
  assert.equal(
    managedBinDirFor("win32", { LOCALAPPDATA: "C:\\Users\\evan\\AppData\\Local" }, "C:\\Users\\evan"),
    "C:\\Users\\evan\\AppData\\Local\\hello-interview\\bin",
  );
  // Falls back to home\AppData\Local when LOCALAPPDATA is unset.
  assert.equal(
    managedBinDirFor("win32", {}, "C:\\Users\\evan"),
    "C:\\Users\\evan\\AppData\\Local\\hello-interview\\bin",
  );
});

test("withExe: appends .exe only on windows and only when missing", () => {
  assert.equal(withExe("win32", "mise"), "mise.exe");
  assert.equal(withExe("win32", "mise.exe"), "mise.exe");
  assert.equal(withExe("darwin", "mise"), "mise");
  assert.equal(withExe("linux", "uv"), "uv");
});

test("envWithManagedBinFor: prepends managed dir with the platform delimiter (host-independent)", () => {
  const unix = envWithManagedBinFor("linux", { PATH: "/usr/bin:/bin" }, "/home/evan");
  assert.equal(unix.PATH, "/home/evan/.local/share/hello-interview/bin:/usr/bin:/bin");

  const win = envWithManagedBinFor(
    "win32",
    { Path: "C:\\Windows;C:\\Windows\\System32", LOCALAPPDATA: "C:\\la" },
    "C:\\Users\\evan",
  );
  assert.equal(win.PATH, "C:\\la\\hello-interview\\bin;C:\\Windows;C:\\Windows\\System32");
  // The Windows `Path` casing is normalized onto PATH.
  assert.equal(win.Path, undefined);
});

test("envWithManagedBinFor: does not duplicate an already-present dir", () => {
  const dir = "/home/evan/.local/share/hello-interview/bin";
  const env = envWithManagedBinFor("linux", { PATH: `${dir}:/usr/bin` }, "/home/evan");
  assert.equal(env.PATH, `${dir}:/usr/bin`);
});

test("envWithManagedBinFor: strips HI_TOKEN", () => {
  const env = envWithManagedBinFor("linux", { PATH: "/usr/bin", HI_TOKEN: "secret" }, "/home/evan");
  assert.equal(env.HI_TOKEN, undefined);
});

test("mvnwPathFor: mvnw.cmd on windows, mvnw elsewhere", () => {
  assert.equal(mvnwPathFor("win32", "C:\\work\\booking-java"), "C:\\work\\booking-java\\mvnw.cmd");
  assert.equal(mvnwPathFor("darwin", "/work/booking-java"), "/work/booking-java/mvnw");
  assert.equal(mvnwPathFor("linux", "/work/booking-java"), "/work/booking-java/mvnw");
});

test("hostKeyFor: maps supported platform/arch pairs", () => {
  assert.equal(hostKeyFor("darwin", "arm64"), "darwin-arm64");
  assert.equal(hostKeyFor("darwin", "x64"), "darwin-x64");
  assert.equal(hostKeyFor("linux", "x64"), "linux-x64");
  assert.equal(hostKeyFor("win32", "arm64"), "win32-arm64");
});

test("hostKeyFor: rejects unsupported platform/arch", () => {
  assert.throws(() => hostKeyFor("freebsd", "x64"), /Unsupported platform/);
  assert.throws(() => hostKeyFor("linux", "ppc64"), /Unsupported CPU architecture/);
});

test("compareVersions: numeric dotted comparison", () => {
  assert.ok(compareVersions("0.11.21", "0.11.21") === 0);
  assert.ok(compareVersions("0.11.22", "0.11.21") > 0);
  assert.ok(compareVersions("0.11.20", "0.11.21") < 0);
  assert.ok(compareVersions("2026.6.10", "2026.6.9") > 0);
  assert.ok(compareVersions("1.2", "1.2.0") === 0);
});

test("parseVersion: extracts the first semver-looking token", () => {
  assert.equal(parseVersion("uv 0.11.21 (5aa65dd7a 2026-06-11 aarch64-apple-darwin)"), "0.11.21");
  assert.equal(parseVersion("2026.6.10 macos-arm64 (2026-06-10)"), "2026.6.10");
  assert.equal(parseVersion("no version here"), null);
});
