import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { LanguageModelV3, LanguageModelV3CallOptions } from "@ai-sdk/provider";
import { createAiSdkModel, createAiSdkRuntime } from "../src/ai-sdk.js";
import type { ModelInvocationRequest, ModelRuntime } from "../src/index.js";

const aiUsage = {
  inputTokens: { total: 3, noCache: 3, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 4, text: 4, reasoning: undefined },
};

describe("AI SDK v3 adapter", () => {
  it("wraps an AI SDK model as a Relay runtime with multi-turn tool messages", async () => {
    let captured: LanguageModelV3CallOptions | undefined;
    const model: LanguageModelV3 = {
      specificationVersion: "v3",
      provider: "fixture-ai",
      modelId: "fixture-model",
      supportedUrls: {},
      async doGenerate(options) {
        captured = options;
        return {
          content: [{ type: "text", text: "done" }, { type: "tool-call", toolCallId: "next:1", toolName: "next", input: "{\"value\":2}" }],
          finishReason: { unified: "tool-calls", raw: "tool_use" },
          usage: aiUsage,
          warnings: [],
        };
      },
      async doStream() { throw new Error("not used"); },
    };
    const result = await createAiSdkRuntime({ model }).invoke({
      messages: [
        { role: "assistant", content: [{ type: "tool-call", id: "call:1", name: "lookup", input: { q: "x" } }] },
        { role: "tool", content: [{ type: "tool-result", id: "call:1", name: "lookup", output: { value: 1 } }] },
      ],
      tools: [{ name: "next", inputSchema: { type: "object" } }],
    });
    assert.equal(captured?.prompt[0]?.role, "assistant");
    assert.equal(captured?.prompt[1]?.role, "tool");
    assert.deepEqual(result.toolCalls, [{ id: "next:1", name: "next", input: { value: 2 } }]);
    assert.equal(result.usage.totalTokens, 7);
  });

  it("presents a Relay runtime as a buffered AI SDK model", async () => {
    let captured: ModelInvocationRequest | undefined;
    const runtime: ModelRuntime = {
      id: "dispatch:fixture",
      capabilities: () => ({ structuredTools: true, streaming: false, abort: true, usage: true }),
      async invoke(request) {
        captured = request;
        return { provider: "selected", model: "selected-model", outputText: "hello", toolCalls: [], usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 }, latencyMs: 2, stopReason: "stop" };
      },
    };
    const model = createAiSdkModel({ runtime });
    const call: LanguageModelV3CallOptions = { prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }], temperature: 0.2 };
    const generated = await model.doGenerate(call);
    assert.deepEqual(captured?.messages, [{ role: "user", content: [{ type: "text", text: "hi" }] }]);
    assert.equal(generated.content[0]?.type, "text");
    assert.equal(generated.warnings[0]?.type, "unsupported");

    const streamed = await model.doStream(call);
    const parts = [];
    for await (const part of streamed.stream) parts.push(part);
    assert.equal(parts[0]?.type, "stream-start");
    assert.equal(parts.at(-1)?.type, "finish");
    assert.ok(parts.some((part) => part.type === "text-delta"));
  });
});
