import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { renderSummary } from '@bananasaurs/core';
import { assistantRepo, conversationRepo, traceRepo } from '@bananasaurs/storage';
import type { HttpDeps, RouteGuard } from '../server.js';
import { badRequest } from '../errors/reply.js';
import { dashboardAuditBase } from './audit-base.js';
import { requireCapability } from './capability.js';

/**
 * The Conversations endpoints (Task 19): the conversation list, one
 * transcript, end/delete, and the auto-delete retention setting.
 *
 * Reads go through `audit.read`; end, delete and the retention save go
 * through `config.write` and write audit rows that carry ids and counts
 * only — never a title, a turn's text, or a trace body.
 */

const conversationListQuerySchema = z.object({
  sort: z.enum(['last-activity', 'started', 'turns']).optional(),
  order: z.enum(['asc', 'desc']).optional(),
  channelId: z.string().min(1).max(64).optional(),
  userId: z.string().min(1).max(64).optional(),
  behaviourId: z.string().min(1).max(64).optional(),
  search: z.string().min(1).max(200).optional(),
  before: z.coerce.number().int().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

const retentionBodySchema = z.object({
  days: z.union([z.literal(61), z.literal(182), z.literal(365), z.null()]),
});

export const registerAssistantConversationRoutes = (
  app: FastifyInstance,
  guard: RouteGuard,
  deps: HttpDeps,
): void => {
  app.get('/api/assistant/conversations', async (request, reply) => {
    const session = guard.require(request, reply);
    if (session === undefined) return reply;
    if (!requireCapability(session, 'audit.read', reply)) return reply;

    const parsed = conversationListQuerySchema.safeParse(request.query);
    if (!parsed.success) return badRequest(reply, parsed.error);
    const sort = parsed.data.sort ?? 'last-activity';
    const order = parsed.data.order ?? 'desc';
    const limit = parsed.data.limit ?? 50;
    const conversations = conversationRepo.listConversations(session.scope, {
      sort,
      order,
      ...(parsed.data.channelId === undefined ? {} : { channelId: parsed.data.channelId }),
      ...(parsed.data.userId === undefined ? {} : { userId: parsed.data.userId }),
      ...(parsed.data.behaviourId === undefined ? {} : { behaviourId: parsed.data.behaviourId }),
      ...(parsed.data.search === undefined ? {} : { search: parsed.data.search }),
      ...(parsed.data.before === undefined ? {} : { before: parsed.data.before }),
      limit,
    });
    // Who each starter is, from live Discord in one bulk fetch per page; a
    // member Discord no longer knows comes back null and the table shows the
    // bare id rather than a guess — the same contract as the History list.
    const ports = deps.portsFor(session.scope);
    const directory = new Map(
      (await ports.fetchGuildMembers([...new Set(conversations.map((c) => c.startedBy))])).map(
        (m) => [m.memberId, m],
      ),
    );
    const oldest = conversations.at(-1);
    const cursorOf = (c: (typeof conversations)[number]): number =>
      sort === 'started' ? c.createdAt : sort === 'turns' ? c.turnCount : c.lastActivityAt;
    // Who takes part, as names in first-seen order — one query for the whole
    // page, never one per row.
    const people = conversationRepo.peopleForConversations(
      session.scope,
      conversations.map((c) => c.conversationId),
    );
    return reply.status(200).send({
      conversations: conversations.map((c) => {
        const member = directory.get(c.startedBy);
        return {
          ...c,
          people: people.get(c.conversationId) ?? [],
          member:
            member === undefined
              ? null
              : { username: member.username, displayName: member.displayName },
        };
      }),
      ...(conversations.length === limit && oldest !== undefined
        ? { nextBefore: cursorOf(oldest) }
        : {}),
    });
  });

  app.get<{ Params: { id: string } }>('/api/assistant/conversations/:id', (request, reply) => {
    const session = guard.require(request, reply);
    if (session === undefined) return reply;
    if (!requireCapability(session, 'audit.read', reply)) return reply;

    const conversation = conversationRepo.getConversation(session.scope, request.params.id);
    if (conversation === undefined) return reply.status(404).send({ error: 'not-found' });
    // The whole transcript, oldest first, in one read. The assistant turns'
    // sources come from one batched trace fetch per transcript, never one per
    // turn.
    const turns = conversationRepo.listTurns(session.scope, request.params.id);
    const traceIds = [
      ...new Set(
        turns.flatMap((turn) =>
          turn.role === 'assistant' && turn.traceId !== undefined ? [turn.traceId] : [],
        ),
      ),
    ];
    const traces = traceIds.length === 0 ? [] : traceRepo.getTracesByIds(session.scope, traceIds);
    const sourcesByTrace = new Map(traces.map((trace) => [trace.traceId, trace.sources]));
    const links = conversationRepo.listLinks(session.scope, request.params.id);
    const storedSummary = conversationRepo.getSummary(session.scope, request.params.id);
    return reply.status(200).send({
      conversation,
      summary:
        storedSummary === undefined
          ? null
          : {
              text: renderSummary(storedSummary.summary),
              version: storedSummary.version,
              updatedAt: storedSummary.updatedAt,
            },
      links,
      turns: turns.map((turn) => {
        if (turn.role !== 'assistant' || turn.traceId === undefined) return turn;
        // The sources line only: title and URL, never the trace body — the
        // full run stays behind the History detail endpoint and its grants.
        const sources = sourcesByTrace.get(turn.traceId) ?? [];
        return {
          ...turn,
          sources: sources.map((s) => ({ title: s.title, url: s.url })),
        };
      }),
    });
  });

  app.post<{ Params: { id: string } }>('/api/assistant/conversations/:id/end', (request, reply) => {
    const session = guard.require(request, reply);
    if (session === undefined) return reply;
    if (!requireCapability(session, 'config.write', reply)) return reply;

    const conversation = conversationRepo.getConversation(session.scope, request.params.id);
    if (conversation === undefined) return reply.status(404).send({ error: 'not-found' });
    conversationRepo.endConversation(session.scope, request.params.id);
    deps.portsFor(session.scope).recordAudit({
      ...dashboardAuditBase(session, deps.now()),
      action: 'assistant_conversation.ended',
      subjectType: 'assistant_conversation',
      subjectId: request.params.id,
      before: { status: conversation.status },
      after: { status: 'ended' },
    });
    return reply.status(200).send({ status: 'ended' });
  });

  app.delete<{ Params: { id: string } }>('/api/assistant/conversations/:id', (request, reply) => {
    const session = guard.require(request, reply);
    if (session === undefined) return reply;
    if (!requireCapability(session, 'config.write', reply)) return reply;

    const conversation = conversationRepo.getConversation(session.scope, request.params.id);
    if (conversation === undefined) return reply.status(404).send({ error: 'not-found' });
    conversationRepo.deleteConversation(session.scope, request.params.id);
    const traces = traceRepo.deleteTracesForConversations(session.scope, [request.params.id]);
    deps.portsFor(session.scope).recordAudit({
      ...dashboardAuditBase(session, deps.now()),
      action: 'assistant_conversation.deleted',
      subjectType: 'assistant_conversation',
      subjectId: request.params.id,
      before: undefined,
      after: { turns: conversation.turnCount, traces },
    });
    return reply.status(200).send({ deleted: true, traces });
  });

  app.get('/api/assistant/conversation-retention', (request, reply) => {
    const session = guard.require(request, reply);
    if (session === undefined) return reply;
    if (!requireCapability(session, 'audit.read', reply)) return reply;

    return reply.status(200).send({ days: assistantRepo.getConversationRetention(session.scope) });
  });

  app.put('/api/assistant/conversation-retention', (request, reply) => {
    const session = guard.require(request, reply);
    if (session === undefined) return reply;
    if (!requireCapability(session, 'config.write', reply)) return reply;

    const parsed = retentionBodySchema.safeParse(request.body);
    if (!parsed.success) return badRequest(reply, parsed.error);
    const before = assistantRepo.getConversationRetention(session.scope);
    assistantRepo.setConversationRetention(session.scope, parsed.data.days, deps.now());
    deps.portsFor(session.scope).recordAudit({
      ...dashboardAuditBase(session, deps.now()),
      action: 'assistant_settings.retention_set',
      subjectType: 'assistant_settings',
      subjectId: session.guildId,
      before: { days: before },
      after: { days: parsed.data.days },
    });
    return reply.status(200).send({ days: parsed.data.days });
  });
};
