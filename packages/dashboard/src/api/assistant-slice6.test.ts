import { describe, expect, it } from 'vitest';
import { BULK_KEYS_URL, MODEL_CHECK_URL, RECOMMENDED_CHAIN_URL } from './assistant.js';

describe('Slice 6 API urls', () => {
  it('pins the three new endpoints', () => {
    expect(BULK_KEYS_URL).toBe('/api/assistant/keys/bulk');
    expect(RECOMMENDED_CHAIN_URL).toBe('/api/assistant/model-chain/recommended');
    expect(MODEL_CHECK_URL).toBe('/api/assistant/model-check');
  });
});
