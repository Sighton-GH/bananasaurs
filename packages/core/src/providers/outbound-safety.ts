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
  readonly pattern: RegExp;
}

const DETECTORS: readonly Detector[] = [
  {
    kind: 'personal-data',
    name: 'email-address',
    pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu,
  },
  { kind: 'personal-data', name: 'phone-number', pattern: /(?:\+?\d[\d .()-]{7,}\d)/u },
  { kind: 'personal-data', name: 'ipv4-address', pattern: /\b(?:\d{1,3}\.){3}\d{1,3}\b/u },
  { kind: 'personal-data', name: 'credit-card-number', pattern: /\b(?:\d[ -]*?){13,19}\b/u },
  { kind: 'personal-data', name: 'canadian-sin', pattern: /\b\d{3}[ -]?\d{3}[ -]?\d{3}\b/u },
  {
    kind: 'secret',
    name: 'authorization-header',
    pattern: /\bauthorization\s*:\s*(?:bearer|basic)\s+\S+/iu,
  },
  {
    kind: 'secret',
    name: 'private-key',
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/iu,
  },
  {
    kind: 'secret',
    name: 'api-key-assignment',
    pattern: /\b(?:api[_ -]?key|token|password|secret)\s*[:=]\s*['"]?[A-Za-z0-9_./+=-]{12,}/iu,
  },
  {
    kind: 'prompt-injection',
    name: 'instruction-override',
    pattern:
      /\b(?:ignore|disregard|override)\s+(?:all\s+)?(?:previous|prior|system|developer)\s+(?:instructions?|prompts?|messages?)/iu,
  },
  {
    kind: 'prompt-injection',
    name: 'authority-claim',
    pattern: /\b(?:system|developer)\s+message\s*:/iu,
  },
  {
    kind: 'prompt-injection',
    name: 'secret-exfiltration',
    pattern:
      /\b(?:reveal|print|return|send|exfiltrate)\b.{0,60}\b(?:system prompt|api key|password|secret|private data)\b/iu,
  },
  {
    kind: 'prompt-injection',
    name: 'tool-coercion',
    pattern:
      /\b(?:call|use|invoke|run)\b.{0,40}\b(?:tool|function|command)\b.{0,40}\b(?:without|bypass|ignore)\b/iu,
  },
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
      detector.pattern.lastIndex = 0;
      if (detector.pattern.test(text)) {
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
