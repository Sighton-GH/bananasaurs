import { describe, expect, expectTypeOf, it } from 'vitest';
import type { GenerationMedia, GenerationMessage } from './contracts.js';
import type { GenerationMedia as RootGenerationMedia } from '../index.js';

describe('GenerationMedia (ADR 0149)', () => {
  it('carries image and pdf bytes on a user message only', () => {
    const media: readonly GenerationMedia[] = [
      { kind: 'image', mediaType: 'image/png', dataBase64: 'aGk=', name: 'chart.png' },
      { kind: 'pdf', mediaType: 'application/pdf', dataBase64: 'aGk=', name: 'report.pdf' },
    ];
    const message: GenerationMessage = { role: 'user', text: 'what is this?', media };
    expect(message.media).toHaveLength(2);
    expectTypeOf(message.media?.[0]?.kind).toEqualTypeOf<'image' | 'pdf' | undefined>();
    expectTypeOf(message.media?.[0]?.dataBase64).toEqualTypeOf<string | undefined>();
  });

  it('stays absent unless set', () => {
    const message: GenerationMessage = { role: 'user', text: 'hello' };
    expect(message.media).toBeUndefined();
  });

  it('is exported from the package root', () => {
    expectTypeOf<RootGenerationMedia>().toEqualTypeOf<GenerationMedia>();
  });
});
