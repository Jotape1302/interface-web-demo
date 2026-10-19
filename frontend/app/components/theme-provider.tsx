'use client';

import { createContext, useContext, useEffect, useState } from 'react';
import { Moon, Sun } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { resolveTheme, saveTheme, type Theme, THEME_STORAGE_KEY } from '@/lib/theme';

const ThemeContext = createContext<{ theme: Theme; toggle: () => void }>({ theme: 'dark', toggle: () => {} });

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setTheme] = useState<Theme>('dark');

  const apply = (value: Theme) => {
    setTheme(value);
    document.documentElement.classList.toggle('dark', value === 'dark');
    document.documentElement.dataset.theme = value;
    document.documentElement.style.colorScheme = value;
  };

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
      apply(resolveTheme(stored || document.documentElement.dataset.theme));
    } catch {
      apply(resolveTheme(document.documentElement.dataset.theme));
    }

    const storageListener = (event: StorageEvent) => {
      if (event.key === THEME_STORAGE_KEY) apply(resolveTheme(event.newValue));
    };
    window.addEventListener('storage', storageListener);
    return () => window.removeEventListener('storage', storageListener);
  }, []);

  const toggle = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    apply(next);
    try {
      saveTheme(next, window.localStorage);
    } catch {
      /* Storage access can itself be blocked. */
    }
  };

  return <ThemeContext.Provider value={{ theme, toggle }}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  return useContext(ThemeContext);
}

export function ThemeToggle() {
  const { theme, toggle } = useContext(ThemeContext);
  return (
    <Button
      variant="ghost"
      className="theme-toggle"
      onClick={toggle}
      aria-label={theme === 'dark' ? 'Ativar tema claro' : 'Ativar tema escuro'}
      title={theme === 'dark' ? 'Ativar tema claro' : 'Ativar tema escuro'}
    >
      {theme === 'dark' ? <Sun size={17} /> : <Moon size={17} />}
      <span>{theme === 'dark' ? 'Tema claro' : 'Tema escuro'}</span>
    </Button>
  );
}
