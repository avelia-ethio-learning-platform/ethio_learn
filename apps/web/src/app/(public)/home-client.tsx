'use client';

import Link from 'next/link';
import { motion, type Variants } from 'framer-motion';
import {
  ArrowRight,
  BadgeCheck,
  BookOpen,
  CreditCard,
  GraduationCap,
  HandCoins,
  Languages,
  MonitorPlay,
  Rocket,
  Search,
  ShieldCheck,
  Sparkles,
  Star,
  Wallet,
  Zap,
} from 'lucide-react';
import { CourseCard, CourseSummary } from '@/components/CourseCard';
import { useT } from '@/lib/i18n';

const CATEGORIES = ['tech', 'business', 'freelancing', 'healthcare', 'other'] as const;

const fadeUp: Variants = {
  hidden: { opacity: 0, y: 30 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.6, ease: [0.16, 1, 0.3, 1] } },
};

const stagger: Variants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: { staggerChildren: 0.12 } },
};

export function HomeClient({ courses, total }: { courses: CourseSummary[]; total: number }) {
  const { t } = useT();

  const stats = [
    { value: '18+', label: t('stat_payments'), icon: Wallet, gradient: 'from-blue-500 to-blue-600' },
    { value: '100%', label: t('stat_verifiable'), icon: BadgeCheck, gradient: 'from-blue-600 to-blue-700' },
    { value: '80%', label: t('stat_share'), icon: HandCoins, gradient: 'from-blue-400 to-blue-500' },
  ];

  const features = [
    { icon: Wallet, title: t('feature_1_title'), desc: t('feature_1_desc') },
    { icon: BadgeCheck, title: t('feature_2_title'), desc: t('feature_2_desc') },
    { icon: MonitorPlay, title: t('feature_3_title'), desc: t('feature_3_desc') },
    { icon: HandCoins, title: t('feature_4_title'), desc: t('feature_4_desc') },
    { icon: ShieldCheck, title: t('feature_5_title'), desc: t('feature_5_desc') },
    { icon: Languages, title: t('feature_6_title'), desc: t('feature_6_desc') },
  ];

  const steps = [
    { icon: Search, title: t('step_1_title'), desc: t('step_1_desc'), time: t('step_1_time') },
    { icon: CreditCard, title: t('step_2_title'), desc: t('step_2_desc'), time: t('step_2_time') },
    { icon: GraduationCap, title: t('step_3_title'), desc: t('step_3_desc'), time: t('step_3_time') },
  ];

  return (
    <div className="overflow-hidden">
      {/* ================= HERO (contained gradient panel, mirrors the floating nav width) ================= */}
      <section className="relative px-3 pb-16 pt-24 sm:px-6 md:pt-28">
        {/* Soft section backdrop behind the panel */}
        <div className="absolute inset-0 -z-10">
          <div className="absolute inset-0 bg-gradient-to-b from-brand-50/60 via-background to-background transition-colors duration-300 dark:from-blue-950/30" />
          <div className="absolute -left-32 -top-24 h-72 w-72 rounded-full bg-blue-400/15 blur-3xl dark:bg-blue-500/10" />
          <div className="absolute -right-24 top-40 h-64 w-64 rounded-full bg-blue-600/10 blur-3xl dark:bg-blue-700/10" />
        </div>
        <div className="mx-auto w-full max-w-6xl">
          <motion.div
            initial={{ opacity: 0, y: 28, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
            className="relative overflow-hidden rounded-[2rem] shadow-floating sm:rounded-[2.5rem]"
          >
            {/* Smooth gradient backdrop */}
            <div className="absolute inset-0 bg-gradient-to-br from-blue-700 via-blue-600 to-indigo-700 dark:from-blue-950 dark:via-blue-900 dark:to-indigo-950" />
            <motion.div
              className="absolute -left-24 -top-24 h-80 w-80 rounded-full bg-white/10 blur-3xl"
              animate={{ scale: [1, 1.15, 1] }}
              transition={{ duration: 9, repeat: Infinity, ease: 'easeInOut' }}
            />
            <motion.div
              className="absolute -bottom-32 left-1/3 h-96 w-96 rounded-full bg-sky-400/20 blur-3xl"
              animate={{ scale: [1, 1.2, 1] }}
              transition={{ duration: 11, repeat: Infinity, ease: 'easeInOut', delay: 1.5 }}
            />
            <div
              className="absolute inset-0 opacity-[0.05]"
              style={{
                backgroundImage:
                  'linear-gradient(rgba(255,255,255,.8) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.8) 1px, transparent 1px)',
                backgroundSize: '64px 64px',
              }}
            />
            {/* Ethiopian flag accent */}
            <span className="gradient-ethiopia absolute inset-x-0 bottom-0 z-10 h-1 opacity-80" />

            <div className="relative z-10 grid items-center gap-10 p-6 py-12 sm:p-10 lg:grid-cols-[1.08fr_0.92fr] lg:gap-12 lg:p-14">
              {/* Left: copy + actions */}
              <div className="text-center lg:text-left">
                <motion.div
                  className="inline-flex items-center gap-2.5 rounded-full border border-white/20 bg-white/10 px-4 py-2 backdrop-blur-sm"
                  initial={{ opacity: 0, scale: 0.85 }}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={{ duration: 0.6, delay: 0.25 }}
                >
                  <span className="flex items-center gap-0.5">
                    {[...Array(5)].map((_, i) => (
                      <motion.span key={i} initial={{ opacity: 0, scale: 0 }} animate={{ opacity: 1, scale: 1 }} transition={{ delay: 0.4 + i * 0.08 }}>
                        <Star className="h-3.5 w-3.5 fill-amber-300 text-amber-300" />
                      </motion.span>
                    ))}
                  </span>
                  <span className="text-xs font-semibold text-white sm:text-sm">{t('hero_badge')}</span>
                </motion.div>

                <motion.h1
                  className="mt-6 text-balance text-4xl font-extrabold leading-[1.08] tracking-tight text-white sm:text-5xl lg:text-6xl"
                  initial={{ opacity: 0, y: 26 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.7, delay: 0.4 }}
                >
                  {t('hero_title_1')}{' '}
                  <span className="block bg-gradient-to-r from-sky-200 via-blue-100 to-white bg-clip-text text-transparent">
                    {t('hero_title_2')}
                  </span>
                </motion.h1>

                <motion.p
                  className="mx-auto mt-5 max-w-xl text-balance text-sm font-light leading-relaxed text-blue-100 sm:text-base lg:mx-0"
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.7, delay: 0.55 }}
                >
                  {t('hero_sub')}
                </motion.p>

                {/* Search */}
                <motion.form
                  action="/courses"
                  className="mx-auto mt-7 flex w-full max-w-md items-center gap-2 rounded-2xl border border-white/20 bg-white/10 p-2 backdrop-blur-md lg:mx-0"
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.7, delay: 0.7 }}
                >
                  <Search className="ml-2 h-5 w-5 shrink-0 text-blue-100" />
                  <input
                    name="q"
                    placeholder={t('search_placeholder')}
                    className="w-full bg-transparent text-sm text-white outline-none placeholder:text-blue-200/80"
                  />
                  <button className="shrink-0 rounded-xl bg-white px-4 py-2.5 text-sm font-bold text-blue-700 transition-colors hover:bg-blue-50">
                    {t('search')}
                  </button>
                </motion.form>

                {/* CTAs */}
                <motion.div
                  className="mt-7 flex flex-col items-center justify-center gap-3 sm:flex-row lg:justify-start"
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.7, delay: 0.85 }}
                >
                  <motion.div whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }}>
                    <Link
                      href="/courses"
                      className="inline-flex items-center gap-2 rounded-2xl bg-white px-7 py-3.5 text-base font-bold text-blue-700 shadow-floating transition-colors hover:bg-blue-50"
                    >
                      {t('explore_courses')}
                      <motion.span animate={{ x: [0, 4, 0] }} transition={{ duration: 1.5, repeat: Infinity }}>
                        <ArrowRight className="h-5 w-5" />
                      </motion.span>
                    </Link>
                  </motion.div>
                  <motion.div whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }}>
                    <Link
                      href="/signup?role=educator"
                      className="inline-flex items-center gap-2 rounded-2xl border border-white/25 bg-white/10 px-7 py-3.5 text-base font-semibold text-white backdrop-blur-sm transition-colors hover:bg-white/20"
                    >
                      {t('become_educator')}
                    </Link>
                  </motion.div>
                </motion.div>
              </div>

              {/* Right: student photo with floating chips */}
              <motion.div
                initial={{ opacity: 0, x: 36 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ duration: 0.8, delay: 0.35, ease: [0.16, 1, 0.3, 1] }}
                className="relative mx-auto w-full max-w-md lg:max-w-none"
              >
                <div className="relative overflow-hidden rounded-3xl border border-white/25 shadow-floating">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src="/hero-student.jpg" alt={t('hero_image_alt')} className="h-72 w-full object-cover sm:h-96 lg:h-[440px]" />
                  <div className="absolute inset-0 bg-gradient-to-t from-blue-950/40 via-transparent to-transparent" />
                </div>

                <motion.div
                  className="absolute -left-2 top-6 sm:-left-4"
                  animate={{ y: [0, -8, 0] }}
                  transition={{ duration: 4, repeat: Infinity, ease: 'easeInOut' }}
                >
                  <span className="flex items-center gap-2 rounded-2xl bg-white/95 px-4 py-2.5 text-xs font-bold text-slate-900 shadow-floating backdrop-blur sm:text-sm">
                    <span className="gradient-bg-blue flex h-7 w-7 shrink-0 items-center justify-center rounded-lg">
                      <BadgeCheck className="h-4 w-4 text-white" />
                    </span>
                    {t('stat_verifiable')}
                  </span>
                </motion.div>
                <motion.div
                  className="absolute -right-2 bottom-6 sm:-right-4"
                  animate={{ y: [0, 8, 0] }}
                  transition={{ duration: 5, repeat: Infinity, ease: 'easeInOut', delay: 1 }}
                >
                  <span className="flex items-center gap-2 rounded-2xl bg-white/95 px-4 py-2.5 text-xs font-bold text-slate-900 shadow-floating backdrop-blur sm:text-sm">
                    <span className="gradient-bg-blue flex h-7 w-7 shrink-0 items-center justify-center rounded-lg">
                      <Wallet className="h-4 w-4 text-white" />
                    </span>
                    {t('feature_1_title')}
                  </span>
                </motion.div>
              </motion.div>
            </div>
          </motion.div>

          {/* Stats */}
          <motion.div
            className="mt-8 grid grid-cols-1 gap-5 sm:grid-cols-3 md:gap-7"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 1, delay: 0.9 }}
          >
            {stats.map((stat, i) => (
              <motion.div
                key={stat.label}
                className="glass-heavy rounded-2xl p-6 text-center"
                initial={{ opacity: 0, y: 24 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.55, delay: 1 + i * 0.12 }}
                whileHover={{ y: -5 }}
              >
                <span className={`mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-r ${stat.gradient}`}>
                  <stat.icon className="h-5 w-5 text-white" />
                </span>
                <p className="gradient-text-blue text-3xl font-extrabold md:text-4xl">{stat.value}</p>
                <p className="mt-1 text-sm font-medium text-gray-500">{stat.label}</p>
              </motion.div>
            ))}
          </motion.div>
        </div>
      </section>

      {/* ================= COURSES (functional catalog) ================= */}
      <section id="courses" className="relative scroll-mt-24 py-20">
        <div className="absolute inset-0 -z-10 bg-gradient-to-b from-transparent via-brand-50/40 to-transparent dark:via-blue-950/20" />
        <div className="mx-auto w-full max-w-6xl px-4 sm:px-6">
          <motion.div className="text-center" variants={stagger} initial="hidden" whileInView="visible" viewport={{ once: true, margin: '-80px' }}>
            <motion.span variants={fadeUp} className="section-badge">
              <Sparkles className="h-4 w-4 text-brand-500" />
              {total > 0 ? `${total} ${t('courses')}` : t('courses')}
            </motion.span>
            <motion.h2 variants={fadeUp} className="mt-6 text-3xl font-bold text-foreground md:text-5xl">
              {t('latest_courses')}
            </motion.h2>
            <motion.p variants={fadeUp} className="mx-auto mt-3 max-w-xl text-gray-500">
              {t('courses_section_sub')}
            </motion.p>
          </motion.div>

          {/* Category quick links — full filtering lives on /courses */}
          <motion.div
            className="mt-10 flex flex-wrap items-center justify-center gap-2"
            initial={{ opacity: 0, y: 16 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.5, delay: 0.1 }}
          >
            {CATEGORIES.map((c) => (
              <Link key={c} href={`/courses?category=${c}`} className="pill">
                {t(`cat_${c}`)}
              </Link>
            ))}
          </motion.div>

          {/* Grid */}
          {courses.length === 0 ? (
            <motion.div
              className="card mx-auto mt-10 max-w-lg py-12 text-center"
              initial={{ opacity: 0, y: 16 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
            >
              <p className="text-4xl">🔎</p>
              <p className="mt-3 text-lg font-medium text-foreground">{t('no_courses')}</p>
              <p className="mt-2 text-sm text-gray-500">
                <Link className="font-semibold text-brand-600 hover:underline" href="/signup?role=educator">
                  {t('become_educator')} →
                </Link>
              </p>
            </motion.div>
          ) : (
            <motion.div
              className="mt-12 grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3"
              variants={stagger}
              initial="hidden"
              whileInView="visible"
              viewport={{ once: true, margin: '-60px' }}
            >
              {courses.map((c) => (
                <motion.div key={c.id} variants={fadeUp}>
                  <CourseCard course={c} />
                </motion.div>
              ))}
            </motion.div>
          )}

          {courses.length > 0 && (
            <motion.div
              className="mt-12 text-center"
              initial={{ opacity: 0, y: 12 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.5 }}
            >
              <motion.span className="inline-block" whileHover={{ scale: 1.03 }} whileTap={{ scale: 0.97 }}>
                <Link href="/courses" className="btn !rounded-2xl !px-8 !py-4 !text-base">
                  {t('view_all_courses')} <ArrowRight className="h-5 w-5" />
                </Link>
              </motion.span>
            </motion.div>
          )}
        </div>
      </section>

      {/* ================= WHY (template WhyDelibix / Services grid) ================= */}
      <section className="relative py-24">
        <div className="mx-auto w-full max-w-6xl px-4 sm:px-6">
          <motion.div className="text-center" variants={stagger} initial="hidden" whileInView="visible" viewport={{ once: true, margin: '-80px' }}>
            <motion.span variants={fadeUp} className="section-badge">
              <Zap className="h-4 w-4 text-brand-500" />
              {t('why_badge')}
            </motion.span>
            <motion.h2 variants={fadeUp} className="mt-6 text-balance text-3xl font-bold leading-tight text-foreground md:text-5xl">
              {t('why_title_1')} <span className="gradient-text-blue">{t('why_title_2')}</span>
            </motion.h2>
          </motion.div>

          <motion.div
            className="mt-14 grid gap-6 sm:grid-cols-2 lg:grid-cols-3"
            variants={stagger}
            initial="hidden"
            whileInView="visible"
            viewport={{ once: true, margin: '-60px' }}
          >
            {features.map((f) => (
              <motion.div key={f.title} variants={fadeUp} className="card card-hover group relative overflow-hidden !rounded-3xl !p-8">
                <span className="absolute right-4 top-4 h-2 w-2 rounded-full bg-brand-400/60 opacity-60" />
                <span className="glass-secondary mb-5 flex h-14 w-14 items-center justify-center rounded-2xl transition-transform duration-300 group-hover:scale-110">
                  <f.icon className="h-7 w-7 text-brand-600" />
                </span>
                <h3 className="text-lg font-bold text-foreground">{f.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-gray-500">{f.desc}</p>
              </motion.div>
            ))}
          </motion.div>
        </div>
      </section>

      {/* ================= PROCESS (template ProcessSection) ================= */}
      <section className="relative py-24">
        <div className="absolute inset-0 -z-10 bg-gradient-to-b from-transparent via-brand-50/50 to-transparent dark:via-blue-950/20" />
        <div className="mx-auto w-full max-w-6xl px-4 sm:px-6">
          <motion.div className="text-center" variants={stagger} initial="hidden" whileInView="visible" viewport={{ once: true, margin: '-80px' }}>
            <motion.span variants={fadeUp} className="section-badge">
              <Rocket className="h-4 w-4 text-brand-500" />
              {t('how_badge')}
            </motion.span>
            <motion.h2 variants={fadeUp} className="mt-6 text-balance text-3xl font-bold leading-tight text-foreground md:text-5xl">
              {t('how_title_1')} <span className="gradient-text-blue">{t('how_title_2')}</span>
            </motion.h2>
          </motion.div>

          <motion.div
            className="mt-16 grid gap-8 lg:grid-cols-3"
            variants={stagger}
            initial="hidden"
            whileInView="visible"
            viewport={{ once: true, margin: '-60px' }}
          >
            {steps.map((step, i) => (
              <motion.div key={step.title} variants={fadeUp} className="group relative">
                <div className="card card-hover relative h-full overflow-visible !rounded-3xl !p-8 text-center">
                  <span className="glass absolute -right-4 -top-4 z-10 flex h-11 w-11 items-center justify-center rounded-full text-sm font-bold text-brand-600">
                    {i + 1}
                  </span>
                  <span className="glass-secondary mx-auto mb-6 flex h-20 w-20 items-center justify-center rounded-2xl transition-transform duration-300 group-hover:scale-105">
                    <step.icon className="h-9 w-9 text-brand-600" />
                  </span>
                  <h3 className="text-xl font-bold text-foreground">{step.title}</h3>
                  <p className="mt-3 text-sm leading-relaxed text-gray-500">{step.desc}</p>
                  <span className="badge-info mt-5">{step.time}</span>
                </div>
                {i < steps.length - 1 && (
                  <span className="absolute -right-5 top-1/2 hidden -translate-y-1/2 text-brand-300 lg:block">
                    <ArrowRight className="h-6 w-6" />
                  </span>
                )}
              </motion.div>
            ))}
          </motion.div>
        </div>
      </section>

      {/* ================= EDUCATOR CTA (template solution card) ================= */}
      <section className="py-24">
        <div className="mx-auto w-full max-w-5xl px-4 sm:px-6">
          <motion.div
            initial={{ opacity: 0, y: 30 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: '-80px' }}
            transition={{ duration: 0.7 }}
            className="glass-heavy relative overflow-hidden rounded-3xl border-2 !border-brand-200/60 bg-gradient-to-br from-brand-50/80 to-brand-100/60 p-10 dark:from-blue-950/40 dark:to-blue-900/20 md:p-14"
          >
            <div className="absolute -right-10 -top-10 h-44 w-44 rounded-full bg-blue-400/15 blur-2xl" />
            <div className="absolute -bottom-14 -left-10 h-52 w-52 rounded-full bg-blue-500/10 blur-3xl" />

            <div className="relative z-10 grid items-center gap-10 md:grid-cols-[1.3fr_1fr]">
              <div>
                <span className="section-badge">
                  <GraduationCap className="h-4 w-4 text-brand-500" />
                  {t('teach_cta_badge')}
                </span>
                <h2 className="mt-5 text-balance text-3xl font-bold leading-tight text-foreground md:text-4xl">
                  {t('teach_cta_title_1')} <span className="gradient-text-blue">{t('teach_cta_title_2')}</span>
                </h2>
                <p className="mt-4 max-w-xl leading-relaxed text-gray-500">{t('teach_cta_sub')}</p>
                <motion.div className="mt-7 inline-block" whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }}>
                  <Link href="/signup?role=educator" className="btn !rounded-2xl !px-8 !py-4 !text-base">
                    {t('become_educator')} <ArrowRight className="h-5 w-5" />
                  </Link>
                </motion.div>
              </div>
              <div className="space-y-4">
                {[t('teach_benefit_1'), t('teach_benefit_2'), t('teach_benefit_3')].map((b, i) => (
                  <motion.div
                    key={b}
                    className="glass flex items-center gap-3 rounded-2xl px-5 py-4"
                    initial={{ opacity: 0, x: 30 }}
                    whileInView={{ opacity: 1, x: 0 }}
                    viewport={{ once: true }}
                    transition={{ duration: 0.5, delay: 0.15 * i }}
                  >
                    <span className="gradient-bg-blue flex h-9 w-9 shrink-0 items-center justify-center rounded-xl">
                      {i === 0 ? <HandCoins className="h-4 w-4 text-white" /> : i === 1 ? <Zap className="h-4 w-4 text-white" /> : <BookOpen className="h-4 w-4 text-white" />}
                    </span>
                    <span className="font-semibold text-foreground">{b}</span>
                  </motion.div>
                ))}
              </div>
            </div>
          </motion.div>
        </div>
      </section>

      {/* ================= FINAL CTA ================= */}
      <section className="pb-10 pt-4">
        <div className="mx-auto max-w-3xl px-4 text-center sm:px-6">
          <motion.div variants={stagger} initial="hidden" whileInView="visible" viewport={{ once: true, margin: '-60px' }}>
            <motion.h2 variants={fadeUp} className="text-balance text-3xl font-bold text-foreground md:text-4xl">
              {t('final_cta_title')}
            </motion.h2>
            <motion.p variants={fadeUp} className="mt-3 text-gray-500">
              {t('final_cta_sub')}
            </motion.p>
            <motion.div variants={fadeUp} className="mt-7 flex flex-wrap items-center justify-center gap-4">
              <motion.div whileHover={{ scale: 1.03 }} whileTap={{ scale: 0.97 }}>
                <Link href="/signup" className="btn !rounded-2xl !px-8 !py-4 !text-base">
                  {t('get_started')} <ArrowRight className="h-5 w-5" />
                </Link>
              </motion.div>
              <Link href="/courses" className="btn-secondary !rounded-2xl !px-8 !py-4 !text-base">
                {t('explore_courses')}
              </Link>
            </motion.div>
          </motion.div>
        </div>
      </section>
    </div>
  );
}
