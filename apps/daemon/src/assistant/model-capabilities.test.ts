import { describe, expect, it } from 'vitest';
import { TEXT_AND_TOOLS_ONLY } from '@bananasaurs/core';
import { capabilitiesForEntry } from './model-capabilities.js';
import type { OpenRouterModelCatalogue } from './openrouter-models.js';

const catalogueWith = (listing: Record<string, unknown>): OpenRouterModelCatalogue => ({
  peek: (model: string) =>
    (listing[model] as ReturnType<OpenRouterModelCatalogue['peek']>) ?? {
      listed: false,
      image: false,
      file: false,
      tools: false,
      reasoning: false,
    },
  refresh: async () => {},
});

describe('capabilitiesForEntry (ADR 0143, spec 1g)', () => {
  it('maps Gemini through the shared table', () => {
    expect(
      capabilitiesForEntry({ providerId: 'gemini', model: 'gemini-3.8-flash' }, catalogueWith({})),
    ).toEqual({ tools: true, image: true, pdf: true, reasoning: true, thinking: 'levels' });
    expect(
      capabilitiesForEntry({ providerId: 'gemini', model: 'gemini-9.9-ultra' }, catalogueWith({})),
    ).toBe(TEXT_AND_TOOLS_ONLY);
  });
  it('maps OpenRouter image, file-to-pdf, tools and reasoning flags', () => {
    const catalogue = catalogueWith({
      'some/vision-model': { listed: true, image: true, file: true, tools: true, reasoning: true },
      'some/text-model': {
        listed: false,
        image: false,
        file: false,
        tools: false,
        reasoning: false,
      },
    });
    expect(
      capabilitiesForEntry({ providerId: 'openrouter', model: 'some/vision-model' }, catalogue),
    ).toEqual({ tools: true, image: true, pdf: true, reasoning: true, thinking: 'budget' });
    expect(
      capabilitiesForEntry({ providerId: 'openrouter', model: 'some/text-model' }, catalogue),
    ).toBe(TEXT_AND_TOOLS_ONLY);
  });
  it('treats NIM as text plus tools only', () => {
    expect(
      capabilitiesForEntry({ providerId: 'nvidia-nim', model: 'any-model' }, catalogueWith({})),
    ).toBe(TEXT_AND_TOOLS_ONLY);
  });
});
