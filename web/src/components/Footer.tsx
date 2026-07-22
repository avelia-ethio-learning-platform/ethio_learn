'use client';

import Link from 'next/link';
import { motion } from 'framer-motion';
import { ArrowUp, BadgeCheck, GraduationCap, Heart, ShieldCheck, Wallet } from 'lucide-react';
import { useT } from '@/lib/i18n';

/** Site footer, adapted from the template's Footer to EthiopiaLearn's pages. */
export function Footer() {
  const { t } = useT();

  const columns = [
    {
      title: t('footer_learn'),
      links: [
        { label: t('footer_browse'), href: '/courses' },
        { label: t('footer_dashboard'), href: '/dashboard' },
        { label: t('certificates'), href: '/dashboard' },
        { label: t('footer_verify'), href: '/verify/example' },
      ],
    },
    {
      title: t('footer_teach_col'),
      links: [
        { label: t('footer_become'), href: '/signup?role=educator' },
        { label: t('teach'), href: '/teach' },
        { label: t('footer_institution'), href: '/institution' },
      ],
    },
    {
      title: t('footer_platform'),
      links: [
        { label: t('login'), href: '/login' },
        { label: t('signup'), href: '/signup' },
        { label: t('account'), href: '/account' },
      ],
    },
  ];

  const scrollTop = () => window.scrollTo({ top: 0, behavior: 'smooth' });

  return (
    <footer className="relative mt-24 overflow-hidden">
      {/* Ethiopian flag hairline */}
      <div className="gradient-ethiopia h-[3px] w-full opacity-80" />

      {/* Soft background glow */}
      <div className="pointer-events-none absolute inset-0 -z-10">
        <div className="absolute -left-32 bottom-0 h-72 w-72 rounded-full bg-brand-500/10 blur-3xl" />
        <div className="absolute -right-24 top-8 h-56 w-56 rounded-full bg-brand-400/10 blur-3xl" />
      </div>

      <div className="mx-auto w-full max-w-6xl px-4 pb-10 pt-14 sm:px-6">
        <div className="grid gap-10 md:grid-cols-[1.4fr_1fr_1fr_1fr]">
          {/* Brand */}
          <div>
            <Link href="/" className="flex items-center gap-2.5">
              <span className="gradient-bg-blue relative flex h-10 w-10 items-center justify-center overflow-hidden rounded-xl shadow-elevated">
                <GraduationCap className="h-5 w-5 text-white" />
                <span className="gradient-ethiopia absolute bottom-0 left-0 h-[3px] w-full opacity-90" />
              </span>
              <span className="text-xl font-extrabold tracking-tight">
                <span className="gradient-text-blue">Ethiopia</span>
                <span className="text-foreground">Learn</span>
              </span>
            </Link>
            <p className="mt-4 max-w-sm text-sm leading-relaxed text-gray-500">{t('footer_desc')}</p>
            <div className="mt-5 flex flex-wrap gap-2">
              <span className="badge-info">
                <Wallet className="h-3 w-3" /> Chapa
              </span>
              <span className="badge-success">
                <BadgeCheck className="h-3 w-3" /> {t('stat_verifiable')}
              </span>
              <span className="badge-info">
                <ShieldCheck className="h-3 w-3" /> {t('feature_5_title')}
              </span>
            </div>
          </div>

          {/* Link columns */}
          {columns.map((col) => (
            <div key={col.title}>
              <h4 className="text-sm font-semibold uppercase tracking-wider text-gray-500">{col.title}</h4>
              <ul className="mt-4 space-y-2.5">
                {col.links.map((l) => (
                  <li key={l.label}>
                    <Link
                      href={l.href}
                      className="group inline-flex items-center gap-1.5 text-sm text-gray-600 transition-colors hover:text-brand-600"
                    >
                      <span className="h-1 w-1 rounded-full bg-brand-400 opacity-0 transition-opacity group-hover:opacity-100" />
                      {l.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        {/* Bottom bar */}
        <div className="mt-12 flex flex-col items-center justify-between gap-4 border-t pt-6 sm:flex-row" style={{ borderColor: 'var(--border)' }}>
          <p className="flex items-center gap-1.5 text-xs text-gray-500">
            © {new Date().getFullYear()} EthiopiaLearn · {t('footer_rights')}
            <span className="hidden items-center gap-1 sm:inline-flex">
              · Made with <Heart className="h-3 w-3 fill-red-500 text-red-500" /> for Ethiopia 🇪🇹
            </span>
          </p>
          <div className="flex items-center gap-3">
            <p className="text-xs text-gray-500">{t('footer_payments')}</p>
            <motion.button
              whileHover={{ scale: 1.08, y: -2 }}
              whileTap={{ scale: 0.95 }}
              onClick={scrollTop}
              aria-label="Back to top"
              className="glass-secondary flex h-9 w-9 items-center justify-center rounded-xl text-brand-600 shadow-glass"
            >
              <ArrowUp className="h-4 w-4" />
            </motion.button>
          </div>
        </div>
      </div>
    </footer>
  );
}
