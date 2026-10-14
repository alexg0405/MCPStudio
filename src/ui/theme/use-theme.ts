import { useSyncExternalStore } from 'react';
import { onThemeChange, themeVersion } from '../timeline/canvas';

/** Re-renders when the theme or accent color changes; put it in a drawing effect's dependencies. */
export function useThemeVersion(): number {
  return useSyncExternalStore(onThemeChange, themeVersion);
}
