import { createMiseRuntime } from "./mise.js";

export const goRuntime = createMiseRuntime("go", {
  install: ["go", "mod", "download"],
  test: ["go", "test", "./..."],
});
