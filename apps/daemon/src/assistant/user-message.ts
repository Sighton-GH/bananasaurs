export interface UserMessageInput {
  readonly question: string;
  readonly askerName?: string | undefined;
  readonly evidenceEnvelope?: string | undefined;
  readonly quoteEnvelope?: string | undefined;
}

/** ADR 0085: evidence, then the quoted message, then the current message, then who to answer. */
export const buildUserMessage = (input: UserMessageInput): string => {
  const name = (input.askerName ?? '').replace(/\s+/g, ' ').trim() || 'the member';
  const question = input.question.replace(/\[\/CURRENT MESSAGE/gi, '[/current-message');
  const currentBlock = `[CURRENT MESSAGE from=${JSON.stringify(name)}]\n${question}\n[/CURRENT MESSAGE]`;
  const answerLine = `Answer ${name}'s current message.`;
  const parts: string[] = [];
  if (input.evidenceEnvelope !== undefined && input.evidenceEnvelope !== '')
    parts.push(input.evidenceEnvelope);
  if (input.quoteEnvelope !== undefined && input.quoteEnvelope !== '')
    parts.push(input.quoteEnvelope);
  parts.push(currentBlock);
  parts.push(answerLine);
  return parts.join('\n\n');
};
