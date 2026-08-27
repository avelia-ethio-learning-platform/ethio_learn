# EthiopiaLearn — Product & Growth Roadmap

Written 2026-08-01, after the first production deploy (Render + Vercel).
Companion to `HANDOFF.md` (which covers infrastructure state, not product).

**How to read this.** Every item has: *what it is · why it matters in Ethiopia
specifically · how it maps onto the code that already exists · rough effort ·
honest risks*. Effort is T-shirt sized against one competent full-stack dev:
**S** ≈ 1 week, **M** ≈ 2–4 weeks, **L** ≈ 1–3 months, **XL** ≈ a quarter or
more. These are engineering estimates only — several items are blocked on
partnerships or regulation, which is usually the *longer* pole. Where an idea
is speculative or needs validation before building, it says so.

---

## 0. Strategic framing — read this before the feature lists

### 0.1 The honest position today

The MVP is unusually complete for its stage. Already shipped: full course
lifecycle with two-stage review, entitlement-gated signed video URLs, Chapa
payments with HMAC-verified webhooks and a reconciliation sweep, 80/20 revenue
split with settlement holds and KYC gates, HMAC-signed certificates with public
verification, quiz/assessment attempts, trust tiers, a QA review queue, an
event-driven 7-service mesh, and English/Amharic i18n.

That is a *product*, not a prototype. The gap is not features — it is that
**every design decision so far assumes a smartphone with reliable data and a
learner who can pay in birr.** That assumption covers maybe the top 15–20% of
the Ethiopian market. Everything strategic below flows from closing that gap.

### 0.2 The three-market reality

Ethiopia is not one market. Building as if it is will cap this product early.

| Segment | Rough size | Device | Connectivity | Who pays | Current fit |
|---|---|---|---|---|---|
| **Urban connected** — Addis, Bahir Dar, Hawassa, Mekelle; students, junior professionals, diaspora-adjacent | ~10–15M | Smartphone, 4G | Decent, expensive | Self-pay | **Good today** |
| **Peri-urban / small town** — TVET students, teachers, traders, youth in regional capitals | ~25–35M | Entry Android, 3G, shared devices | Intermittent, cost-sensitive | Sponsor or self, small amounts | **Weak** — video cost, no offline |
| **Rural** — ~78% of the population; smallholder farmers, women's groups, out-of-school youth | ~80M+ | Feature phone; shared/borrowed smartphone; often no personal device | Poor to none; power unreliable | Almost never self-pay — donor, government, or employer | **No fit today** |

The rural segment cannot be reached by making the current app lighter. It needs
**different delivery modes entirely** (§2) and **someone other than the learner
paying** (§5). Both are addressable, but they are a different product surface,
not a tweak.

### 0.3 The business-model pivot investors will ask about

Direct-to-consumer course sales in Ethiopia face brutal arithmetic: low
disposable income, a thin card/mobile-money-to-merchant rail, and high customer
acquisition cost. A 500 birr course at 80/20 nets the platform ~100 birr
(≈$0.80 at 2026 rates). At that ARPU, paid B2C acquisition never pays back.

The strategically stronger position — and the one that makes NGO and impact
capital available — is **B2B2C**:

1. **Donor / NGO programs** — an organization sponsors a cohort (§5.1). They
   pay per-learner or per-outcome. Predictable, large, and they *want* the
   reporting burden this platform can uniquely satisfy.
2. **Government / TVET** — alignment with national occupational standards
   (§4.3) makes the platform procurement-eligible for the Ministry of Education
   and regional TVET bureaus.
3. **Employer-sponsored upskilling** — banks, telcos, agro-processors, BPO
   firms paying to train and *verify* staff and pipeline candidates.
4. **B2C** stays — it is the credibility layer, the content flywheel, and the
   diaspora revenue line (§5.4). It just should not be the primary bet.

The existing `Institution` entity and institution-admin role are already ~40% of
the data model for (1) and (3). That is a real head start.

### 0.4 What actually differentiates this product

Be clear-eyed: Coursera, Udemy, YouTube, and TikTok all exist here and are free
or cheap. The defensible position is **not** "online courses in Ethiopia." It is:

- **Verified, employer-trusted local credentials** — the certificate signing +
  public verification + trust-tier machinery is already built and is genuinely
  hard to replicate. This is the moat. Lean into it hard (§4).
