import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A local Anthropic-compatible endpoint for running the real SDK: "rate-limit"
 * answers every request with a 429, "hang" never answers. Counts requests.
 */
export async function withStub(
  respond: "rate-limit" | "hang",
  run: (baseUrl: string, requestCount: () => number) => Promise<void>,
): Promise<void> {
  let count = 0;
  const server: Server = createServer((request, response) => {
    count++;
    request.resume();
    if (respond === "hang") return;
    response.writeHead(429, { "content-type": "application/json", "retry-after-ms": "1" });
    response.end(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "slow down" } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await run(`http://127.0.0.1:${String((server.address() as AddressInfo).port)}`, () => count);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
