import { ModelInvocationError, type ModelTool } from "./types.js";

/**
 * Prompt lines carrying a forced tool's description and its schema's field
 * descriptions. A CLI harness receives the schema as an output constraint, not
 * as a tool definition, so text that a hosted SDK would send as the tool
 * description has to travel in the prompt. Returns nothing when the tool
 * declares no descriptions, leaving the prompt unchanged.
 *
 * Field descriptions are collected from the schema root, `properties`, a
 * single-schema `items`, `anyOf`/`oneOf`/`allOf` branches, and
 * `$defs`/`definitions`. Descriptions under other keywords (`prefixItems`,
 * tuple-form `items`, `additionalProperties`, `patternProperties`,
 * `if`/`then`/`else`, `not`) are not listed; they still reach the CLI inside
 * the schema itself.
 */
export function toolDescriptionLines(tool: ModelTool | undefined): string[] {
  if (!tool) return [];
  const lines: string[] = [];
  if (typeof tool.description === "string" && tool.description.trim()) {
    lines.push(`Description of the ${tool.name} result:\n${tool.description}`);
  }
  const fields = fieldDescriptions(tool.inputSchema);
  if (fields.length) {
    lines.push([
      `Field descriptions for the ${tool.name} result:`,
      ...fields.map(([fieldPath, description]) => `- ${fieldPath}: ${description}`),
    ].join("\n"));
  }
  return lines;
}

const maxSchemaDepth = 32;

