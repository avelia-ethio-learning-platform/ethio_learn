# Features and roadmap

What EthiopiaLearn does today, what's being built, and what's left. For running the code, see the [README](../README.md); for how to work on it, see [CONTRIBUTING](../CONTRIBUTING.md).

- [What EthiopiaLearn is](#what-ethiopialearn-is)
- [Features by role](#features-by-role)
- [Across the platform](#across-the-platform)
- [Stubbed, mock-only and known gaps](#stubbed-mock-only-and-known-gaps)
- [UI and color](#ui-and-color)
- [Roadmap](#roadmap)
- [After launch](#after-launch)

## What EthiopiaLearn is

An educator-first online learning marketplace for Ethiopia, live at **https://ethio-learn.vercel.app**:
- Educators and institutions publish courses, which pass a quality review before going live.
- Learners take them free or pay in birr through Chapa. Educators are paid 80% of what their courses earn.
- Completing a course gives a certificate that anyone can verify.

Choices that shape the product:
- **Free-tier hosting.** The API runs on Render's free tier, where services sleep when idle. The web shows a "waking up" state instead of an error, and scheduled jobs are moving to an external scheduler (Phase 9c).
- **English first, Amharic where new learners start.** The shell, the catalog and the sign-in flow are bilingual today. Phase 10 extends Amharic to the whole new-learner path. Course content is in whatever language the educator writes it.
- **Email and password, no SMS.** Sign-in uses a verification link. Google sign-in is optional.

Five roles: learner, educator, institution admin, quality officer (QO) and platform admin. A visitor who isn't logged in can browse everything public.

In numbers (at `main`):
- 36 page routes;
- about 180 API endpoints behind one gateway;
- 7 backend services;
- 47 event types.

## Features by role

### Visitor (not logged in)
- **Home** `/`: the newest courses. It is served statically, so it loads even while the API sleeps.
- **Catalog** `/courses`:
  - search;
  - category and price filters (free, freemium, paid);
  - sort by top, new, popular or price;
  - 12, 24 or 48 per page.
- **Course page** `/courses/[id]`:
  - the outline with lesson lengths;
  - a free preview video;
  - recent reviews and a "recently updated" badge;
  - a price box (a sticky buy bar on phones);
  - a generated cover when there's no thumbnail.
- **Educators** `/educators`: ranked by rating. Each has a profile page `/educators/[id]` with a bio, stats and their courses.
- **Help** `/help`: an FAQ and a contact form that reaches the support inbox.
- **Certificate check** `/verify` and `/verify/[uid]`: anyone can confirm a certificate (this is where its QR code points). It shows the learner, course, educator, trust tier, date and passed assessments.
- **Accounts:**
  - sign up `/signup` as a learner, educator or institution;
  - log in `/login`. Login waits until the email is verified (`/verify-email`, with a resend);
  - reset a password `/reset-password`;
  - accept a staff or instructor invitation `/accept-invite`.
- **Pay link** `/pay/[token]`: someone else asked you to pay for their course. You can view it freely, and paying needs a login.
- **Offline page** `/offline`, served by the service worker without a connection.

### Learner
- **Enrol** from the course page (all payments go through Chapa):
  - free;
  - pay with Chapa;
  - apply a coupon;
  - pay from the wallet;
  - **gift** the course to an email (they get an invitation if they have no account);
  - **ask someone to pay** (a pay link by email).
- **Payment return** `/payment/return` checks the payment until it settles, for courses, wallet top-ups, gifts, pay links and bulk seats.
- **Dashboard** `/dashboard`:
  - courses with progress;
  - the wallet (balance, pending credits, top-up);
  - referrals (code, stats, email invites);
  - certificates (PDF download);
  - payment history with "Request a refund";
  - refund requests;
  - gifts and sponsored learning;
  - pending institution invitations.
- **Learning** `/learn/[courseId]`:
  - the video player, protected by signed short-lived links, with a moving viewer watermark;
  - resume where you left off;
  - lesson completion (offline progress is queued and sent when the connection returns);
  - "What's new" for updated courses;
  - assessments;
  - an **AI tutor** that answers only from the course's material;
  - a review prompt once you're 20% in;
  - a completion card with the certificate.
- **Assessments:**
  - quizzes (multiple choice inline);
  - an **AI viva** (written answers graded by AI);
  - **projects** (upload a file; the educator grades it).
- **People:**
  - follow an educator for new-course alerts;
  - direct messages `/messages`;
  - notifications `/notifications` and the header bell;
  - preferences `/notifications/preferences` for categories, followed educators, in-app and email, and progress and inactivity emails.
- **Account:**
  - `/account` (name, phone, delete with password confirmation; data is anonymised);
  - `/account/password`;
  - `/account/invites` (accept or decline an institution's invitation to teach, or leave an institution).

### Educator
- **Teaching home** `/teach`: your courses, pending payout balance, payout history and your educator profile.
- **New course** `/teach/new`. It can draft the outline from a PDF, DOCX or text file with AI; you review it before it's applied.
- **Course editor** `/teach/courses/[id]`:
  - details and thumbnail;
  - sections and lessons, including free-preview sections;
  - resumable video upload straight to storage;
  - AI tutor knowledge documents, and the questions the tutor couldn't answer;
  - a change log.
- **Lifecycle:** submit, withdraw, unpublish, republish, archive, restore, duplicate, and appeal a flag.
  - Edits to a published course are staged as a **revision** that goes through review again before it goes live.
  - Instructors who belong to an institution are reviewed by the institution first.
- **Assessments:**
  - quizzes (multiple choice and written, AI-generated questions, pass score, time limit);
  - AI viva;
  - projects, with grading of submitted projects.
- **Preview as a learner** `/preview/[id]`.
- **Analytics** `/teach/analytics`:
  - revenue, gross and net;
  - learners;
  - active learners in the last 7 days;
  - completion rate;
  - monthly revenue and enrolment charts;
  - a per-course table.
- **Coupons** `/teach/coupons`: percent or birr off, total uses, uses per learner and expiry, for your own paid courses.

### Institution admin
- **Institution** `/institution`:
  - register the institution;
  - invite instructors by email, and suspend, reactivate or remove them;
  - see every institution course and unlist or restore it.
- **Bulk seats** with a volume discount (10% from 5 seats, 20% from 10, 30% from 50), paid by Chapa or wallet, then assigned by email.
- **Review** `/institution/review`: approve or reject instructors' courses and revisions before they go to platform review.

### Quality officer
- **Review queue** `/qa`:
  - ordered by deadline (24 h for revisions, 48 h otherwise);
  - a 30-minute claim lock;
  - "what changed" chips;
  - an AI plagiarism score.
- Decisions are approve, request changes, flag or reject, for new courses, revisions, appeals and post-publish reviews.
- A revision can't be approved until the officer has watched every new video and opened every new assessment. The review uses a word-level diff in `/preview/[id]?revision=`.

### Platform admin
- **Admin** `/admin`, with ten tabs (the tab is kept in the URL):
  - analytics (key numbers plus monthly revenue and enrolments);
  - payments (with recording a manual bank transfer);
  - payouts (run now, release held);
  - refunds (the manual-review band);
  - fraud flags;
  - users (search, suspend, ban, reactivate, invite staff);
  - course overrides;
  - platform coupons;
  - wallet adjustments;
  - announcements to a role or everyone.
- Every money-moving or destructive action asks for confirmation first.
- Also uses the review queue and can open any course in the editor.

## Across the platform

- **Payments:**
  - Chapa checkout, then a signed webhook, then a server-side re-check of amount and currency, then a confirmation that happens exactly once.
  - Also the wallet, 100% coupons, and admin-recorded bank transfers.
  - Without Chapa keys, a local mock checkout `/dev/checkout` sends a real signed webhook. Production refuses mock mode.
- **Refunds:**
  - within 7 days and under 20% progress: approved automatically;
  - 20–50%: an admin decides;
  - over 50%, past 7 days, or after a certificate or a passed assessment: denied.

  An approved refund removes access only if the learner has no other claim to the course, and it cancels pending cashback and referral rewards.
- **Payouts:**
  - 80% to the educator;
  - a 7-day hold (14 days for new educators);
  - a hold above the KYC threshold and on open fraud flags;
  - a nightly run, or run by an admin.
- **Growth:**
  - referral rewards and purchase cashback (configurable), held for about 7 days;
  - wallet top-ups;
  - gifts, pay links and bulk seats.
- **Certificates:**
  - a PDF with a QR code to the public check page;
  - a signed identifier, so a tampered one fails the check;
  - issued when every lesson is complete and every required assessment is passed.
- **Reviews and trust:**
  - 1–5 stars and a comment, after 20% progress;
  - ratings feed the catalog's "top" sort, the educator ranking and trust tiers (new, proven, trusted);
  - a low course rating, or a high refund rate across the educator's sales, sends a reviewed course back for another review.
- **Notifications:**
  - an in-app inbox and the bell;
  - email through Brevo, SMTP or Resend (printed to the console in development);
  - progress milestones and inactivity nudges.
- **AI (Groq):**
  - quiz generation;
  - viva questions and grading;
  - written-answer grading;
  - study plans;
  - a plagiarism and spam screen;
  - course outlines from documents;
  - the course tutor.

  Without a key, a deterministic mock answers, labelled "[mock]".
- **Search and sharing:**
  - a sitemap;
  - a robots file that hides private areas;
  - share images for the site and each course;
  - Course structured data on course pages;
  - an installable web app (manifest and icons).
- **Language:** English and Amharic, switched from the header.
- **Theme:** light, dark or system, applied before the first paint.
- **Accessibility:**
  - a skip link;
  - keyboard-operable tabs and dialogs;
  - screen-reader text for charts;
  - a 375 px layout;
  - reduced motion.

  Automated axe, keyboard and layout tests run in CI.
- **Sleeping servers:** a "waking up" page instead of a false "not found", a notice after 4 seconds, and a wake-up ping.
- **Offline:** a service worker, an offline page, and queued lesson progress.
- **Architecture:**
  - one public API gateway with per-route rate limits;
  - seven services, each with its own Postgres schema, talking through RabbitMQ events;
  - S3-compatible storage for video, files and certificates.

  See the [README](../README.md#architecture).

## Stubbed, mock-only and known gaps

These are true at `main` today. Each one is either in a phase below or listed under [After launch](#after-launch).

- **Payout transfer is manual.** A payout run marks payouts paid. The money is sent outside the platform until Chapa's split payouts or a bank integration is chosen.
- **Refund money is returned manually.** An approved refund updates the ledger and access. There's no automatic Chapa refund call.
- **No video transcoding.** Uploads are served as uploaded, through signed links.
- **The proctored exam room isn't reachable.**
  - The page `/learn/[courseId]/exam/[assessmentId]` exists, with face checks, tab-switch guards, a proctor report and a study plan, but nothing links to it.
  - The inline quiz shows multiple-choice questions only.
  - Educators can turn proctoring on, and they have no view of exam results.
- **Course comments aren't shown.** The comment API and component exist, but no page renders them.
- **Role-wide notifications** (announcements, the QO queue) share one read flag: one person marking one read marks it for the whole role.
- **Institution admins can't create courses** (`/teach` and `/teach/new` are educator-only). The course tools they can open have no menu links.
- **Course language is always English.** There's no way to mark a course as Amharic.
- **API only, no screen yet:**
  - an admin test email;
  - force-verifying a user's email;
  - raising a fraud signal by hand;
  - the unread message count. There's also no Messages link in the header.
- **Amharic covers** the shell, home, catalog filters and parts of sign-in and the dashboard. The rest is English (Phase 10 extends it).

## UI and color

The visual direction was approved on 2026-10-02:
- the blue brand and Inter are kept;
- identity lives in the content: generated course covers, Amharic labels, educator names, and the flag band used as structure, not decoration;
- motion is calm;
- helper text is readable, with visible focus and human status words;
- money actions ask for confirmation.

**[COLOR_SYSTEM.md](COLOR_SYSTEM.md)** defines every color role in light and dark. Every text pair reaches 4.5:1 and every boundary, focus ring and graphic 3:1, all computed. It also covers status colors, charts, category covers and the flag, with do and don't rules. Phase 7c brings the code fully onto it and adds tests that keep it there.

## Roadmap

The work runs as numbered phases. Each has a plan, a reviewed plan, an implementation, a code review and one PR. The phase tracker, with findings and PR numbers, is [`docs/plans/2026-10-02-refinement-audit/roadmap.md`](plans/2026-10-02-refinement-audit/roadmap.md). Below, each phase is one line in plain words.

### Done
| Phase | What it delivered |
|---|---|
| 1 | CI runs the build and tests on every PR, and the repo baseline is clean. |
| 2 | Versioned database migrations replace automatic schema sync, and a drift check runs in CI. |
| 3 | Every endpoint checks who you are and what you own, plus fixes to the web's most exposed pages. |
| 4 | Payments are confirmed exactly once, with amounts and currency checked against Chapa. |
| 5 | The web handles sleeping servers gracefully; a browser test harness (Playwright) is in CI. |
| 6a | Platform hardening: service-to-service calls, password changes, email sending limits, coupons and pay links. |
| 6b | Learning integrity: watch time is measured, and assessment attempts and project uploads follow the rules. |
| 6c | Money integrity: coupons, cashback, referral rewards and refunds stay consistent with each other. |
| 6d | Money integrity: pay-link payments, and refunds of a course bought twice, keep access right. |
| 7a | UI foundations: the shared page chrome, accessibility, page titles and share images. |
| 7b | Public and learner pages: the course page decides from the first screen on a phone, a finished catalog with covers, a phone-friendly lesson player, branded error pages, and a recovery path for a lost verification email. |
| 8a, 8b | Role dashboards for admin, educator, institution and QO: tabs, confirmations, charts, human status words. |
| 11a | CI gates every merge (lint, secret scan, audit), the deployment docs match the real setup, and the repo is tidied. |
| 11d | This guide, CONTRIBUTING, the color system and the README refresh. |

### In progress
| Phase | What it delivers |
|---|---|
| 9a + 9b | Events are delivered reliably: consumers are safe to run twice, and the outbox makes "save, then announce" atomic. They ship together. |
| 9c | Calls between services and to Chapa fail clearly and retry sensibly. Scheduled jobs run from an external scheduler, so they fire even when free-tier servers sleep. |
| 9d | Logs are structured JSON with one request id followed across services, and personal data stays out of logs. |
| 10 | Security headers, faster pages (self-hosted fonts, sized images, lazy-loaded video), SEO, and Amharic for the new-learner path. |

### Planned
In build order. Backend and web run as parallel tracks.

| Phase | What it delivers |
|---|---|
| 9e | List pages cost a fixed number of queries: batched cross-service reads and bounded pages (My learning, bulk seats, analytics, long message threads). |
| 7c | The color system in code: status tokens, contrast fixes in both themes, and guard tests. |
| 11b | Sign-in sessions move to a sturdier transport, and the riskiest paths (login, payments, entitlements, service calls) get dedicated tests. |
| 11c | Dependencies are up to date: Next.js 15 and React 19. |
| 12a | A motion system: calm, consistent and reduced-motion-safe. It covers the shared components, the shell, Home and the catalog. |
| 12b | The same polish for the course page, checkout, the learner path, certificates and dashboards. |

## After launch

Not in a phase yet. Each needs a decision or a plan first.

**Product:**
- Wire the proctored exam room into the learner flow, and give educators an exam-results view.
- Show course comments on the course or lesson page.
- Give each person their own read state for role-wide notifications.
- Let institution admins create courses, and add links to the tools they can already use.
- Let educators mark a course's language (Amharic or English) and filter the catalog by it.
- Screens for the API-only admin tools, plus a Messages link and unread count in the header.

**Money:** automatic payout transfers (Chapa split payouts or a bank API) and automatic Chapa refunds.

**Media:** video transcoding to adaptive streams for slow connections.

**Language:**
- Amharic beyond the new-learner path.
- A native speaker's review of all Amharic strings.

**Smaller items** found by the audit that no phase touched. They're picked up when a phase works in the same files.

Ideas and requests: open an issue (see [CONTRIBUTING](../CONTRIBUTING.md#proposing-a-change)).
