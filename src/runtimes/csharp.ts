import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createMiseRuntime } from "./mise.js";

// C# seeds are laid out as `<App>/<App>.csproj` (the runnable web app) alongside `<App>.Tests/` and an
// `<App>.sln`. `dotnet test` finds everything through the solution, but `dotnet run` needs the startup
// project named explicitly — and that name differs per problem (Schedulr, Transcribe, Fileshare, …).
// Discover the one non-test project dir instead of hardcoding a single seed's name.
function dotnetStartupProject(repoDir: string): string {
  const project = readdirSync(repoDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith(".") && !e.name.endsWith(".Tests"))
    .map((e) => e.name)
    .filter((name) => existsSync(join(repoDir, name, `${name}.csproj`)))
    .sort()[0];
  if (!project) {
    throw new Error(
      `Couldn't find a C# startup project in ${repoDir} (expected <App>/<App>.csproj alongside <App>.Tests).`,
    );
  }
  return project;
}

export const csharpRuntime = createMiseRuntime("csharp", {
  install: ["dotnet", "restore"],
  test: ["dotnet", "test"],
  dev: (repoDir) => ["dotnet", "run", "--project", dotnetStartupProject(repoDir)],
});
