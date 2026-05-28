import { createMiseRuntime } from "./mise.js";

export const csharpRuntime = createMiseRuntime("csharp", {
  install: ["dotnet", "restore"],
  test: ["dotnet", "test"],
});
