import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { it } from "node:test";
import { createAnthropicRuntime, type AnthropicMessagesClient } from "../src/anthropic.js";

// Node's test runner isolates test files in separate processes. Resolve the API
// used by the installed SDK so the registered globals are the SDK's globals.
const require = createRequire(import.meta.url);
const sdkRequire = createRequire(require.resolve("@anthropic-ai/sdk"));
const otel = sdkRequire("@opentelemetry/api");

it("keeps Relay-owned SDK calls out of ambient telemetry", async () => {
  process.env["ANTHROPIC_OPEN_TELEMETRY"] = "true";
  process.env["ANTHROPIC_OPEN_TELEMETRY_PROPAGATION"] = "true";
  process.env["ANTHROPIC_OPEN_TELEMETRY_TRACES_CONTENT_MODE"] = "content";
  const spans: Array<Record<string, unknown>> = [];
  let injections = 0;
  const span = () => {
    const attributes: Record<string, unknown> = {};
    spans.push(attributes);
    return {
      isRecording: () => true,
      spanContext: () => ({ traceId: "11111111111111111111111111111111", spanId: "1111111111111111", traceFlags: 1 }),
      setAttribute: (key: string, value: unknown) => { attributes[key] = value; },
      setAttributes: (values: Record<string, unknown>) => { Object.assign(attributes, values); },
      setStatus: () => {}, end: () => {},
    };
  };
  assert.equal(otel.trace.setGlobalTracerProvider({ getTracer: () => ({ startSpan: span }) }), true);
  assert.equal(otel.propagation.setGlobalPropagator({
    inject: (_context: unknown, carrier: Record<string, string>) => { injections++; carrier["baggage"] = "synthetic=private"; },
    extract: (context: unknown) => context,
    fields: () => ["baggage"],
  }), true);
  const headers: Array<string | string[] | undefined> = [];
  const server = createServer((request, response) => {
    headers.push(request.headers.baggage);
    request.resume();
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ id: "msg_test", type: "message", role: "assistant", model: "m", content: [{ type: "text", text: "synthetic-response" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
    const request = { messages: [{ role: "system" as const, content: "synthetic-system" }, { role: "user" as const, content: "synthetic-prompt" }] };
    // The caller-owned client proves the ambient tracer, content mode, and
    // propagator are active and remain under the caller's control.
    const moduleName = "@anthropic-ai/sdk";
    const sdk = await import(moduleName);
    const client = new sdk.default({ apiKey: "test-key", baseURL: baseUrl, maxRetries: 0 });
    await createAnthropicRuntime({ client: client.messages as AnthropicMessagesClient, model: "m" }).invoke(request);
    assert.ok(spans.length > 0, "control did not create an SDK span");
    assert.ok(JSON.stringify(spans).includes("synthetic-prompt"), "control did not capture synthetic content");
    assert.ok(injections > 0, "control did not invoke the propagator");
    assert.equal(headers[0], "synthetic=private");
    spans.length = 0;
    injections = 0;
    await createAnthropicRuntime({ apiKey: "test-key", baseUrl, model: "m" }).invoke(request);
    assert.equal(headers.length, 2);
    assert.equal(spans.length, 0, "Relay-owned SDK created a span");
    assert.equal(injections, 0, "Relay-owned SDK invoked the propagator");
    assert.equal(headers[1], undefined, "Relay-owned SDK sent baggage");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    otel.trace.disable();
    otel.propagation.disable();
    delete process.env["ANTHROPIC_OPEN_TELEMETRY"];
    delete process.env["ANTHROPIC_OPEN_TELEMETRY_PROPAGATION"];
    delete process.env["ANTHROPIC_OPEN_TELEMETRY_TRACES_CONTENT_MODE"];
  }
});
