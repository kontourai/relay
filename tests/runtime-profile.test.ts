import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createModelRuntimeProfile, parseModelRuntimeProfile } from "../src/runtime-profile.js";

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
});
