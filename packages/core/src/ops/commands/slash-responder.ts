import type { InteractionRef, OutgoingMessage } from '../../discord/port.js';
import type { Modal } from '../../ui/discord/kit.js';

export interface SlashResponder {
  defer(ref: InteractionRef, options: { ephemeral: boolean }): Promise<void>;
  respond(ref: InteractionRef, message: OutgoingMessage): Promise<void>;
  /** Callback type 6: acknowledge a button without a visible reply. */
  deferUpdate(ref: InteractionRef): Promise<void>;
  /** Callback type 9: the first and only response. */
  showModal(ref: InteractionRef, modal: Modal): Promise<void>;
}
