import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ROUTER_KEYWORDS,
  DEFAULT_ROUTER_GREETINGS,
  INSTANCE_SETTINGS,
  isInstanceSettingKey,
  settingDefinition,
} from './instance-settings.js';

describe('instance settings registry', () => {
  it('has 41 definitions and every default parses under its own schema', () => {
    expect(INSTANCE_SETTINGS).toHaveLength(41);
    for (const def of INSTANCE_SETTINGS) {
      expect(def.schema.safeParse(def.defaultValue).success, def.key).toBe(true);
    }
  });

  it('streaming timeouts default to 45 s idle and 300 s ceiling', () => {
    const values = Object.fromEntries(INSTANCE_SETTINGS.map((s) => [s.key, s.defaultValue]));
    expect(values['assistant.providerIdleTimeoutMs']).toBe(45_000);
    expect(values['assistant.providerMaxCallMs']).toBe(300_000);
  });

  it('max output tokens defaults to 4096 for reasoning', () => {
    const values = Object.fromEntries(INSTANCE_SETTINGS.map((s) => [s.key, s.defaultValue]));
    expect(values['assistant.maxOutputTokens']).toBe(4_096);
  });

  it('registers the Slice 2 reply-ping caps with their bounds (ADR 0145)', () => {
    const members = settingDefinition('assistant.pingMaxMembers');
    expect(members).toMatchObject({
      group: 'Assistant replies',
      label: 'Reply pings: max members',
      defaultValue: 5,
      bounds: { min: 1, max: 5 },
    });
    expect(members?.schema.safeParse(5).success).toBe(true);
    expect(members?.schema.safeParse(0).success).toBe(false);
    expect(members?.schema.safeParse(6).success).toBe(false);
    const roles = settingDefinition('assistant.pingMaxRoles');
    expect(roles).toMatchObject({
      group: 'Assistant replies',
      label: 'Reply pings: max roles',
      defaultValue: 3,
      bounds: { min: 1, max: 3 },
    });
    expect(roles?.schema.safeParse(3).success).toBe(true);
    expect(roles?.schema.safeParse(4).success).toBe(false);
    expect(isInstanceSettingKey('assistant.pingMaxMembers')).toBe(true);
    expect(isInstanceSettingKey('assistant.pingMaxRoles')).toBe(true);
  });

  it('retry delays accept an empty list and refuse bad shapes', () => {
    const def = settingDefinition('assistant.retryDelaysMs');
    expect(def).toBeDefined();
    expect(def?.schema.safeParse([60_000, 60_000, 60_000]).success).toBe(true);
    expect(def?.schema.safeParse([]).success).toBe(true);
    const over = def?.schema.safeParse([60_000, 60_000, 60_001]);
    expect(over?.success).toBe(false);
    if (over !== undefined && !over.success) {
      expect(over.error.issues[0]?.message).toBe('Retry delays must add up to 3 minutes or less.');
    }
    expect(def?.schema.safeParse([10_000, 10_000, 10_000, 10_000, 10_000]).success).toBe(false);
    expect(def?.schema.safeParse([500]).success).toBe(false);
  });

  it('refuses a reserved fetch header name and accepts a custom one', () => {
    const def = settingDefinition('resources.fetchHeaderName');
    expect(def?.schema.safeParse('Authorization').success).toBe(false);
    expect(def?.schema.safeParse('X-Bananasaurs-Fetch').success).toBe(true);
  });

  it('accepts a bare host and refuses a URL', () => {
    const def = settingDefinition('resources.fetchHeaderHosts');
    expect(def?.schema.safeParse(['sfuracerbot.ca']).success).toBe(true);
    expect(def?.schema.safeParse(['https://x.ca']).success).toBe(false);
  });

  it('channel context defaults to 15 messages and accepts 0–50', () => {
    const def = settingDefinition('assistant.channelContextMessages');
    expect(def?.defaultValue).toBe(15);
    expect(def?.group).toBe('Assistant context');
    expect(def?.label).toBe('Channel messages sent with each question');
    expect(def?.schema.safeParse(0).success).toBe(true);
    expect(def?.schema.safeParse(50).success).toBe(true);
    expect(def?.schema.safeParse(-1).success).toBe(false);
    expect(def?.schema.safeParse(51).success).toBe(false);
    expect(def?.schema.safeParse(7.5).success).toBe(false);
  });

  it('defaults equal today\u2019s constants', () => {
    const valueOf = (key: string): unknown => settingDefinition(key)?.defaultValue;
    expect(valueOf('assistant.retryDelaysMs')).toEqual([10_000, 30_000, 90_000]);
    expect(valueOf('assistant.providerTimeoutMs')).toBe(60_000);
    expect(valueOf('assistant.maxConcurrentRuns')).toBe(4);
    expect(valueOf('assistant.maxToolRounds')).toBe(4);
    expect(valueOf('assistant.maxToolCalls')).toBe(12);
    expect(valueOf('assistant.maxOutputTokens')).toBe(4096);
    expect(valueOf('network.connectFallbackMs')).toBe(1000);
    expect(valueOf('resources.fetchTimeoutMs')).toBe(5000);
    expect(valueOf('resources.refreshIntervalMin')).toBe(60);
  });

  it('recognises known keys', () => {
    expect(isInstanceSettingKey('assistant.maxToolRounds')).toBe(true);
    expect(isInstanceSettingKey('nope')).toBe(false);
    expect(settingDefinition('nope')).toBeUndefined();
  });

  it('registers the five MCP caps with defaults, group and bounds', () => {
    const expected: Readonly<Record<string, number>> = {
      'mcp.cap.message': 300,
      'mcp.cap.edit': 300,
      'mcp.cap.member_role': 1000,
      'mcp.cap.structure': 100,
      'mcp.cap.pin_react': 300,
    };
    for (const [key, defaultValue] of Object.entries(expected)) {
      const def = settingDefinition(key);
      expect(def, key).toBeDefined();
      expect(def?.defaultValue).toBe(defaultValue);
      expect(def?.group).toBe('MCP connector');
      expect(def?.display).toBe('count');
      expect(def?.bounds).toEqual({ min: 1, max: 10000 });
      expect(def?.schema.safeParse(defaultValue).success, key).toBe(true);
      expect(def?.schema.safeParse(0).success, key).toBe(false);
      expect(def?.schema.safeParse(10001).success, key).toBe(false);
      expect(def?.schema.safeParse(1).success, key).toBe(true);
      expect(def?.schema.safeParse(10000).success, key).toBe(true);
      expect(def?.schema.safeParse(2.5).success, key).toBe(false);
      expect(def?.help).toContain('per rolling hour per guild');
      expect(def?.help).toContain('never trip the breaker');
    }
  });

  it('registers the eight router and tier settings with spec defaults (ADR 0144, spec §4.7)', () => {
    expect(INSTANCE_SETTINGS.length).toBeGreaterThanOrEqual(26);
    const valueOf = (key: string): unknown => settingDefinition(key)?.defaultValue;
    expect(valueOf('assistant.routerEnabled')).toBe(1);
    expect(valueOf('assistant.routerMaxChars')).toBe(80);
    expect(valueOf('assistant.routerFullModelKeywords')).toEqual(DEFAULT_ROUTER_KEYWORDS);
    expect(valueOf('assistant.routerGreetingPatterns')).toEqual(DEFAULT_ROUTER_GREETINGS);
    expect(valueOf('assistant.routerLongThreadTurns')).toBe(4);
    expect(valueOf('assistant.routerEscalateOnTool')).toBe(1);
    expect(valueOf('assistant.routerSummaryTier')).toBe('light');
    expect(valueOf('assistant.routerDailyDigestTier')).toBe('light');
    expect(settingDefinition('assistant.routerEnabled')?.group).toBe('Assistant context');
    expect(settingDefinition('assistant.routerMaxChars')?.schema.safeParse(81).success).toBe(true);
    expect(settingDefinition('assistant.routerMaxChars')?.schema.safeParse(9).success).toBe(false);
    const keywords = settingDefinition('assistant.routerFullModelKeywords');
    expect(keywords?.schema.safeParse(['remind']).success).toBe(true);
    expect(keywords?.schema.safeParse([]).success).toBe(false);
    const tier = settingDefinition('assistant.routerSummaryTier');
    expect(tier?.schema.safeParse('light').success).toBe(true);
    expect(tier?.schema.safeParse('standard').success).toBe(true);
    expect(tier?.schema.safeParse('heavy').success).toBe(false);
    expect(isInstanceSettingKey('assistant.routerDailyDigestTier')).toBe(true);
  });

  it('validates router settings bounds and provides owner-facing registry metadata', () => {
    const counts = [
      ['assistant.routerEnabled', 0, 1],
      ['assistant.routerMaxChars', 10, 1000],
      ['assistant.routerLongThreadTurns', 0, 50],
      ['assistant.routerEscalateOnTool', 0, 1],
    ] as const;
    for (const [key, min, max] of counts) {
      const def = settingDefinition(key);
      expect(def?.bounds, key).toEqual({ min, max });
      expect(def?.schema.safeParse(min).success, key).toBe(true);
      expect(def?.schema.safeParse(max).success, key).toBe(true);
      for (const value of [min - 1, max + 1, min + 0.5, '1']) {
        expect(def?.schema.safeParse(value).success, key).toBe(false);
      }
    }
    for (const key of ['assistant.routerFullModelKeywords', 'assistant.routerGreetingPatterns']) {
      const def = settingDefinition(key);
      expect(def?.display, key).toBe('text');
      expect(def?.bounds, key).toEqual({ maxItems: 40 });
      expect(def?.schema.safeParse(['a'.repeat(40)]).success, key).toBe(true);
      expect(def?.schema.safeParse(Array.from({ length: 40 }, () => 'hi')).success, key).toBe(true);
      for (const value of [
        [],
        [''],
        ['a'.repeat(41)],
        Array.from({ length: 41 }, () => 'hi'),
        'hi',
      ]) {
        expect(def?.schema.safeParse(value).success, key).toBe(false);
      }
    }
    for (const key of ['assistant.routerSummaryTier', 'assistant.routerDailyDigestTier']) {
      const def = settingDefinition(key);
      expect(def?.display, key).toBe('text');
      expect(def?.schema.safeParse('light').success, key).toBe(true);
      expect(def?.schema.safeParse('standard').success, key).toBe(true);
      expect(def?.schema.safeParse('heavy').success, key).toBe(false);
    }
    for (const def of INSTANCE_SETTINGS.filter((entry) =>
      entry.key.startsWith('assistant.router'),
    )) {
      expect(def.group, def.key).toBe('Assistant context');
      expect(def.label.length, def.key).toBeGreaterThan(0);
      expect(def.help.length, def.key).toBeGreaterThan(0);
      expect(isInstanceSettingKey(def.key), def.key).toBe(true);
    }
  });
  it('registers the four digest settings with spec defaults (ADR 0150, spec §4.7)', () => {
    const valueOf = (key: string): unknown => settingDefinition(key)?.defaultValue;
    expect(valueOf('assistant.digestEnabled')).toBe(1);
    expect(valueOf('assistant.digestHour')).toBe(4);
    expect(valueOf('assistant.digestInputChars')).toBe(40_000);
    expect(valueOf('assistant.digestMaxProposals')).toBe(10);
    // The tier is Slice 6's key, not a digest key: the digest reads it through
    // backgroundTier('daily-digest').
    expect(valueOf('assistant.routerDailyDigestTier')).toBe('light');
    const enabled = settingDefinition('assistant.digestEnabled');
    expect(enabled?.group).toBe('Assistant context');
    expect(enabled?.display).toBe('count');
    expect(enabled?.schema.safeParse(0).success).toBe(true);
    expect(enabled?.schema.safeParse(1).success).toBe(true);
    expect(enabled?.schema.safeParse(2).success).toBe(false);
    const hour = settingDefinition('assistant.digestHour');
    expect(hour?.schema.safeParse(4).success).toBe(true);
    expect(hour?.schema.safeParse(24).success).toBe(false);
    expect(isInstanceSettingKey('assistant.digestEnabled')).toBe(true);
  });
});

