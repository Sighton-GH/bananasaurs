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
      'list_sources',
      'search_sources',
      'read_chunk',
      'outline',
      'refresh_source',
    ]);
    expect(new Set(names).size).toBe(names.length);
    for (const tool of TOOL_CATALOGUE) {
      expect(tool.parameters.type).toBe('object');
      expect(['first', 'all']).toContain(tool.rounds);
      expect(tool.outputLimit.length).toBeGreaterThan(0);
    }
  });

  it('opens every round except read_chunk, outline and open_resource, which stay reachable in a follow-up round (ADR 0071)', () => {
    for (const tool of TOOL_CATALOGUE) {
      if (tool.name === 'read_chunk' || tool.name === 'outline' || tool.name === 'open_resource')
        expect(tool.rounds).toBe('all');
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

  it('gives the cache tools camelCase parameters with the ruled bounds', () => {
    const list = TOOL_CATALOGUE.find((tool) => tool.name === 'list_sources')!;
    expect(list.parameters.properties.filter).toMatchObject({
      type: 'string',
      maxLength: 80,
    });
    expect(list.parameters.required ?? []).not.toContain('filter');
    expect(list.rounds).toBe('first');
    const search = TOOL_CATALOGUE.find((tool) => tool.name === 'search_sources')!;
    expect(search.parameters.properties.query).toMatchObject({
      type: 'string',
      minLength: 2,
      maxLength: 200,
    });
    expect(search.parameters.required).toEqual(['query']);
    expect(search.rounds).toBe('first');
    const read = TOOL_CATALOGUE.find((tool) => tool.name === 'read_chunk')!;
    expect(read.parameters.properties.chunkId).toMatchObject({ type: 'string' });
    expect(read.parameters.required).toEqual(['chunkId']);
    expect(read.rounds).toBe('all');
    const outline = TOOL_CATALOGUE.find((tool) => tool.name === 'outline')!;
    expect(outline.parameters.properties.docId).toMatchObject({ type: 'string' });
    expect(outline.parameters.required).toEqual(['docId']);
    expect(outline.rounds).toBe('all');
    const refresh = TOOL_CATALOGUE.find((tool) => tool.name === 'refresh_source')!;
    expect(refresh.parameters.properties.resourceId).toMatchObject({ type: 'string' });
    expect(refresh.parameters.required).toEqual(['resourceId']);
    expect(refresh.rounds).toBe('first');
  });
});
