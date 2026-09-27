import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import { createAnthropicRuntime, type AnthropicMessagesClient } from "../src/anthropic.js";
import { ModelInvocationError } from "../src/index.js";

describe("Anthropic-compatible runtime", () => {
  it("normalizes forced tools, identity, usage, latency, and stop reason", async () => {
    let captured: Record<string, unknown> | undefined;
    const client: AnthropicMessagesClient = { async create(params) {
      captured = params;
      return { model: "served-model", stop_reason: "tool_use", usage: { input_tokens: 3, output_tokens: 4 }, content: [
        { type: "text", text: "working" }, { type: "tool_use", id: "tool:1", name: "submit", input: { value: 42 } },
      ] };
    } };
    const ticks = [10, 17];
    const runtime = createAnthropicRuntime({ client, model: "requested-model", provider: "fixture-anthropic", now: () => ticks.shift()! });
    const normalized = await runtime.invoke({
      messages: [{ role: "system", content: "system" }, { role: "user", content: "extract" }],
      tools: [{ name: "submit", inputSchema: { type: "object" } }], toolChoice: { type: "tool", name: "submit" }, maxOutputTokens: 12,
    });
    assert.equal(captured?.["model"], "requested-model");
    assert.deepEqual(captured?.["tool_choice"], { type: "tool", name: "submit" });
    assert.deepEqual(normalized, { provider: "fixture-anthropic", model: "served-model", modelSource: "provider-reported", outputText: "working", toolCalls: [{ id: "tool:1", name: "submit", input: { value: 42 } }], usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 }, latencyMs: 7, stopReason: "tool_use" });
  });

  it("returns typed failures without exposing provider payloads", async () => {
    const client: AnthropicMessagesClient = { async create() { throw Object.assign(new Error("secret response"), { status: 429 }); } };
    await assert.rejects(() => createAnthropicRuntime({ client, model: "m" }).invoke({ messages: [{ role: "user", content: "x" }] }),
      (error: unknown) => error instanceof ModelInvocationError && error.code === "RATE_LIMITED" && error.retryable);
    const unknownFailure: AnthropicMessagesClient = { async create() { throw new Error("provider body contains a secret"); } };
    await assert.rejects(() => createAnthropicRuntime({ client: unknownFailure, model: "m" }).invoke({ messages: [{ role: "user", content: "x" }] }),
      (error: unknown) => error instanceof ModelInvocationError && error.code === "RUNTIME_FAILURE" && error.message === "Model invocation failed");
  });

  it("projects portable tool calls and results into Anthropic message blocks", async () => {
    let captured: Record<string, unknown> | undefined;
    const client: AnthropicMessagesClient = { async create(params) {
      captured = params;
      return { model: "m", stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: "text", text: "ok" }] };
    } };
    await createAnthropicRuntime({ client, model: "m" }).invoke({ messages: [
      { role: "assistant", content: [{ type: "tool-call", id: "call:1", name: "lookup", input: { q: "x" } }] },
      { role: "tool", content: [{ type: "tool-result", id: "call:1", name: "lookup", output: { value: 1 } }] },
    ] });
    assert.deepEqual(captured?.["messages"], [
      { role: "assistant", content: [{ type: "tool_use", id: "call:1", name: "lookup", input: { q: "x" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call:1", content: "{\"value\":1}" }] },
    ]);
  });

  it("labels the configured model when the provider response carries no model", async () => {
    const client: AnthropicMessagesClient = { async create() {
      return { model: "", stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: "text", text: "ok" }] };
    } };
    const result = await createAnthropicRuntime({ client, model: "requested-model" }).invoke({ messages: [{ role: "user", content: "x" }] });
    assert.deepEqual([result.model, result.modelSource], ["requested-model", "configured"]);
  });
});

// These run the installed @anthropic-ai/sdk against a local HTTP stub, so they
// count the requests the SDK really sends rather than the options Relay passes.
describe("Anthropic-compatible runtime over the SDK", () => {
  async function withStub(
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
  const request = { messages: [{ role: "user" as const, content: "x" }] };
  const rateLimited = (error: unknown) => error instanceof ModelInvocationError && error.code === "RATE_LIMITED" && error.retryable;

  it("sends exactly one provider request per invocation by default", async () => {
    await withStub("rate-limit", async (baseUrl, requestCount) => {
      await assert.rejects(() => createAnthropicRuntime({ apiKey: "test-key", baseUrl, model: "m" }).invoke(request), rateLimited);
      assert.equal(requestCount(), 1);
    });
  });

  it("retries in the SDK only when the caller opts in", async () => {
    await withStub("rate-limit", async (baseUrl, requestCount) => {
      await assert.rejects(() => createAnthropicRuntime({ apiKey: "test-key", baseUrl, model: "m", maxRetries: 2 }).invoke(request), rateLimited);
      assert.equal(requestCount(), 3);
    });
  });

  it("bounds a hung request by timeoutMs and classifies it as a retryable timeout", async () => {
    await withStub("hang", async (baseUrl, requestCount) => {
      const started = performance.now();
      await assert.rejects(() => createAnthropicRuntime({ apiKey: "test-key", baseUrl, model: "m", timeoutMs: 100 }).invoke(request),
        (error: unknown) => error instanceof ModelInvocationError && error.code === "PROVIDER_UNAVAILABLE" && error.retryable);
      assert.ok(performance.now() - started < 5_000, "timeout was not applied");
      assert.equal(requestCount(), 1);
    });
  });
});
