import type { InteractionRef, OutgoingMessage } from '../../discord/port.js';

export interface SlashResponder {
  defer(ref: InteractionRef, options: { ephemeral: boolean }): Promise<void>;
  respond(ref: InteractionRef, message: OutgoingMessage): Promise<void>;
}
