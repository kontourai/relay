import type { ModelTool } from "./types.js";

/**
 * Prompt lines carrying a forced tool's description and its schema's field
 * descriptions. A CLI harness receives the schema as an output constraint, not
 * as a tool definition, so text that a hosted SDK would send as the tool
 * description has to travel in the prompt. Returns nothing when the tool
 * declares no descriptions, leaving the prompt unchanged.
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

// Bounds the text scanned, so a noisy stream cannot make classification slow.
const maxScannedChars = 16 * 1024;

const namedLimits: ReadonlyArray<[RegExp, string]> = [
  [/\b(session|weekly|opus|sonnet|fast|monthly spend|monthly|usage credit) limit\b/i, "$1 limit reached"],
  [/\bout of (?:usage credits|extra usage)\b/i, "usage credits exhausted"],
  [/\bcredits? (?:are )?(?:depleted|exhausted)\b/i, "usage credits exhausted"],
  [/\bfree (?:usage )?limit\b|FreeUsageLimitError/i, "free usage limit reached"],
  [/\busage limit\b|\busage_limit_reached\b|GoUsageLimitError/i, "usage limit reached"],
  [/\b(?:insufficient_quota|quota (?:exceeded|exhausted)|exceeded your (?:current )?quota)\b/i, "quota exhausted"],
  [/\b(?:hit|reached) your (?:[a-z0-9]{1,16} ){0,3}limit\b/i, "usage limit reached"],
  [/\brate[ _-]?limit(?:ed|s|ing)?\b|\btoo many requests\b|\btoo_many_requests\b|\bstatus:? 429\b|\b429 too many\b/i, "rate limit reached"],
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
 */
export function detectUsageLimit(texts: readonly string[]): string | undefined {
  const text = texts.join("\n").slice(0, maxScannedChars);
  let phrase: string | undefined;
  for (const [pattern, template] of namedLimits) {
    const match = pattern.exec(text);
    if (!match) continue;
    phrase = template.replace("$1", (match[1] ?? "").toLowerCase());
    break;
  }
  if (!phrase) return undefined;
  const at = resetAt.exec(text)?.[1];
  const within = at ? undefined : resetIn.exec(text)?.[1];
  const reset = at ? `; resets ${tidy(at)}` : within ? `; resets in ${tidy(within)}` : "";
  return `${phrase}${reset}`;
}

function tidy(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
