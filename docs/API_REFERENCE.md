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

### `GET /search?q=&category=&pricing_type=&page=1&limit=12` `[public]`
Published catalog (cached ~30s). → `{ total, page, items: [courseSummary] }`

**`courseSummary`:** `{ id, title, description, category, language, thumbnail_url, pricing_type, price_etb, owner_id, owner_type, published_at }`

### `GET /courses/:id` `[public]`
Full detail. Owners/QO/admin can view their own unpublished courses. Video keys are never exposed.
```json
{ ...courseSummary, "status": "published",
  "sections": [ { "id", "title", "order", "is_free_preview",
    "lessons": [ { "id", "title", "duration_seconds", "order", "has_video" } ] } ],
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

### `PUT /courses/:id` `[jwt: educator]`  (draft only)
Any of: `{ title?, description?, category?, thumbnail_url?, pricing_type?, price_etb? }`

### Lifecycle actions `[jwt: educator]`  (POST, no body unless noted)
| Endpoint | Effect |
|---|---|
| `POST /courses/:id/submit` | draft → `submitted` (solo) or `institution_review` (institution instructor) |
| `POST /courses/:id/withdraw` | submitted/under_review/institution_review → `draft` |
| `POST /courses/:id/unpublish` | published → `unlisted` |
| `POST /courses/:id/republish` | unlisted → `published` |
| `POST /courses/:id/appeal` | flagged → `submitted`. Body: `{ "note": "…(10-2000)" }` |
| `POST /courses/:id/duplicate` | copies course+sections+lessons as a new `draft` |
| `POST /courses/:id/archive` | draft/unlisted → `archived` |
| `POST /courses/:id/restore` | archived → `draft` |

### `POST /courses/generate-structure` `[jwt: educator | institution_admin]`  ✨ AI
Draft an outline from a prompt and/or uploaded document text (the file is parsed in the browser; send the extracted text here). Nothing is saved — the educator edits it, then creates sections/lessons.
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
  "note?": "The AI outline service was unavailable, so here is a starter outline…" }
// Never 500s: if the AI call fails, it returns an editable starter outline + `note`.
```

### Sections & lessons `[jwt: educator]`
| Endpoint | Body | Result |
|---|---|---|
| `POST /courses/:id/sections` | `{ title, is_free_preview, lessons? }` | section |
| `POST /sections/:id/lessons` | `{ title, video_s3_key?, duration_seconds? }` | lesson |
| `PUT /lessons/:id` | `{ title?, duration_seconds?, video_s3_key? }` | lesson |
| `DELETE /lessons/:id` | — | `{ deleted: true }` |
| `DELETE /sections/:id` | — | `{ deleted: true }` |

### `POST /uploads` `[jwt: educator | institution_admin]`
Get a signed S3 URL, then `PUT` the file bytes to `upload_url`.
```json
// request
{ "kind": "video" | "thumbnail" | "photo", "filename": "intro.mp4", "content_type": "video/mp4" }
// response
{ "upload_url": "https://…signed…", "key": "videos/…" }   // store `key` on the lesson/course
```

### `GET /lessons/:id/stream-url` `[jwt]`
Signed playback URL — allowed for the owner, staff, a free-preview section, or an active entitlement.
→ `{ "url": "https://…signed (900s)…" }` (`403` if no entitlement)

### Institution course management `[jwt: institution_admin]`
| Endpoint | Body | Notes |
|---|---|---|
| `GET /institution/review-queue` | — | courses awaiting internal review — each item includes `instructor_name` + `instructor_email` (who authored it) |
| `GET /institution/courses` | — | all institution courses — each includes `instructor_name` + `instructor_email` |
| `POST /institution/courses/:id/decision` | `{ action: "approve"｜"reject", notes? }` | approve → platform QO queue; reject → back to instructor draft (the `notes` show on the instructor's course page) |
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

---

## 6. Payments, Refunds & Payouts  (financial-service)

### `POST /payments/initiate` `[jwt: learner]`
`{ "course_id": "uuid" }` → `{ checkout_url, tx_ref, payment_id }`. Redirect the browser to `checkout_url` (real Chapa checkout in live mode; local mock page in dev). `tx_ref` is always server-generated.

### `POST /payments/reconcile` `[jwt: learner]`
`{ "tx_ref": "TX-..." }` → payment (`{ status: "pending"|"confirmed"|"failed"|... }`). Webhook fallback: asks the **server** to verify a pending payment with Chapa's API directly (the browser's word grants nothing). A cancelled/`failed/cancelled` checkout is recorded as `failed` (not left pending). Call it from the payment-return page; idempotent.

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

