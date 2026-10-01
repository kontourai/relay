import assert from "node:assert/strict";
import test from "node:test";
import { detectUsageLimit, toolDescriptionLines } from "../src/harness-text.js";

test("tool description lines carry the tool description and every field description", () => {
  assert.deepEqual(toolDescriptionLines({
    name: "submit",
    description: "Report openings exactly as written.",
    inputSchema: {
      type: "object",
      description: "One camp.",
      properties: {
        openings: { type: "number", description: "Seats still open." },
        rows: { type: "array", items: { type: "object", properties: { note: { anyOf: [{ type: "string", description: "Free text." }, { type: "null" }] } } } },
        plain: { type: "string" },
      },
      $defs: { Age: { type: "number", description: "Whole years." } },
    },
  }), [
    "Description of the submit result:\nReport openings exactly as written.",
    [
      "Field descriptions for the submit result:",
      "- (result): One camp.",
      "- openings: Seats still open.",
      "- rows[].note: Free text.",
      "- $defs.Age: Whole years.",
    ].join("\n"),
  ]);
});

test("tool description lines add nothing when no description is declared", () => {
  assert.deepEqual(toolDescriptionLines(undefined), []);
  assert.deepEqual(toolDescriptionLines({ name: "submit", inputSchema: { type: "object", properties: { openings: { type: "number" } } } }), []);
  assert.deepEqual(toolDescriptionLines({ name: "submit", description: "  ", inputSchema: {} }), []);
});

test("usage-limit detection recognises each CLI's own wording and its reset time", () => {
  const cases: Array<[string, string]> = [
    // Claude Code result text, as the CLI printed it.
    ["You've hit your session limit · resets 5pm (America/Denver)", "session limit reached; resets 5pm"],
    ["You've hit your weekly limit · resets Oct 4", "weekly limit reached; resets Oct 4"],
    ["You've hit your Opus limit · resets Oct 4, 9:30am (America/Denver)", "opus limit reached; resets Oct 4, 9:30am"],
    ["You're out of usage credits. /model to switch models.", "usage credits exhausted"],
    // Codex error-event text.
    ["You've hit your usage limit. Upgrade to Plus to continue using Codex (https://chatgpt.com/explore/plus), or try again at Oct 4th, 2026 9:00 AM.", "usage limit reached; resets Oct 4th, 2026 9:00 AM"],
    ["You've hit your usage limit. Try again at 9:05 PM.", "usage limit reached; resets 9:05 PM"],
    ["exceeded retry limit, last status: 429 Too Many Requests, request id: abc", "rate limit reached"],
    // OpenCode error-event text.
    ["Go usage limit reached. It will reset in 2 days 3 hours. To continue using this model now, enable usage from your available balance - https://opencode.ai/workspace/wrk_1/go", "usage limit reached; resets in 2 days 3 hours"],
    ["{\"type\":\"error\",\"error\":{\"type\":\"FreeUsageLimitError\"}}", "free usage limit reached"],
    ["Rate Limited", "rate limit reached"],
    ["You exceeded your current quota, please check your plan and billing details.", "quota exhausted"],
  ];
  for (const [text, expected] of cases) assert.equal(detectUsageLimit([text]), expected, text);
});

test("usage-limit detection ignores unrelated failures", () => {
  for (const text of ["", "Error: model not found", "unexpected server error", "context limit reached", "exit code 1", "generated 429 rows"]) {
    assert.equal(detectUsageLimit([text]), undefined, text);
  }
});

test("usage-limit reasons are bounded and built only from allowlisted text", () => {
  const hostile = [
    "You've hit your weekly limit · resets Oct 4, 9am (/Users/someone/.config/secret)",
    "token sk-live-PRIVATE0123456789 https://user:hunter2@example.test/path?key=PRIVATE",
    "resets /etc/passwd ".repeat(4000),
  ];
  const reason = detectUsageLimit(hostile);
  assert.equal(reason, "weekly limit reached; resets Oct 4, 9am");
  // The reset must follow the strict date/time grammar or be left out.
  assert.equal(detectUsageLimit(["usage limit reached, resets https://user:hunter2@example.test/x"]), "usage limit reached");
  assert.equal(detectUsageLimit(["usage limit reached, try again at /Users/someone/secret"]), "usage limit reached");
  for (const text of [...hostile, "You've hit your sk-live-PRIVATE limit"]) {
    const value = detectUsageLimit([text]) ?? "";
    assert.ok(value.length <= 80, value);
    assert.match(value, /^[A-Za-z0-9 ,;:]*$/);
  }
});
