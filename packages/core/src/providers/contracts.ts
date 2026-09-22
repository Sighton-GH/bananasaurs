export type ProviderCapability =
  'text' | 'streaming' | 'structured-output' | 'tools' | 'vision' | 'usage';

export interface ProviderEligibility {
  readonly trainsOnInput: 'no' | 'yes' | 'unknown';
  readonly productionUseAllowed: boolean;
  readonly evidenceUrl: string;
  readonly reviewedAt: string;
}

export interface GenerationMessage {
  readonly role: 'user' | 'assistant';
  readonly text: string;
}

export interface GenerateTextRequest {
  readonly model: string;
  readonly messages: readonly GenerationMessage[];
  readonly systemInstruction?: string;
  readonly maxOutputTokens?: number;
  readonly temperature?: number;
  readonly signal?: AbortSignal;
}

export interface ProviderUsage {
  readonly promptTokens?: number;
  readonly completionTokens?: number;
  readonly totalTokens?: number;
}

export interface GenerateTextResponse {
  readonly text: string;
  readonly model: string;
  readonly finishReason?: string;
  readonly usage?: ProviderUsage;
}

export interface TextProvider {
  readonly id: string;
  readonly capabilities: ReadonlySet<ProviderCapability>;
  generateText(request: GenerateTextRequest): Promise<GenerateTextResponse>;
}
