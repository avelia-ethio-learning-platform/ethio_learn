# Testing pass + fixes — 2026-09-18

Commits on `deploy/render-vercel`: `be1af0f` (security + AI-key), `2da6c1c` (AI study coach + CI gate).
All green: **112 API tests pass** (was 103; +9 new), web typechecks and builds, 12 web tests pass.

---

## 1. The AI issue — it was your key, not the code

**Root cause: the Groq API key is EXPIRED.** I called Groq's API directly with it and got
`{"code":"expired_api_key","message":"Invalid API Key"}`. The quiz/outline generation code was always
correct — it just fell back to placeholder questions because the key it was handed is dead.

**Fix from my side:** the fallback message now says *why* it fell back. An expired/invalid key produces
"an admin needs to rotate GROQ_API_KEY" instead of a generic "AI unavailable", so you'd never have to guess.

**Fix you need to do (2 minutes):**
1. Get a fresh free key at <https://console.groq.com/keys>.
2. Put it in Render → env group `ethiopialearn-shared` → `GROQ_API_KEY`, and redeploy (or Manual sync).
3. Update `.env.production.local` locally too (it's flagged there now).

That single change turns real AI back on for: quiz generation, course-outline generation, viva grading,
written-answer grading, the course tutor chatbot, and the new study coach.

## 2. Security review — findings and fixes

I audited auth, the internal-token trust boundary, IDOR on every new commerce endpoint, pricing integrity,
wallet atomicity, and JWT handling. The new commerce endpoints were clean (wallet uses `ctx.id` not a param,
bulk-assign checks ownership, tutor checks entitlement, admin wallet is platform-admin-only, all prices are
fetched server-side, wallet debits use row locks). Four real gaps found and fixed:

| Finding | Severity | Fix |
|---|---|---|
| **Logout didn't revoke the session** — it only cleared the cookie client-side; the refresh token stayed valid in Redis for up to 7 days. On a shared device the next person could refresh into your account. | High | New `POST /auth/logout` revokes the token server-side; the Header calls it. |
| **Password change / reset didn't sign out other sessions** — a compromised session survived a password reset. | High | `revokeAllSessions()` on password change, reset, admin suspend/ban, and self-deletion. Only the ≤15-min access token can outlive the change. |
| **Admin suspend/ban didn't kick the user immediately** — they kept working until their access token expired and failed to refresh. | Medium | Suspend/ban now revokes all their refresh tokens at once. |
| **JWT algorithm not pinned** — `jwt.verify` accepted any algorithm (alg-confusion surface). | Low (HS256-only today) | Pinned `algorithms:['HS256']` on verify and `algorithm:'HS256'` on sign. |

All four are covered by 4 new unit tests (fake Redis). The gateway's existing defenses were verified intact:
it strips client-supplied `x-user-*`/`x-internal-token` headers, verifies the JWT itself, and every service
re-checks the internal token (`REQUIRE_INTERNAL_TOKEN`).

## 3. Verified working (live where possible, tests otherwise)

- **Video streaming — live against R2.** Signed upload PUT → 200, signed stream GET → 200, and **Range
  requests → 206 with `accept-ranges: bytes`** (this is what makes video seekable and progressively playable).
  The whole upload→store→signed-stream path is production-ready.
- **Gateway + frontend serve** — `https://ethiopialearn-gateway.onrender.com/health` → 200,
  `https://ethio-learn.vercel.app/` → 200. (First request after idle takes ~20s: free-tier cold start.)
- **Everything from the last batch** — the branch is merged to `main` (PR #13) and deployed; the wallet/
  coupon/referral/gift/bulk/tutor routes all answer through the live gateway.
- **112 API tests** cover the security envelope, per-attempt quiz shuffle+grading, wallet pricing rules,
  session revocation, and the new study coach.

### One live-testing caveat
I could not run a full click-through of the live site because Render's **free-tier hibernate rate limiter**
(`x-render-routing: hibernate-rate-limited`) throttles the login endpoint whenever the instance is waking —
independent of our own rate limiter, which still had budget. This is a free-plan infrastructure limit, not a
bug. A keep-alive pinger (see below) removes it. The functional logic is fully covered by the test suite and
the direct R2/gateway/frontend probes above.

## 4. New AI feature — Study Coach

After a quiz, a learner can tap **"Get my study plan"** on the results screen. It takes the exact questions
they got wrong, pulls the course's real lesson outline (new internal `/courses/:id/outline`), and asks the AI
for a short, encouraging, specific review plan that points at real lessons — grounded, never invented. Offline
fallback when the AI is down. New `GET /attempts/:id/study-plan` (learner-owned, AI-rate-limited). 5 tests.

This complements the existing AI surface: quiz generation, outline generation, viva + written grading,
plagiarism screening, and the per-course RAG tutor.

**More AI ideas worth doing next** (not built): AI course recommendations from a learner's history; an
"explain this lesson simpler" button in the tutor; AI-suggested prices/thumbnails/descriptions for educators;
auto-generated lesson summaries and captions; an AI teaching-assistant that drafts replies to course comments
for the educator to approve.

## 5. Google OAuth — already built; here's what to configure

The full "Sign in with Google" flow already exists (backend verifies the Google ID token's signature,
audience and issuer; frontend renders the Google button and only shows it when configured). It's dormant
because no client ID is set. To turn it on:

1. <https://console.cloud.google.com> → APIs & Services → Credentials → Create OAuth client ID → **Web application**.
2. Authorised JavaScript origins: `https://ethio-learn.vercel.app` (and `http://localhost:3000` for dev).
3. Copy the **Client ID** (`…apps.googleusercontent.com`). The client **secret is not needed** (ID-token flow).
4. Set `GOOGLE_CLIENT_ID` in Render (backend) **and** `NEXT_PUBLIC_GOOGLE_CLIENT_ID` in Vercel (frontend) —
   same value. The button appears and works the moment both are set. `.env.production.local` has dummy
   placeholders showing the exact shape.

## 6. CI / workflow improvements

- **gitleaks secret-scan job** added to CI — fails the build on any leaked credential (this repo has had live
  keys pasted into it during development), with `.gitleaks.toml` allowlisting the intentional placeholders and
  demo fixtures. The tracked tree was scanned and is clean.
- Existing CI is already strong (build + typecheck + unit tests + a real-infra e2e smoke + GHCR image publish
  on `main`) and was left intact.

## 7. What you should do now

1. **Rotate the Groq key** (§1) — this is the only thing blocking real AI.
2. Merge `deploy/render-vercel` → `main`, Render → Manual sync (picks up the security fixes + study coach;
   new tables auto-create).
3. Optional but recommended for a "production feel": add an **UptimeRobot / cron-job.org** ping to each
   `https://ethiopialearn-<service>.onrender.com/health` every 5–10 min. This keeps the free instances warm,
   removes the cold-start delay and the hibernate-rate-limit on login, and lets the cron jobs (inactivity
   nudges, abandoned-cart, payouts) actually run on schedule.
4. Optional: configure Google OAuth (§5).
