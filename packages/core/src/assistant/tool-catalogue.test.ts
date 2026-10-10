import { describe, expect, it } from 'vitest';
import { CLUB_ASSISTANT_SKILLS } from './skills.js';
import { RETURNED_ID_ARGS, TOOL_CATALOGUE, TOOL_GROUPS } from './tool-catalogue.js';

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
      'set_reminder',
      'edit_reminder',
      'cancel_reminder',
      'propose_memory',
      'propose_decision',
      'search_sources',
      'read_chunk',
      'refresh_source',
      'upcoming_events',
      'search_conversations',
      'channel_history',
    ]);
    expect(new Set(names).size).toBe(names.length);
    for (const tool of TOOL_CATALOGUE) {
      expect(tool.parameters.type).toBe('object');
      expect(['first', 'all', 'returned-id']).toContain(tool.rounds);
      expect(tool.outputLimit.length).toBeGreaterThan(0);
    }
  });

  it('keeps follow-up tools that need a returned id out of round one alone (ADR 0071, ADR 0137)', () => {
    for (const tool of TOOL_CATALOGUE) {
      if (
        tool.name === 'read_chunk' ||
        tool.name === 'open_resource' ||
        tool.name === 'channel_history' ||
        tool.name === 'edit_reminder' ||
        tool.name === 'cancel_reminder'
      )
        expect(tool.rounds).toBe('returned-id');
      else expect(['first', 'all']).toContain(tool.rounds);
    }
  });

  it('lists only real skill ids, and the search skill on every read tool', () => {
    const skillIds = new Set(CLUB_ASSISTANT_SKILLS.map((skill) => skill.id));
    // 'web-search' is the skill gate for web_search (ADR 0136); the skill
    // catalogue lists it once Task 1 lands.
    skillIds.add('web-search');
    for (const tool of TOOL_CATALOGUE) {
      for (const skillId of tool.skills) {
        expect(skillIds.has(skillId), skillId).toBe(true);
      }
      if (tool.actsForSkill === undefined) expect(tool.skills).toContain('search-club');
    }
  });

  it('names no legacy create-reminder skill anywhere', () => {
    for (const tool of TOOL_CATALOGUE) {
      expect(tool.skills).not.toContain('create-reminder');
      expect(tool.skills).not.toContain('send-reminder');
    }
    expect(TOOL_CATALOGUE.map((tool) => tool.name)).not.toContain('create-reminder');
  });

  it('declares the acting and listing tools with their acting skill and round scope', () => {
    const expected: Readonly<Record<string, { readonly skill: string; readonly rounds: string }>> =
      {
        my_reminders: { skill: 'reminders', rounds: 'all' },
        set_reminder: { skill: 'reminders', rounds: 'first' },
        edit_reminder: { skill: 'reminders', rounds: 'returned-id' },
        cancel_reminder: { skill: 'reminders', rounds: 'returned-id' },
        propose_memory: { skill: 'propose-memory', rounds: 'first' },
        propose_decision: { skill: 'record-decision', rounds: 'first' },
      };
    for (const [name, { skill, rounds }] of Object.entries(expected)) {
      const entry = TOOL_CATALOGUE.find((tool) => tool.name === name);
      expect(entry, name).toBeDefined();
      expect(entry?.rounds).toBe(rounds);
      expect(entry?.actsForSkill).toBe(skill);
    }
    const idTools = new Set(['read_chunk', 'open_resource']);
    for (const name of Object.keys(expected)) expect(idTools.has(name)).toBe(false);
  });

  it('gives my_reminders an optional all flag for the owner', () => {
    const mine = TOOL_CATALOGUE.find((tool) => tool.name === 'my_reminders')!;
    expect(mine.skills).toEqual(['search-club', 'reminders']);
    expect(mine.description).toBe(
      "The asking member's own reminders that have not finished, with ids for edit_reminder and cancel_reminder. The server owner may pass all=true to see everyone's.",
    );
    expect(mine.parameters.properties.all).toMatchObject({ type: 'boolean' });
    expect(mine.parameters.required ?? []).not.toContain('all');
  });

  it('bounds set_reminder text, context, members, roles and repeat', () => {
    const set = TOOL_CATALOGUE.find((tool) => tool.name === 'set_reminder')!;
    expect(set.parameters.properties.text).toMatchObject({
      type: 'string',
      minLength: 1,
      maxLength: 1500,
    });
    expect(set.parameters.properties.when).toMatchObject({ type: 'string' });
    expect(set.parameters.properties.context?.maxLength).toBe(300);
    expect(set.parameters.properties.members).toMatchObject({ type: 'array', maxItems: 25 });
    expect(set.parameters.properties.roles).toMatchObject({ type: 'array', maxItems: 10 });
    expect(set.parameters.required).toEqual(expect.arrayContaining(['text', 'when']));
    const repeat = set.parameters.properties.repeat;
    expect(repeat?.type).toBe('object');
    expect(repeat?.properties?.kind?.enum).toEqual(['daily', 'weekdays', 'weekly', 'monthly']);
    expect(repeat?.properties?.days?.maxItems).toBe(7);
    expect(repeat?.properties?.everyWeeks).toMatchObject({ minimum: 1, maximum: 12 });
    expect(repeat?.properties?.dayOfMonth).toMatchObject({ minimum: 1, maximum: 31 });
    expect(repeat?.properties?.count).toMatchObject({ minimum: 1, maximum: 1000 });
  });

  it('bounds edit_reminder, cancel_reminder and the proposal tools', () => {
    const edit = TOOL_CATALOGUE.find((tool) => tool.name === 'edit_reminder')!;
    expect(edit.parameters.required).toEqual(expect.arrayContaining(['reminderId']));
    expect(edit.parameters.properties.text).toMatchObject({ minLength: 1, maxLength: 1500 });
    expect(edit.parameters.properties.context?.maxLength).toBe(300);
    expect(edit.parameters.properties.members).toMatchObject({ type: 'array', maxItems: 25 });
    expect(edit.parameters.properties.roles).toMatchObject({ type: 'array', maxItems: 10 });
    expect(edit.parameters.properties.stopRepeating).toMatchObject({ type: 'boolean' });
    const cancel = TOOL_CATALOGUE.find((tool) => tool.name === 'cancel_reminder')!;
    expect(cancel.parameters.required).toEqual(['reminderId']);
    const memory = TOOL_CATALOGUE.find((tool) => tool.name === 'propose_memory')!;
    expect(memory.parameters.properties.content).toMatchObject({
      type: 'string',
      minLength: 1,
      maxLength: 1000,
    });
    expect(memory.parameters.properties.section?.maxLength).toBe(100);
    expect(memory.description.toLowerCase()).toContain('owner');
    const decision = TOOL_CATALOGUE.find((tool) => tool.name === 'propose_decision')!;
    expect(decision.parameters.properties.summary).toMatchObject({
      type: 'string',
      minLength: 1,
      maxLength: 4000,
    });
    expect(decision.parameters.properties.kind?.enum).toEqual(['decision', 'review-plan']);
    expect(decision.description.toLowerCase()).toContain('draft');
  });

  it('gives search_archive a bounded query string and open_resource both ids with neither required', () => {
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
    expect(open.parameters.properties.docId).toMatchObject({
      type: 'string',
      minLength: 1,
      maxLength: 128,
    });
    expect(open.parameters.required ?? []).toEqual([]);
    expect(open.rounds).toBe('returned-id');
  });

  it('gives the cache tools camelCase parameters with the ruled bounds', () => {
    const search = TOOL_CATALOGUE.find((tool) => tool.name === 'search_sources')!;
    expect(search.parameters.properties.query).toMatchObject({
      type: 'string',
      minLength: 2,
      maxLength: 200,
    });
    expect(search.parameters.required ?? []).not.toContain('query');
    expect(search.parameters.properties.filter).toMatchObject({
      type: 'string',
      maxLength: 80,
    });
    expect(search.parameters.required ?? []).not.toContain('filter');
    expect(search.description).toContain('Without a query it lists');
    expect(search.rounds).toBe('all');
    const read = TOOL_CATALOGUE.find((tool) => tool.name === 'read_chunk')!;
    expect(read.parameters.properties.chunkId).toMatchObject({ type: 'string' });
    expect(read.parameters.required).toEqual(['chunkId']);
    expect(read.rounds).toBe('returned-id');
    const refresh = TOOL_CATALOGUE.find((tool) => tool.name === 'refresh_source')!;
    expect(refresh.parameters.properties.resourceId).toMatchObject({ type: 'string' });
    expect(refresh.parameters.required).toEqual(['resourceId']);
    expect(refresh.rounds).toBe('all');
  });

  it('names neither list_sources nor outline anywhere in the catalogue', () => {
    const names = TOOL_CATALOGUE.map((tool) => tool.name);
    expect(names).not.toContain('list_sources');
    expect(names).not.toContain('outline');
    for (const tool of TOOL_CATALOGUE) {
      expect(tool.description).not.toContain("'list_sources'");
      expect(tool.description).not.toContain("'outline'");
      for (const property of Object.values(tool.parameters.properties)) {
        expect(property.description ?? '').not.toContain("'list_sources'");
        expect(property.description ?? '').not.toContain("'outline'");
      }
    }
  });

  it('gives search_archive an optional from for checking one member (ADR 0090 D3)', () => {
    const search = TOOL_CATALOGUE.find((tool) => tool.name === 'search_archive')!;
    expect(search.parameters.properties.from).toMatchObject({ type: 'string', maxLength: 100 });
    expect(search.parameters.required).toEqual(['query']);
    expect(search.description).toContain('pass their name as from');
  });

  it('gives search_sources.sourceIds array items with a bound of 10', () => {
    const search = TOOL_CATALOGUE.find((tool) => tool.name === 'search_sources')!;
    expect(search.parameters.properties.sourceIds).toMatchObject({
      type: 'array',
      items: { type: 'string' },
      maxItems: 10,
    });
  });

  it('gives upcoming_events no parameters and channel_history a bounded before and limit', () => {
    const upcoming = TOOL_CATALOGUE.find((tool) => tool.name === 'upcoming_events')!;
    expect(upcoming.rounds).toBe('all');
    expect(upcoming.skills).toEqual(['search-club']);
    expect(upcoming.actsForSkill).toBeUndefined();
    expect(Object.keys(upcoming.parameters.properties)).toEqual([]);
    const history = TOOL_CATALOGUE.find((tool) => tool.name === 'channel_history')!;
    expect(history.rounds).toBe('returned-id');
    expect(history.skills).toEqual(['search-club']);
    expect(history.actsForSkill).toBeUndefined();
    expect(history.parameters.properties.before).toMatchObject({ type: 'string' });
    expect(history.parameters.properties.limit).toMatchObject({
      type: 'integer',
      minimum: 1,
      maximum: 50,
    });
    expect(history.parameters.required ?? []).toEqual([]);
  });

  it('gives search_conversations a bounded query string on the search skill (ADR 0093)', () => {
    const search = TOOL_CATALOGUE.find((tool) => tool.name === 'search_conversations')!;
    expect(search.description).toBe(
      'Look back at summaries of earlier conversations in channels everyone here can read.',
    );
    expect(search.parameters.properties.query).toMatchObject({
      type: 'string',
      minLength: 2,
      maxLength: 200,
    });
    expect(search.parameters.required).toEqual(['query']);
    expect(search.rounds).toBe('all');
    expect(search.skills).toEqual(['search-club']);
  });
});

