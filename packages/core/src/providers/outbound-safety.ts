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

const regexDetector = (kind: SafetyFindingKind, name: string, pattern: RegExp): Detector => ({
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
/**
 * Card candidates must start in an issuer range (2 Mastercard, 3 Amex/Diners/
 * JCB, 4 Visa, 5 Mastercard, 6 Discover/UnionPay) and pass Luhn. About one
 * digit run in ten passes Luhn by chance; the issuer check is what keeps
 * binary out - a pair of 8-bit bytes ("01110111 00100000") is 16 digits that
 * can pass Luhn, but always starts with 0 or 1.
 */
const isCardNumber = (candidate: string): boolean => {
  const digits = candidate.replace(/[ -]/gu, '');
  // 17-19 digits with no separator is a Discord snowflake (17-20 digits, in
  // mentions like <@id> and in tool results), not a card: an older account's
  // 18-digit id can start with 2-6 and pass Luhn. Contiguous cards are 13-16.
  const maxDigits = digits.length === candidate.length ? 16 : 19;
  return (
    digits.length >= 13 && digits.length <= maxDigits && /^[2-6]/u.test(digits) && luhnValid(digits)
  );
};
const matchesCardNumber = (text: string): boolean => {
  CARD_CANDIDATE_PATTERN.lastIndex = 0;
  for (let match = CARD_CANDIDATE_PATTERN.exec(text); match !== null;) {
    if (isCardNumber(match[0])) return true;
    match = CARD_CANDIDATE_PATTERN.exec(text);
  }
  return false;
};

const DETECTORS: readonly Detector[] = [
  regexDetector('personal-data', 'email-address', /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu),
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
  regexDetector('secret', 'authorization-header', /\bauthorization\s*:\s*(?:bearer|basic)\s+\S+/iu),
  regexDetector('secret', 'private-key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/iu),
  regexDetector(
    'secret',
    'api-key-assignment',
    /\b(?:api[_ -]?key|token|password|secret)\s*[:=]\s*['"]?[A-Za-z0-9_./+=-]{12,}/iu,
  ),
  // Bare provider key shapes with no assignment around them (low, round 2):
  // a member pasting their OpenAI/Anthropic-style key must still refuse.
  regexDetector('secret', 'bare-api-key', /\b(?:sk|pk|gsk|xox[baprs])-[A-Za-z0-9_-]{16,}\b/iu),
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

/**
 * The MCP connector's withholding policy (ADR 0113): member text that trips a
 * secret or prompt-injection detector is not shown to the operator's model at
 * all. Personal-data detectors are deliberately excluded — the operator runs
 * the club and needs names, emails and phone numbers in its messages.
 */
export function detectWithheldEvidence(text: string): readonly string[] {
  const names: string[] = [];
  for (const detector of DETECTORS) {
    if (detector.kind === 'personal-data') continue;
    if (detector.matches(text) && !names.includes(detector.name)) names.push(detector.name);
  }
  return names;
}

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

const EVIDENCE_REDACTION = '[redacted by the evidence safety filter]';

/**
 * The evidence-appropriate policy (should-fix, round 2).
 *
 * Reviewed public resources are evidence, not member input: a club handbook
 * that prints a contact email made the whole request fail the member-PII
 * preflight, and the member got a generic refusal with no activity row. For
 * evidence the policy is redact-and-continue. Personal data and secrets are
 * replaced, never passed through; prompt-injection-looking phrases are
 * neutralised the same way (the untrusted-evidence envelope is the real
 * boundary, but the phrase itself does not need to reach the provider
 * verbatim). Member input never goes through here - it keeps the hard
 * refusal in `assertOutboundRequestSafe`.
 *
 * Returns the redacted text and the names of every detector that fired, so
 * the activity log can say what happened.
 */
export function redactEvidenceText(text: string): { text: string; detectors: readonly string[] } {
  const detectors = new Set<string>();
  let out = text;

  const redact = (name: string, pattern: RegExp, replacement = EVIDENCE_REDACTION): void => {
    pattern.lastIndex = 0;
    if (pattern.test(out)) {
      detectors.add(name);
      pattern.lastIndex = 0;
      out = out.replace(pattern, replacement);
    }
  };

  redact('email-address', /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu);
  redact('phone-number', new RegExp(PHONE_PATTERN.source, 'gu'));
  redact('ipv4-address', /\b(?:\d{1,3}\.){3}\d{1,3}\b/gu);
  redact('canadian-sin', /\b\d{3}[ -]?\d{3}[ -]?\d{3}\b/gu);

  // Card numbers keep their issuer and Luhn checks: candidates are replaced
  // one at a time, and only the ones that pass count as redactions.
  CARD_CANDIDATE_PATTERN.lastIndex = 0;
  out = out.replace(CARD_CANDIDATE_PATTERN, (candidate: string) => {
    if (isCardNumber(candidate)) {
      detectors.add('credit-card-number');
      return EVIDENCE_REDACTION;
    }
    return candidate;
  });

  redact('authorization-header', /\bauthorization\s*:\s*(?:bearer|basic)\s+\S+/giu);
  redact(
    'private-key',
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|$)/giu,
  );
  redact(
    'api-key-assignment',
    /\b(?:api[_ -]?key|token|password|secret)\s*[:=]\s*['"]?[A-Za-z0-9_./+=-]{12,}/giu,
  );
  // Bare provider key shapes (should-fix, low): sk-..., and the common
  // vendor prefixes, whether or not they follow an assignment.
  redact('bare-api-key', /\b(?:sk|pk|key|gsk|xox[baprs])-[A-Za-z0-9_-]{16,}\b/giu);

  redact(
    'instruction-override',
    /\b(?:ignore|disregard|override)\s+(?:all\s+)?(?:previous|prior|system|developer)\s+(?:instructions?|prompts?|messages?)/giu,
    '[instruction-like phrase removed by the evidence safety filter]',
  );
  redact(
    'authority-claim',
    /\b(?:system|developer)\s+message\s*:/giu,
    '[authority claim removed by the evidence safety filter]:',
  );
  redact(
    'secret-exfiltration',
    /\b(?:reveal|print|return|send|exfiltrate)\b.{0,60}\b(?:system prompt|api key|password|secret|private data)\b/giu,
    '[exfiltration-like phrase removed by the evidence safety filter]',
  );
  redact(
    'tool-coercion',
    /\b(?:call|use|invoke|run)\b.{0,40}\b(?:tool|function|command)\b.{0,40}\b(?:without|bypass|ignore)\b/giu,
    '[coercion-like phrase removed by the evidence safety filter]',
  );

  return { text: out, detectors: [...detectors] };
}
