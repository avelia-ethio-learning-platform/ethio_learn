# EthiopiaLearn — API Reference (Frontend)

Every request goes through the **API Gateway**.

- **Base URL:** `http://localhost:4000/api/v1` (set `NEXT_PUBLIC_API_URL` in prod)
- **Content-Type:** `application/json` for all bodies
- **Auth header:** `Authorization: Bearer <access_token>` for `[jwt]` routes
- **Access token:** JWT, 15-min lifetime. On `401`, call `POST /auth/refresh` (uses the httpOnly `el_refresh` cookie) to get a new one, then retry.
- **Refresh token:** httpOnly cookie `el_refresh`, set by `login` / `refresh` / `accept-invite`. Always send credentials (`fetch(..., { credentials: 'include' })`) to auth routes.
- **Error shape (all failures):**
  ```json
  { "statusCode": 400, "message": "human readable or [field errors]", "error": "Bad Request" }
  ```
- **Auth legend:** `[public]` no token · `[jwt]` any logged-in user · `[jwt: role]` role-restricted · `[internal]` service-to-service only — **do not call from the frontend.**
- **Rate limits (per minute, keyed per user — per IP when anonymous):** 300 overall · 10 on credential endpoints (login/signup/reset/verify) · 30 on the rest of `/auth` · 5 on AI generation · 20 on comment/DM writes · 10 on `POST /payments/initiate` · 60 on other mutations. Exceeding one returns `429 { "statusCode": 429, "message": "Too many requests — please slow down and try again shortly." }` with `RateLimit-*` headers — back off until the window resets.

### Strong-password rule
Applies to signup, reset, change, and accept-invite `new_password`: **≥ 8 chars and ≥ 3 of** {lowercase, uppercase, number, symbol}.

### Enums
| Enum | Values |
|---|---|
| `role` | `learner`, `educator`, `institution_admin`, `quality_officer`, `platform_admin` |
| `user status` | `active`, `suspended`, `banned` |
| `course status` | `draft`, `institution_review`, `submitted`, `under_review`, `published`, `flagged`, `unlisted`, `archived` |
| `pricing_type` | `free`, `freemium`, `paid` |
| `category` | `tech`, `business`, `freelancing`, `healthcare`, `other` |
| `entitlement_status` | `none`, `active`, `refunded` |
| `assessment type` | `quiz`, `ai_viva`, `project` |
| `qa decision action` | `approve`, `coach`, `flag` |
| `trust_tier` | `new`, `proven`, `trusted` |

---

## 1. Auth & Identity

### `POST /auth/signup` `[public]`
Create a learner / educator / institution account. Sends a verification email.
```json
// request
{ "name": "Abebe K", "email": "a@example.com", "password": "Str0ng!pass", "role": "learner" }
// role ∈ learner | educator | institution_admin
// response 201
{ "user_id": "uuid" }
```

### `POST /auth/verify-email?token=<token>` `[public]`
Confirm email from the link. → `{ "message": "Email verified. You can now log in." }`

### `POST /auth/login` `[public]`
```json
// request
{ "email": "a@example.com", "password": "Str0ng!pass" }
// response 200 (also sets el_refresh cookie)
{ "access_token": "jwt", "expires_in": 900,
  "user": { "id": "uuid", "name": "Abebe K", "email": "a@example.com", "role": "learner", "must_change_password": false } }
```
> If `user.must_change_password` is `true`, route the user to set a new password before continuing.

### `POST /auth/google` `[public]`
```json
// request — the Google ID token from Google Identity Services (client-side)
{ "id_token": "<google-id-token-jwt>" }
// response 200 (identical shape to /auth/login, also sets el_refresh cookie)
{ "access_token": "jwt", "expires_in": 900, "user": { … } }
```
The server verifies the token with Google (audience must equal `GOOGLE_CLIENT_ID`), then finds or creates a verified learner account and issues an EthiopiaLearn session. Returns `401` if Google sign-in isn't configured or the token is invalid. See `web/.env.example` (`NEXT_PUBLIC_GOOGLE_CLIENT_ID`) and `api/.env.example` (`GOOGLE_CLIENT_ID`).

### `POST /auth/refresh` `[public, cookie]`
No body; reads the `el_refresh` cookie. Returns the same shape as `login` and rotates the cookie.

### `GET /auth/invite/:token` `[public]`
Look up an invitation (staff or institution instructor) so the accept page can greet the user.
→ `{ "email": "...", "name": "...", "role": "quality_officer" }` (or `400` if invalid/expired)

### `POST /auth/accept-invite` `[public]`
Invitee sets their **own** password and is logged straight in (admins never set passwords).
```json
// request
{ "token": "<from invite link>", "new_password": "MyOwn!pass1" }
// response 200 — same shape as login (access_token + user), sets el_refresh cookie
```

