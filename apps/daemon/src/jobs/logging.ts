import {
  attributeAndLogDeletion,
  JOB_KINDS,
  logMessageDeletePayload,
  type JobHandler,
  type LogMessageDeletePayload,
  type MessageDeleteAttributionPorts,
} from '@bananasaurs/core';

/**
 * Wiring only — the decision lives in `core`'s `attributeAndLogDeletion`
 * (ADR 0022 decision 3). The composition root is the only place allowed to
 * know both the domain and the database (`docs/19` §1).
 */
export const logMessageDeleteHandler = (
  ports: MessageDeleteAttributionPorts,
): JobHandler<LogMessageDeletePayload> => ({
  kind: JOB_KINDS.logMessageDelete,
  payload: logMessageDeletePayload,
  run: (payload) => attributeAndLogDeletion(ports, payload),
});
