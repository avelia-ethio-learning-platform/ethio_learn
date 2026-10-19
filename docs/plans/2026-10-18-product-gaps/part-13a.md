# 13a: per-user read flags, institution admins on /teach, course language

Part of [plan.md](plan.md). Branch `feat/product-gaps-a`. Lines at `origin/main` `ec8549e`.

## Gap 3: per-user reads for role rows
**Data model.** New table `notification.inbox_notification_reads(notification_id uuid, user_id uuid, read_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (notification_id, user_id), FK notification_id → inbox_notifications(id) ON DELETE CASCADE)`. Entity `InboxNotificationRead` in `entities.ts`, exported from `database.ts` (the module registers that list, `app.module.ts:14-15`). The FK is declared on the entity as `@ManyToOne(() => InboxNotification, { onDelete: 'CASCADE' })` + `@JoinColumn({ name: 'notification_id' })` (the first relation in that file): `db:check` diffs the schema builder's `log()` (`common/src/typeorm/schema-check.ts:37`), so a FK only the migration knows about reads as drift. No extra index: the PK serves both the `IN (ids)` read and the `NOT EXISTS`. User rows (`user_id` set) keep using `read_at`; role rows (`target_role` set, `user_id` null, written by `notification.service.ts:691-709` and `broadcast` `controllers.ts:217-227`) never get `read_at` again and are read per user through this table.

**Migration** `migrations/<ts>-InboxReads.ts`, exported from `migrations/index.ts` (pattern `:2-8`): one `CREATE TABLE IF NOT EXISTS` plus the FK with the name TypeORM generates (Baseline style, e.g. course `1790955681997-Baseline.ts:210`); no `CONCURRENTLY`, so the default transaction stays. `down()` drops the table. `db:check` (schema-migrations handoff :20-24) confirms entity and migration match.

**Reads** (`controllers.ts:101-146`):
- `list` :104-107: same 50 rows, then one `reads.find({ user_id, notification_id: In(ids) })`; `read = !!n.read_at || readIds.has(n.id)`.
- `unreadCount` :109-114: `myQuery` + `n.read_at IS NULL` + `NOT EXISTS (SELECT 1 FROM notification.inbox_notification_reads r WHERE r.notification_id = n.id AND r.user_id = :uid)`.
- `markRead` :116-127: `UPDATE ... SET read_at = now() WHERE id = :id AND user_id = :uid`, then `INSERT INTO reads (notification_id, user_id) SELECT id, :uid FROM inbox_notifications WHERE id = :id AND target_role = :role ON CONFLICT DO NOTHING`. Both scoped to the caller, so no id outside the caller's inbox is touched.
- `markAllRead` :129-140: the same two statements without the `id` filter (`read_at IS NULL` on both).
- Response shapes unchanged, so `NotificationBell.tsx:34-58,99-103` and `notifications/page.tsx` need no change.

