import { z } from 'zod';
import { truncateDetailString } from '../trace.js';
import type { AutomodRule, CompiledPredicate, Predicate } from './types.js';

/**
 * Both lists live in `mod_rules.config` rather than in tables (plan ruling
 * PR-16). ADR 0040 section 3 names the relational cases explicitly —
 * `invite`'s labelled allowlist and `link_domain`'s allow/deny lists — and
 * does not name this one: an extension list has no per-item metadata and no
 * per-item suppression target, which is what the relational shape exists for.
 * Config also reaches the rule fingerprint for free, where a relational list
 * has to be carried into it deliberately.
 *
 * Extensions are stored without a leading dot and matched case-insensitively.
 */
export const attachmentTypeConfig = z
  .object({
    blockedExtensions: z.array(z.string().min(1).max(20)).max(100).default([]),
    blockedContentTypes: z.array(z.string().min(1).max(255)).max(100).default([]),
  })
  .strict()
  .refine((value) => value.blockedExtensions.length > 0 || value.blockedContentTypes.length > 0, {
    // A rule with both lists empty compiles cleanly and can never match —
    // the ADR 0039 shape, and the same failure `no-terms` closes for
    // `keyword_filter` (registry.ts). Refused at validation instead, so
    // `doctor` reports it as an invalid config rather than a clean rule.
    message: 'an attachment_type rule needs at least one blocked extension or content type',
  });

export type AttachmentTypeConfig = z.infer<typeof attachmentTypeConfig>;

/** The final dot-separated segment, lower-cased. '' when there is no dot. */
const extensionOf = (fileName: string): string => {
  const dot = fileName.lastIndexOf('.');
  // `dot <= 0` also rejects a dotfile like '.env', whose name is not an
  // extension. Matching on the last segment rather than a substring is what
  // stops 'exeter-notes.pdf' matching a blocked 'exe'.
  return dot <= 0 ? '' : fileName.slice(dot + 1).toLowerCase();
};

/** 'application/pdf; charset=x' -> 'application/pdf'. Discord sends parameters. */
const bareContentType = (contentType: string | undefined): string =>
  (contentType ?? '').split(';')[0]?.trim().toLowerCase() ?? '';

/**
 * A redacted description of the file that matched — extension, declared
 * content type and size, never the name (IMPORTANT-4).
 *
 * This predicate matches on content type and extension, never on the
 * filename itself, so the filename was never the decision basis and does not
 * belong in the record of *why* the rule fired. That record —
 * `mod_case_events`, via `PredicateMatch.snippet` and `.trace.detail` — is a
 * moderation record `/forgetme` does not delete (`PRIVACY.md`), unlike the
 * fixture corpus, whose retention row and `/forgetme` reach OD-3's filenames
 * deliberately. Putting a filename here as well would be a widening the
 * owner was never asked about.
 */
const redactedDescription = (extension: string, contentType: string, sizeBytes: number): string =>
  `${extension === '' ? '(no extension)' : `*.${extension}`} ` +
  `(${contentType === '' ? 'unknown type' : contentType}, ${String(sizeBytes)} bytes)`;

/**
 * `attachment_type` — matches on the declared content type **and** the file
 * extension, since either alone is trivially spoofed by the uploader (spec
 * section 3, Slice 5). A hit on either list is enough; the two are belt and
 * braces, not a conjunction.
 *
 * **This task carries obligation 3 of the slices 3-5 handoff.** The
 * one-code-path gate (ADR 0041 section 3) is a *behavioural* comparison
 * between the dry-run evaluator and the live subscriber, so it can only see a
 * divergence in a field some shipped predicate actually reads.
 * `keyword_filter` reads only `content`; this is the first predicate to read
 * `PredicateInput.attachments`, so `dry-run.test.ts` now reaches that field
 * from both sides instead of only from the type system.
 */
export const attachmentTypePredicate: Predicate<AttachmentTypeConfig> = {
  kind: 'attachment_type',
  config: attachmentTypeConfig,
  compile(_rule: AutomodRule, config: AttachmentTypeConfig): CompiledPredicate {
    const extensions = new Set(
      config.blockedExtensions.map((e) => e.replace(/^\./, '').toLowerCase()),
    );
    const contentTypes = new Set(config.blockedContentTypes.map((t) => t.trim().toLowerCase()));

    return {
      evaluate(input) {
        // Either list is enough. The spec's reasoning: a content type is
        // declared by the uploader and an extension is chosen by the
        // uploader, so each alone is trivially spoofed and the pair is
        // checked rather than one being trusted.
        for (const attachment of input.attachments) {
          const extension = extensionOf(attachment.fileName);
          const contentType = bareContentType(attachment.contentType);
          const byExtension = extension !== '' && extensions.has(extension);
          const byContentType = contentType !== '' && contentTypes.has(contentType);
          if (!byExtension && !byContentType) continue;

          return {
            categoryId: 'attachment_type',
            // Redacted (IMPORTANT-4): the extension, declared content type
            // and size, never the filename itself — see
            // `redactedDescription`'s comment for why. The full filename
            // stays in the fixture corpus (`automod_fixtures` +
            // `automod_fixture_attachments`), which OD-3's retention row and
            // `/forgetme` already cover.
            snippet: redactedDescription(extension, contentType, attachment.sizeBytes),
            trace: {
              kind: 'attachment_type',
              matchedOn: byExtension ? extension : contentType,
              // A property of a file on the message, not a span of its text.
              span: undefined,
              normalisations: [],
              detail: {
                matchedOn: byExtension ? 'extension' : 'contentType',
                // Member-controlled and unbounded in principle — Discord's
                // declared content type is the uploader's own claim
                // (`discord/events.ts`) — truncated defensively at the
                // producer the same way `link-domain.ts`'s `host` is
                // (IMPORTANT-3), even though it is short in practice.
                declaredContentType: truncateDetailString(contentType),
                sizeBytes: attachment.sizeBytes,
                attachmentCount: input.attachments.length,
              },
            },
          };
        }
        return undefined;
      },
    };
  },
};
