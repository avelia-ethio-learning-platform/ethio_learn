'use client';

import { useEffect, useId, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { AnimatePresence, m } from 'framer-motion';
import { GraduationCap, LogOut, Menu, User, X } from 'lucide-react';
import { api, signOut } from '@/lib/api';
import { useAuth } from '@/lib/hooks';
import { useT } from '@/lib/i18n';
import { useDismiss } from '@/lib/use-dismiss';
import { dur, ease, RISE } from '@/lib/motion';
import { NotificationBell } from './NotificationBell';
import { ThemeToggle } from './ThemeToggle';
import { LanguageToggle } from './LanguageToggle';

/**
 * Floating glass navigation bar, ported from the template's Header
 * (pill → panel on scroll) and wired to the platform's auth + roles.
 */
export function Header() {
  const { user, ready } = useAuth();
  const { t } = useT();
  const router = useRouter();
  const pathname = usePathname();
  const [isScrolled, setIsScrolled] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const burgerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  // Escape and an outside press close the menu. It hosts the theme menu, so
  // that one opening must not close it (closeOnOtherOpen off); the bell sits
  // outside the panel, and pressing it closes the menu as an outside press.
  useDismiss({ open: menuOpen, onClose: () => setMenuOpen(false), containerRef: panelRef, triggerRef: burgerRef, closeOnOtherOpen: false });

  // The backdrop makes the open menu modal: focus moves in, and Tab wraps
  // between the burger and the panel's controls.
  useEffect(() => {
    if (!menuOpen) return;
    const panel = panelRef.current;
    const focusables = () => [
      ...(burgerRef.current ? [burgerRef.current] : []),
      ...Array.from(panel?.querySelectorAll<HTMLElement>('a[href], button:not([disabled])') ?? []),
    ];
    panel?.querySelector<HTMLElement>('a[href]')?.focus();
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const items = focusables();
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [menuOpen]);

  useEffect(() => {
    const onScroll = () => setIsScrolled(window.scrollY > 20);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  // Close the mobile menu on navigation.
  useEffect(() => setMenuOpen(false), [pathname]);

  const roleLinks: Record<string, { href: string; label: string }[]> = {
    learner: [{ href: '/dashboard', label: t('my_learning') }],
    educator: [{ href: '/teach', label: t('teach') }],
    institution_admin: [
      { href: '/institution', label: t('institution') },
      { href: '/institution/review', label: t('review_queue') },
    ],
    quality_officer: [{ href: '/qa', label: t('review_queue') }],
    platform_admin: [
      { href: '/admin', label: t('admin') },
      { href: '/qa', label: t('quality_review') },
    ],
  };

  const navLinks = [
    { href: '/', label: t('home') },
    { href: '/courses', label: t('courses') },
    ...(ready && user ? (roleLinks[user.role] ?? []) : []),
  ];

  // Help and Educators live in the footer on desktop; the mobile menu carries them too.
  const mobileLinks = [...navLinks, { href: '/educators', label: t('educators') }, { href: '/help', label: t('help') }];

  const isActive = (href: string) => (href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`));

  const logout = async () => {
    // Revokes the refresh token server-side too: without that call the session
    // stayed valid in Redis for up to 7 days.
    await signOut();
    router.push('/');
  };

  return (
    <>
      {/* Dimmed backdrop under the open mobile menu; a tap closes it. Outside the nav,
          whose transform would otherwise contain a fixed child. */}
      <AnimatePresence>
        {menuOpen && (
          <m.div
            key="menu-backdrop"
            aria-hidden
            data-testid="menu-backdrop"
            onClick={() => setMenuOpen(false)}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: dur.base, ease: ease.quart }}
            className="fixed inset-0 z-40 bg-black/40 lg:hidden"
          />
        )}
      </AnimatePresence>
      <nav aria-label="Main" className="fixed left-1/2 top-0 z-50 w-full max-w-6xl -translate-x-1/2 px-3 pt-4 sm:px-6">
        <div
          className={`flex w-full items-center justify-between transition-[background-color,border-color,box-shadow,border-radius] duration-slow ease-out-quart ${
            isScrolled ? 'glass rounded-2xl px-4 py-2.5 shadow-floating sm:px-6' : 'glass-secondary rounded-full px-4 py-3 shadow-glass sm:px-8'
          }`}
        >
          {/* Logo */}
          <Link href="/" className="group flex items-center gap-2.5">
            <span className="gradient-bg-blue relative flex h-9 w-9 items-center justify-center overflow-hidden rounded-xl shadow-elevated">
              <GraduationCap className="h-5 w-5 text-white" />
              <span className="gradient-ethiopia absolute bottom-0 left-0 h-[3px] w-full opacity-90" />
            </span>
            <span className="flex flex-col leading-none">
              <span className="text-lg font-extrabold tracking-tight">
                <span className="gradient-text-blue">Ethiopia</span>
                <span className="text-foreground">Learn</span>
              </span>
            </span>
          </Link>

          {/* Desktop nav */}
          <div className="hidden items-center gap-1 lg:flex">
            {navLinks.map((l) => {
              const active = isActive(l.href);
              return (
                <Link
                  key={l.href}
                  href={l.href}
                  className={`relative rounded-lg px-3 py-2 text-sm font-medium transition-colors duration-fast ${
                    active ? 'text-brand-600' : 'text-gray-600 hover:bg-brand-500/5 hover:text-brand-600'
                  }`}
                >
                  {l.label}
                  {active && (
                    <m.span
                      layoutId="nav-underline"
                      transition={{ duration: dur.base, ease: ease.quart }}
                      className="gradient-bg-blue absolute inset-x-3 -bottom-0.5 h-0.5 rounded-full"
                    />
                  )}
                </Link>
              );
            })}
          </div>

          {/* Desktop actions */}
          <div className="hidden items-center gap-2 lg:flex">
            <LanguageToggle />
            <ThemeToggle />
            {ready && user && <NotificationBell />}
            {ready && !user && (
              <>
                <Link href="/login" className="btn-ghost">
                  {t('login')}
                </Link>
                <Link href="/signup" className="btn">
                  {t('signup')}
                </Link>
              </>
            )}
            {ready && user && (
              <div className="flex items-center gap-1.5">
                <Link
                  href="/account"
                  title={t('account')}
                  className="glass-secondary flex h-10 items-center gap-2 rounded-xl px-3 text-sm font-semibold text-gray-700 shadow-glass transition-colors duration-fast hover:text-brand-600"
                >
                  <span className="brand-fill flex h-6 w-6 items-center justify-center rounded-lg text-xs font-bold">
                    {user.name.charAt(0).toUpperCase()}
                  </span>
                  <span className="max-w-[90px] truncate">{user.name.split(' ')[0]}</span>
                </Link>
                <button onClick={logout} title={t('logout')} aria-label={t('logout')} className="btn-ghost !px-2.5 hover:!text-danger">
                  <LogOut className="h-4 w-4" />
                </button>
              </div>
            )}
          </div>

          {/* Mobile: toggles + burger */}
          <div className="flex items-center gap-2 lg:hidden">
            {ready && user && <NotificationBell />}
            <button
              ref={burgerRef}
              onClick={() => setMenuOpen((o) => !o)}
              aria-label={t('menu')}
              aria-expanded={menuOpen}
              aria-controls={menuId}
              className="glass-secondary flex h-11 w-11 items-center justify-center rounded-xl text-brand-600 shadow-glass transition duration-fast active:scale-[.98]"
            >
              {menuOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
            </button>
          </div>
        </div>

        {/* Mobile menu: the panel is at its full height from the start and only fades and drops in
            (animating `height: auto` relaid out the page on every frame). */}
        <AnimatePresence>
          {menuOpen && (
            <m.div
              id={menuId}
              initial={{ opacity: 0, y: -RISE }}
              animate={{ opacity: 1, y: 0, transition: { duration: dur.base, ease: ease.expo } }}
              exit={{ opacity: 0, y: -RISE, transition: { duration: dur.fast, ease: ease.quart } }}
              className="mt-3 lg:hidden"
            >
              <div
                ref={panelRef}
                data-testid="mobile-menu-panel"
                className="rounded-2xl bg-background px-4 py-4 shadow-floating"
                style={{ border: '1px solid var(--border)' }}
              >
                <div className="space-y-1">
                  {mobileLinks.map((l) => (
                    <Link
                      key={l.href}
                      href={l.href}
                      className={`block rounded-xl px-3 py-2.5 text-sm font-medium transition-colors duration-fast ${
                        isActive(l.href) ? 'bg-brand-500/10 text-brand-600' : 'text-gray-600 hover:bg-brand-500/5 hover:text-brand-600'
                      }`}
                    >
                      {l.label}
                    </Link>
                  ))}
                  {ready && user && (
                    <Link href="/account" className="block rounded-xl px-3 py-2.5 text-sm font-medium text-gray-600 transition-colors duration-fast hover:bg-brand-500/5 hover:text-brand-600">
                      <span className="inline-flex items-center gap-2">
                        <User className="h-4 w-4" /> {user.name.split(' ')[0]} — {t('account')}
                      </span>
                    </Link>
                  )}
                </div>
                <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t pt-3" style={{ borderColor: 'var(--border)' }}>
                  <div className="flex items-center gap-2">
                    <LanguageToggle />
                    <ThemeToggle placement="up" />
                  </div>
                  {ready && !user ? (
                    <div className="flex items-center gap-2">
                      <Link href="/login" className="btn-ghost">
                        {t('login')}
                      </Link>
                      <Link href="/signup" className="btn">
                        {t('signup')}
                      </Link>
                    </div>
                  ) : (
                    ready && (
                      <button onClick={logout} className="btn-ghost hover:!text-danger">
                        <LogOut className="h-4 w-4" /> {t('logout')}
                      </button>
                    )
                  )}
                </div>
              </div>
            </m.div>
          )}
        </AnimatePresence>
      </nav>
    </>
  );
}
