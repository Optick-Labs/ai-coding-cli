import type { Lang } from "../session.js";
import type { Runtime } from "./types.js";
import { pythonRuntime } from "./python.js";
import { javaRuntime } from "./java.js";
import { typescriptRuntime } from "./typescript.js";
import { goRuntime } from "./go.js";
import { csharpRuntime } from "./csharp.js";
import { anyRuntime } from "./any.js";

export function getRuntime(lang: Lang): Runtime {
  switch (lang) {
    case "python":
      return pythonRuntime;
    case "java":
      return javaRuntime;
    case "typescript":
      return typescriptRuntime;
    case "go":
      return goRuntime;
    case "csharp":
      return csharpRuntime;
    case "any":
      return anyRuntime;
    default: {
      const exhaustive: never = lang;
      throw new Error(`Unsupported lang: ${String(exhaustive)}`);
    }
  }
}

export { setVerbose, isVerbose, startSpinner, LANG_LABEL } from "./shared.js";
export type { Runtime, TestResult } from "./types.js";
