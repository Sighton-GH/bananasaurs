/**
 * Raw Discord mention snowflakes carry no meaning to a provider and trip the
 * conservative outbound scan's long-digit detectors, so they are flattened to
 * readable tokens before anything leaves the process. Only the mention shape
 * is rewritten; bare numbers stay untouched.
 */
export const sanitizeMentionsForProvider = (text: string): string =>
  text
    .replace(/<@&\d{17,20}>/g, '@role')
    .replace(/<@!?\d{17,20}>/g, '@user')
    .replace(/<#\d{17,20}>/g, '#channel');
