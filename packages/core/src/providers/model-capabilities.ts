/** Which thinking control a model family takes (contracts §3, Slice 6 produces). */
export type ThinkingControl = 'levels' | 'budget' | 'none';

export interface ModelCapabilities {
  readonly tools: boolean;
  readonly image: boolean;
  readonly pdf: boolean;
  readonly reasoning: boolean;
  readonly thinking: ThinkingControl;
}

/** Known Gemini models: capabilities plus free-tier limits for pre-filling a chain row. */
export interface GeminiModelProfile extends ModelCapabilities {
  readonly freeRpm?: number;
  readonly freeRpd?: number;
}

const FULL_GEMINI: ModelCapabilities = {
  tools: true,
  image: true,
  pdf: true,
  reasoning: true,
  thinking: 'levels',
};

export const GEMINI_MODEL_TABLE: Readonly<Record<string, GeminiModelProfile>> = {
  'gemini-3.8-flash': { ...FULL_GEMINI, freeRpm: 5, freeRpd: 20 },
  'gemini-3.6-flash': { ...FULL_GEMINI, freeRpm: 5, freeRpd: 20 },
  'gemini-3.5-flash-lite': { ...FULL_GEMINI, freeRpm: 15, freeRpd: 500 },
};

/** Unknown Gemini model → text + tools only, thinking 'none'. */
export const TEXT_AND_TOOLS_ONLY: ModelCapabilities = {
  tools: true,
  image: false,
  pdf: false,
  reasoning: false,
  thinking: 'none',
};

export function geminiCapabilities(model: string): ModelCapabilities {
  const row = GEMINI_MODEL_TABLE[model];
  if (row === undefined) return TEXT_AND_TOOLS_ONLY;
  return {
    tools: row.tools,
    image: row.image,
    pdf: row.pdf,
    reasoning: row.reasoning,
    thinking: row.thinking,
  };
}
