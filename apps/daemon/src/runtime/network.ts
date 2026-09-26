import net from 'node:net';
import { safeLogFields, type Logger } from '@bananasaurs/core';

/** Verified 2026-09-25 on Node v22.23.2: global fetch honours a runtime change for new connections. */
export const applyConnectFallback = (ms: number, logger: Pick<Logger, 'info'>): void => {
  net.setDefaultAutoSelectFamilyAttemptTimeout(ms);
  logger.info(
    safeLogFields({ component: 'config', settingKey: 'network.connectFallbackMs' }),
    `connect fallback wait set to ${ms} ms`,
  );
};
