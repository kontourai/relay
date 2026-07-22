import type {
  JSONValue,
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3Content,
  LanguageModelV3FinishReason,
  LanguageModelV3GenerateResult,
  LanguageModelV3Message,
  LanguageModelV3TextPart,
  LanguageModelV3ToolCallPart,
  LanguageModelV3ToolResultPart,
  LanguageModelV3StreamPart,
  LanguageModelV3Usage,
  SharedV3Warning,
} from "@ai-sdk/provider";
import {
  ModelInvocationError,
  type JsonSchema,
  type ModelInvocationRequest,
  type ModelInvocationResult,
  type ModelMessage,
  type ModelMessageContentPart,
  type ModelRuntime,
} from "./types.js";

export interface AiSdkRuntimeOptions {
  model: LanguageModelV3;
  id?: string;
  now?: () => number;
}

export interface AiSdkModelOptions {
  runtime: ModelRuntime;
  provider?: string;
  modelId?: string;
}

function unsupported(feature: string, details?: string): SharedV3Warning {
  return { type: "unsupported", feature, ...(details ? { details } : {}) };
}

function textPart(part: ModelMessageContentPart): string | undefined {
  return part.type === "text" ? part.text : undefined;
}

function relayPart(part: LanguageModelV3TextPart | LanguageModelV3ToolCallPart | LanguageModelV3ToolResultPart): ModelMessageContentPart {
  if (typeof part !== "object" || part === null || !("type" in part)) {
    throw new ModelInvocationError("INVALID_REQUEST", "AI SDK prompt contains an invalid content part", false);
  }
  if (part.type === "text") return { type: "text", text: part.text };
  if (part.type === "tool-call") return { type: "tool-call", id: part.toolCallId, name: part.toolName, input: part.input };
  if (part.type === "tool-result") {
    const output = part.output.type === "text" || part.output.type === "json" ? part.output.value : part.output;
    return { type: "tool-result", id: part.toolCallId, name: part.toolName, output, ...(part.output.type.startsWith("error-") ? { isError: true } : {}) };
  }
  throw new ModelInvocationError("INVALID_REQUEST", "AI SDK prompt part is not supported by Relay", false);
}

function toRelayMessages(prompt: LanguageModelV3CallOptions["prompt"]): ModelMessage[] {
  return prompt.map((message) => {
    if (message.role === "system") return { role: "system", content: message.content };
    return { role: message.role, content: message.content.map((part) => relayPart(part as LanguageModelV3TextPart | LanguageModelV3ToolCallPart | LanguageModelV3ToolResultPart)) };
  });
}

function toAiSdkMessage(message: ModelMessage): LanguageModelV3Message {
  if (message.role === "system") {
    const content = typeof message.content === "string"
      ? message.content
      : message.content.map(textPart).filter((part): part is string => part !== undefined).join("\n");
    return { role: "system", content };
  }
  const parts = typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content;
  if (message.role === "user") {
    if (parts.some((part) => part.type !== "text")) throw new ModelInvocationError("INVALID_REQUEST", "Relay user messages may contain only text for AI SDK v3", false);
    return { role: "user", content: parts.map((part) => {
      if (part.type !== "text") throw new ModelInvocationError("INVALID_REQUEST", "Relay user messages may contain only text for AI SDK v3", false);
      return { type: "text", text: part.text };
    }) };
  }
  if (message.role === "assistant") {
    return {
      role: "assistant",
      content: parts.map((part) => {
        if (part.type === "text") return { type: "text" as const, text: part.text };
        if (part.type === "tool-call") return { type: "tool-call" as const, toolCallId: part.id, toolName: part.name, input: part.input };
        return { type: "tool-result" as const, toolCallId: part.id, toolName: part.name, output: aiSdkToolOutput(part.output, part.isError) };
      }),
    };
  }
  if (parts.some((part) => part.type !== "tool-result")) throw new ModelInvocationError("INVALID_REQUEST", "Relay tool messages require tool-result parts", false);
  return {
    role: "tool",
    content: parts.map((part) => {
      if (part.type !== "tool-result") throw new ModelInvocationError("INVALID_REQUEST", "Relay tool messages require tool-result parts", false);
      return { type: "tool-result", toolCallId: part.id, toolName: part.name, output: aiSdkToolOutput(part.output, part.isError) };
    }),
  };
}

