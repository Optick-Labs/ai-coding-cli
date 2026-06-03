import { createMiseRuntime } from "./mise.js";

export const javaRuntime = createMiseRuntime("java", {
  test: ["./mvnw", "-q", "test"],
  dev: ["./mvnw", "-q", "spring-boot:run"],
});
