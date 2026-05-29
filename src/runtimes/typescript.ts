import { createMiseRuntime } from "./mise.js";

export const typescriptRuntime = createMiseRuntime("typescript", {
  install: ["npm", "ci"],
  test: ["npm", "test"],
});
