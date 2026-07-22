import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createAnthropicRuntime, type AnthropicMessagesClient } from "../src/anthropic.js";
import { createClaudeCodeCodec } from "../src/claude-code.js";
import { createCodexCodec } from "../src/codex.js";
import { createOpenCodeCodec } from "../src/opencode.js";
import type { ModelInvocationRequest, ModelInvocationResult } from "../src/types.js";

const extracted = { facilityName: "North Star Camp", minimumAge: 8 };
const request: ModelInvocationRequest = {
  messages: [
    { role: "system", content: "Extract only supported fields." },
    { role: "user", content: "North Star Camp accepts campers age 8 and older." },
  ],
  tools: [{
    name: "submit_extraction",
    description: "Return the grounded extraction proposal.",
    inputSchema: {
      type: "object",
      properties: {
        facilityName: { type: "string" },
        minimumAge: { type: "number" },
      },
      required: ["facilityName", "minimumAge"],
      additionalProperties: false,
    },
  }],
  toolChoice: { type: "tool", name: "submit_extraction" },
};

function semanticResult(result: ModelInvocationResult) {
  return result.toolCalls.map(({ name, input }) => ({ name, input }));
}

describe("portable definition parity", () => {
  it("preserves one structured workload across harness and hosted SDK profiles", async () => {
    const output = { stderr: "", exitCode: 0, latencyMs: 1 };
    const claude = createClaudeCodeCodec("fixture-claude").parse({
      ...output,
      stdout: JSON.stringify({ structured_output: extracted }),
    }, request);
    const codex = createCodexCodec("fixture-codex", "/fixture/schema.json").parse({
      ...output,
      stdout: JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify(extracted) } }),
    }, request);
    const opencode = createOpenCodeCodec("zai/glm-5", "prompted").parse({
      ...output,
      stdout: JSON.stringify({ type: "text", part: { type: "text", text: JSON.stringify(extracted) } }),
    }, request);
    const client: AnthropicMessagesClient = {
      async create() {
        return {
          model: "fixture-hosted",
          stop_reason: "tool_use",
          usage: { input_tokens: 1, output_tokens: 1 },
          content: [{ type: "tool_use", id: "hosted:1", name: "submit_extraction", input: extracted }],
        };
      },
    };
    const hosted = await createAnthropicRuntime({ client, model: "fixture-hosted" }).invoke(request);

    const expected = [{ name: "submit_extraction", input: extracted }];
    assert.deepEqual(semanticResult(claude), expected);
    assert.deepEqual(semanticResult(codex), expected);
    assert.deepEqual(semanticResult(opencode), expected);
    assert.deepEqual(semanticResult(hosted), expected);
    assert.equal(opencode.warnings?.length, 1);
  });

  it("declares native fidelity for built-in hosted structured tools", () => {
    const client: AnthropicMessagesClient = { async create() { throw new Error("not invoked"); } };
    assert.equal(createAnthropicRuntime({ client, model: "fixture" }).capabilities().structuredToolsFidelity, "native");
  });
});
