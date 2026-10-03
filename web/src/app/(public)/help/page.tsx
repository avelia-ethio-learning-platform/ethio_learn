'use client';

import { FormEvent, useId, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { getAuth } from '@/lib/api';
import { Field } from '@/components/form/Field';
import { FormStatus, useFormStatus } from '@/components/form/FormStatus';

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
        a: "Paid courses check out securely through Chapa (cards, mobile money and bank transfer). After payment you're returned to EthiopiaLearn and the course unlocks automatically once the payment is confirmed.",
      },
      {
        q: 'My payment succeeded but the course is still locked.',
        a: `Confirmation usually takes a few seconds. If it hasn't unlocked, open the course and use "Check again" on the return page — our server re-verifies with Chapa. Payments also reconcile automatically within a couple of minutes, so it will unlock on its own.`,
      },
    ],
  },
  {
    group: 'Courses & learning',
    items: [
      {
        q: "What's the difference between free, freemium and paid courses?",
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
        q: "A video won't play.",
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
        a: `Google accounts sign in with one tap and don't need a password. If you'd like one (for example to also log in with email), use "Forgot password?" on the login page to set it.`,
      },
    ],
  },
];

function FaqItem({ item }: { item: Faq }) {
  const [open, setOpen] = useState(false);
  const answerId = useId();
  return (
    <div className="border-b border-gray-100 last:border-0">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={answerId}
        className="flex w-full items-center justify-between gap-4 py-4 text-left"
      >
        <span className="font-medium text-gray-900">{item.q}</span>
        <span className={`shrink-0 text-brand-600 transition-transform duration-200 ${open ? 'rotate-45' : ''}`} aria-hidden>
          ＋
        </span>
      </button>
      <div id={answerId} className={`grid transition-all duration-200 ${open ? 'grid-rows-[1fr] pb-4' : 'grid-rows-[0fr]'}`}>
        {/* invisible while closed, so links in a collapsed answer are not tab stops; the
            visibility transition keeps the text shown until the collapse finishes. */}
        <div className={`overflow-hidden text-sm leading-relaxed text-gray-600 transition-[visibility] duration-200 ${open ? 'visible' : 'invisible'}`}>
          {item.a}
        </div>
      </div>
    </div>
  );
}

function ContactForm() {
  const auth = getAuth();
  const [status, setOk, setError, clearStatus] = useFormStatus();
  const [sending, setSending] = useState(false);

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const formEl = e.currentTarget;
    setSending(true);
    clearStatus();
    const form = new FormData(formEl);
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
      formEl.reset();
      setOk("Message sent. Thanks for reaching out — we'll reply to your email as soon as we can.");
    } catch (err) {
      setError((err as Error).message || 'Something went wrong. Please try again.');
    }
    setSending(false);
  };

  return (
    <form onSubmit={submit} className="card space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Your name">
          {(ids) => <input {...ids} name="name" className="input" placeholder="Optional" defaultValue={auth?.user.name ?? ''} />}
        </Field>
        <Field label="Email">
          {(ids) => <input {...ids} name="email" type="email" required className="input" defaultValue={auth?.user.email ?? ''} placeholder="you@example.com" />}
        </Field>
      </div>
      <Field label="Subject">
        {(ids) => <input {...ids} name="subject" className="input" placeholder="What's this about?" maxLength={160} />}
      </Field>
      <Field label="How can we help?">
        {(ids) => <textarea {...ids} name="message" required minLength={10} maxLength={4000} rows={5} className="input" placeholder="Tell us what's going on…" />}
      </Field>
      <FormStatus status={status} />
      <button className="btn w-full sm:w-auto" disabled={sending}>
        {sending ? 'Sending…' : 'Send message'}
      </button>
    </form>
  );
}

export default function HelpPage() {
  return (
    <div className="page-shell max-w-3xl">
      <div className="animate-in rounded-2xl bg-gradient-to-br from-blue-700 to-blue-900 px-6 py-10 text-white">
        <h1 className="text-3xl font-bold">Help &amp; Support</h1>
        <p className="mt-2 max-w-xl text-blue-100">
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
