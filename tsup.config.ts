import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/cli.ts"],
  format: ["esm"],
  clean: true,
  noExternal: ["commander", "chalk", "execa"],
  banner: {
    js: "#!/usr/bin/env node",
  },
});
