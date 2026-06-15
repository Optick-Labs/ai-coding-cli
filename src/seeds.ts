import type { Lang } from "./session.js";

export interface ResolveSeedOptions {
  task: string;
  lang: Lang;
  seedFlag?: string;
}

function assertNotFlag(source: string): string {
  // The clone passes `--` before the source, but reject a leading-dash source up front so an offline
  // user gets a clear error instead of a confusing git failure.
  if (source.startsWith("-")) {
    throw new Error(`Seed source cannot start with "-" (got "${source}").`);
  }
  return source;
}

export function resolveSeed({ task, lang, seedFlag }: ResolveSeedOptions): string {
  if (seedFlag && seedFlag.trim().length > 0) {
    return assertNotFlag(seedFlag.trim());
  }

  const envKey = `HI_SEED_${task.toUpperCase()}_${lang.toUpperCase()}`;
  const fromEnv = process.env[envKey];
  if (fromEnv && fromEnv.trim().length > 0) {
    return assertNotFlag(fromEnv.trim());
  }

  throw new Error(
    `No seed source for task "${task}" + lang "${lang}" in offline mode. ` +
      `Pass --seed <url-or-path> or set ${envKey}. ` +
      `(Online mode with --token fetches the seed automatically.)`,
  );
}
