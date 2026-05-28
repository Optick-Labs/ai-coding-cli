import { createMiseRuntime } from "./mise.js";

export const javaRuntime = createMiseRuntime("java", {
  test: ["./mvnw", "-q", "test"],
});
