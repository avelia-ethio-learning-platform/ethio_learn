'use client';

import { FormEvent, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { getAuth } from '@/lib/api';

interface Faq {
  q: string;
  a: React.ReactNode;
}

const FAQS: { group: string; items: Faq[] }[] = [
  {
    group: 'Payments & refunds',
    items: [
      {
        q: 'How do refunds work?',
        a: (
          <>
            Refunds depend on how much of the course you&apos;ve completed and how long ago you paid:
            <ul className="ml-5 mt-2 list-disc space-y-1">
              <li><strong>Under 20% watched, within 7 days</strong> — approved automatically.</li>
              <li><strong>20–50% watched</strong> — reviewed manually by our team.</li>
              <li><strong>Over 50% watched, an assessment taken, a certificate earned, or more than 7 days</strong> — not eligible.</li>
            </ul>
            Request a refund from your dashboard; approved refunds revoke access to the course.
          </>
        ),
      },
      {
        q: 'How do I pay for a course?',
        a: 'Paid courses check out securely through Chapa (cards, mobile money and bank transfer). After payment you&apos;re returned to EthiopiaLearn and the course unlocks automatically once the payment is confirmed.',
      },
      {
        q: 'My payment succeeded but the course is still locked.',
        a: 'Confirmation usually takes a few seconds. If it hasn&apos;t unlocked, open the course and use "Check again" on the return page — our server re-verifies with Chapa. Payments also reconcile automatically within a couple of minutes, so it will unlock on its own.',
      },
    ],
  },
  {
    group: 'Courses & learning',
    items: [
      {
        q: 'What&apos;s the difference between free, freemium and paid courses?',
        a: 'Free courses open fully once you enroll. Freemium courses let you preview the first section for free and unlock the rest after purchase. Paid courses require payment before any lessons play.',
      },
      {
        q: 'Do I get a certificate?',
        a: (
          <>
            Yes — finish every lesson (and pass the assessment where required) and a verifiable certificate is issued to your dashboard. Anyone can confirm it&apos;s genuine on the{' '}
            <Link href="/verify" className="text-brand-700 underline">certificate verification page</Link>.
          </>
        ),
      },
      {
        q: 'A video won&apos;t play.',
        a: 'Refresh the lesson — streaming links are short-lived and simply need re-issuing. If it keeps happening, check your connection, or contact us below with the course and lesson name.',
      },
      {
        q: 'How do new-course alerts work?',
        a: (
          <>
            Follow the categories you care about or follow an instructor, and we&apos;ll notify you the moment a matching course launches. Manage this any time in your{' '}
            <Link href="/notifications/preferences" className="text-brand-700 underline">alert settings</Link>.
          </>
        ),
      },
    ],
  },
  {
    group: 'Teaching & accounts',
    items: [
      {
        q: 'How do I become an educator?',
        a: (
          <>
            Sign up and pick the educator role, then create your first course from the{' '}
            <Link href="/teach" className="text-brand-700 underline">teaching dashboard</Link>. Courses go through a quality review before they&apos;re published to learners.
          </>
        ),
      },
      {
        q: 'I signed up with Google — how do I set a password?',
        a: 'Google accounts sign in with one tap and don&apos;t need a password. If you&apos;d like one (for example to also log in with email), use "Forgot password?" on the login page to set it.',
      },
    ],
  },
];

function FaqItem({ item }: { item: Faq }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-b border-gray-100 last:border-0">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-4 py-4 text-left"
      >
        <span className="font-medium text-gray-900">{item.q}</span>
        <span className={`shrink-0 text-brand-600 transition-transform duration-200 ${open ? 'rotate-45' : ''}`} aria-hidden>
          ＋
        </span>
      </button>
      <div className={`grid transition-all duration-200 ${open ? 'grid-rows-[1fr] pb-4' : 'grid-rows-[0fr]'}`}>
        <div className="overflow-hidden text-sm leading-relaxed text-gray-600">{item.a}</div>
      </div>
    </div>
  );
}

function ContactForm() {
  const auth = getAuth();
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [error, setError] = useState('');

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setStatus('sending');
    setError('');
    const form = new FormData(e.currentTarget);
    try {
      await api('/support/contact', {
        method: 'POST',
        auth: false,
        body: {
          name: form.get('name') || undefined,
          email: form.get('email'),
          subject: form.get('subject') || undefined,
          message: form.get('message'),
        },
      });
      setStatus('sent');
    } catch (err) {
      setError((err as Error).message);
      setStatus('error');
    }
  };

  if (status === 'sent') {
    return (
      <div className="card text-center">
        <p className="text-3xl">✅</p>
        <h3 className="mt-2 font-semibold">Message sent</h3>
        <p className="mt-1 text-sm text-gray-600">Thanks for reaching out — we&apos;ll reply to your email as soon as we can.</p>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="card space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label className="label">Your name</label>
          <input name="name" className="input" placeholder="Optional" defaultValue={auth?.user.name ?? ''} />
        </div>
        <div>
          <label className="label">Email</label>
          <input name="email" type="email" required className="input" defaultValue={auth?.user.email ?? ''} placeholder="you@example.com" />
        </div>
      </div>
      <div>
        <label className="label">Subject</label>
        <input name="subject" className="input" placeholder="What&apos;s this about?" maxLength={160} />
      </div>
      <div>
        <label className="label">How can we help?</label>
        <textarea name="message" required minLength={10} maxLength={4000} rows={5} className="input" placeholder="Tell us what&apos;s going on…" />
      </div>
      {status === 'error' && <p className="text-sm text-red-600">{error || 'Something went wrong. Please try again.'}</p>}
      <button className="btn w-full sm:w-auto" disabled={status === 'sending'}>
        {status === 'sending' ? 'Sending…' : 'Send message'}
      </button>
    </form>
  );
}

export default function HelpPage() {
  return (
    <div className="mx-auto max-w-3xl">
      <div className="rounded-2xl bg-gradient-to-br from-brand-700 to-brand-900 px-6 py-10 text-white">
        <h1 className="text-3xl font-bold">Help &amp; Support</h1>
        <p className="mt-2 max-w-xl text-brand-100">
          Answers to common questions, and a direct line to our team when you need a hand.
        </p>
      </div>

      <div className="mt-8 space-y-8">
        {FAQS.map((section) => (
          <section key={section.group}>
            <h2 className="mb-2 text-lg font-semibold text-gray-900">{section.group}</h2>
            <div className="card py-0">
              {section.items.map((item) => (
                <FaqItem key={item.q} item={item} />
              ))}
            </div>
          </section>
        ))}
      </div>

      <section className="mt-10">
        <h2 className="text-lg font-semibold text-gray-900">Still need help?</h2>
        <p className="mb-3 mt-1 text-sm text-gray-600">Send us a message and we&apos;ll get back to you by email.</p>
        <ContactForm />
      </section>
    </div>
  );
}
