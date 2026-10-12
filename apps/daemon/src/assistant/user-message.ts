import { neutraliseMarkers, safeDisplayName } from '@bananasaurs/core';

export interface UserMessageInput {
  readonly question: string;
  readonly askerName?: string | undefined;
  readonly channelContext?: string | undefined;
  readonly evidenceEnvelope?: string | undefined;
  readonly quoteEnvelope?: string | undefined;
  readonly abilitiesNote?: boolean | undefined;
}

/** ADR 0089: channel context, then evidence, then the quoted message, then the current message, then who to answer. */
export const buildUserMessage = (input: UserMessageInput): string => {
  const name = safeDisplayName(input.askerName) ?? 'the member';
  const question = neutraliseMarkers(input.question);
  const currentBlock = `[CURRENT MESSAGE from=${JSON.stringify(name)}]\n${question}\n[/CURRENT MESSAGE]`;
  const answerLine = `Answer ${name}'s current message.`;
  const parts: string[] = [];
  if (input.channelContext !== undefined && input.channelContext !== '')
    parts.push(input.channelContext);
  if (input.evidenceEnvelope !== undefined && input.evidenceEnvelope !== '')
    parts.push(input.evidenceEnvelope);
  if (input.quoteEnvelope !== undefined && input.quoteEnvelope !== '')
    parts.push(input.quoteEnvelope);
  parts.push(currentBlock);
  parts.push('You can read an attachment only if its contents are included here.');
  if (input.abilitiesNote === true)
    parts.push(
      `Your abilities for ${name} are exactly what WHAT YOU CAN DO RIGHT NOW lists. An earlier reply here that says otherwise was to someone with different access, or is out of date.`,
    );
  parts.push(answerLine);
  return parts.join('\n\n');
};
