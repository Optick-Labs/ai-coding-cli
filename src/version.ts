// `__CLI_VERSION__` is injected by tsup at build time from package.json (see tsup.config.ts), so the
// published binary always reports the version npm shipped — no constant to keep in sync. The typeof
// guard makes unbundled contexts (tsc, editor tooling) fall back instead of crashing on the free
// identifier.
declare const __CLI_VERSION__: string | undefined;

export const CLI_VERSION: string = typeof __CLI_VERSION__ === "string" ? __CLI_VERSION__ : "0.0.0-dev";
