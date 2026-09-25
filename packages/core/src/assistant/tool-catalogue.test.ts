import { describe, expect, it } from 'vitest';
import { CLUB_ASSISTANT_SKILLS } from './skills.js';
import { TOOL_CATALOGUE } from './tool-catalogue.js';

describe('TOOL_CATALOGUE', () => {
  it('names every tool once, with a JSON Schema object and a round scope', () => {
    const names = TOOL_CATALOGUE.map((tool) => tool.name);
    expect(names).toEqual([
      'search_archive',
      'open_resource',
      'web_search',
      'server_info',
      'current_time',
      'my_reminders',
    ]);
    expect(new Set(names).size).toBe(names.length);
    for (const tool of TOOL_CATALOGUE) {
      expect(tool.parameters.type).toBe('object');
      expect(['first', 'all']).toContain(tool.rounds);
      expect(tool.outputLimit.length).toBeGreaterThan(0);
    }
  });

  it('opens every round except open_resource, which stays reachable in a follow-up round (ADR 0071)', () => {
    for (const tool of TOOL_CATALOGUE) {
      if (tool.name === 'open_resource') expect(tool.rounds).toBe('all');
      else expect(tool.rounds).toBe('first');
    }
  });

  it('lists only real skill ids, and the search skill on every tool (it uses all read tools)', () => {
    const skillIds = new Set(CLUB_ASSISTANT_SKILLS.map((skill) => skill.id));
    for (const tool of TOOL_CATALOGUE) {
      for (const skillId of tool.skills) expect(skillIds.has(skillId), skillId).toBe(true);
      expect(tool.skills).toContain('search-club');
    }
  });

  it('gives search_archive a bounded query string and open_resource a bounded id', () => {
    const search = TOOL_CATALOGUE.find((tool) => tool.name === 'search_archive')!;
    expect(search.parameters.properties.query).toMatchObject({
      type: 'string',
      minLength: 1,
      maxLength: 200,
    });
    expect(search.parameters.required).toEqual(['query']);
    const open = TOOL_CATALOGUE.find((tool) => tool.name === 'open_resource')!;
    expect(open.parameters.properties.resourceId).toMatchObject({
      type: 'string',
      minLength: 1,
      maxLength: 64,
    });
  });
});
