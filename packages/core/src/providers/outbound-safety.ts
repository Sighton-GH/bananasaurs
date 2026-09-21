import type { GenerateTextRequest } from './contracts.js';
import { ProviderError } from './errors.js';

export type SafetyFindingKind = 'personal-data' | 'secret' | 'prompt-injection';

export interface SafetyFinding {
  readonly kind: SafetyFindingKind;
  readonly detector: string;
  readonly location: string;
}

export interface OutboundSafetyResult {
  readonly safe: boolean;
  readonly findings: readonly SafetyFinding[];
}

interface Detector {
  readonly kind: SafetyFindingKind;
  readonly name: string;
  readonly matches: (text: string) => boolean;
}

const regexDetector = (
  kind: SafetyFindingKind,
  name: string,
  pattern: RegExp,
): Detector => ({
  kind,
  name,
  matches: (text) => {
    pattern.lastIndex = 0;
    return pattern.test(text);
  },
});

/**
 * URLs carry long digit runs (Discord channel/message snowflakes, dated
 * paths) that look like phone or card numbers to a naive pattern. Resource
 * URLs are legitimate system-instruction content, so the number-shaped
 * detectors scan text with URLs masked out; other detectors see the raw
 * text.
 */
const URL_PATTERN = /https?:\/\/\S+/giu;
const maskUrls = (text: string): string => text.replace(URL_PATTERN, ' ');

/**
 * Phone-shaped means grouped the way people write phone numbers: an NANP
 * grouping (3-3-4, optional +1/1 prefix, optional parenthesised area code)
 * or an explicitly international number with a leading +. Bare digit runs
 * (snowflakes), dates (4-2-2), and versions do not match.
 */
const PHONE_PATTERN =
  /(?:(?:\+?1[ .-]?)?(?:\(\d{3}\)\s?|\d{3}[ .-])\d{3}[ .-]\d{4}\b)|(?:\+\d[\d .()-]{6,}\d)/u;

const CARD_CANDIDATE_PATTERN = /\b(?:\d[ -]*?){13,19}\b/gu;
const luhnValid = (digits: string): boolean => {
  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let value = digits.charCodeAt(index) - 48;
    if (double) {
      value *= 2;
      if (value > 9) value -= 9;
    }
    sum += value;
    double = !double;
  }
  return digits.length > 0 && sum % 10 === 0;
};
/** Card candidates must also pass Luhn; arbitrary 13-19 digit runs do not. */
const matchesCardNumber = (text: string): boolean => {
  CARD_CANDIDATE_PATTERN.lastIndex = 0;
  for (let match = CARD_CANDIDATE_PATTERN.exec(text); match !== null; ) {
    const digits = match[0].replace(/[ -]/gu, '');
    if (digits.length >= 13 && digits.length <= 19 && luhnValid(digits)) return true;
    match = CARD_CANDIDATE_PATTERN.exec(text);
  }
  return false;
};

const DETECTORS: readonly Detector[] = [
  regexDetector(
    'personal-data',
    'email-address',
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu,
  ),
  {
    kind: 'personal-data',
    name: 'phone-number',
    matches: (text) => {
      PHONE_PATTERN.lastIndex = 0;
      return PHONE_PATTERN.test(maskUrls(text));
    },
  },
  regexDetector('personal-data', 'ipv4-address', /\b(?:\d{1,3}\.){3}\d{1,3}\b/u),
  {
    kind: 'personal-data',
    name: 'credit-card-number',
    matches: (text) => matchesCardNumber(maskUrls(text)),
  },
  regexDetector('personal-data', 'canadian-sin', /\b\d{3}[ -]?\d{3}[ -]?\d{3}\b/u),
  regexDetector(
    'secret',
    'authorization-header',
    /\bauthorization\s*:\s*(?:bearer|basic)\s+\S+/iu,
  ),
  regexDetector(
    'secret',
    'private-key',
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/iu,
  ),
  regexDetector(
    'secret',
    'api-key-assignment',
    /\b(?:api[_ -]?key|token|password|secret)\s*[:=]\s*['"]?[A-Za-z0-9_./+=-]{12,}/iu,
  ),
  regexDetector(
    'prompt-injection',
    'instruction-override',
    /\b(?:ignore|disregard|override)\s+(?:all\s+)?(?:previous|prior|system|developer)\s+(?:instructions?|prompts?|messages?)/iu,
  ),
  regexDetector('prompt-injection', 'authority-claim', /\b(?:system|developer)\s+message\s*:/iu),
  regexDetector(
    'prompt-injection',
    'secret-exfiltration',
    /\b(?:reveal|print|return|send|exfiltrate)\b.{0,60}\b(?:system prompt|api key|password|secret|private data)\b/iu,
  ),
  regexDetector(
    'prompt-injection',
    'tool-coercion',
    /\b(?:call|use|invoke|run)\b.{0,40}\b(?:tool|function|command)\b.{0,40}\b(?:without|bypass|ignore)\b/iu,
  ),
];

const requestSections = (request: GenerateTextRequest): readonly (readonly [string, string])[] => [
  ...(request.systemInstruction
    ? [['system-instruction', request.systemInstruction] as const]
    : []),
  ...request.messages.map(
    (message, index) => [`message-${index}-${message.role}`, message.text] as const,
  ),
];

/**
 * Conservative local preflight. It detects known patterns; it cannot prove text
 * contains no personal data or adversarial instructions. No text leaves the
 * process when a finding is returned.
 */
export function scanOutboundRequest(request: GenerateTextRequest): OutboundSafetyResult {
  const findings: SafetyFinding[] = [];
  for (const [location, text] of requestSections(request)) {
    for (const detector of DETECTORS) {
      if (detector.matches(text)) {
        findings.push({ kind: detector.kind, detector: detector.name, location });
      }
    }
  }
  return { safe: findings.length === 0, findings };
}

export function assertOutboundRequestSafe(request: GenerateTextRequest): void {
  const result = scanOutboundRequest(request);
  if (!result.safe) {
    const kinds = [...new Set(result.findings.map((finding) => finding.kind))].join(', ');
    throw new ProviderError(
      'safety-refusal',
      `request refused by local pre-API scan (${kinds}); no content was sent`,
      false,
    );
  }
}