describe('catalogue groups and round policy (ADR 0136, 0137)', () => {
  it('puts every tool in a known group, and every group has a tool', () => {
    const ids = new Set(TOOL_GROUPS.map((g) => g.id));
    for (const entry of TOOL_CATALOGUE) expect(ids.has(entry.group)).toBe(true);
    for (const group of TOOL_GROUPS)
      expect(TOOL_CATALOGUE.some((e) => e.group === group.id)).toBe(true);
  });

  it('lets read-only tools run in any round and keeps acting tools first or returned-id', () => {
    const byName = new Map(TOOL_CATALOGUE.map((e) => [e.name, e]));
    for (const name of [
      'web_search',
      'search_sources',
      'search_archive',
      'search_conversations',
      'server_info',
      'current_time',
      'my_reminders',
      'upcoming_events',
      'refresh_source',
    ])
      expect(byName.get(name)?.rounds).toBe('all');
    for (const name of [
      'read_chunk',
      'open_resource',
      'channel_history',
      'edit_reminder',
      'cancel_reminder',
    ])
      expect(byName.get(name)?.rounds).toBe('returned-id');
    for (const name of ['set_reminder', 'propose_memory', 'propose_decision'])
      expect(byName.get(name)?.rounds).toBe('first');
  });

  it('never lets a tool that writes run in every round', () => {
    const writers = TOOL_CATALOGUE.filter((e) => e.writes === true)
      .map((e) => e.name)
      .sort();
    expect(writers).toEqual([
      'cancel_reminder',
      'edit_reminder',
      'propose_decision',
      'propose_memory',
      'set_reminder',
    ]);
    for (const entry of TOOL_CATALOGUE)
      if (entry.writes === true) expect(entry.rounds, entry.name).not.toBe('all');
  });

  it('derives the returned-id arguments from the catalogue', () => {
    expect(RETURNED_ID_ARGS).toEqual({
      open_resource: ['resourceId', 'docId'],
      edit_reminder: ['reminderId'],
      cancel_reminder: ['reminderId'],
      read_chunk: ['chunkId'],
      channel_history: ['before'],
    });
    expect(Object.values(RETURNED_ID_ARGS).every((a) => a.length > 0)).toBe(true);
  });

  it('gates web_search behind the web-search skill', () => {
    expect(TOOL_CATALOGUE.find((e) => e.name === 'web_search')?.requiresSkill).toBe('web-search');
  });
});