### `POST /auth/reset-password` `[public]`
`{ "email": "a@example.com" }` → `{ "message": "Reset email sent if account exists" }` (never leaks existence)

### `POST /auth/reset-password/confirm` `[public]`
`{ "token": "...", "new_password": "New!pass12" }` → `{ "message": "Password updated..." }`

---

## 2. Profiles  `[jwt]`

### `GET /profiles/me`
→ `{ id, name, email, role, phone, email_verified, created_at, educator_profile, institution }`
(`educator_profile` set only for educators, `institution` only for institution admins.)

### `PUT /profiles/me`
```json
{ "name": "New Name", "phone": "0911...", "bio": "...", "expertise_area": "...", "photo_url": "..." }
// all optional; bio/expertise/photo apply to educators
```

### `PUT /profiles/password`
`{ "new_password": "New!pass12" }` (strong) — first-login or self-service change. → `{ "message": "Password changed." }`

### `DELETE /profiles/me`
`{ "password": "current password" }` — permanent self-service account deletion (any role). Personal data (email, name, phone, credentials) is anonymized in place and the account locked; ledger/enrollment/certificate rows survive under the anonymized id. Educators/institutions with **published** courses get a `400` — unpublish or archive first. Wrong password → `401`. → `{ "deleted": true, "message": "…" }`

### `POST /profiles/educator` `[jwt: educator]`
`{ "bio": "...", "expertise_area": "Web Development", "photo_url?": "...", "sample_video_url?": "..." }`

### `POST /profiles/institution` `[jwt: institution_admin]`
`{ "name": "Addis Coding Center", "logo_url?": "..." }` → institution

### `POST /institutions/:id/instructors` `[jwt: institution_admin]`
Add an instructor, resolving the email safely so accounts are never duplicated:
- **New email** → educator account created + one-time set-password link emailed (`invited: true`).
- **Existing learner** → upgraded to educator so they can author; enrollments/learning are kept; they're notified to sign in again (`upgraded: true`).
- **Existing independent educator** → affiliated; courses they already own stay independent, only NEW courses route through the institution's review + payout.
- **Platform staff / institution owner** → rejected with `400`.
```json
// request
{ "email": "teacher@x.com", "name": "Sara T", "role_in_org?": "instructor" }
// name required only for a brand-new account
// response
{ "id": "uuid", "user_id": "uuid", "role_in_org": "instructor",
  "invited": false, "upgraded": true, "instructor_email": "teacher@x.com" }
```

### `GET /institutions/:id/instructors` `[jwt: institution_admin | platform_admin]`
→ `[ { id, user_id, role_in_org, name, email, status } ]`

### `POST /institutions/:id/instructors/:userId/status` `[jwt: institution_admin]`
Moderate an instructor: `{ "status": "suspended" | "banned" | "active", "reason?": "..." }` → `{ user_id, status }`

---

## 3. Admin — User Management  `[jwt: platform_admin]`

### `GET /admin/users?q=&role=&page=1&limit=20`
→ `{ total, items: [ { id, name, email, role, email_verified, status, status_reason, must_change_password, created_at } ] }`

### `POST /admin/users/:id/status`
Ban / suspend / reactivate any user (cannot target yourself).
`{ "status": "banned" | "suspended" | "active", "reason?": "..." }` → `{ id, status, status_reason }`

### `POST /admin/users/staff`
Provision a QO / platform admin. **No password** — an invite link is emailed; they set their own.
`{ "email": "...", "name": "...", "role": "quality_officer" | "platform_admin" }` → `{ user_id, invited: true }`

### `POST /admin/users/:id/verify-email`
Force-verify an account. → `{ "message": "verified" }`

---

## 4. Catalog & Courses  (course-service)

### `GET /search?q=&category=&pricing_type=&sort=&page=1&limit=12` `[public]`
Published catalog (cached ~30s). → `{ total, page, sort, items: [courseSummary] }`