- **Works where nothing else works** — offline, low-bandwidth, feature-phone
  (§2). Global platforms will never build this for Ethiopia.
- **Local-language, local-context content** with a paid educator economy that
  makes producing it worthwhile (§3).
- **Donor-grade measurement** built in, not bolted on (§5.2).

Anything that does not strengthen one of those four should be deprioritized.

---

## 1. Foundations to fix first (before any new pillar)

These are not exciting, but several later items are unbuildable without them,
and two are current production risks.

### 1.1 Real database migrations *(effort: S–M · do this first)*

**What.** Replace TypeORM `synchronize: true` with generated, reviewed,
version-controlled migrations.

**Why now.** `HANDOFF.md` §6.3 flags this. `synchronize` infers schema changes
from entity diffs and *will* silently drop or retype a column when an entity
changes. That is survivable with five seeded demo rows. It is catastrophic the
first week real learners have progress and real educators have payout balances.
Every §5 donor-reporting feature depends on historical data that must not
vanish.

**Maps to.** `api/packages/common/src/typeorm/typeorm.ts` (`DB_SYNC` env),
`render.yaml` shared group. Each of the 7 services needs its own migration
directory since each owns a schema.

**Risk if skipped.** Silent data loss with no error and no rollback path.

### 1.2 Backups and a tested restore *(effort: S)*

Neon's free tier history is short. Before real users: automated `pg_dump` to R2
on a schedule, **and one rehearsed restore**. An untested backup is not a backup.

### 1.3 Observability *(effort: S–M)*

Structured JSON logs with `correlation_id` (the event envelope already carries
one — propagate it through HTTP too), error tracking (Sentry free tier), and
uptime checks on the gateway. Right now a production failure is invisible until
a user reports it — as happened repeatedly during deployment.

### 1.4 Move off free-tier Render for the 7 services *(effort: S, cost ~$50/mo)*

`HANDOFF.md` §6.5: free instances sleep after 15 min, and gateway↔service calls
currently cross the public internet because free-tier private networking is
receive-disabled. A cold chain can take 50s+. **No user will wait 50 seconds.**
This single change also lets `fromService` private networking come back, which
removes the public exposure that forced the `REQUIRE_INTERNAL_TOKEN` guard.

### 1.5 Load and cost modelling *(effort: S)*

Before any growth push, know: cost per learner-hour of video at current R2 egress
pricing, and Neon connection headroom at N concurrent services. Video egress is
the line item that kills ed-tech margins, and §2.1/§2.2 are the mitigations.

---

## 2. Pillar A — Reaching rural Ethiopia (the hardest and most valuable work)

This pillar is where the product either becomes nationally significant or stays
an Addis-only app. Ordered by impact-per-unit-effort.

### 2.1 Audio-first mode *(effort: S–M · highest ROI item in this document)*

**What.** For every video lesson, auto-generate a low-bitrate mono audio track
(Opus 24–32 kbps) and offer "Audio only" playback plus download. A 60-minute
lesson: ~300–600 MB as 720p video, **~13–16 MB as audio**. That is a 20–40×
reduction.

**Why Ethiopia.** Mobile data is among the most expensive in the world relative
to income. For a huge share of learners, the binding constraint is not "is there
signal" but "can I afford the megabytes." Audio also works on 2G/EDGE, survives
intermittent connectivity, and lets people learn while working — walking to
market, farming, driving. Much instructional content (business skills, health,
agriculture, language, exam prep) loses very little without the visual track.

**Maps to.** `api/packages/storage/src/index.ts` — the `StorageProvider`
interface already anticipates a transcoding step (README explicitly flags video
transcoding as stubbed behind it). Add an ffmpeg worker triggered off a
`LessonVideoUploaded` event on the existing RabbitMQ bus, writing an `audio_s3_key`
alongside `video_s3_key`. Frontend adds a toggle and a data-size label.

**Effort.** S for the transcode worker + storage key; M including UI, download
management, and a resumable audio player synced to the existing progress
high-water mark.

**Risk.** Some content genuinely needs video (welding, tailoring, software UI).
Let educators mark a lesson "audio-sufficient" rather than assuming.

**Metric.** % of lesson-completions served as audio; mean MB per completed lesson.

### 2.2 Adaptive/ladder bitrate + explicit data budgeting *(effort: M)*

