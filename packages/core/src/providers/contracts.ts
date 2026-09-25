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

export interface GenerateTextRequest {
  readonly model: string;
  readonly messages: readonly GenerationMessage[];
  readonly systemInstruction?: string;
  readonly maxOutputTokens?: number;
  readonly temperature?: number;
  readonly signal?: AbortSignal;
  /** Hint for providers with a thinking budget (Gemini); ignored elsewhere. */
  readonly thinkingBudget?: number;
  /** Offered only by providers with the `tools` capability. */
  readonly tools?: readonly ToolDeclaration[];
}

export interface ProviderUsage {
  readonly promptTokens?: number;
  readonly completionTokens?: number;
  readonly totalTokens?: number;
  readonly thinkingTokens?: number;
}

export interface GenerateTextResponse {
  /** Empty when the model only asked for tools. */
  readonly text: string;
  readonly model: string;
  readonly finishReason?: string;
  readonly usage?: ProviderUsage;
  readonly toolCalls?: readonly ToolCall[];
  /** See `GenerationMessage.providerParts`. */
  readonly providerParts?: unknown;
}

export interface TextProvider {
  readonly id: string;
  readonly capabilities: ReadonlySet<ProviderCapability>;
  generateText(request: GenerateTextRequest): Promise<GenerateTextResponse>;
}
