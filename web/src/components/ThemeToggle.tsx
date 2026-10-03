'use client';

import { useId, useRef, useState } from 'react';
import { AnimatePresence, m } from 'framer-motion';
import { Check, Monitor, Moon, Sun } from 'lucide-react';
import { Theme, useTheme } from './ThemeProvider';
import { useT } from '@/lib/i18n';
import { useDismiss } from '@/lib/use-dismiss';

/**
 * Light / Dark / System selector, ported from the template's DarkModeToggle.
 * `placement="up"` opens the menu above the trigger, aligned to its left edge:
 * the mobile menu's bottom row needs it, because that panel clips anything
 * below it and the trigger sits near the screen's left edge.
 */
export function ThemeToggle({ placement = 'down' }: { placement?: 'down' | 'up' }) {
  const { theme, setTheme } = useTheme();
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  useDismiss({ open, onClose: () => setOpen(false), containerRef: ref, triggerRef });

  const themes: { value: Theme; label: string; icon: typeof Sun }[] = [
    { value: 'light', label: t('theme_light'), icon: Sun },
    { value: 'dark', label: t('theme_dark'), icon: Moon },
    { value: 'system', label: t('theme_system'), icon: Monitor },
  ];

  const current = themes.find((x) => x.value === theme) ?? themes[2];
  const CurrentIcon = current.icon;
  const up = placement === 'up';

  return (
    <div className="relative" ref={ref}>
      <button
        ref={triggerRef}
        onClick={() => setOpen((o) => !o)}
        aria-label="Theme"
        aria-expanded={open}
        aria-controls={panelId}
        className="glass-secondary flex h-10 w-10 items-center justify-center rounded-xl text-brand-600 shadow-glass transition hover:scale-105 hover:text-brand-700 active:scale-[.98]"
      >
        <span className="flex items-center justify-center">
          <CurrentIcon className="h-4 w-4" />
        </span>
      </button>

      <AnimatePresence>
        {open && (
          <m.div
            id={panelId}
            initial={{ opacity: 0, scale: 0.92, y: up ? 8 : -8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.92, y: up ? 8 : -8 }}
            transition={{ duration: 0.15 }}
            className={`absolute z-50 min-w-[150px] space-y-1 rounded-2xl p-2 shadow-floating ${up ? 'bottom-12 left-0' : 'right-0 top-12'}`}
            style={{ background: 'var(--popover)', border: '1px solid var(--card-border)', backdropFilter: 'blur(16px)' }}
          >
            {themes.map((option) => {
              const Icon = option.icon;
              const selected = theme === option.value;
              return (
                <button
                  key={option.value}
                  aria-pressed={selected}
                  onClick={() => {
                    setTheme(option.value);
                    setOpen(false);
                    triggerRef.current?.focus();
                  }}
                  className={`flex w-full items-center gap-3 rounded-xl px-3 py-2 text-sm font-medium transition-colors ${
                    selected ? 'bg-brand-500/10 text-brand-700' : 'text-gray-600 hover:bg-brand-500/5 hover:text-foreground'
                  }`}
                >
                  <Icon className="h-4 w-4" />
                  <span>{option.label}</span>
                  {selected && <Check className="ml-auto h-3.5 w-3.5" />}
                </button>
              );
            })}
          </m.div>
        )}
      </AnimatePresence>
    </div>
  );
}