**What.** Transcode each video to 144p / 240p / 360p / 720p. Default to the
lowest tier on cellular. Show **"This lesson ≈ 8 MB"** before playback and a
running "data used this session" figure. Add a hard "Data saver" account setting.

**Why.** Data anxiety suppresses usage more than data cost does. Telling someone
exactly what a lesson will cost them converts far better than an unmarked play
button. Ethiopian users are highly attuned to megabyte cost; making the platform
visibly respectful of that is a trust signal competitors do not send.

**Maps to.** Same transcode worker as §2.1. HLS variant playlists; signed URL
logic unchanged.

**Risk.** Storage and transcode cost multiply per variant. Mitigate: generate
lower tiers eagerly, 720p lazily on first request.

### 2.3 Offline-first PWA with downloadable course packs *(effort: L · flagship)*

**What.** Installable PWA. Learner downloads a whole course (audio/low-res
video + quizzes + text) while on WiFi, learns fully offline for days, and
progress/quiz attempts sync automatically when connectivity returns.

**Why.** This is the single feature that makes the platform usable in most of
Ethiopia — and it doubles as resilience against network shutdowns, which are a
real and recurring risk in this market. It also transforms the economics: one
WiFi session at a school or café powers a week of learning.

**Maps to.**
- Service worker + IndexedDB for content and an outbox queue.
- Progress sync: `enrollment` service already uses a **high-water mark** for
  watch percentage — that is genuinely fortunate, because high-water marks are
  *idempotent and commutative*. Offline replay cannot corrupt them; last-write
  conflicts resolve to `max()`. Quiz attempts need explicit
  `client_attempt_id` idempotency keys, mirroring the existing `tx_ref` pattern
  in payments.
- Certificates must be issued server-side only, on sync — never offline.

**The hard problem — content protection vs offline.** Playback currently relies
on **15-minute signed URLs** gated by a server-side entitlement check
(`course.controller.ts` `streamUrl`). That mechanism is fundamentally
incompatible with offline: the file must sit on the device, decryptable without
a server. Options, honestly ranked:

1. **Encrypted local packs** — download AES-encrypted media; key delivered on
   download, stored in IndexedDB, bound to the account, wiped on logout, packs
   given an expiry requiring periodic re-auth. Defeats casual copying, not a
   determined attacker. **Recommended** — proportionate.
2. **Accept plaintext for audio-only** — audio is cheap to reproduce anyway;
   protect video, leave audio open. Pragmatic and simple.
3. **Full commercial DRM** (Widevine/FairPlay) — correct in theory,
   disproportionate in cost and complexity here, and poorly supported on the
   cheap Android devices that matter most. **Not recommended.**

Decide this explicitly before building — it changes the storage layer.

**Effort.** L. This is the biggest single engineering item here and deserves
its own design doc.

**Metric.** % of active learners with ≥1 downloaded course; completion rate of
downloaded vs streamed courses (expect downloaded to be *much* higher).

### 2.4 Learning hubs — offline server boxes *(effort: M software / L program)*

**What.** A Raspberry Pi (or similar) running a local content mirror + WiFi
hotspot, preloaded with courses, deployed at schools, TVET colleges, woreda
offices, health posts, and community centers. Learners connect over local WiFi
with zero internet and zero data cost. The box syncs new content and uploads
accumulated progress whenever it gets connectivity (or via a periodically
carried USB drive).

**Why.** This is the proven mechanism for genuinely offline populations —
Learning Equality's Kolibri, RACHEL, and BRCK all validate the pattern across
Africa. It converts "no connectivity" from a blocker into a logistics problem,
which is solvable. It is also extremely legible to donors: a hub is a
photographable, countable, fundable unit.

**Maps to.** Needs a sync protocol (batch export/import of course packs and
progress records) — a natural fit for the existing event bus if events are made
replayable. The `Institution` entity is the right owner abstraction for a hub.

**Risk.** Hardware logistics, theft, power, and local maintenance are the real
costs — the software is the easy half. Do not attempt without an implementing
partner who has field presence. Pilot at 3–5 sites before scaling.

**Metric.** Learner-hours per hub per month; cost per learner-hour vs online.

### 2.5 IVR — courses over a normal phone call *(effort: M build / L partnership)*

**What.** Learner dials a number, navigates a voice menu in their language,
listens to lessons, answers quizzes via keypad. Works on **any** phone,
including the cheapest feature phone, with no data at all.