**Spec.** `inbox-reads.db.spec.ts` with the opt-in Postgres pattern (`auth.resend-verification.db.spec.ts:15-32`: `describe.skip` without `TEST_DATABASE_URL`, creates the schema and runs the service's migrations itself): a QO row read by user A is unread for user B and counted once for A; read-all by A leaves B's count; a user row still sets `read_at`; repeating markRead is a no-op (`ON CONFLICT`). Injecting the reads repository adds one mock argument to the two specs that build the controller positionally (`controllers.spec.ts:22`, `email.provider.spec.ts:109`).

**Where it runs** (`pnpm -C api test` is database-free, so without this the spec runs nowhere):
- CI: a step after `.github/workflows/ci.yml:134`, same shape as the resend-verification step (:129-134), with its own scratch database:
  `docker compose exec -T postgres sh -c 'createdb -U "$POSTGRES_USER" el_ci_inbox_reads'` then `TEST_DATABASE_URL="${base%/*}/el_ci_inbox_reads" pnpm -C api exec jest --ci services/notification/src/inbox-reads.db.spec.ts` (`base` from `api/.env` as :131).
- Local (Postgres on :55432, schema-migrations handoff :28): once `docker exec ethiopialearn-postgres-1 createdb -U ethiopialearn el_inbox_reads`, then `base="$(sed -n 's/^DATABASE_URL=//p' api/.env)"; TEST_DATABASE_URL="${base%/*}/el_inbox_reads" pnpm -C api exec jest services/notification/src/inbox-reads.db.spec.ts`.

## Gap 4: institution admins author courses
**API** (`course.service.ts`), three lines in `create` :341-368:
- Delete the throw :342-345. `const { ownerId, ownerType } = await this.resolveOwner(ctx)` (:1543-1553; 400 "Create your institution profile before creating courses" for an admin without one) replaces the hardcoded `owner_id: ctx.id, owner_type: OwnerType.EDUCATOR` :355-356.
- `institution_id` keeps `institution?.institution_id ?? null` (:352, :358): that lookup is the instructor membership (`auth/src/internal.controller.ts:42-45`), null for an admin. Setting it to the institution instead would route every revision of the live course into the admin's own queue (`revision.service.ts:181` routes on `institution_id` alone; announced :213-223, listed :537-544, decided by the same admin :574-577). With null, `submit` :726 and `revision.service.ts:181` need no change: first submits and revisions go to the QO queue, `CourseSubmitted` :743-753 carries `owner_type` institution, and `ownerContact` :1557-1559 names the institution on the QO card.
- Already in place: `ownedCourse` :1473-1480 and `canAuthor` :1488-1496 (`created_by`), `listOwn` :1394-1398 (`owner_id`), outcomes `canManageCourse` (`assessment.service.ts:1021-1032`, `owner_id` = institution id), payouts to the institution (`payout.service.ts:224-233,267`, `payment.service.ts:186`), certificates (`certificate.service.ts:144-145`).
- Spec (`course.service.spec.ts`, next to :832 and :1154; the internal mock :161 answers `by-owner` with `inst1` and the membership lookup with nothing): admin creates → `owner_id: 'inst1'`, `owner_type: 'institution'`, `institution_id: null`; submit → `SUBMITTED`, `CourseSubmitted` with `owner_type: 'institution'`, no `CourseSubmittedToInstitution`; admin without institution → 400.

**Web.**
- `teach/page.tsx:183` roles add `institution_admin`; `EducatorSetup` :62 only when `user.role === 'educator'`; badge/title :40-43 read "Institution" / "Institution courses" for admins; a `/courses` error for an admin links to `/institution`. `/payouts/balance` :20 already allows the role (financial `controllers.ts:165-170`).
- `teach/new/page.tsx:113` roles add `institution_admin`.
- `Header.tsx:77-80` institution_admin gains `{ href: '/teach', label: t('teach') }` (key exists :76). `safe-next.ts` HOMES unchanged.
- `institution/page.tsx:168`: one "Manage" `Link` to `/teach/courses/${c.id}` next to Preview per row (not "Edit": on an instructor's course content saves 403 via `ownedCourse`, `course.service.ts:386-387,1473-1480`; assessments and tutor notes work) (the editor allows the role, `teach/courses/[id]/page.tsx:585`; `canAuthor` :1490-1492 admits the institution's admin). That closes "the course tools they can open have no menu links".
- `e2e/roles.spec.ts:8-12` flips to "gets the create-course form on /teach/new" (same assertions as :27-31); re-find after 11b's per-test login.

## Gap 5: course language en/am
**API** (course service):
- `dto.ts:125-127` `@IsIn(['en', 'am'])` via one `COURSE_LANGUAGES` const; `UpdateCourseDto` :148-177 adds `@IsOptional() @IsIn(COURSE_LANGUAGES) language?: string`. `language` is a plain varchar default `'en'` (`entities.ts:78-79`): no migration.
- `update` :449-456 adds `language: dto.language` to the picked fields; the draft path writes it, the live path stages it. For that, `CoursePending` (`entities.ts:9-16`), `CoursePendingFields` and `CourseLike` (`revision-diff.ts:14-21,36-46`), `COURSE_DIFF_FIELDS` :85, `mergedCourse` :137-147 and `applyStagedState` (`staging.ts:57-69`) all gain `language`. The diff then lists it as metadata (:196-203) and the QA chip reads "language changed" (`qa.ts:282-286`).
- `search` :1108-1125 takes `language` and adds `c.language = :language` when it is in `COURSE_LANGUAGES`; `course.controller.ts` `search` (:145-155 today; 9c's `@Query() paging` keeps the named params) gains `@Query('language')`. The cache key :1109 already covers it. `publicSummary` :1459 already returns `language`, and `CourseCard.tsx:52-56` already shows the EN/አማ badge.
- Specs: `revision-diff.spec.ts` (a staged language shows in metadata; apply writes it), `course.service.spec.ts` (`'fr'` → 400; search by language).

**Web.**
- `teach/new/page.tsx:36`: a `<select name="language">` (English/Amharic, `lang_en`/`lang_am` keys at `i18n-en.ts:159-160`), default `en`.
- `course-details.tsx`: the field in the form :117-148 and in the diff body :40-46; `working.ts:101-108` and `qa.ts:218-225` add `language: 'language'`.
- Catalog: `explore-client.tsx` `ExploreFilters` :18-23, `NavPatch` :25-32, active filters :89-93, `clearAll` :114-117 gain `language`; a pill group (All / English / Amharic) after pricing :212-220 and a chip :273-274; `courses/page.tsx:17-47` forwards `language` to `/search`. New key `filter_language` (en "Language", am "ቋንቋ") in both dictionaries (parity test `i18n.test.ts:9-11`); its `am-review.md` row is written by 13b.

## Steps
- [ ] 1. Branch from `origin/main` after 12b. Gap 3 entity, migration, controller, db spec, the `ci.yml` step. Gate: `pnpm -C api db:check` and the db spec locally (gap 3 "Where it runs").
- [ ] 2. Gap 4 API + specs. 3. Gap 5 API + specs. Gate: `pnpm -C api build && pnpm -C api test && node scripts/lint-check.mjs`.
- [ ] 4. Gap 4 web + e2e flip. 5. Gap 5 web + i18n. Gate: `pnpm -C web typecheck && pnpm -C web test`, Playwright `roles` and `catalog-and-404`.
- No doc step: 13b's step 7 closes all six gaps in `FEATURES_AND_ROADMAP.md`, `am-review.md` and the roadmap row.

## Rollout
Migrations run on boot before the service listens (`typeorm.ts:9-12`); the reads table is additive, so API and web deploy in either order. Pre-merge `db:check` against production is the user's step (schema-migrations handoff :35).

## Handoff note (accepted at code review, no code change)
- New users see every role row written since the migration (broadcasts, QO queue rows) as unread; the bell count has no cap, the list shows 50.
