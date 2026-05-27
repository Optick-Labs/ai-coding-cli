import type { Lang } from "./session.js";

export interface ResolveSeedOptions {
  task: string;
  lang: Lang;
  seedFlag?: string;
}

export function resolveSeed({ task, lang, seedFlag }: ResolveSeedOptions): string {
  if (seedFlag && seedFlag.trim().length > 0) {
    return seedFlag.trim();
  }

  const envKey = `HI_SEED_${task.toUpperCase()}_${lang.toUpperCase()}`;
  const fromEnv = process.env[envKey];
  if (fromEnv && fromEnv.trim().length > 0) {
    return fromEnv.trim();
  }

  throw new Error(
    `No seed source for task "${task}" + lang "${lang}" in offline mode. ` +
      `Pass --seed <url-or-path> or set ${envKey}. ` +
      `(Online mode with --token fetches the seed automatically.)`,
  );
}
