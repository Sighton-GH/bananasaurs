import { expect, it } from 'vitest';
import { humanise } from './humanise.js';
it.each([
  ['requestTimeoutMs', 'Request timeout ms'],
  ['max_retry-count', 'Max retry count'],
  ['HTTPServerURL', 'Http server url'],
  ['', ''],
  ['simple', 'Simple'],
])('humanises %s', (key, label) => expect(humanise(key)).toBe(label));
