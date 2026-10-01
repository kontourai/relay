// stderr lines the three harness profiles classified as RATE_LIMITED before
// limit reasons were added (the earlier stderr check was /rate.?limit|too many
// requests/). That earlier behaviour is a floor: these must keep classifying.
export const priorRateLimitStderr: readonly string[] = [
  "This request would exceed your organization's rate limit of 50,000 input tokens per minute",
  "RateLimitError: 429",
  "openai.RateLimitError",
  "AI_APICallError: Rate limit",
  "error: rate_limited",
  "rate limit error",
  "exceeded rate limit",
  "stream error: rate limits exceeded",
  "ratelimited",
  "Rate limiting in effect",
  "Request rejected (429) · rate limit",
  "rate-limits.md not found",
  "log: ratelimit headers remaining=4999",
  "Error: Too Many Requests",
];

// Lines a CLI can print on stderr beside a real failure that only look like an
// authentication problem to a loose text match.
export const incidentalAuthStderr: readonly string[] = [
  "mcp client for linear failed to start: OAuth token expired",
  "warning: could not read /Users/a/authored-notes/AGENTS.md",
  "ERROR codex_core::auth: token refresh",
  "WARN codex_login: using cached credentials",
  "author: bob",
];
