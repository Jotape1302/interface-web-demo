export type Theme = 'light' | 'dark';
export const THEME_STORAGE_KEY = 'norvia-theme';

export function resolveTheme(value: unknown): Theme {
  if (value === 'light') return 'light';
  if (value === 'dark') return 'dark';
  if (typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) {
    return 'light';
  }
  return 'dark';
}

export function readTheme(storage?: Pick<Storage, 'getItem'>): Theme {
  try {
    const item = storage?.getItem(THEME_STORAGE_KEY);
    if (item === 'light' || item === 'dark') return item;
    return resolveTheme(item);
  } catch {
    return 'dark';
  }
}

export function saveTheme(theme: Theme, storage?: Pick<Storage, 'setItem'>): void {
  try {
    storage?.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    /* Session state remains available through the provider. */
  }
}

export const themeInitScript = `(function(){var t='dark';try{var s=localStorage.getItem('norvia-theme');if(s==='light'||s==='dark'){t=s}else if(window.matchMedia&&window.matchMedia('(prefers-color-scheme: light)').matches){t='light'}}catch(e){}document.documentElement.classList.toggle('dark',t==='dark');document.documentElement.dataset.theme=t;document.documentElement.style.colorScheme=t})();`;