`sort`: `top` *(default — Bayesian-weighted rating: a lone 5★ can't outrank fifty 4.8★)* · `popular` (enrollments) · `new` · `price_asc` · `price_desc`

**`courseSummary`:** `{ id, title, description, category, language, thumbnail_url, pricing_type, price_etb, owner_id, owner_type, published_at, rating_avg, rating_count, enrolled_count }`

### `GET /educators/top?limit=12` `[public]`
Top-educators leaderboard, ranked by **total rating points** (sum of every star across all their courses), enrollments as tiebreaker.
→ `[ { educator_id, name, course_count, total_rating_points, rating_count, average_rating, learner_count } ]`

### `GET /educators/:id/profile` `[public]`
Educator public profile. → `{ educator_id, name, bio, expertise_area, course_count, total_rating_points, rating_count, average_rating, learner_count, courses: [courseSummary] }` (`404` if they have no published courses)

### `GET /courses/:id` `[public]`
Full detail. Owners/QO/admin can view their own unpublished courses. Video keys are never exposed.
```json
{ ...courseSummary, "status": "published",
  "instructor_id": "uuid", "instructor_name": "…",   // course author (public)
  "sections": [ { "id", "title", "order", "is_free_preview",
    "lessons": [ { "id", "title", "summary", "duration_seconds", "order", "has_video" } ] } ],
  // Owner/staff ONLY (null for learners): latest reviewer feedback shown on the course page.
  "review_feedback": { "action": "coach"|"flag"|"approve"|"institution_reject",
                       "notes": "…", "reviewed_at": "ISO" } | null }
```

### `GET /courses` `[jwt: educator | institution_admin]`
List your own courses. → `[ courseSummary + { status } ]`

### `POST /courses` `[jwt: educator]`  (institution admins are blocked — instructors author)
```json
{ "title": "…(4-120)", "description": "…(20-2000)", "category": "tech",
  "language": "en", "thumbnail_url?": "...", "pricing_type": "paid",
  "price_etb?": 500,               // required if pricing_type = paid
  "sections?": [ { "title", "is_free_preview": false,
                   "lessons?": [ { "title", "video_s3_key?", "duration_seconds?" } ] } ] }
// → courseDetail
```

### `PUT /courses/:id` `[jwt: educator | institution_admin | platform_admin]`
Any of: `{ title?, description?, category?, thumbnail_url?, pricing_type?, price_etb? }`
- **draft** → edits the course directly.
- **published / unlisted** → the change is **staged** (see *Staged changes to a live course*); learners keep the approved version.
- **submitted / under_review / institution_review**, or a staged change set that is in review → `409` ("withdraw it to make changes").
- **flagged / archived** → `400`.
The same rules apply to every section/lesson/tutor-note write below.

### `GET /courses/:id/working` `[jwt: owner | institution_admin of the course | platform_admin]`
The educator's **working copy**: the live course with staged changes merged in. The teach page edits this.
```json
{ ...courseSummary (merged), "status": "published", "review_feedback": { … } | null,
  "pending_fields": ["title"],                 // course fields that differ from live
  "has_pending_changes": true,
  "revision": { "id", "status": "draft"|"institution_review"|"submitted", "changelog_summary",
                "major", "submitted_at", "decision_notes" } | null,
  "pending_assessments_count": 1, "pending_knowledge_count": 0,
  "sections": [ { "id", "title", "order", "is_free_preview",
                  "pending_state": "added"|"removed"|null, "changed_fields": ["title"],
                  "lessons": [ { "id", "title", "summary", "duration_seconds", "order", "has_video",
                                 "video_pending": false, "pending_state": null, "changed_fields": [] } ] } ] }
```

### Lifecycle actions `[jwt: educator]`  (POST, no body unless noted)
| Endpoint | Effect |
|---|---|
| `POST /courses/:id/submit` | draft → `submitted` (solo) or `institution_review` (institution instructor) |
| `POST /courses/:id/withdraw` | submitted/under_review/institution_review → `draft` (also removes it from the QO queue) |
| `POST /courses/:id/unpublish` | published → `unlisted` |
| `POST /courses/:id/republish` | unlisted → `published` |
| `POST /courses/:id/appeal` | flagged → `submitted`. Body: `{ "note": "…(10-2000)" }` |
| `POST /courses/:id/duplicate` | copies course+sections+lessons as a new `draft` |
| `POST /courses/:id/archive` | draft/unlisted → `archived` (closes an open change set) |
| `POST /courses/:id/restore` | archived → `draft` |

### `POST /courses/generate-structure` `[jwt: educator | institution_admin | platform_admin]`  ✨ AI
Draft an outline from a prompt and/or document text. PDF/DOCX are parsed **in the browser** (pdf.js / mammoth) and condensed to a **digest** — `DOCUMENT OUTLINE (authoritative order):` (one heading per line, 2-space indent per level) then `EXCERPTS:` — that fits `source_text` (≤ 30 000 chars; the model reads the first 24 000). Nothing is saved — the educator edits it, then applies it.
```json
// request
{ "title": "Mobile Money for Merchants",
  "prompt?": "practical course for shop owners",
  "source_text?": "…extracted PDF/DOCX/notes text…",
  "section_count?": 4, "lessons_per_section?": 3,
  "level?": "beginner" | "intermediate" | "advanced",
  "learning_style?": "hands-on" }
// response
{ "sections": [ { "title", "is_free_preview", "lessons": [ { "title", "summary" } ] } ],
  "ai_live": true,     // false = offline draft (no GROQ_API_KEY, or AI was unavailable)
  "origin": "model" | "headings" | "placeholder",   // headings = built from the document's own headings
  "note?": "AI is offline — this is a starter outline built from your document's headings; edit it." }
// Never 500s: if the AI call fails, it returns an editable starter outline + `note`.
```

### `POST /courses/:id/apply-structure` `[jwt: educator | institution_admin | platform_admin]`
Apply a generated outline in **one atomic call** (one transaction) — sections, lessons and their `summary` lines land together, or nothing does. 1–12 sections, ≤ 12 lessons each. On a live course they are staged.
```json
// request
{ "sections": [ { "title", "is_free_preview",
                  "lessons": [ { "title", "summary?", "duration_seconds?" } ] } ] }
// response
{ "applied": true, "sections_added": 4, "lessons_added": 12 }
```

### Sections & lessons `[jwt: educator | institution_admin | platform_admin]`
| Endpoint | Body | Result |
|---|---|---|
| `POST /courses/:id/sections` | `{ title, is_free_preview, lessons? }` | section |
| `PUT /sections/:id` | `{ title?, is_free_preview? }` | section |
| `POST /sections/:id/lessons` | `{ title, summary?, video_s3_key?, duration_seconds? }` | lesson |
| `PUT /lessons/:id` | `{ title?, summary?, duration_seconds?, video_s3_key? }` | lesson |
| `DELETE /lessons/:id` | — | `{ deleted: true, staged }` (`staged: true` = marked for removal on a live course) |
| `DELETE /sections/:id` | — | `{ deleted: true, staged }` |

`video_s3_key` must be a key under the **course author's** upload prefix that exists in storage (use the key an upload returned) — otherwise `400`.

### Staged changes to a live course `[jwt]`
| Endpoint | Who | Result |
|---|---|---|
| `GET /courses/:id/revisions/current/diff` | owner, QO, platform admin, the course's institution admin | the focused diff below; `404` = nothing staged; `503` = the new assessments could not be loaded (retry — never approve without them) |
| `POST /courses/:id/revisions/submit` | owner | body `{ summary?: string (≤1000, the change-log line), major?: boolean (notify enrolled learners) }` → `{ revision_id, status: "submitted" \| "institution_review" }`; `400` "There are no changes to submit." |
| `POST /courses/:id/revisions/withdraw` | owner | back to `draft` (editable), leaves the QO queue |
| `POST /courses/:id/revisions/discard` | owner | throws the staged changes away → `{ discarded: true }` |
```json
// diff
{ "revision": { … } | null, "course": { "id", "title", "status", "thumbnail_url" },
  "metadata": [ { "field": "title", "before": "…", "after": "…" } ],
  "sections": { "added": [ { "id", "title", "is_free_preview", "lessons": [ … ] } ], "removed": [ { "id", "title" } ],
                "changed": [ { "id", "before": { "title", "is_free_preview" }, "after": { … } } ] },
  "lessons":  { "added": [ { "id", "section_id", "section_title", "title", "summary", "has_video" } ],
                "removed": [ { "id", "section_title", "title" } ],
                "changed": [ { "id", "section_title", "title_before", "title_after", "summary_before", "summary_after",
                               "duration_before", "duration_after", "video_replaced" } ] },
  "knowledge_added": [ { "title", "chars", "excerpt" } ],
  "pending_assessments": [ { "id", "type", "is_required", "pass_score", "question_count", "questions": [ … answer keys … ] } ],
  "diff_summary": { "fields_changed": [], "sections_added": 1, "lessons_removed": 1, "videos_replaced": 0, "price_from", "price_to", … },
  "empty": false }
```
On approve the change set is applied atomically; the course keeps its status (`published`/`unlisted`) and `published_at`.

### `POST /uploads` `[jwt: educator | institution_admin | platform_admin]`
Small files in one signed `PUT` (thumbnails/photos ≤ 5 MiB as jpeg/png/webp; videos < 16 MiB). The signed URL enforces the declared `size` and `content_type` — send exactly that `Content-Type` on the PUT.
```json
// request
{ "kind": "video" | "thumbnail" | "photo", "filename": "intro.mp4", "content_type": "video/mp4",
  "size": 734003, "lesson_id?": "uuid" }     // lesson_id (videos): keys the object under the course author
// response
{ "upload_url": "https://…signed…", "key": "videos/…" }   // store `key` on the lesson/course
```

### Resumable video uploads (multipart) `[jwt: educator | institution_admin | platform_admin]`
Bytes go straight to R2 in parts; the API only signs and assembles. `web/src/lib/upload.ts` implements the client.
| Endpoint | Body | Result |
|---|---|---|
| `POST /uploads/multipart` | `{ kind: "video", filename, size (≤ MAX_VIDEO_UPLOAD_BYTES, default 2 GiB), content_type: mp4\|webm\|quicktime\|x-m4v, lesson_id? }` | `{ session_id, key, part_size (≥ 8 MiB), part_count, size }` — `409` over 10 unfinished uploads |
| `POST /uploads/multipart/:id/parts` | `{ part_numbers: [1..100 numbers] }` | `{ urls: [ { part_number, url } ], expires_at, expires_in }` — PUT exactly the part's bytes to each url |
| `GET /uploads/multipart/:id` | — | `{ status: "uploading"\|"completed"\|"expired", size, part_size, part_count, parts: [ { part_number, size } ], uploaded_bytes }` — the server's view, used to resume |
| `POST /uploads/multipart/:id/complete` | `{ lesson_id? }` | `{ key, size, lesson_updated }` (idempotent; with `lesson_id` the video is attached, staged on a live course); `409 { missing: [part numbers] }`; `410` expired |
| `DELETE /uploads/multipart/:id` | — | `{ aborted: true }`; `409` if it already finished |
| `GET /uploads/multipart?lesson_id=` | — | your unfinished uploads |

### `GET /lessons/:id/stream-url[?version=pending]` `[jwt]`
Signed playback URL — allowed for the owner, staff, a free-preview section, or an active entitlement. Learners always get the approved video and `404` for a lesson that is only staged. `?version=pending` (owner/staff) returns the staged replacement video — used by the QO diff page. QOs and platform admins are exempt from the per-minute cap.
→ `{ "url": "https://…signed (900s)…", "expires_in", "watermark" }` (`403` if no entitlement)

### Institution course management `[jwt: institution_admin]`
| Endpoint | Body | Notes |
|---|---|---|
| `GET /institution/review-queue` | — | items awaiting internal review — `kind: "new_course"` (a first submission) or `kind: "revision"` (an update to a live course, with `revision_id`, `diff_summary`, `changelog_summary`); each includes `instructor_name` + `instructor_email` |
| `GET /institution/courses` | — | all institution courses — each includes `instructor_name` + `instructor_email` |
| `POST /institution/courses/:id/decision` | `{ action: "approve"｜"reject", notes? }` | approve → platform QO queue; reject → back to the instructor (the `notes` show on the instructor's course page). Works for both kinds |
| `POST /institution/courses/:id/unlist` | — | published → unlisted |
| `POST /institution/courses/:id/restore` | — | unlisted → published |

### Admin course overrides `[jwt: platform_admin]`
- `GET /admin/courses?q=` → `[ { id, title, status, category, pricing_type } ]`
- `POST /admin/courses/:id/unlist` · `.../restore` · `.../archive`

---

## 5. Enrollment & Progress  (enrollment-service)  `[jwt]`

### `POST /enrollments` `[jwt: learner]`
`{ "course_id": "uuid" }` — free/freemium enroll instantly; paid requires a confirmed payment first.

### `GET /enrollments` `[jwt: learner]`
→ `[ { id, course_id, course_title, entitlement_status, progress_percent, completed_at } ]`

### `GET /enrollments/status?course_id=<uuid>` `[jwt: learner]`
→ `{ entitlement_status, enrollment_id }`

### `GET /enrollments/:id` · `GET /enrollments/:id/progress` `[jwt: owner]`
Progress → `{ completed_lessons: [ { lesson_id } ], progress_percent, completed_at }`

### `POST /progress/lessons/:lessonId/complete` `[jwt: learner]`
Mark a lesson complete → updated progress.

### `POST /progress/lessons/:lessonId/video` `[jwt: learner]`
Video watch heartbeat — send every ~10 s while playing, on pause, and on leave.
```json
// request
{ "position_seconds": 42.5, "duration_seconds": 120 }
// response 201
{ "lesson_id": "uuid", "position_seconds": 42.5, "duration_seconds": 120, "percent_watched": 35 }
```
`position_seconds` is the resume point (rewinds move it back); `percent_watched` is a
high-water mark and never decreases. Reaching **≥ 90 %** auto-completes the lesson
(same effect as `POST …/complete`, including course-completion detection).

### `GET /enrollments/:id/video-progress` `[jwt: owner]`
Everything the player needs to restore state:
```json
{ "enrollment_id": "uuid", "last_lesson_id": "uuid|null",
  "lessons": [ { "lesson_id": "uuid", "position_seconds": 42.5, "duration_seconds": 120,
                 "percent_watched": 35, "updated_at": "ISO" } ] }
```
`last_lesson_id` (most recently watched) is what the learn page auto-reopens; lessons are ordered most-recent first.

---

## 6. Payments, Refunds & Payouts  (financial-service)

### `POST /payments/initiate` `[jwt: learner]`
`{ "course_id": "uuid" }` → `{ checkout_url, tx_ref, payment_id }`. Redirect the browser to `checkout_url` (real Chapa checkout in live mode; local mock page in dev). `tx_ref` is always server-generated.

### `POST /payments/reconcile` `[jwt: learner]`
`{ "tx_ref": "TX-..." }` → payment (`{ status: "pending"|"confirmed"|"failed"|... }`). Webhook fallback: asks the **server** to verify a pending payment with Chapa's API directly (the browser's word grants nothing). A cancelled/`failed/cancelled` checkout is recorded as `failed` (not left pending). Call it from the payment-return page; idempotent.

> **Background safety net:** even if the learner never opens the return page (closed tab, webhook undeliverable), Financial sweeps pending Chapa payments from the last 24h every 2 minutes and re-verifies each one with Chapa directly, applying the same amount/currency checks as the webhook path. A completed checkout confirms within ~2 minutes without any client action.

> **Chapa email note:** Chapa validates the customer email domain for deliverability and rejects non-mainstream domains (e.g. the `*.et` demo accounts). `POST /payments/initiate` retries once with `CHAPA_FALLBACK_EMAIL` when that happens, so a purchase is never blocked by the payer's email domain — the learner still receives the platform's own receipt.

### `POST /payments/mock/complete` `[public, dev only]`
`{ "tx_ref": "...", "outcome": "success" | "failed" }` — simulate a gateway callback (403 unless `CHAPA_MODE=mock`).

### `GET /payments/mine` `[jwt: learner]` → `[ payment ]`
### `GET /payments/:id` `[jwt: owner]` → payment

### `POST /refunds` `[jwt: learner]`
`{ "payment_id": "uuid", "reason": "…(5-1000)" }` → `{ status, rule }`

### `GET /refunds/mine` `[jwt: learner]` → `[ refund ]`
### `GET /refunds/pending` `[jwt: platform_admin]` → `[ refund ]`
### `POST /refunds/:id/decide` `[jwt: platform_admin]`
`{ "action": "approve" | "deny" }`

### Payouts
- `GET /payouts/balance` `[jwt: educator | institution_admin]` → `{ pending_net_etb, payment_count }`
- `GET /payouts` `[jwt]` → your payouts
- `POST /payouts/run` `[jwt: platform_admin]` — trigger a payout run
- `POST /payouts/:id/release` `[jwt: platform_admin]` — release a held payout

### Admin payments
- `POST /admin/payments/bank-transfer` `[jwt: platform_admin]` — `{ learner_id, course_id }` (manual enrollment)
- `GET /admin/payments?page=&limit=` `[jwt: platform_admin]` → `{ total, items }` — each item is enriched: `{ id, course_id, course_title, amount_etb, method, status, tx_ref, created_at, learner_id, learner_name, learner_email, payee_id, payee_type, webhook_received_at, payout_id }`

### `POST /payments/webhook/chapa` `[public, HMAC]` — Chapa → server only. **Not a frontend call.**

---

## 7. Assessments, Attempts & Certificates  (outcomes-service)

### `POST /assessments` `[jwt: educator | institution_admin | platform_admin]`
```json
{ "course_id": "uuid", "type": "quiz" | "ai_viva" | "project",
  "is_required?": true, "pass_score?": 60, "config?": { } }
```
**Quiz `config`** — MCQ and AI-graded written questions can be mixed, with optional proctoring:
```json
{ "proctored?": true,               // webcam single-face check, tab & copy/paste guards
  "time_limit_minutes?": 30,        // 1–240; auto-submits at zero
  "questions": [
    { "kind": "mcq", "prompt": "…", "options": ["…","…"], "correct_index": 0, "points?": 1 },
    { "kind": "written", "prompt": "…", "guidance?": "what a full answer covers (AI grader only, never shown to learners)", "points?": 2 } ] }
```

### `POST /assessments/generate` `[jwt: educator | institution_admin | platform_admin]`  ✨ AI
```json
// request
{ "course_id": "uuid", "topic": "…", "count": 5, "difficulty?": "mixed" }
// response
{ "questions": [ { "prompt", "options": ["…"], "correct_index": 0 } ], "ai_live": true }
```

### `GET /assessments?course_id=<uuid>[&include_pending=1]` `[jwt]` → `[ assessment ]`
Quiz rows also carry `question_count, written_count, proctored, time_limit_minutes`, and every row has `state: "live" | "pending"`.
An assessment created on a **published/unlisted** course is `pending` until its change set is approved; learners never see pending ones (list, attempts `404`, certificates). `include_pending=1` returns them for the course owner, institution admin, QO and platform admin.
### `POST /assessments/:id/attempts` `[jwt: learner]` — start an attempt
Quiz response: `{ attempt_id, questions: [ { index, kind, prompt, options?, points } ], pass_score, proctored, time_limit_minutes, warning_limit, started_at }` — `correct_index` and `guidance` are never sent to learners.
### `GET /attempts/mine` `[jwt: learner]` → `[ attempt ]` (includes `flagged`, `terminated`)
### `PUT /attempts/:id/submit` `[jwt: learner]`
```json
{ "responses?": [ { "index": 0, "selected_index": 1 },      // quiz MCQ
                  { "index": 2, "text": "written answer…" } ], // quiz written → AI-graded
  "answers?": [0,2,1],          // legacy quiz shape (MCQ-only)
  "answer?": "text",            // ai_viva
  "file_key?": "…",             // project
  "terminated?": true, "termination_reason?": "…" }  // proctor auto-exit (server re-verifies)
// response: { attempt_id, score, passed, breakdown: [ { index, kind, points, earned,
//   correct? , ai_score?, ai_feedback? } ], flagged, terminated, termination_reason? }
// A terminated attempt is failed regardless of score; written answers are graded by AI
// against the educator's guidance (offline fallback grader if the AI is unavailable).
```
### `PUT /attempts/:id/review` `[jwt: educator | institution_admin | platform_admin]`
`{ "passed": true }` — grade a project attempt.
### `GET /courses/:id/pending-projects` `[jwt: educator | …]` → `[ { attempt_id, submitted_at, download_url } ]`

### Proctoring 📹
The exam room (frontend) runs on-device face detection (MediaPipe, served from `/public` — no third-party calls), tab-switch and copy/paste guards. Each violation type gets **3 warnings**; the 3rd strike of one type auto-exits and flags the exam. Every violation captures a webcam snapshot.

- `POST /attempts/:id/proctor-events` `[jwt: learner]` — record a violation during the exam.
  `{ "type": "no_face"|"multiple_faces"|"tab_switch"|"copy_paste", "description": "…", "screenshot_base64?": "…(JPEG ≤ ~95KB, stored in S3)" }`
  → `{ recorded, type, count, remaining, terminate }` (`terminate: true` on the 3rd of a type — also enforced server-side at submit)
- `GET /attempts/:id/proctor-report` `[jwt: own learner | course owner/creator | institution_admin | QO | platform_admin]`
  → `{ score, passed, flagged, terminated, termination_reason, warning_limit, breakdown, events: [ { type, description, at, screenshot_url } ] }` (screenshot URLs are signed, 15 min)
- `GET /courses/:id/attempts` `[jwt: educator | institution_admin | QO | platform_admin]` — exam-results table
  → `[ { attempt_id, assessment_type, proctored, learner_id, learner_name, learner_email, score, passed, flagged, terminated, violation_count, started_at, submitted_at } ]`

### Certificates
- `GET /me/certificates` `[jwt: learner]` → `[ { id, course_title, issued_at, verify_url } ]`
- `GET /me/certificates/:id/download` `[jwt: learner]` → `{ url }` (signed PDF)
- `GET /certificates/:uid` `[public]` → certificate
- `GET /verify/:uid` `[public]` → public verification

---

## 8. Quality — Reviews, QA, Trust & Fraud  (quality-service)

### `POST /courses/:id/reviews` `[jwt: learner]`
Eligible at ≥ 20 % progress. `{ "rating": 1-5, "comment?": "…(≤2000)" }`
Publishes `CourseRated` — the course service caches `rating_avg / rating_count / rating_points` on the course row, which drives catalog ranking and the educator leaderboard.

### `GET /courses/:id/reviews` `[public]`
Learner ratings & comments — shown on the course page and to the educator & institution admin.
→ `{ average_rating, review_count, reviews: [ { id, rating, comment, created_at } ] }`

### `GET /educators/:id/trust-tier` `[public]` → `{ trust_tier, … }`

### QA (Quality Officer) `[jwt: quality_officer | platform_admin]`
- `GET /qa/queue` → open items ordered by SLA deadline (new courses 48 h, updates 24 h), then priority. Each item: `{ id, course_id, course_title, kind: "new_course"|"revision"|"appeal"|"post_publish", revision_id, diff_summary, changelog_summary, priority (1 = low-risk update, still reviewed), plagiarism, claimed_by, claim_active, sla_deadline, … }`
- `GET /qa/items/:id` → one item
- `POST /qa/items/:id/claim` → mark it yours for 30 min (`409` if another officer holds it)
- `POST /qa/items/:id/decision` → `{ "action", "notes?" }` — updates (`kind: "revision"`): `approve` (goes live) · `coach` (back to the educator, notes required) · `reject` (staged changes discarded, notes required). Other kinds: `approve` · `coach` (notes required) · `flag`.
- `GET /qa/courses/:id` → review detail incl. catalog-aware plagiarism screen
- `POST /qa/courses/:id/decision` → legacy; decides the course's only open item (`409` when more than one is open — decide by item)

### Fraud `[jwt: platform_admin | quality_officer]`
- `POST /fraud/signals` — `{ subject_type, subject_id, signal_type, detail?, payee_id? }`
- `GET /fraud/flags` `[jwt: platform_admin]` → `[ flag ]`
- `POST /fraud/flags/:id/resolve` `[jwt: platform_admin]`

---

## 9. Notifications  (notification-service)  `[jwt]`

### `GET /notifications`
→ `[ { id, type, title, body, link, read_at, created_at } ]` (targets you or your role)

### `GET /notifications/unread-count` → `{ count }`
### `POST /notifications/:id/read` — mark one read
### `POST /notifications/read-all` — mark all read
### `GET /notification-preferences/:userId` → `{ marketing_opt_out }`
### `PUT /notification-preferences/:userId` — `{ marketing_opt_out: true }`
### `GET /admin/notifications` `[jwt: platform_admin]` → delivery log

### Course discussion 💬 (notification-service)
Threaded comments under a course — `parent_id` may point at any comment **or reply** (arbitrary depth).

- `GET /courses/:id/comments` `[public]` → flat list, client builds the tree:
  `[ { id, parent_id, author_id, author_name, author_role, body, deleted, created_at } ]` (deleted rows keep the thread shape, body blanked)
- `POST /courses/:id/comments` `[jwt]` — `{ body (≤4000), parent_id? }`.
  Learners must be enrolled; educators/staff may always post. Replies notify the parent author's inbox; new threads notify the course author.
- `DELETE /comments/:id` `[jwt: author | QO | platform_admin]` → soft delete

### Direct messages 💬 (notification-service) `[jwt]`
1:1 conversations between anyone — learners, instructors, institution and platform staff.

- `GET /messages/threads` → `[ { thread_id, peer: { id, name, role }, last_preview, last_message_at, unread } ]`
- `POST /messages/threads` — `{ recipient_id }` → find-or-create the thread (self-DM is a `400`)
- `GET /messages/threads/:id` → `{ thread, messages: [ { id, sender_id, mine, body, created_at } ] }` — opening marks your side read
- `POST /messages/threads/:id` — `{ body (≤4000) }` → the sent message (bumps the peer's unread count)
- `GET /messages/unread-count` → `{ unread }` (header badge)

Find people to message with `GET /profiles/directory?q=` `[jwt]` (auth-service): partial name or **exact** email, ≥2 chars → `[ { id, name, role } ]` (max 20; emails/phones never exposed).

---

## 10. Internal (service-to-service — NOT for the frontend)
Require the shared `x-internal-token`; the gateway rejects browser calls. Listed for completeness only:
`GET /internal/users/:id` · `/internal/users/:id/institution` · `/internal/educators/:id` ·
`/internal/institutions/by-owner/:userId` · `/internal/institutions/:id` ·
`/internal/courses/:id` · `/internal/courses/:id/lesson-ids` · `/internal/courses/:id/pending-assessments` (outcomes) · `/internal/lessons/:id` ·
`/internal/owners/:id/published-count` · `/internal/entitlements` · `/internal/enrollments/:id` ·
`/internal/enrollments/:id/outcomes-status` · `/internal/educators/:id/trust-tier`

---

## Typical frontend flows

**Learner enroll & learn (paid):** `POST /payments/initiate` → (Chapa / `POST /payments/mock/complete`) → `POST /enrollments` → `GET /courses/:id` → `GET /lessons/:id/stream-url` → `POST /progress/lessons/:id/complete` → `POST /courses/:id/reviews`.

**Educator publish:** `POST /courses` → `POST /courses/generate-structure` (edit) → `POST /courses/:id/apply-structure` → `POST /sections/:id/lessons` + `/uploads/multipart` (attach on complete) → set thumbnail via `PUT /courses/:id` → `POST /courses/:id/submit` → (QO) → published. Feedback via `GET /courses/:id/reviews`.

**Educator updates a live course:** edit as usual (`PUT /courses/:id`, sections, lessons, uploads — all staged) → `GET /courses/:id/working` → `POST /courses/:id/revisions/submit { summary, major }` → QO: `GET /qa/queue` → `/preview/:id?revision=…` (`GET /courses/:id/revisions/current/diff`) → `POST /qa/items/:id/claim` → `POST /qa/items/:id/decision` → applied (learners see it; enrolled learners notified if `major`).

**Staff / instructor onboarding:** admin `POST /admin/users/staff` (or institution `POST /institutions/:id/instructors`) → invitee opens link → `GET /auth/invite/:token` → `POST /auth/accept-invite` (sets own password, logged in).