**Why.** This is the only channel that reaches the tens of millions with no
smartphone. Viamo's 3-2-1 service runs exactly this model at national scale
across multiple African countries — the pattern is proven, and partnering may
beat building.

**Maps to.** Content: reuse §2.1 audio. New: an IVR gateway service (an eighth
microservice, or a thin adapter), phone-number-based identity distinct from the
current email/password auth, and keypad-based assessment scoring. Note the
existing auth is email-only with no SMS anywhere — phone identity is a genuine
new subsystem, not a small change.

**Risk / honesty.** The blocker is commercial, not technical: you need a
shortcode and a revenue-share or sponsored-call arrangement with Ethio Telecom
or Safaricom Ethiopia. Budget months for that. **Strongly consider partnering
with Viamo rather than building**, at least to validate demand.

### 2.6 SMS + USSD companion *(effort: M build / L partnership)*

**What.** USSD menu (`*XYZ#`) for: check progress, enroll, get today's lesson
summary, receive a quiz question. SMS for nudges, streaks, and certificate
verification codes.

**Why.** USSD is the interaction paradigm Ethiopians already use daily for
mobile money and airtime. It needs no data, no app, no smartphone, and no
literacy in English. As a *retention* channel layered on the smartphone product,
it may outperform push notifications by a wide margin.

**Risk.** Same telco dependency as §2.5. USSD sessions are stateful, timeout
aggressively, and cap at ~182 characters — a real UX constraint.

### 2.7 Peer-to-peer content sharing *(effort: M)*

**What.** Let a learner who has downloaded a course share it to a nearby device
over local WiFi Direct / hotspot, with the recipient's entitlement checked on
their next sync.

**Why.** Ethiopians already share large files device-to-device constantly
(SHAREit/Xender behaviour is deeply embedded). Meeting that existing habit turns
one expensive download into many free ones and creates organic rural spread.

**Risk.** Entitlement enforcement gets genuinely harder. Pair with §2.3 option 1
or 2. Consider allowing free/freemium content to spread freely and treating that
as *marketing* rather than leakage.

### 2.8 Zero-rating / sponsored data *(effort: S technical / L commercial)*

Negotiate with Ethio Telecom or Safaricom Ethiopia so EthiopiaLearn traffic is
free or discounted. Technically trivial (IP/domain allowlisting); commercially
slow. High leverage — and a strong joint press story for both parties. Pursue in
parallel with §2.5/§2.6 since it is the same counterparty relationship.

---

## 3. Pillar B — Learners and educators (retention and supply)

### 3.1 Language: Afaan Oromo, Tigrinya, Somali *(effort: M per language)*

**What.** Extend beyond the current English/Amharic starter dictionaries to full
UI localization, and — more importantly — build content-side language metadata,
filtering, and discovery.

**Why.** **Afaan Oromo has more first-language speakers than Amharic.** Shipping
Amharic-only quietly excludes the single largest linguistic group in the
country, plus Tigrinya and Somali speakers. This is both a market-size issue and
a political/legitimacy one that matters for government and donor relationships.

**Maps to.** `web/src/lib/i18n.tsx` (dictionaries — mechanical). The real work is
content: language tags on courses, discovery by language, and *incentives for
educators to author in non-Amharic languages* (§3.5).

**Risk.** Amharic and Tigrinya use Ge'ez script; Afaan Oromo and Somali use
Latin. Font, input, and search handling differ. Test Ge'ez rendering on cheap
Android devices specifically.

### 3.2 AI subtitles, transcripts and translation *(effort: M)*

**What.** Auto-transcribe lesson audio, generate subtitles, and offer
machine translation of subtitles into the §3.1 languages, with educator review
before publish.

**Why.** Subtitles massively aid comprehension in a second language, make video
usable with sound off (shared spaces, mosques, classrooms), and — critically —
make content **searchable**. Transcripts are also a very cheap way to serve
text-only learners on terrible connections.

**Maps to.** `api/packages/ai/src/index.ts` already wraps Groq with a clean
`AiAssessor` interface and a mock fallback — extend the same pattern. Whisper
for transcription.

**Risk.** ASR quality for Amharic/Oromo is materially worse than for English.
**Always require educator review before publishing** — never auto-publish
machine transcripts. Budget for it being unusable for some accents/dialects.

