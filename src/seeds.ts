import type { Lang } from "./session.js";

const REGISTRY: Record<string, Partial<Record<Lang, string>>> = {
  booking: {
    python: "https://github.com/Optick-Labs/byoe-booking-python",
    java: "https://github.com/Optick-Labs/byoe-booking-java",
  },
};

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

  const fromRegistry = REGISTRY[task]?.[lang];
  if (fromRegistry) {
    return fromRegistry;
  }

  throw new Error(
    `No seed repo for task "${task}" + lang "${lang}". ` +
      `Pass --seed <url-or-path>, set ${envKey}, or add it to the registry.`,
  );
}