### `POST /assessments/generate` `[jwt: educator | institution_admin | platform_admin]`  ✨ AI
```json
// request
{ "course_id": "uuid", "topic": "…", "count": 5, "difficulty?": "mixed" }
// response
{ "questions": [ { "prompt", "options": ["…"], "correct_index": 0 } ], "ai_live": true }
```

### `GET /assessments?course_id=<uuid>` `[jwt]` → `[ assessment ]`
### `POST /assessments/:id/attempts` `[jwt: learner]` — start an attempt → attempt
### `GET /attempts/mine` `[jwt: learner]` → `[ attempt ]`
### `PUT /attempts/:id/submit` `[jwt: learner]`
```json
{ "answers?": [0,2,1],   // quiz: selected option indexes
  "answer?": "text",     // ai_viva: written answer
  "file_key?": "…" }     // project: uploaded submission key
```
### `PUT /attempts/:id/review` `[jwt: educator | institution_admin | platform_admin]`
`{ "passed": true }` — grade a project attempt.
### `GET /courses/:id/pending-projects` `[jwt: educator | …]` → `[ { attempt_id, submitted_at, download_url } ]`

### Certificates
- `GET /me/certificates` `[jwt: learner]` → `[ { id, course_title, issued_at, verify_url } ]`
- `GET /me/certificates/:id/download` `[jwt: learner]` → `{ url }` (signed PDF)
- `GET /certificates/:uid` `[public]` → certificate
- `GET /verify/:uid` `[public]` → public verification

---

## 8. Quality — Reviews, QA, Trust & Fraud  (quality-service)

### `POST /courses/:id/reviews` `[jwt: learner]`
Eligible at ≥ 20 % progress. `{ "rating": 1-5, "comment?": "…(≤2000)" }`

### `GET /courses/:id/reviews` `[public]`
Learner ratings & comments — shown on the course page and to the educator & institution admin.
→ `{ average_rating, review_count, reviews: [ { id, rating, comment, created_at } ] }`

### `GET /educators/:id/trust-tier` `[public]` → `{ trust_tier, … }`

### QA (Quality Officer) `[jwt: quality_officer | platform_admin]`
- `GET /qa/queue` → pending review items (each has an AI `plagiarism` result)
- `GET /qa/courses/:id` → review detail incl. catalog-aware plagiarism screen
- `POST /qa/courses/:id/decision` → `{ "action": "approve" | "coach" | "flag", "notes?": "…" }`

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

---

## 10. Internal (service-to-service — NOT for the frontend)
Require the shared `x-internal-token`; the gateway rejects browser calls. Listed for completeness only:
`GET /internal/users/:id` · `/internal/users/:id/institution` · `/internal/educators/:id` ·
`/internal/institutions/by-owner/:userId` · `/internal/institutions/:id` ·
`/internal/courses/:id` · `/internal/courses/:id/lesson-ids` · `/internal/lessons/:id` ·
`/internal/owners/:id/published-count` · `/internal/entitlements` · `/internal/enrollments/:id` ·
`/internal/enrollments/:id/outcomes-status` · `/internal/educators/:id/trust-tier`

---

## Typical frontend flows

**Learner enroll & learn (paid):** `POST /payments/initiate` → (Chapa / `POST /payments/mock/complete`) → `POST /enrollments` → `GET /courses/:id` → `GET /lessons/:id/stream-url` → `POST /progress/lessons/:id/complete` → `POST /courses/:id/reviews`.

**Educator publish:** `POST /courses` → `POST /courses/generate-structure` (edit) → `POST /courses/:id/sections` + `/uploads` + `/sections/:id/lessons` → set thumbnail via `PUT /courses/:id` → `POST /courses/:id/submit` → (QO) → published. Feedback via `GET /courses/:id/reviews`.

**Staff / instructor onboarding:** admin `POST /admin/users/staff` (or institution `POST /institutions/:id/instructors`) → invitee opens link → `GET /auth/invite/:token` → `POST /auth/accept-invite` (sets own password, logged in).