function aiSdkToolOutput(output: unknown, isError?: boolean) {
  if (isError) return { type: "error-json" as const, value: jsonValue(output) };
  return typeof output === "string" ? { type: "text" as const, value: output } : { type: "json" as const, value: jsonValue(output) };
}

function jsonValue(value: unknown): JSONValue {
  return JSON.parse(JSON.stringify(value ?? null)) as JSONValue;
}

function finishReason(reason?: string, hasTools = false): LanguageModelV3FinishReason {
  const unified = hasTools ? "tool-calls" : reason === "length" || reason === "max_tokens" ? "length"
    : reason === "content-filter" ? "content-filter" : reason === "error" ? "error" : reason ? "stop" : "other";
  return { unified, raw: reason };
}

function usage(result: ModelInvocationResult): LanguageModelV3Usage {
  return {
    inputTokens: { total: result.usage.inputTokens, noCache: result.usage.inputTokens, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: result.usage.outputTokens, text: result.usage.outputTokens, reasoning: undefined },
  };
}

function generatedContent(result: ModelInvocationResult): LanguageModelV3Content[] {
  return [
    ...(result.outputText ? [{ type: "text" as const, text: result.outputText }] : []),
    ...result.toolCalls.map((call) => ({ type: "tool-call" as const, toolCallId: call.id, toolName: call.name, input: JSON.stringify(call.input) })),
  ];
}

function invocationRequest(options: LanguageModelV3CallOptions): { request: ModelInvocationRequest; warnings: SharedV3Warning[] } {
  const warnings: SharedV3Warning[] = [];
  const tools = options.tools?.map((tool) => {
    if (tool.type !== "function") throw new ModelInvocationError("INVALID_REQUEST", "Provider-defined AI SDK tools are not portable through Relay", false);
    if (tool.strict !== undefined) warnings.push(unsupported("tool.strict", "Relay preserves the input schema but has no strict-tool flag."));
    return { name: tool.name, ...(tool.description === undefined ? {} : { description: tool.description }), inputSchema: tool.inputSchema as JsonSchema };
  });
  for (const [feature, value] of Object.entries({ temperature: options.temperature, stopSequences: options.stopSequences, topP: options.topP, topK: options.topK, presencePenalty: options.presencePenalty, frequencyPenalty: options.frequencyPenalty, responseFormat: options.responseFormat, seed: options.seed, providerOptions: options.providerOptions })) {
    if (value !== undefined) warnings.push(unsupported(feature));
  }
  const toolChoice = options.toolChoice?.type === "tool" ? { type: "tool" as const, name: options.toolChoice.toolName }
    : options.toolChoice?.type === "required" ? { type: "required" as const }
      : options.toolChoice?.type === "auto" ? { type: "auto" as const } : undefined;
  if (options.toolChoice?.type === "none") warnings.push(unsupported("toolChoice:none", "Omitting tools is the portable Relay equivalent."));
  return {
    request: {
      messages: toRelayMessages(options.prompt),
      ...(tools?.length && options.toolChoice?.type !== "none" ? { tools } : {}),
      ...(toolChoice ? { toolChoice } : {}),
      ...(options.maxOutputTokens === undefined ? {} : { maxOutputTokens: options.maxOutputTokens }),
    },
    warnings,
  };
}

function generatedResult(result: ModelInvocationResult, warnings: SharedV3Warning[] = []): LanguageModelV3GenerateResult {
  return {
    content: generatedContent(result),
    finishReason: finishReason(result.stopReason, result.toolCalls.length > 0),
    usage: usage(result),
    response: { modelId: result.model },
    warnings: [...warnings, ...(result.warnings ?? []).map((warning) => unsupported("runtime", warning))],
  };
}

