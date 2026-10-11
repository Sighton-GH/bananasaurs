import { describe, expect, it } from 'vitest';
import { INSTANCE_SETTINGS, isInstanceSettingKey, settingDefinition } from './instance-settings.js';

describe('instance settings registry', () => {
  it('has 20 definitions and every default parses under its own schema', () => {
    expect(INSTANCE_SETTINGS).toHaveLength(20);
    for (const def of INSTANCE_SETTINGS) {
      expect(def.schema.safeParse(def.defaultValue).success, def.key).toBe(true);
    }
  });

  it('registers the Slice 2 reply-ping caps with their bounds (ADR 0145)', () => {
    expect(INSTANCE_SETTINGS).toHaveLength(20);
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
    expect(valueOf('assistant.maxOutputTokens')).toBe(2048);
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
});