### 3.3 Structured learning paths and cohorts *(effort: M)*

**What.** Ordered multi-course programs ("Become a Bookkeeper" = 6 courses +
assessment + certificate). Optional time-boxed **cohorts** with a shared start
date and a group.

**Why.** Single courses have famously poor completion rates. Paths give
direction and a destination; cohorts add social accountability, which is the
strongest known completion lever short of a human tutor. Paths also package
naturally as the unit an NGO or employer buys (§5.1).

**Maps to.** New aggregate over existing courses; certificates already exist and
extend naturally to a path-level credential.

### 3.4 Facilitator / blended-learning mode *(effort: M–L)*

**What.** A role for a local facilitator who convenes a physical group, marks
attendance, tracks group progress, and escalates questions — with a dedicated
low-bandwidth dashboard.

**Why.** For first-time learners, low-literacy learners, and women's groups,
pure self-directed online learning has very low completion. A trained local
facilitator is the difference between 10% and 60% completion. This is also
exactly the delivery model NGOs already fund and staff, so it plugs into
existing donor programming rather than asking them to change.

**Maps to.** A 6th role alongside the existing five. Reuse `Institution` and the
instructor-invite flow. Pairs naturally with hubs (§2.4) and cohorts (§3.3).

### 3.5 Educator economics and tooling *(effort: M, several parts)*

Supply is as much a constraint as demand — without local-language content the
platform is empty. Concretely:

- **Mobile-money payouts** (telebirr / M-PESA) rather than bank-only. Most
  Ethiopian educators are not comfortably banked. Extends the existing payout
  machinery in `financial`.
- **Faster settlement for high-trust educators** — the trust-tier system already
  exists and already varies holds (7 vs 14 days). Make speed an explicit,
  visible reward for quality.
- **Record-on-phone tooling** — guidance and in-app capture tuned for a phone
  camera. Most local educators will never own a DSLR or a studio.
- **AI course-quality coach** — pre-submission feedback on structure, pacing,
  audio quality, and assessment coverage, reusing the Groq integration. Reduces
  QA review load *and* raises quality; the review queue already exists to
  measure the effect.
- **Bounties for priority content** — the platform (or a donor) pays a fixed fee
  for a specific needed course in a specific language. This is the fastest way
  to fill catalogue gaps in Afaan Oromo, and it is very fundable.

### 3.6 Completion and habit mechanics *(effort: S–M)*

Streaks, weekly goals, resume-where-you-left-off nudges (the high-water mark is
already tracked — surface it), and certificate progress bars. Deliver nudges via
SMS (§2.6) where push is unreliable.

**Caveat.** Gamification is easy to overdo and can feel patronizing to adult
learners. Prefer *progress made legible* over points and badges. Validate with
users before investing heavily.

### 3.7 Accessibility and low-literacy mode *(effort: M)*

Icon-driven navigation, audio labels on key actions, high-contrast and
large-text modes, full screen-reader semantics, and captions (§3.2).

**Why.** Beyond being right: disability inclusion is an explicit funding
criterion for most major donors, and low-literacy support materially widens the
rural market. Cheap to do early, expensive to retrofit.

---

## 4. Pillar C — Credentials, trust and employment outcomes (the moat)

This pillar is what makes the platform matter to employers, government, and
funders — and it is the area where the existing codebase is furthest ahead.

### 4.1 Upgrade certificates to open, verifiable credentials *(effort: M)*

**What.** Move from bespoke HMAC-signed certificates to **W3C Verifiable
Credentials / Open Badges 3.0**, keeping the existing public verification page.

**Why.** The current design (signed `certificate_uid`, QR to `/verify/{uid}`,
trust-tier snapshot, tamper-checking endpoint) is genuinely good and already
does the hard part. Moving to an open standard makes credentials portable into
LinkedIn, employer ATS systems, and government skills registries — and makes
them *legible to institutions that will never trust a proprietary format*. This
converts an internal feature into an ecosystem asset.

**Maps to.** `api/services/outcomes` certificate service. The signing, UID, and
verification endpoint largely survive; the payload format and key management
change.

### 4.2 Employer verification portal + talent directory *(effort: M)*

**What.** A public/employer surface to verify a credential in one step, plus —
with explicit learner opt-in — a searchable directory of credential-holders by
skill and region.