export function createAiSdkRuntime(options: AiSdkRuntimeOptions): ModelRuntime {
  const now = options.now ?? (() => performance.now());
  return {
    id: options.id ?? `${options.model.provider}:${options.model.modelId}`,
    capabilities: () => ({ structuredTools: true, structuredToolsFidelity: "native", streaming: false, abort: true, usage: true }),
    async invoke(request, invocationOptions) {
      const started = now();
      try {
        const generated = await options.model.doGenerate({
          prompt: request.messages.map(toAiSdkMessage),
          ...(request.tools?.length ? { tools: request.tools.map((tool) => ({ type: "function" as const, name: tool.name, ...(tool.description === undefined ? {} : { description: tool.description }), inputSchema: tool.inputSchema as never })) } : {}),
          ...(request.toolChoice ? { toolChoice: request.toolChoice.type === "tool" ? { type: "tool", toolName: request.toolChoice.name } : request.toolChoice } : {}),
          ...(request.maxOutputTokens === undefined ? {} : { maxOutputTokens: request.maxOutputTokens }),
          ...(invocationOptions?.signal ? { abortSignal: invocationOptions.signal } : {}),
        });
        const text = generated.content.filter((part) => part.type === "text").map((part) => part.text).join("");
        const toolCalls = generated.content.filter((part) => part.type === "tool-call").map((part) => ({ id: part.toolCallId, name: part.toolName, input: JSON.parse(part.input) as unknown }));
        const inputTokens = generated.usage.inputTokens.total;
        const outputTokens = generated.usage.outputTokens.total;
        return {
          provider: options.model.provider,
          model: generated.response?.modelId ?? options.model.modelId,
          outputText: text,
          toolCalls,
          usage: { ...(inputTokens === undefined ? {} : { inputTokens }), ...(outputTokens === undefined ? {} : { outputTokens }), ...(inputTokens === undefined || outputTokens === undefined ? {} : { totalTokens: inputTokens + outputTokens }) },
          latencyMs: Math.max(0, now() - started),
          stopReason: generated.finishReason.raw ?? generated.finishReason.unified,
          warnings: generated.warnings.map((warning) => warning.type === "other" ? warning.message : `${warning.feature}${warning.details ? `: ${warning.details}` : ""}`),
        };
      } catch (error) {
        if (invocationOptions?.signal?.aborted) throw new ModelInvocationError("ABORTED", "Invocation aborted", false, { cause: error });
        if (error instanceof ModelInvocationError) throw error;
        throw new ModelInvocationError("RUNTIME_FAILURE", "AI SDK model invocation failed", false, { cause: error });
      }
    },
  };
}

export function createAiSdkModel(options: AiSdkModelOptions): LanguageModelV3 {
  const invoke = async (call: LanguageModelV3CallOptions) => {
    const { request, warnings } = invocationRequest(call);
    return { result: await options.runtime.invoke(request, call.abortSignal ? { signal: call.abortSignal } : undefined), warnings };
  };
  return {
    specificationVersion: "v3",
    provider: options.provider ?? "relay",
    modelId: options.modelId ?? options.runtime.id,
    supportedUrls: {},
    async doGenerate(call) {
      const { result, warnings } = await invoke(call);
      return generatedResult(result, warnings);
    },
    async doStream(call) {
      const { result, warnings } = await invoke(call);
      const content = generatedContent(result);
      const stream = new ReadableStream<LanguageModelV3StreamPart>({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [...warnings, { type: "compatibility", feature: "streaming", details: "Relay v0.1 buffers the invocation before emitting AI SDK stream parts." }] });
          if (result.outputText) {
            controller.enqueue({ type: "text-start", id: "relay-text" });
            controller.enqueue({ type: "text-delta", id: "relay-text", delta: result.outputText });
            controller.enqueue({ type: "text-end", id: "relay-text" });
          }
          for (const part of content) if (part.type === "tool-call") controller.enqueue(part);
          controller.enqueue({ type: "finish", usage: usage(result), finishReason: finishReason(result.stopReason, result.toolCalls.length > 0) });
          controller.close();
        },
      });
      return { stream };
    },
  };
}
