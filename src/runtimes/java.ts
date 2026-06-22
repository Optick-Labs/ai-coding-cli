import { createMiseRuntime } from "./mise.js";
import { mvnwPath } from "./shared.js";

// The Maven wrapper is a POSIX script (`mvnw`) on unix and a batch file (`mvnw.cmd`) on Windows — both
// ship in the seed. Resolve the right one as an absolute path per platform instead of a bare `./mvnw`,
// which only exists on unix.
export const javaRuntime = createMiseRuntime("java", {
  test: (repoDir) => [mvnwPath(repoDir), "-q", "test"],
  dev: (repoDir) => [mvnwPath(repoDir), "-q", "spring-boot:run"],
});
