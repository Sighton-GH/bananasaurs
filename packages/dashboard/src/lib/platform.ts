/** True on Apple platforms, where the shortcut hint reads ⌘ K instead of Ctrl K. */
export function isMac(nav: Pick<Navigator, 'platform' | 'userAgent'> = navigator): boolean {
  return /Mac|iPhone|iPad/.test(nav.platform || nav.userAgent);
}
