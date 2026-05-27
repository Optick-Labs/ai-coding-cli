import type { Lang } from "../session.js";
import type { Runtime } from "./types.js";
import { pythonRuntime } from "./python.js";
import { javaRuntime } from "./java.js";

export function getRuntime(lang: Lang): Runtime {
  switch (lang) {
    case "python":
      return pythonRuntime;
    case "java":
      return javaRuntime;
    default: {
      const exhaustive: never = lang;
      throw new Error(`Unsupported lang: ${String(exhaustive)}`);
    }
  }
}

export type { Runtime, TestResult } from "./types.js";
