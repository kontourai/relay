import { ModelInvocationError, type ModelInvocationOptions, type ModelInvocationRequest, type ModelInvocationResult, type ModelRuntime, type ModelRuntimeCapabilities } from "./types.js";

interface AnthropicMessage {
  model: string;
  content: Array<{ type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: unknown }>;
  stop_reason: string | null;
  usage: { input_tokens: number; output_tokens: number };
}

export interface AnthropicMessagesClient {
  create(params: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<AnthropicMessage>;
}

export interface AnthropicRuntimeOptions {
  client?: AnthropicMessagesClient;
  apiKey?: string;
  baseUrl?: string;
  model: string;
  provider?: string;
  defaultMaxOutputTokens?: number;
  now?: () => number;
}

function classify(error: unknown): ModelInvocationError {
  if (error instanceof ModelInvocationError) return error;
  const status = typeof error === "object" && error !== null && "status" in error ? Number((error as { status: unknown }).status) : undefined;
  if (status === 401 || status === 403) return new ModelInvocationError("AUTHENTICATION_FAILED", "Provider authentication failed", false, { cause: error });
  if (status === 429) return new ModelInvocationError("RATE_LIMITED", "Provider rate limit reached", true, { cause: error });
  if (status !== undefined && status >= 500) return new ModelInvocationError("PROVIDER_UNAVAILABLE", "Provider unavailable", true, { cause: error });
  return new ModelInvocationError("RUNTIME_FAILURE", "Model invocation failed", false, { cause: error });
}

async function clientFor(options: AnthropicRuntimeOptions): Promise<AnthropicMessagesClient> {
  if (options.client) return options.client;
  const apiKey = options.apiKey ?? process.env["ANTHROPIC_API_KEY"];
  if (!apiKey) throw new ModelInvocationError("AUTHENTICATION_FAILED", "No Anthropic-compatible API key supplied", false);
  const moduleName = "@anthropic-ai/sdk";
  const loaded = await (Function("m", "return import(m)")(moduleName) as Promise<{ default: new (input: { apiKey: string; baseURL?: string }) => { messages: AnthropicMessagesClient } }>);
  const clientOptions = options.baseUrl ? { apiKey, baseURL: options.baseUrl } : { apiKey };
  return new loaded.default(clientOptions).messages;
}

function anthropicMessages(request: ModelInvocationRequest): Array<Record<string, unknown>> {
  return request.messages.filter(({ role }) => role !== "system").map((message) => {
    if (typeof message.content === "string") return { role: message.role === "tool" ? "user" : message.role, content: message.content };
    const content = message.content.map((part) => {
      if (part.type === "text") return { type: "text", text: part.text };
      if (part.type === "tool-call") return { type: "tool_use", id: part.id, name: part.name, input: part.input };
      return { type: "tool_result", tool_use_id: part.id, content: typeof part.output === "string" ? part.output : JSON.stringify(part.output), ...(part.isError ? { is_error: true } : {}) };
    });
    return { role: message.role === "tool" ? "user" : message.role, content };
  });
}

function systemText(request: ModelInvocationRequest): string | undefined {
  const content = request.messages.filter(({ role }) => role === "system").flatMap((message) => typeof message.content === "string"
    ? [message.content]
    : message.content.filter((part) => part.type === "text").map((part) => part.text));
  return content.length ? content.join("\n\n") : undefined;
}

export function createAnthropicRuntime(options: AnthropicRuntimeOptions): ModelRuntime {
  const provider = options.provider ?? "anthropic-compatible";
  const now = options.now ?? (() => performance.now());
  return {
    id: `${provider}:${options.model}`,
    capabilities: (): ModelRuntimeCapabilities => ({ structuredTools: true, structuredToolsFidelity: "native", streaming: false, abort: true, usage: true }),
    async invoke(request: ModelInvocationRequest, invocationOptions?: ModelInvocationOptions): Promise<ModelInvocationResult> {
      if (invocationOptions?.signal?.aborted) throw new ModelInvocationError("ABORTED", "Invocation aborted", false);
      const started = now();
      try {
        const client = await clientFor(options);
        const tools = request.tools?.map((tool) => ({ name: tool.name, description: tool.description ?? "", input_schema: tool.inputSchema }));
        const toolChoice = request.toolChoice?.type === "tool"
          ? { type: "tool", name: request.toolChoice.name }
          : request.toolChoice?.type === "required" ? { type: "any" } : request.toolChoice ? { type: "auto" } : undefined;
        const system = systemText(request);
        const response = await client.create({
          model: options.model,
          max_tokens: request.maxOutputTokens ?? options.defaultMaxOutputTokens ?? 2048,
          messages: anthropicMessages(request),
          ...(system === undefined ? {} : { system }),
          ...(tools?.length ? { tools } : {}),
          ...(toolChoice ? { tool_choice: toolChoice } : {}),
        }, invocationOptions?.signal ? { signal: invocationOptions.signal } : undefined);
        const outputText = response.content.filter((block): block is { type: "text"; text: string } => block.type === "text").map(({ text }) => text).join("\n");
        const toolCalls = response.content.filter((block): block is { type: "tool_use"; id: string; name: string; input: unknown } => block.type === "tool_use")
          .map(({ id, name, input }) => ({ id, name, input }));
        return Object.freeze({
          provider,
          model: response.model,
          outputText,
          toolCalls: Object.freeze(toolCalls),
          usage: Object.freeze({ inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens, totalTokens: response.usage.input_tokens + response.usage.output_tokens }),
          latencyMs: Math.max(0, now() - started),
          ...(response.stop_reason ? { stopReason: response.stop_reason } : {}),
        });
      } catch (error) {
        if (invocationOptions?.signal?.aborted) throw new ModelInvocationError("ABORTED", "Invocation aborted", false, { cause: error });
        throw classify(error);
      }
    },
  };
}