**Why.** Closes the loop that makes credentials *valuable* rather than
decorative. It is also a natural second revenue line (employer subscriptions)
and a powerful acquisition story for learners: "employers actually look here."

**Risk.** Privacy and consent must be explicit, granular, and revocable.
Learners must never be listed by default.

### 4.3 Map courses to national TVET occupational standards *(effort: M–L)*

**What.** Tag courses and assessments against Ethiopian TVET occupational
standards and units of competence.

**Why.** This is the bridge to government procurement and to formal recognition
of prior learning. A certificate that maps to a recognized national standard is
worth vastly more to a learner than a platform-branded one, and it makes the
platform legible to the Ministry of Education and regional TVET bureaus.

**Risk.** Requires real domain expertise and sustained institutional
relationship-building. Do not attempt to infer the mapping with AI; get it
validated by a TVET body or it is worthless — arguably harmful.

### 4.4 Employment outcome tracking *(effort: M)*

**What.** Follow up with graduates at 3 / 6 / 12 months (SMS + in-app):
employed? self-employed? income change? Track against cohorts and programs.

**Why.** **This is the number every funder and impact investor actually cares
about.** Mastercard Foundation's Young Africa Works is explicitly framed around
*jobs*, not enrollments. A platform that can credibly report "of 1,200 women who
completed bookkeeping in Oromia, 38% reported new or increased income at 6
months" is in a completely different funding category than one reporting course
completions. Almost no ed-tech platform in the region can do this well.

**Maps to.** New surveys/outcomes domain; SMS delivery via §2.6.

**Risk.** Self-reported data is weak evidence and response rates decay fast.
Be honest about methodology in reporting; consider third-party verification for
flagship claims. Do not overstate causality — completion correlating with
employment is not proof the course caused it.

### 4.5 Proctoring appropriate to the context *(effort: S–M)*

Webcam proctoring exists in the codebase but is a poor fit for low-bandwidth
users. Better ladder: **oral viva** (already built, AI-graded — genuinely well
suited here and cheap in bandwidth), randomized item banks, and
**facilitator-proctored or hub-proctored in-person exams** (§2.4, §3.4) for
high-stakes credentials. Make integrity proportionate to stakes rather than
uniform.

---

## 5. Pillar D — Institutions, NGOs and funders

### 5.1 Sponsored programs and cohort management *(effort: M–L · highest commercial value)*

**What.** A first-class "Program" object: a funder creates a program, defines a
cohort (say 500 women in Oromia, aged 18–30), bulk-invites or bulk-enrolls
learners with **payment bypassed** (the sponsor has paid), assigns facilitators
and learning paths, sets a budget, and gets a live dashboard.

**Why.** This is the primary B2B2C monetization path (§0.3) and it is currently
the biggest gap between what the platform *can* do and what funders need to buy.
Right now, enrollment is entitlement-gated on a confirmed payment — an NGO
cannot cleanly sponsor 500 people at once.

**Maps to.** Builds on `Institution` + the instructor-invite flow. Critically,
it needs a **sponsored entitlement path** in `enrollment` that grants access
without a `PaymentConfirmed` event — architecturally clean (a new event type,
`SponsorshipGranted`), but it touches the most safety-critical invariant in the
system, so it needs careful design and tests. Do **not** hack it by faking
payment events.

**Effort.** M for basic bulk enrollment; L with budgets, facilitators, and
dashboards.

### 5.2 Impact measurement and donor reporting *(effort: M)*

**What.** Disaggregated reporting — by gender, age band, region/woreda,
disability status, urban/rural — over enrollment, completion, assessment
outcomes, credentials, and §4.4 employment follow-ups. Exportable to CSV/PDF on
the reporting cycles donors actually use (quarterly, annual).

**Why.** Every donor mandates disaggregated M&E reporting; most implementing
partners produce it by hand in spreadsheets, painfully. A platform that emits it
automatically is *dramatically* easier to fund and to renew. Map indicators to
SDG 4 (quality education), SDG 5 (gender equality), and SDG 8 (decent work)
explicitly — that is the vocabulary funding decisions are written in.

**Risk.** Collecting sensitive demographic data creates real obligations:
minimize, get informed consent, and be careful about disability and any
ethnicity-adjacent fields, which are politically sensitive in Ethiopia. Collect
only what a specific funded program actually requires.

