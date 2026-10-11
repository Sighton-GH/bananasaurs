import { describe, expect, it } from 'vitest';
import {
  GEMINI_MODEL_TABLE,
  TEXT_AND_TOOLS_ONLY,
  geminiCapabilities,
} from './model-capabilities.js';

describe('geminiCapabilities (ADR 0143)', () => {
  it('marks gemini-3.8-flash as full capability with 5/20 free limits', () => {
    expect(GEMINI_MODEL_TABLE['gemini-3.8-flash']).toEqual({
      tools: true,
      image: true,
      pdf: true,
      reasoning: true,
      thinking: 'levels',
      freeRpm: 5,
      freeRpd: 20,
    });
    expect(geminiCapabilities('gemini-3.8-flash')).toEqual({
      tools: true,
      image: true,
      pdf: true,
      reasoning: true,
      thinking: 'levels',
    });
  });
  it('marks gemini-3.6-flash the same and flash-lite 15/500', () => {
    expect(GEMINI_MODEL_TABLE['gemini-3.6-flash']).toMatchObject({ freeRpm: 5, freeRpd: 20 });
    expect(GEMINI_MODEL_TABLE['gemini-3.5-flash-lite']).toMatchObject({
      tools: true,
      image: true,
      pdf: true,
      reasoning: true,
      thinking: 'levels',
      freeRpm: 15,
      freeRpd: 500,
    });
  });
  it('treats an unknown Gemini model as text plus tools only', () => {
    expect(TEXT_AND_TOOLS_ONLY).toEqual({
      tools: true,
      image: false,
      pdf: false,
      reasoning: false,
      thinking: 'none',
    });
    expect(geminiCapabilities('gemini-9.9-ultra')).toBe(TEXT_AND_TOOLS_ONLY);
  });
});
