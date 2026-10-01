import assert from "node:assert/strict";
import test from "node:test";
import { detectUsageLimit, toolDescriptionLines } from "../src/harness-text.js";

test("tool description lines carry the tool description and the field descriptions it collects", () => {
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
      // Keywords the helper does not walk; their descriptions stay in the schema only.
      additionalProperties: { type: "string", description: "Not listed: additionalProperties." },
      patternProperties: { "^x-": { type: "string", description: "Not listed: patternProperties." } },
      prefixItems: [{ type: "string", description: "Not listed: prefixItems." }],
      not: { type: "null", description: "Not listed: not." },
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

test("usage-limit detection recognises other limit wordings the CLIs and providers use", () => {
  const cases: Array<[string, string]> = [
    ["Claude usage limit reached. Your limit will reset at 1pm.", "usage limit reached; resets 1pm"],
    ["Weekly limit reached · resets Oct 4", "weekly limit reached; resets Oct 4"],
    ["{\"error\":{\"type\":\"usage_limit_reached\"}}", "usage limit reached"],
    ["GoUsageLimitError", "usage limit reached"],
    ["API Error: Rate limit reached", "rate limit reached"],
    ["You have hit the rate limit, retry in 20 seconds", "rate limit reached; resets in 20 seconds"],
    ["{\"type\":\"rate_limit_error\"}", "rate limit reached"],
    ["Error: Too Many Requests", "rate limit reached"],
    ["insufficient_quota", "quota exhausted"],
  ];
  for (const [text, expected] of cases) assert.equal(detectUsageLimit([text]), expected, text);
});

test("usage-limit detection does not mistake other limits or passing mentions for a rate limit", () => {
  for (const text of [
    "you have reached your context window limit",
    "reached your output token limit",
    "hit your max turns limit",
    "MCP server exceeded session limit of 5 connections",
    "rate-limits.md not found",
    "log: ratelimit headers remaining=4999",
    "fast limit switch tripped",
    "Error: not logged in. Run login. (See rate limits at https://example.test/limits)",
    "401 Unauthorized: invalid api key. usage limit info unavailable",
  ]) {
    assert.equal(detectUsageLimit([text]), undefined, text);
  }
});

test("usage-limit reset time comes only from the line that reported the limit", () => {
  assert.equal(detectUsageLimit(["usage limit reached", "server restarting, try again in 5 seconds"]), "usage limit reached");
  assert.equal(detectUsageLimit(["usage limit reached\nserver restarting, try again in 5 seconds"]), "usage limit reached");
  assert.equal(detectUsageLimit(["server restarting, try again in 5 seconds", "usage limit reached"]), "usage limit reached");
  // Text before the limit wording on the same line is not its reset time either.
  assert.equal(detectUsageLimit(["try again in 5 seconds; usage limit reached"]), "usage limit reached");
  assert.equal(detectUsageLimit(["noise", "usage limit reached. Try again in 5 seconds."]), "usage limit reached; resets in 5 seconds");
});

test("usage-limit detection scans a bounded prefix of the output", () => {
  // The bound is 16 KiB; pinned here as a literal rather than read from the source.
  const bound = 16384;
  assert.equal(detectUsageLimit(["x".repeat(bound), "usage limit reached"]), undefined);
  assert.equal(detectUsageLimit(["x".repeat(bound - 100), "usage limit reached"]), "usage limit reached");
});
