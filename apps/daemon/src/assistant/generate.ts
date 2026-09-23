import {
  ProviderError,
  type GenerateTextRequest,
  type GenerateTextResponse,
  type GenerationMessage,
  type TextProvider,
  type ToolCall,
  type ToolDeclaration,
} from '@bananasaurs/core';
import type { AssistantToolResult, ToolSource } from './tools.js';

/** What the AI log channel reports about one answer (ADR 0065). */
export interface GenerationTrace {
  /** The model that produced the answer, as the provider reported it. */
  readonly model: string;
  readonly tools: readonly { readonly name: string; readonly ok: boolean }[];
  readonly sources: readonly ToolSource[];
  /** True when any web search result reached the model. */
  readonly web: boolean;
  readonly usedFallback: boolean;
}

/** Calls beyond this in the one tool round are refused, not run. */
const MAX_TOOL_CALLS = 6;
const BRAVE_ATTRIBUTION = '\n\n-# Powered by Brave Search';

/**
 * One answer, with at most one read-only tool round (ADR 0067). The model may
 * call tools only in the first turn, whose new input is the member's own
 * question. The results go back with tools switched off, because a turn whose
 * only new input is retrieved text may not emit a tool call (hard rule 3).
 */
export const generateAnswer = async (input: {
  readonly provider: TextProvider;
  readonly model: string;
  /** Tried once when the main model is overloaded or rate-limited. */
  readonly fallbackModel?: string | undefined;
  readonly systemInstruction: string;
  readonly userText: string;
  readonly maxOutputTokens?: number;
  readonly temperature?: number;
  readonly tools?:
    | {
        readonly declarations: readonly ToolDeclaration[];
        readonly run: (call: ToolCall) => Promise<AssistantToolResult>;
      }
    | undefined;
}): Promise<{ readonly text: string; readonly trace: GenerationTrace }> => {
  let usedFallback = false;
  const call = async (
    request: Omit<GenerateTextRequest, 'model'>,
  ): Promise<GenerateTextResponse> => {
    const model =
      usedFallback && input.fallbackModel !== undefined ? input.fallbackModel : input.model;
    try {
      return await input.provider.generateText({ ...request, model });
    } catch (err) {
      const canFallBack =
        !usedFallback &&
        input.fallbackModel !== undefined &&
        input.fallbackModel !== input.model &&
        err instanceof ProviderError &&
        err.retryable &&
        (err.kind === 'outage' || err.kind === 'rate-limit' || err.kind === 'timeout');
      if (!canFallBack) throw err;
      usedFallback = true;
      return await input.provider.generateText({ ...request, model: input.fallbackModel! });
    }
  };

  const base = {
    systemInstruction: input.systemInstruction,
    ...(input.maxOutputTokens === undefined ? {} : { maxOutputTokens: input.maxOutputTokens }),
    ...(input.temperature === undefined ? {} : { temperature: input.temperature }),
  };
  const question: GenerationMessage = { role: 'user', text: input.userText };
  const offered =
    input.tools !== undefined &&
    input.tools.declarations.length > 0 &&
    input.provider.capabilities.has('tools')
      ? input.tools
      : undefined;

  const first = await call({
    ...base,
    messages: [question],
    ...(offered === undefined ? {} : { tools: offered.declarations }),
  });
  const calls = first.toolCalls ?? [];
  if (offered === undefined || calls.length === 0) {
    return {
      text: first.text,
      trace: { model: first.model, tools: [], sources: [], web: false, usedFallback },
    };
  }

  const results: AssistantToolResult[] = await Promise.all(
    calls.map((toolCall, index) =>
      index < MAX_TOOL_CALLS
        ? offered.run(toolCall)
        : Promise.resolve({
            name: toolCall.name,
            ok: false,
            text: 'Too many tool calls in one request; this one was not run.',
            sources: [],
          }),
    ),
  );
  const toolMessages: GenerationMessage[] = results.map((result, index) => ({
    role: 'tool',
    toolName: calls[index]!.name,
    ...(calls[index]!.id === undefined ? {} : { toolCallId: calls[index]!.id }),
    text: `[UNTRUSTED TOOL RESULT tool=${result.name}]\n${result.text}\n[/UNTRUSTED TOOL RESULT]`,
  }));
  const second = await call({
    ...base,
    messages: [
      question,
      {
        role: 'assistant',
        text: first.text,
        toolCalls: calls,
        ...(first.providerParts === undefined ? {} : { providerParts: first.providerParts }),
      },
      ...toolMessages,
    ],
  });

  const web = results.some((result) => result.ok && result.web === true);
  return {
    text: web ? `${second.text}${BRAVE_ATTRIBUTION}` : second.text,
    trace: {
      model: second.model,
      tools: results.map((result) => ({ name: result.name, ok: result.ok })),
      sources: results.flatMap((result) => (result.ok ? result.sources : [])),
      web,
      usedFallback,
    },
  };
};
