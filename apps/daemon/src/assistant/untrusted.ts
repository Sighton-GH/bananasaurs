/**
 * Re-export of the shared core neutralisers (slice 1 final fix, step 1).
 * Existing `./untrusted.js` imports keep working unchanged.
 */
export { escapeUntrustedClose, neutraliseMarkers } from '@bananasaurs/core';
