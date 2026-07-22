import assert from "node:assert/strict";
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
    assert.deepEqual(normalized, { provider: "fixture-anthropic", model: "served-model", outputText: "working", toolCalls: [{ id: "tool:1", name: "submit", input: { value: 42 } }], usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 }, latencyMs: 7, stopReason: "tool_use" });
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
});