it('attachment caps default to the D7 table and a count of 0 disables that kind', () => {
  expect(INSTANCE_SETTINGS).toHaveLength(41);
  const def = (key: string) => settingDefinition(key);
  expect(def('assistant.attachments.textMaxBytes')?.defaultValue).toBe(262_144);
  expect(def('assistant.attachments.textMaxChars')?.defaultValue).toBe(24_000);
  expect(def('assistant.attachments.textMaxCount')?.defaultValue).toBe(3);
  expect(def('assistant.attachments.imageMaxBytes')?.defaultValue).toBe(5_242_880);
  expect(def('assistant.attachments.imageMaxCount')?.defaultValue).toBe(4);
  expect(def('assistant.attachments.pdfMaxBytes')?.defaultValue).toBe(10_485_760);
  expect(def('assistant.attachments.pdfMaxCount')?.defaultValue).toBe(2);
  for (const key of [
    'assistant.attachments.textMaxBytes',
    'assistant.attachments.textMaxChars',
    'assistant.attachments.textMaxCount',
    'assistant.attachments.imageMaxBytes',
    'assistant.attachments.imageMaxCount',
    'assistant.attachments.pdfMaxBytes',
    'assistant.attachments.pdfMaxCount',
  ]) {
    expect(def(key)?.group).toBe('Assistant attachments');
    expect(def(key)?.schema.safeParse(def(key)?.defaultValue).success, key).toBe(true);
  }
  expect(def('assistant.attachments.textMaxCount')?.schema.safeParse(0).success).toBe(true);
  expect(def('assistant.attachments.imageMaxCount')?.schema.safeParse(11).success).toBe(false);
  expect(def('assistant.attachments.pdfMaxBytes')?.schema.safeParse(0).success).toBe(false);
});
