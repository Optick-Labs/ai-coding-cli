import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

// The published version is injected at build time from package.json so it can never drift from what
// npm actually ships. `version.ts` carries the dev fallback for unbundled runs (tsc, editors).
const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as {
  version: string;
};

export default defineConfig({
  entry: ["src/cli.ts"],
  format: ["esm"],
  clean: true,
  banner: {
    js: "#!/usr/bin/env node",
  },
  define: {
    __CLI_VERSION__: JSON.stringify(version),
  },
});
