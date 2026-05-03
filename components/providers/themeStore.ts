// Backward-compat re-export. Prefer '@/components/providers/state' in new code.
export { useThemeStore, useAppStore } from './state';
export type { AppState as ThemeState } from './state';