function fieldDescriptions(schema: unknown): Array<[string, string]> {
  const found: Array<[string, string]> = [];
  const visit = (value: unknown, fieldPath: string, depth: number): void => {
    if (typeof value !== "object" || value === null || Array.isArray(value) || depth > maxSchemaDepth) return;
    const node = value as Record<string, unknown>;
    if (typeof node.description === "string" && node.description.trim()) {
      found.push([fieldPath || "(result)", node.description]);
    }
    if (isRecord(node.properties)) {
      for (const [name, property] of Object.entries(node.properties)) {
        visit(property, fieldPath ? `${fieldPath}.${name}` : name, depth + 1);
      }
    }
    if ("items" in node) visit(node.items, `${fieldPath}[]`, depth + 1);
    for (const keyword of ["anyOf", "oneOf", "allOf"] as const) {
      const branches = node[keyword];
      if (Array.isArray(branches)) for (const branch of branches) visit(branch, fieldPath, depth + 1);
    }
    for (const keyword of ["$defs", "definitions"] as const) {
      const definitions = node[keyword];
      if (!isRecord(definitions)) continue;
      for (const [name, definition] of Object.entries(definitions)) {
        visit(definition, `${keyword}.${name}`, depth + 1);
      }
    }
  };
  visit(schema, "", 0);
  return found;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Bounds the text matched line by line. A long stream is scanned at its head
// and its tail, because a CLI usually prints its error last.
const maxScannedChars = 16 * 1024;

// The kinds below are matched only inside wording that says the limit was hit,
// so a context-window, token, turn, or connection limit is not read as a usage
// limit. This narrowing applies to the usage/session/quota wording only.
const limitKind = "session|weekly|opus|sonnet|fast|monthly spend|monthly|usage credit|free usage|usage";

// Any mention of a rate limit counts, with no narrowing: classifying one too
// many costs a router one extra attempt, while missing one stops fallback.
const rateLimitMention = /rate.?limit|too many requests|too_many_requests/i;

const namedLimits: ReadonlyArray<[RegExp, string]> = [
  [new RegExp(`\\b(?:hit|reached|exceeded) your (${limitKind}) limit\\b`, "i"), "$1 limit reached"],
  [new RegExp(`\\b(${limitKind}) limit (?:reached|exceeded|hit)\\b`, "i"), "$1 limit reached"],
  [/\bFreeUsageLimitError\b/, "free usage limit reached"],
  [/\b(?:usage_limit_reached|usage_limit_exceeded|GoUsageLimitError)\b/, "usage limit reached"],
  [/\bout of (?:usage credits|extra usage)\b/i, "usage credits exhausted"],
  [/\bcredits? (?:are )?(?:depleted|exhausted)\b/i, "usage credits exhausted"],
  [/\b(?:insufficient_quota|quota (?:exceeded|exhausted)|exceeded your (?:current )?quota)\b/i, "quota exhausted"],
  [rateLimitMention, "rate limit reached"],
];

const month = "(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]{0,6}";
const clock = "\\d{1,2}(?::\\d{2})?\\s?(?:am|pm)";
const date = `${month} \\d{1,2}(?:st|nd|rd|th)?(?:, \\d{4})?`;
const moment = `(?:${date}(?:,? (?:at )?${clock})?|${clock})`;
const unit = "(?:day|hour|minute|second|min|sec|hr)s?";
const duration = `(?:\\d{1,3} ${unit}(?: \\d{1,3} ${unit}){0,2}|less than a minute)`;
const resetAt = new RegExp(`\\b(?:resets?|try again)(?: at| on)? (${moment})`, "i");
const resetIn = new RegExp(`\\b(?:resets?|try again|retry)(?: after)? in (${duration})`, "i");

/**
 * Recognises a harness CLI's own usage-limit or rate-limit message and returns
 * a reason assembled only from fixed phrases and a date, clock time, or
 * duration matched by a strict grammar. Nothing else from the CLI's output is
 * copied, so paths, URLs, account names, and tokens cannot reach the reason.
 * The reset time is read only from the line that reported the limit, after the
 * limit wording, so an unrelated "try again in 5 seconds" is not attributed to it.
 */
export function detectUsageLimit(texts: readonly string[]): string | undefined {
  const text = texts.join("\n");
  const scanned = text.length <= 2 * maxScannedChars
    ? text
    : `${text.slice(0, maxScannedChars)}\n${text.slice(-maxScannedChars)}`;
  for (const line of scanned.split(/\r?\n/)) {
    for (const [pattern, template] of namedLimits) {
      const match = pattern.exec(line);
      if (!match) continue;
      const phrase = template.replace("$1", (match[1] ?? "").toLowerCase());
      const rest = line.slice(match.index);
      const at = resetAt.exec(rest)?.[1];
      const within = at ? undefined : resetIn.exec(rest)?.[1];
      return `${phrase}${at ? `; resets ${tidy(at)}` : within ? `; resets in ${tidy(within)}` : ""}`;
    }
  }
  // A rate-limit mention between the scanned head and tail still counts.
  return rateLimitMention.test(text) ? "rate limit reached" : undefined;
}

export interface HarnessFailureEvidence {
  /** The CLI's own structured error reported an authentication status. */
  structuredAuth?: boolean;
  /** A limit reason read from the CLI's own structured error report. */
  structuredLimit?: string | undefined;
  stderr: string;
}

/**
 * Decides between an authentication failure and a rate limit, or neither.
 * The CLI's structured error report is trusted before stderr text: stderr is
 * matched loosely and often carries incidental lines (an MCP server's OAuth
 * warning, a path containing "auth") beside a real limit event. When stderr is
 * the only evidence, authentication wins over a limit mentioned in it.
 */
export function classifyAuthOrLimit(label: string, evidence: HarnessFailureEvidence): ModelInvocationError | undefined {
  const authenticationFailed = () => new ModelInvocationError("AUTHENTICATION_FAILED", `${label} authentication failed`, false);
  // Retryable, as RATE_LIMITED is from the API adapters: a router uses the flag
  // to decide whether it may try again or move to its next candidate.
  const rateLimited = (reason: string) => new ModelInvocationError("RATE_LIMITED", `${label} rate limited: ${reason}`, true);
  if (evidence.structuredAuth) return authenticationFailed();
  if (evidence.structuredLimit) return rateLimited(evidence.structuredLimit);
  if (/auth|login|credential|api key/.test(evidence.stderr.toLowerCase())) return authenticationFailed();
  const reason = detectUsageLimit([evidence.stderr]);
  return reason ? rateLimited(reason) : undefined;
}

function tidy(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
