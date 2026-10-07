# What was built — feature batch of 2026-09-13

Commits on `deploy/render-vercel`: `03b4321` (production fix), `cadf91e` (API), `feat(web)` (frontend).
Everything builds (12/12 API packages, Next.js production build) and all tests pass (103 API, 12 web).

---

## 0. First: the production bug you reported (video upload + GET 500)

**The upload itself was fine.** Your R2 bucket already has a CORS policy for `https://ethio-learn.vercel.app` —
I tested a real presigned `PUT` (200) and the browser-style preflight (204 with `Access-Control-Allow-Origin`).
The CORS error you saw came from a **different origin** (a Vercel preview URL or `localhost`), which the bucket
policy does not list. If you want uploads to work from previews/localhost too, add those origins in
Cloudflare R2 → bucket → Settings → CORS policy.

**The `GET 500` was real and is fixed.** `GET /courses/:id/pending-projects` (and every other cross-service read)
failed because `GATEWAY_INTERNAL_URL` was never set on Render, so services fell back to `localhost:4000`.
It is now in `render.yaml` and the app fails fast with a named error if it is ever missing again.
This same bug is why some **emails were silently skipped** ("no recipient"): payment receipts and completion
emails look the learner's address up through that URL. Brevo itself works — I logged in and sent a real probe.

---

## 1. Built — feature by feature