### 5.3 Partner API and white-labelling *(effort: M–L)*

Let an NGO or government body run programs under their own branding on shared
infrastructure. The service architecture and `Institution` model already suit
multi-tenancy. Opens revenue without proportional CAC — but do not build ahead
of a signed first partner.

### 5.4 Diaspora sponsorship marketplace *(effort: M · genuinely novel here)*

**What.** Let an individual — especially in the Ethiopian diaspora — sponsor a
named or anonymous learner's course or full path, with progress updates and the
resulting certificate shared back to the sponsor.

**Why.** Ethiopian diaspora remittances run into the billions of dollars
annually, and a large share is already directed at education for relatives.
This channels an existing, enormous, emotionally-motivated money flow into a
product-native mechanism — and it is a genuinely fresh idea in this market, not
a copy of an existing platform. It also gives a hard-currency revenue line,
which matters given birr volatility and FX constraints.

**Risk.** Needs international card acceptance (Chapa's coverage here needs
checking) and careful safeguarding: never expose minors, never expose precise
locations, make anonymity the default, and be alert to the paternalism failure
mode of "sponsor a poor child" marketing. Design it with dignity.

---

## 6. Pillar E — Technical and platform advances

### 6.1 Search that works *(effort: M)*
Full-text search across titles, descriptions, and — once §3.2 lands —
transcripts, with Amharic/Ge'ez tokenization and typo tolerance. Postgres
full-text is likely sufficient before adding a dedicated engine.

### 6.2 Recommendations *(effort: M)*
"Next course," "learners like you," skill-gap suggestions from assessment
results. Start with simple heuristics over collaborative filtering — the data is
sparse at this stage and a simple rule beats an undertrained model.

### 6.3 AI tutor in local languages *(effort: M–L · validate before building)*
A conversational tutor answering questions about lesson content in Amharic or
Afaan Oromo, grounded in the transcript (RAG) rather than free-generating.

**Risk, stated plainly.** Current LLM quality in Amharic and especially Afaan
Oromo is materially weaker than in English, and a confidently wrong tutor is
worse than none — particularly for health or agricultural content where bad
advice causes real harm. Strictly ground answers in course material, show
sources, make "I don't know" a first-class response, and pilot narrowly with
human review before broad release. Do **not** ship this as a headline feature
on the assumption it will work.

### 6.4 Live sessions and webinars *(effort: M)*
Scheduled live classes with recording. Bandwidth-hostile, so make audio-only
attendance and a recorded fallback first-class. Valuable for cohorts (§3.3) and
for employer training.

### 6.5 Assessment depth *(effort: M)*
Beyond quizzes and viva: practical/project submissions with rubric grading, peer
review, and portfolio artifacts. Especially important for TVET-aligned
credentials (§4.3) where competence is demonstrated, not recalled.

### 6.6 Payments breadth *(effort: M)*
Direct telebirr and M-PESA where fees beat Chapa's; **cash-voucher / scratch-card
enrollment** sold through kiosks and agents (essential for the unbanked, and a
proven distribution model in East Africa); installment payments; agent-assisted
enrollment where a shop owner enrolls a learner for cash.

### 6.7 Security and privacy maturity *(effort: M, ongoing)*
The `x-user-*` header-trust incident in `HANDOFF.md` §4.5 is a warning worth
generalizing: **the architecture assumes a trusted network boundary, and any
deployment change can invalidate that.** Warranted next: an external
penetration test before any large cohort onboards, a documented data-retention
policy, learner data export/deletion, and a considered position on Ethiopian
data-residency expectations for government and donor work.

---

## 7. Funder-specific positioning

### 7.1 Mastercard Foundation

Their Ethiopia work runs through **Young Africa Works**, oriented to dignified
work for young people — with an explicit emphasis on **young women**, and on
*employment outcomes* rather than training volume.

**What to lead with:** §4.4 employment tracking, §5.1 sponsored cohorts, §5.2
disaggregated reporting, §3.4 facilitator model, and §2.x rural reach. Frame the
ask as **cost per young person in improved work**, not per enrollment. Be ready
to disaggregate by gender at every level and to explain deliberate design
choices that improve access for young women — offline access to shared devices,
audio mode, facilitated women's groups.

**What will sink it:** enrollment vanity metrics, an Addis-only footprint, and
no credible outcome measurement.

