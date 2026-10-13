import type { ComponentProps } from 'react';
import { PanelPreview } from '../../../ui/PanelPreview.js';
/** Same panel preview, in normal flow below 1024px. */
export function BuilderPreview(props: ComponentProps<typeof PanelPreview>) {
  return <PanelPreview {...props} />;
}
