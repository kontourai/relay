import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ModelInvocationError } from "../src/index.js";
import { createModelRuntimeProfile, parseModelRuntimeProfile } from "../src/runtime-profile.js";
import { withStub } from "./support/anthropic-stub.js";

describe("declarative runtime profiles", () => {
  it("preserves provider-qualified model identifiers", () => {
    assert.deepEqual(parseModelRuntimeProfile("opencode:zai/glm-5"), { profile: "opencode", model: "zai/glm-5" });
    assert.throws(() => parseModelRuntimeProfile("unknown:model"), /unknown runtime profile/);
  });
  it("constructs native structured-output local profiles without invoking them", () => {
    const claudeCodeCapabilities = createModelRuntimeProfile({ profile: "claude-code", model: "sonnet" }).capabilities();
    const codexCapabilities = createModelRuntimeProfile({ profile: "codex", model: "gpt-5" }).capabilities();
    assert.equal(claudeCodeCapabilities.structuredToolsFidelity, "native");
    assert.equal(claudeCodeCapabilities.outputTokenLimitFidelity, "unavailable");
    assert.equal(codexCapabilities.structuredToolsFidelity, "native");
    assert.equal(codexCapabilities.outputTokenLimitFidelity, "unavailable");
  });
  it("requires explicit consent for prompted structured output", () => {
    assert.throws(() => createModelRuntimeProfile({ profile: "opencode", model: "zai/glm-5" }), /explicit prompted-output opt-in/);
    assert.equal(createModelRuntimeProfile({ profile: "opencode", model: "zai/glm-5", allowPromptedStructuredOutput: true }).capabilities().structuredToolsFidelity, "prompted");
  });
  it("does not source hosted credentials implicitly", () => {
    assert.throws(() => createModelRuntimeProfile({ profile: "anthropic", model: "claude-haiku-4-5" }), /requires an API key/);
  });
  it("forwards retry and timeout options to the anthropic profile", async () => {
    const request = { messages: [{ role: "user" as const, content: "x" }] };
    const rateLimited = (error: unknown) => error instanceof ModelInvocationError && error.code === "RATE_LIMITED";
    await withStub("rate-limit", async (baseUrl, requestCount) => {
      await assert.rejects(() => createModelRuntimeProfile({ profile: "anthropic", model: "m", apiKey: "test-key", baseUrl, maxRetries: 2 }).invoke(request), rateLimited);
      assert.equal(requestCount(), 3);
    });
    await withStub("hang", async (baseUrl) => {
      const started = performance.now();
      await assert.rejects(() => createModelRuntimeProfile({ profile: "anthropic", model: "m", apiKey: "test-key", baseUrl, timeoutMs: 100 }).invoke(request),
        (error: unknown) => error instanceof ModelInvocationError && error.code === "PROVIDER_UNAVAILABLE");
      assert.ok(performance.now() - started < 5_000, "timeout was not forwarded");
    });
  });
});
