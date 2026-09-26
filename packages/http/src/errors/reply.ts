import type { FastifyReply } from 'fastify';
import type { ZodError } from 'zod';

/**
 * One validation problem: the field path plus the Zod issue code only.
 *
 * Never a message and never a value — a value can be a key the owner just
 * pasted (ADR 0078).
 */
export interface FieldProblem {
  readonly path: string;
  readonly problem: string;
}

/** `issue.path.join('.')` and `issue.code` only. The first 20 issues. */
export const fieldsOf = (error: ZodError): FieldProblem[] =>
  error.issues
    .slice(0, 20)
    .map((issue) => ({ path: issue.path.join('.'), problem: issue.code }));

/** A 400 that carries the code plus `fields`, so the page can highlight. */
export const badRequest = (
  reply: FastifyReply,
  error?: ZodError,
  code?: string,
): FastifyReply =>
  reply
    .status(400)
    .send({ error: code ?? 'bad-request', ...(error === undefined ? {} : { fields: fieldsOf(error) }) });
