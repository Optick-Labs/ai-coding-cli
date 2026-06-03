import { createConnection, createServer } from "node:net";

const HOST = "127.0.0.1";

// Resolves true if `port` can be bound on 127.0.0.1 right now. EADDRINUSE means it's taken (try the
// next one); EACCES (a privileged port without rights) is re-thrown so the caller can surface a clear
// error instead of silently scanning past it.
function tryBind(port: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        resolve(false);
      } else {
        reject(err);
      }
    });
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, HOST);
  });
}

// Finds a free port on 127.0.0.1 at or above `start`. Probes the same host the seed apps bind so we
// don't get a false "busy" from an unrelated 0.0.0.0 bind. There's an inherent TOCTOU window between
// this check and the child actually binding — acceptable for single-user local dev; `dev` still
// surfaces a bind failure if the child loses the race.
export async function findFreePort(start: number, maxTries = 50): Promise<number> {
  for (let port = start; port < start + maxTries && port <= 65535; port++) {
    if (await tryBind(port)) return port;
  }
  throw new Error(`No free port available in range ${start}-${Math.min(start + maxTries - 1, 65535)}.`);
}

// Resolves true once something accepts a TCP connection on 127.0.0.1:port (the dev server bound), or
// false if `timeoutMs` elapses first. Used to confirm the server actually started before we record it.
export function waitForPort(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const attempt = (): void => {
      const socket = createConnection({ host: HOST, port });
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => {
        socket.destroy();
        if (Date.now() >= deadline) {
          resolve(false);
        } else {
          setTimeout(attempt, 150);
        }
      });
    };
    attempt();
  });
}
