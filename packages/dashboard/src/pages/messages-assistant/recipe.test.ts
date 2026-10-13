import { describe, expect, it } from 'vitest';

import conversations from './assistant-conversations.tsx?raw';
import history from './assistant-history.tsx?raw';
import skill from './assistant-skill.tsx?raw';
import items from './skill-items.tsx?raw';
import wizard from './assistant-prompt-wizard.tsx?raw';
import memory from '../assistant-memory.tsx?raw';
import search from '../search.tsx?raw';
const sources: Record<string, string> = {
  'assistant-conversations.tsx': conversations,
  'assistant-history.tsx': history,
  'assistant-skill.tsx': skill,
  'skill-items.tsx': items,
  'assistant-prompt-wizard.tsx': wizard,
  '../assistant-memory.tsx': memory,
  '../search.tsx': search,
};
const source = (name: string) => sources[name]!;
describe('P5 7b owned page recipe', () => {
  it.each([
    'assistant-conversations.tsx',
    'assistant-history.tsx',
    'assistant-skill.tsx',
    'skill-items.tsx',
    'assistant-prompt-wizard.tsx',
    '../assistant-memory.tsx',
  ])('%s uses kit controls and copyable model content', (name) => {
    expect(source(name)).not.toMatch(/<(?:select|textarea|table|pre)\b/);
  });
  it.each(['assistant-conversations.tsx', 'assistant-history.tsx', '../search.tsx'])(
    '%s offers a clear-filter path',
    (name) => {
      expect(source(name)).toContain('Clear filters');
    },
  );
});
