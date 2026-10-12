import type { ModelCapabilities } from './model-capabilities.js';

export type ProviderCapability =
  'text' | 'streaming' | 'structured-output' | 'tools' | 'vision' | 'usage';

export interface ProviderEligibility {
  readonly trainsOnInput: 'no' | 'yes' | 'unknown';
  readonly productionUseAllowed: boolean;
  readonly evidenceUrl: string;
  readonly reviewedAt: string;
}

/** A read-only tool the model may call (ADR 0067). `parameters` is a JSON Schema object. */
export interface ToolDeclaration {
  readonly name: string;
  readonly description: string;
  readonly parameters: Readonly<Record<string, unknown>>;
}

/** A call the model asked for. `args` is untrusted until the tool's Zod schema accepts it. */
export interface ToolCall {
  readonly id?: string;
  readonly name: string;
  readonly args: unknown;
}

export interface GenerationMessage {
  /** `tool` carries one tool result; `text` is that result, already redacted. */
  readonly role: 'user' | 'assistant' | 'tool';
  readonly text: string;
  /** On an assistant turn: the tool calls it made. */
  readonly toolCalls?: readonly ToolCall[];
  /** On a tool turn: which call this answers. */
  readonly toolName?: string;
  readonly toolCallId?: string;
  /**
   * On an assistant turn: the provider's own parts, echoed back unchanged on
   * the next request (Gemini's thought signatures). Model output, so it is
   * never logged and never scanned as member input.
   */
  readonly providerParts?: unknown;
}

/** Throttled stream counters: metadata only, safe for the run ledger. */
export interface StreamProgress {
  readonly round: number;
  readonly answerChars: number;
  readonly reasoningChars: number;
  readonly keepalives: number;
  readonly msSinceLastByte: number;
}

/** Unthrottled text deltas for the live buffer; never stored in the ledger. */
export interface StreamChunk {
  readonly text: string;
  readonly reasoning: string;
}

export interface GenerateTextRequest {
  readonly model: string;
  readonly messages: readonly GenerationMessage[];
  readonly systemInstruction?: string;
  readonly maxOutputTokens?: number;
  readonly temperature?: number;
  readonly signal?: AbortSignal;
  /** Hint for providers with a thinking budget (Gemini); ignored elsewhere. */
  readonly thinkingBudget?: number;
  /**
   * Explicit thinking level (Gemini 3). Absent means the adapter derives
   * `low` for tool rounds and `medium` for the answer. Never `minimal`.
   * Never sent when the entry capabilities forbid thinking.
   */
  readonly thinkingLevel?: 'low' | 'medium' | 'high';
  /**
   * Per-entry capabilities from daemon `capabilitiesForEntry`. Absent means
   * the adapter's conservative built-in default (unknown models get no
   * thinking parameter and no reasoning request).
   */
  readonly capabilities?: ModelCapabilities;
  /** Offered only by providers with the `tools` capability. */
  readonly tools?: readonly ToolDeclaration[];
  /** Throttled progress counters (metadata only, safe for the ledger). */
  readonly onProgress?: (progress: StreamProgress) => void;
  /** Unthrottled text deltas for the live buffer; never stored in the ledger. */
  readonly onChunk?: (chunk: StreamChunk) => void;
}

export interface ProviderUsage {
  readonly promptTokens?: number;
  readonly completionTokens?: number;
  readonly totalTokens?: number;
  readonly thinkingTokens?: number;
  /** ADR 0129 §8: OpenRouter's per-call cost, present only when the provider reported it. */
  readonly costUsd?: number;
}

export interface GenerateTextResponse {
  /** Empty when the model only asked for tools. */
  readonly text: string;
  /**
   * Non-answer reasoning (OpenRouter `delta.reasoning`, Gemini thought
   * summaries). Absent when the model exposed none. Saved per round under
   * trace `reasoning`, never delivered to members.
   */
  readonly reasoning?: string;
  readonly model: string;
  readonly finishReason?: string;
  readonly usage?: ProviderUsage;
  readonly toolCalls?: readonly ToolCall[];
  /** The upstream provider OpenRouter routed to (ADR 0129 §4). */
  readonly upstream?: string;
  /** See `GenerationMessage.providerParts`. */
  readonly providerParts?: unknown;
}

export interface TextProvider {
  readonly id: string;
  readonly capabilities: ReadonlySet<ProviderCapability>;
  generateText(request: GenerateTextRequest): Promise<GenerateTextResponse>;
}