### 7.2 Development finance / bilateral donors (World Bank, GIZ, USAID-type, EU)

Lead with §4.3 TVET-standard alignment, government partnership, and system
strengthening. These funders buy *institutional capacity*, not apps. §5.3
white-labelling matters here.

### 7.3 Impact investors and commercial VC

Lead with §0.3 B2B2C unit economics, retention curves, the §4 credential moat,
and evidence that CAC is repaid by B2B contracts rather than B2C sales. Be
honest that B2C ARPU in Ethiopia is structurally low; the investable story is
sponsor-paid distribution with consumer-grade product quality.

### 7.4 Corporates and telcos

Ethio Telecom / Safaricom: zero-rating (§2.8) plus co-branded skills content is
a mutually good story. Banks and insurers: financial-literacy content plus
verified credentials as CSR *and* pipeline. Agro-processors and BPOs: verified
skills pipelines (§4.2).

---

## 8. Suggested sequencing

Deliberately narrow. The failure mode for a product this feature-complete is
building in twelve directions at once.

**Phase 0 — Stabilize (next 4–6 weeks).**
§1.1 migrations, §1.2 backups, §1.3 observability, §1.4 paid instances.
*Nothing else until this is done.* Then get 50–100 real users on the current
product and watch what actually breaks.

**Phase 1 — Make it usable in Ethiopia (2–3 months).**
§2.1 audio-first, §2.2 data budgeting, §3.6 habit mechanics, §6.1 search.
Highest impact-per-effort in the document. Audio-first alone may move
completion more than anything else here.

**Phase 2 — Make it fundable (3–4 months, overlapping).**
§5.1 sponsored programs, §5.2 impact reporting, §4.4 outcome tracking,
§3.3 paths and cohorts. This is what converts the product into contracts.
Start funder conversations *during* this phase, not after — their requirements
should shape it.

**Phase 3 — Make it reach everyone (4–6 months).**
§2.3 offline PWA (flagship), §3.1 Afaan Oromo, §3.4 facilitators, §4.1
verifiable credentials.

**Phase 4 — Ecosystem (opportunistic, partnership-gated).**
§2.4 hubs, §2.5 IVR, §2.6 USSD, §2.8 zero-rating, §4.3 TVET alignment,
§5.4 diaspora sponsorship. Each is gated on a relationship — begin those
conversations early since they run on institutional, not engineering, timelines.

---

## 9. Metrics worth instrumenting now

Instrument before you need them; retrofitting analytics loses the baseline.

- **Activation** — % of signups completing one lesson within 7 days.
- **Completion** — by course, by delivery mode (streamed vs downloaded vs
  audio), by facilitated vs self-directed. Expect large gaps; that is the point.
- **Cost per completed lesson** — egress + transcode + infra. Watch §2.1 drive
  it down.
- **Educator supply** — new educators/month, time-to-first-published-course,
  QA rejection rate, median educator earnings.
- **Credential utility** — verifications per certificate issued (are employers
  actually checking?).
- **Outcome** — §4.4 employment/income change at 6 months. The number that
  raises money.
- **Reach equity** — share of learners outside Addis; share female; share on
  2G/3G. If these do not move, the rural strategy is not working regardless of
  total growth.

---

## 10. Risks to hold in view

- **Connectivity and shutdowns** — network disruption is a recurring reality in
  Ethiopia. §2.3/§2.4 are the mitigation, and also a resilience story worth
  telling funders.
- **Currency and FX** — birr volatility and hard-currency access affect pricing,
  payouts, and hosting costs. §5.4 provides some natural hedge.
- **Regulatory** — data protection, education/credential accreditation, and
  telecom licensing all touch this product. Get local legal advice before §2.5,
  §2.6, and §4.3.
- **Political and regional sensitivity** — language, ethnicity, and regional
  targeting are consequential in Ethiopia. Language coverage (§3.1) is partly a
  legitimacy question. Avoid demographic data collection that could be misused.
- **Content quality at scale** — the QA queue works at current volume; it will
  not survive 10× without §3.5's AI pre-screening and more reviewers.
- **Over-building ahead of demand** — the biggest risk here. This document is a
  menu, not a plan. Nearly every item should be validated with real users or a
  signed partner before full implementation. The MVP is already ahead of its
  evidence base; the next phase should close that gap rather than widen it.