| # | Your ask | Status | Where |
|---|---|---|---|
| 1 | Leak protection & anti-cheat on quizzes | **Built** | outcomes service, exam page, learn page |
| 2 | Referral system, promo codes, coupons | **Built** | financial service, dashboard, checkout, teach/coupons |
| 3 | Course + video progress tracking | **Built** (backend existed; the player never used it — now it does) | learn page, enrollment service |
| 4 | Inactivity: in-app first, email later | **Built** | enrollment cron → notification |
| 5 | Bulk purchase & corporate discounts | **Built** | financial service, institution page |
| 6 | Offline / low-connectivity + leak mitigation | **Partially built** (see §3) | service worker, outbox, learn page |
| 7 | Notify learners when a course is updated | **Built** (with change log + "Updated" badge) | course service, teach course page, learn page |
| 8 | Mini RAG chatbot per course | **Built** | course service, ai package, learn page |
| 9 | Request other people to pay | **Built** | financial service, checkout, /pay/[token] |
| — | Organisations buy courses for employees | **Built** (= #5) | institution page |
| — | Personalised notifications, abandoned cart, feature alerts | **Built** | financial cron, notification service, admin "Announce" |
| — | Reports & analytics (educator, institution, admin) | **Built** | /teach/analytics, admin Analytics tab |
| — | % of video watched + history | **Built** | per-lesson watched bars; heartbeat log |
| — | Well-proctored assessment (capstone) | **Partially** — quiz proctoring hardened; project + AI-viva already existed | outcomes |
| — | Email sending not working | **Diagnosed & fixed** (see §0) | render.yaml |
| — | Invite people by gifting / recommending | **Built** (gifts + invites) | dashboard, checkout |
| — | Badge + change log on edited courses | **Built** | course page, learn page |
| — | Parental control (buy for child, track progress) | **Built** via gifts: sponsor sees each recipient's progress | dashboard → "Gifts & sponsored learning" |
| — | Progress emails ("you're 80% done") | **Built** (25/50/75% milestones; email at 50 & 75) | enrollment → notification |
| — | Notify on new courses by category / instructor | **Already existed** — verified | notification prefs |
| — | Course categories field | **Already existed** (16 categories incl. graphic design, programming, video editing…) | contracts |
| — | Points / coins learners can buy or receive | **Built** as the wallet (ETB credits) | dashboard |
| — | Buyers get points to spend on other courses | **Built** — cashback on every real-money purchase | wallet |
| — | Help & support | **Already existed** | /help |
| — | Threaded comments + DMs | **Already existed** (replies to replies work) | learn page |
| — | Rating implemented properly + top educators + sorting | **Already existed** (Bayesian ranking, `educators/top` by total rating points) — verified | course service |
| — | AI-generated content included in the course | **Already existed** (`apply-structure`); now also indexed for the tutor | course service |
| — | Separate repos / Supabase / Dockerize | **Not done** — see §4 | — |

### 1.1 Anti-cheat & leak protection (quizzes and video)
- **Per-learner paper.** Each attempt draws `pool_size` questions from the bank and shuffles questions *and* options
  (crypto random). The served order is stored on the attempt; answers are mapped back for grading. Two learners
  side by side never see the same paper. Answer keys and marking guidance never leave the server (they never did).
- **Resume, don't restart.** Starting a quiz with an unfinished attempt returns *that* attempt with its original
  deadline. Refreshing or reopening the tab cannot buy a new paper or more time.
- **Server clock.** `deadline_at` comes from the server; the client counts down to it. A submission past the limit
  (+90 s grace) is recorded as late and cannot pass.
- **Attempt limits** (`max_attempts`, default 3) and **cooldown** between attempts; no re-attempt after a pass.
- **Video:** at most 8 signed stream URLs per learner per minute (account sharing / scraping trips it), a
  **moving watermark** with the viewer's email over the player, `nodownload`, no picture-in-picture, no context menu.
  The existing webcam/tab/clipboard proctoring is unchanged; the exam now also requests fullscreen.
- Educator UI: "Integrity settings" block in the quiz builder.

### 1.2 Referrals, coupons, wallet, gifts, pay requests, bulk seats
- **Coupons:** `POST /coupons` (educators: own courses only; admins: platform-wide), % or ETB off, max uses,
  expiry. Learners preview at checkout (`GET /coupons/validate`). A 100 % code enrols with no payment (scholarships).
  Uses are counted only on confirmed payments.
- **Wallet:** `GET /wallet`, `POST /wallet/topup` (Chapa, 50–50 000 ETB). Pay any checkout from it.
  **5 % cashback** on every real-money purchase; **50 ETB referral reward** when an invitee first buys.
  Wallet top-ups are platform liabilities — excluded from educator payouts.
- **Referrals:** `GET /referrals/me` (code + share link + stats), `POST /referrals/invite` (emails; existing accounts
  get a "log in" variant), `POST /referrals/claim` (auto on first dashboard visit after signing up with `?ref=`).
- **Gifts:** `POST /gifts` — pay for someone by email. Existing account → instant access; otherwise an invite email
  and the seat unlocks when they sign up with that address. The sponsor sees the recipient's progress.
- **Pay requests:** learner `POST /pay-requests` → payer gets an email with `/pay/<token>`; anyone signed in can pay
  (Chapa or wallet); the learner gets access the moment it clears.
- **Bulk seats:** `POST /bulk-purchases/quote` → volume tiers (5+ 10 %, 10+ 20 %, 50+ 30 %; env `BULK_DISCOUNT_TIERS`),
  `POST /bulk-purchases` → Chapa/wallet, then `POST /bulk-purchases/:id/assign` with employee emails.
  Per-seat progress is shown on the Institution page.
- All sponsored access funnels into **one event, `SponsorshipGranted`**, handled by the enrollment service — the only
  non-payment path to entitlement. Nothing fakes a `PaymentConfirmed`.

### 1.3 Progress, engagement, notifications
- The player now sends a **heartbeat** (every 10 s, on pause, on leave) and **resumes** where you left off; each
  lesson shows a watched bar; ≥ 90 % auto-completes (existing rule).
- **Milestones** at 25/50/75 % → in-app; email at 50 and 75 (opt-out toggle).
- **Inactivity ladder:** in-app after 7 days, one email after 14 (env `INACTIVITY_DAYS`, `INACTIVITY_EMAIL_DAYS`);
  any activity resets it. Runs daily at 06:00 UTC.
- **Abandoned checkout:** hourly cron, one reminder per checkout opened 1–48 h ago (in-app + email).
- **Course updates:** educators post a change-log entry; **major** entries notify every enrolled learner (in-app +
  email, opt-out toggle) and flip an *Updated* badge until the learner opens the log. Lesson additions and video
  replacements are logged automatically as minor entries. The public course page shows *Recently updated* for 30 days.
- **Announcements:** admin → Announce tab → in-app to a role or everyone.
- New preference toggles: course updates, progress milestones, inactivity reminders.

### 1.4 Course tutor (mini RAG)
- Corpus per course: description + lesson outline (auto-indexed on publish) + anything the educator adds
  (`POST /courses/:id/knowledge` — notes, FAQs, `.txt/.md/.srt/.vtt` transcripts; timestamps stripped).
- Retrieval: Postgres full-text (`simple` config, so Amharic works) + ILIKE fallback; top 6 chunks.
- Generation: Groq, instructed to answer **only** from those chunks, cite the lesson, reply in the learner's
  language, and say so when the material doesn't cover it. Falls back to quoting excerpts if the LLM is down.
- Educators see what learners ask and how often the material failed to answer (`/courses/:id/chat/insights`).
- Only entitled learners (and the owner) can chat; rate-limited in the AI bucket.

### 1.5 Analytics
- Educator/institution: `/teach/analytics` — revenue by month & course, enrollments, completion rate, average
  progress, active 7/30 d, never-started, ratings.
- Admin: Analytics tab — gross revenue, platform share, by purpose/method, top courses, wallet liability, coupon
  discounts, enrollments/completions by month, sponsored seats, pending/failed checkouts.

---

## 2. Partially built / limits you should know

- **Offline (§6).** Built: installable PWA, cached app shell, cached course/progress reads, an outbox that queues
  progress while offline and replays it, `/offline` page. **Not built: downloading videos for offline.** Reason:
  playback uses 15-minute signed URLs precisely so files can't be copied; storing them on-device would either break
  (expired URL) or defeat leak protection. Doing this properly needs encrypted local packs or DRM — see
  `PRODUCT_ROADMAP.md` §2.3. Text (summaries, outline) is available offline.
- **Proctored capstone.** Quiz proctoring is now server-hardened; project uploads and AI viva already existed. A
  combined "project + oral defence" capstone flow is not built (it's a UI composition on top of what exists).
- **Broadcast email.** Announcements are in-app only. Bulk marketing email needs unsubscribe handling and Brevo
  list management to stay out of spam folders — deliberately not automated.
- **Refunds** for wallet-/coupon-settled, gifted, sponsored and bulk purchases go through support (self-service
  refund covers the learner's own Chapa course purchases only). The rule engine was not extended to sponsors.

---

## 3. Not implemented — and why

- **Split into separate repos per service / frontend.** Deliberate: both deploy from one repo by root directory
  today and that works; splitting is a repo/CI project, not a feature. Do it after this batch is stable.
- **Supabase (or "other Claude database").** Neon is working and the schema-per-service model is already in place.
  Switching providers buys nothing right now.
- **Dockerize.** Already done — `api/Dockerfile`, `web/Dockerfile`, `docker-compose.yml --profile full`.
- **Video downloads for offline** — see §2.

---

## 4. What you need to do / set up

1. **Merge `deploy/render-vercel` → `main`**, then Render → Blueprint → **Manual sync** (all 8 services). New tables
   are created automatically (`DB_SYNC=true`). New env values are literals in `render.yaml` — nothing to type.
2. **Vercel** redeploys from `main`. No new env vars.
3. **R2 CORS** (only if you want uploads from previews/localhost): add those origins to the bucket policy.
4. **Keep the free services awake** (optional but recommended): add UptimeRobot / cron-job.org pings to each
   `https://ethiopialearn-<service>.onrender.com/health` every 10 minutes. Without this, crons (inactivity nudges,
   abandoned-cart reminders, payout runs) and RabbitMQ consumers only run while the instance is awake.
5. **Nothing else is needed from third parties.** Groq (tutor, quiz grading) and Brevo (email) are already configured.
   Optional knobs, all with defaults: `REFERRAL_REWARD_ETB`, `PURCHASE_CASHBACK_PERCENT`, `BULK_DISCOUNT_TIERS`,
   `INACTIVITY_DAYS`, `INACTIVITY_EMAIL_DAYS`, `STREAM_URLS_PER_MIN` (see `api/.env.example`).

---

## 5. New endpoints (all behind the gateway)

```
POST /coupons · GET /coupons · POST /coupons/:id/deactivate · GET /coupons/validate?code&course_id
GET  /wallet · POST /wallet/topup · POST /admin/wallet/adjust
GET  /referrals/me · POST /referrals/invite · POST /referrals/claim
POST /gifts · POST /pay-requests · GET /pay-requests/:token (public) · POST /pay-requests/:token/pay
GET  /sponsorships/mine · POST /sponsorships/claim
POST /bulk-purchases/quote · POST /bulk-purchases · GET /bulk-purchases/mine · POST /bulk-purchases/:id/assign
GET  /payouts/analytics · GET /admin/analytics/financial
GET  /enrollments/analytics?course_ids · GET /admin/enrollments/analytics · POST /enrollments/:id/changelog-seen
GET  /courses/:id/changelog (public) · POST /courses/:id/changelog
GET/POST /courses/:id/knowledge · POST /courses/:id/knowledge/reindex · DELETE /courses/:id/knowledge/:title
POST /courses/:id/chat · GET /courses/:id/chat · GET /courses/:id/chat/insights
POST /admin/notifications/broadcast
POST /payments/initiate now accepts { coupon_code?, use_wallet? }
POST /assessments quiz config now accepts { max_attempts, cooldown_minutes, shuffle, pool_size, time_limit_minutes, proctored }
```

New events: `SponsorshipGranted`, `SponsorshipInvited`, `PayRequestCreated`, `ReferralInviteSent`,
`PaymentAbandoned`, `WalletCredited`, `BulkPurchaseActivated`, `CourseUpdated`, `CourseProgressMilestone`,
`LearnerInactive`.

---

## 6. If you'd rather prompt these separately next time

This batch was large; here is how I would split a request of this size into independent prompts, each of which
can be built, tested and deployed on its own:

1. *"Fix production: cross-service reads 500 on Render and emails are skipped. Diagnose, fix, verify with a real
   request."* (small, urgent, unblocks everything else)
2. *"Commerce: coupons, wallet with cashback, referrals with rewards. Coupons apply at checkout; wallet can settle a
   purchase; wallet top-ups never reach payouts. Tests for pricing rules."*
3. *"Sponsored access: gifts by email, 'ask someone to pay' with a public pay page, corporate bulk seats with
   volume tiers and seat assignment. One event grants entitlement; sponsors see recipient progress."*
4. *"Engagement: video heartbeat + resume in the player, progress milestones, inactivity ladder (in-app then
   email), abandoned checkout reminder, educator change log with learner notifications and an Updated badge,
   admin announcements, preference toggles."*
5. *"Assessment integrity: per-attempt shuffled paper from a pool, resume-not-restart, server-side time limit,
   attempt limits/cooldown, stream-URL cap + watermark."*
6. *"Course tutor: knowledge base (notes/transcripts + auto outline), full-text retrieval, grounded Groq answers
   with citations, learner chat UI, educator insights."*
7. *"Offline: PWA manifest + service worker, cached reads, progress outbox with replay, offline page."*
8. *"Analytics: educator revenue/funnel page, admin platform dashboard."*

---

## 7. Ideas worth doing next (not built)

- **Audio-only lessons** (20–40× less data) and **adaptive bitrate** — the single biggest reach win in Ethiopia.
- **Learning paths / cohorts** with start dates — the unit an NGO or employer actually buys.
- **Verifiable credentials (Open Badges 3.0)** + employer verification portal on top of the existing signed certificates.
- **Employment outcome surveys** at 3/6/12 months — the number funders ask for.
- **Facilitator role** for blended learning in low-literacy / first-time cohorts.
- **Afaan Oromo, Tigrinya, Somali** UI + content language tags.
- **Real migrations** instead of `DB_SYNC=true` before the schema carries real money.
See `PRODUCT_ROADMAP.md` for the full reasoning on each.
