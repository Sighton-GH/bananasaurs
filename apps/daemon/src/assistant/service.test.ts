import { describe, expect, it } from 'vitest';
import { sanitizeMentionsForProvider } from './service.js';

describe('sanitizeMentionsForProvider', () => {
  it('flattens role, user and channel mentions to readable tokens', () => {
    expect(
      sanitizeMentionsForProvider(
        'what did <@456789012345678901> say in <#345678901234567890> about <@&567890123456789012>?',
      ),
    ).toBe('what did @user say in #channel about @role?');
  });

  it('leaves ordinary prose and short numbers untouched', () => {
    expect(sanitizeMentionsForProvider('meet at 7, bring 12345 cones')).toBe(
      'meet at 7, bring 12345 cones',
    );
  });
});
