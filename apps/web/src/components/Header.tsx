'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { AnimatePresence, motion } from 'framer-motion';
import { GraduationCap, LogOut, Menu, User, X } from 'lucide-react';
import { setAuth } from '@/lib/api';
import { useAuth } from '@/lib/hooks';
import { useT } from '@/lib/i18n';
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
      { href: '/qa', label: 'QA' },
    ],
  };

  const navLinks = [{ href: '/', label: t('courses') }, ...(ready && user ? (roleLinks[user.role] ?? []) : [])];

  const logout = () => {
    setAuth(null);
    router.push('/');
  };

  return (
    <motion.nav
      className="fixed left-1/2 top-0 z-50 w-full max-w-6xl -translate-x-1/2 px-3 pt-4 sm:px-6"
      initial={{ y: -80, x: '-50%', opacity: 0 }}
      animate={{ y: 0, x: '-50%', opacity: 1 }}
      transition={{ duration: 0.7, ease: 'easeOut' }}
    >
      <div
        className={`flex w-full items-center justify-between transition-all duration-500 ${
          isScrolled ? 'glass rounded-2xl px-4 py-2.5 shadow-floating sm:px-6' : 'glass-secondary rounded-full px-5 py-3 shadow-glass sm:px-8'
        }`}
      >
        {/* Logo */}
        <Link href="/" className="group flex items-center gap-2.5">
          <motion.span
            whileHover={{ rotate: [0, -6, 6, 0] }}
            transition={{ duration: 0.5 }}
            className="gradient-bg-blue relative flex h-9 w-9 items-center justify-center overflow-hidden rounded-xl shadow-elevated"
          >
            <GraduationCap className="h-5 w-5 text-white" />
            <span className="gradient-ethiopia absolute bottom-0 left-0 h-[3px] w-full opacity-90" />
          </motion.span>
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
            const active = pathname === l.href;
            return (
              <Link
                key={l.href}
                href={l.href}
                className={`relative rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                  active ? 'text-brand-600' : 'text-gray-600 hover:bg-brand-500/5 hover:text-brand-600'
                }`}
              >
                {l.label}
                {active && (
                  <motion.span
                    layoutId="nav-underline"
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
              <motion.div whileHover={{ scale: 1.03 }} whileTap={{ scale: 0.97 }}>
                <Link href="/signup" className="btn">
                  {t('signup')}
                </Link>
              </motion.div>
            </>
          )}
          {ready && user && (
            <div className="flex items-center gap-1.5">
              <Link
                href="/account"
                title={t('account')}
                className="glass-secondary flex h-10 items-center gap-2 rounded-xl px-3 text-sm font-semibold text-gray-700 shadow-glass transition-colors hover:text-brand-600"
              >
                <span className="gradient-bg-blue flex h-6 w-6 items-center justify-center rounded-lg text-[11px] font-bold text-white">
                  {user.name.charAt(0).toUpperCase()}
                </span>
                <span className="max-w-[90px] truncate">{user.name.split(' ')[0]}</span>
              </Link>
              <button onClick={logout} title={t('logout')} aria-label={t('logout')} className="btn-ghost !px-2.5 hover:!text-red-500">
                <LogOut className="h-4 w-4" />
              </button>
            </div>
          )}
        </div>

        {/* Mobile: toggles + burger */}
        <div className="flex items-center gap-2 lg:hidden">
          {ready && user && <NotificationBell />}
          <button
            onClick={() => setMenuOpen((o) => !o)}
            aria-label="Menu"
            className="glass-secondary flex h-10 w-10 items-center justify-center rounded-xl text-brand-600 shadow-glass"
          >
            {menuOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </button>
        </div>
      </div>

      {/* Mobile menu */}
      <AnimatePresence>
        {menuOpen && (
          <motion.div
            initial={{ opacity: 0, height: 0, y: -8 }}
            animate={{ opacity: 1, height: 'auto', y: 0 }}
            exit={{ opacity: 0, height: 0, y: -8 }}
            transition={{ duration: 0.25 }}
            className="mt-3 overflow-hidden lg:hidden"
          >
            <div className="glass rounded-2xl px-4 py-4 shadow-floating">
              <div className="space-y-1">
                {navLinks.map((l) => (
                  <Link
                    key={l.href}
                    href={l.href}
                    className={`block rounded-xl px-3 py-2.5 text-sm font-medium transition-colors ${
                      pathname === l.href ? 'bg-brand-500/10 text-brand-600' : 'text-gray-600 hover:bg-brand-500/5 hover:text-brand-600'
                    }`}
                  >
                    {l.label}
                  </Link>
                ))}
                {ready && user && (
                  <Link href="/account" className="block rounded-xl px-3 py-2.5 text-sm font-medium text-gray-600 hover:bg-brand-500/5 hover:text-brand-600">
                    <span className="inline-flex items-center gap-2">
                      <User className="h-4 w-4" /> {user.name.split(' ')[0]} — {t('account')}
                    </span>
                  </Link>
                )}
              </div>
              <div className="mt-3 flex items-center justify-between gap-2 border-t pt-3" style={{ borderColor: 'var(--border)' }}>
                <div className="flex items-center gap-2">
                  <LanguageToggle />
                  <ThemeToggle />
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
                    <button onClick={logout} className="btn-ghost hover:!text-red-500">
                      <LogOut className="h-4 w-4" /> {t('logout')}
                    </button>
                  )
                )}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.nav>
  );
}
