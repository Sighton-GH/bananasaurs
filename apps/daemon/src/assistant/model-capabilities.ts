import { geminiCapabilities, TEXT_AND_TOOLS_ONLY, type ModelCapabilities } from '@bananasaurs/core';
import type { ProviderId } from './model-chain.js';
import type { OpenRouterModelCatalogue } from './openrouter-models.js';

/**
 * Per-entry capabilities (spec 1g Gemini half, ADR 0143): gemini reads the
 * shared table, openrouter reads the catalogued listing (`file` means PDF),
 * nvidia-nim is text plus tools only. Unlisted models are text plus tools only.
 */
export function capabilitiesForEntry(
  entry: { readonly providerId: ProviderId; readonly model: string },
  catalogue: OpenRouterModelCatalogue,
): ModelCapabilities {
  if (entry.providerId === 'gemini') return geminiCapabilities(entry.model);
  if (entry.providerId === 'nvidia-nim') return TEXT_AND_TOOLS_ONLY;
  const listing = catalogue.peek(entry.model);
  if (listing === undefined || !listing.listed) return TEXT_AND_TOOLS_ONLY;
  return {
    tools: listing.tools,
    image: listing.image,
    pdf: listing.file,
    reasoning: listing.reasoning,
    thinking: listing.reasoning ? 'budget' : 'none',
  };
}
