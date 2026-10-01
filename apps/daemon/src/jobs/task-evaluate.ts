import {
  buildTaskEvaluationInput,
  guardAnswer,
  parseTaskEvaluation,
  ProviderError,
  redactEvidenceText,
  TASK_EVALUATION_INSTRUCTION,
  type GenerateTextRequest,
} from '@bananasaurs/core';
import type { ChainEntry } from '../assistant/model-chain.js';

/** What the evaluate worker needs: one verdict per recorded update. */
export type TaskUpdateEvaluator = (req: {
  guildId: string;
  title: string;
  description: string;
  update: string;
}) => Promise<
  | { ok: true; clear: true }
  | { ok: true; clear: false; question: string }
  | { ok: false; reason: string }
>;

/**
 * The model half of ADR 0112 decision 2: each recorded update goes to the
 * first usable entry of the assistant model chain with the fixed evaluation
 * instruction.
 *
 * Recording stays deterministic — this never decides whether an update is
 * kept. A failed or unreachable model posts nothing: every skip returns
 * `{ ok: false }` and the update stays recorded. Mirrors the summary job's
 * one-shot pattern (`runtime/guild.ts` `summariseModel`).
 */
export const createTaskUpdateEvaluator = (deps: {
  chain: () => readonly ChainEntry[];
  reserve: (entry: ChainEntry, guildId: string) => { ok: boolean };
  now: () => number;
}): TaskUpdateEvaluator => {
  return async (req) => {
    const entries = deps.chain();
    const modelIds = entries.map((candidate) => candidate.model);
    for (const candidate of entries) {
      if (candidate.provider === undefined || candidate.skip !== undefined) continue;
      if (!deps.reserve(candidate, req.guildId).ok) continue;
      let text: string;
      try {
        const request: GenerateTextRequest = {
          model: candidate.model,
          systemInstruction: TASK_EVALUATION_INSTRUCTION,
          messages: [
            {
              role: 'user',
              text: buildTaskEvaluationInput({
                title: req.title,
                description: req.description,
                update: req.update,
              }),
            },
          ],
          maxOutputTokens: 300,
          temperature: 0,
        };
        const response = await candidate.provider.generateText(request);
        text = response.text;
      } catch (err) {
        // One entry's failure is the next entry's turn, never a post.
        if (err instanceof ProviderError) continue;
        return { ok: false, reason: 'error' };
      }
      const parsed = parseTaskEvaluation(text);
      if (parsed === undefined) return { ok: false, reason: 'invalid-json' };
      if (parsed.clear) return { ok: true, clear: true };
      const guarded = guardAnswer({
        text: parsed.question,
        protectedText: TASK_EVALUATION_INSTRUCTION,
        modelIds,
      });
      if (!guarded.ok) return { ok: false, reason: 'guard' };
      return { ok: true, clear: false, question: redactEvidenceText(guarded.text).text };
    }
    return { ok: false, reason: 'no-model' };
  };
};
