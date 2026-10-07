# Color system

How EthiopiaLearn uses color, in light and dark mode. Every page and component follows this document. The values live in [`web/src/app/globals.css`](../web/src/app/globals.css) and [`web/tailwind.config.ts`](../web/tailwind.config.ts); the category colors live in [`web/src/lib/categories.ts`](../web/src/lib/categories.ts).

> **Status.** The roles marked **7c** are being built in Phase 7c (see [FEATURES_AND_ROADMAP.md](FEATURES_AND_ROADMAP.md#roadmap)). Until it merges, the code uses the value shown as "today", and status colors are Tailwind palette classes. New code should still follow the rules below.

## Principles

1. **Roles, not hues.** A component asks for a role (`text-danger`, `bg-brand-50`, `text-muted-foreground`), never a palette color (`text-red-600`, `bg-blue-50`) or a hex value. A role holds its value in both themes, so nothing is "fixed for dark mode" one class at a time.
2. **Readable in both themes.** Both themes are first-class, and every pair below is checked in both:
   - text is at least **4.5:1**;
   - boundaries that identify a control (input borders), focus indicators and meaningful graphics (chart bars, status dots) are at least **3:1**.

   That's WCAG 2.2 AA. We don't use the 3:1 large-text allowance for text, so a heading that later shrinks stays readable.
3. **Color is never the only signal.**
   - A status always has a word ("Payment not finished") or an icon.
   - An error field has a message.
   - A chart prints its values.
4. **Blue means brand and action, status hues mean status, and the flag means identity.**
   - Flag red is not "error".
   - Flag green is not "success".
5. **Identity lives in the content:** generated course covers, Amharic labels and the flag band used as structure. No gradient text in body copy, and no decoration on data.

## How theming works

- `globals.css` declares every token twice: under `:root` (light) and under `.dark`.
- The brand, gray and status colors are RGB channels (`--brand-600: 37 99 235`), so Tailwind's alpha modifiers work (`bg-brand-600/10`).
- `.dark` is set on `<html>` before the first paint from the saved choice (`el_theme`) or the system preference (`web/src/lib/theme-script.ts`).
- **The scales invert in dark mode.** `brand-50` is the lightest tint in light mode and the darkest in dark mode, and `brand-700` is a dark blue in light mode and a light blue in dark mode. So `text-brand-700 bg-brand-50` reads well in both themes.
  - **The trap:** a fill with white text on top. `bg-brand-600 text-white` is 5.17:1 in light, but `brand-600` is `#60a5fa` in dark, and white on it is 2.5:1.
  - Buttons therefore use `.btn` and `.btn-danger`, whose fills are fixed in both themes.

## Tokens

### Surfaces

| Token | Light | Dark | Use |
|---|---|---|---|
| `background` | `#ffffff` | `#0f172a` | The page. |
| `background-secondary` | `#fafbff` | `#1e293b` | Alternating sections, side panels. |
| `background-tertiary` | `#f1f5ff` | `#334155` | Decorative fills only. **Not a text surface:** brand, danger and muted text all fall under 4.5:1 on it in dark mode. Unused today. |
| `card` | `rgba(255,255,255,.92)` | `rgba(30,41,59,.72)` | Cards and panels (`.card`). |
| `popover` | `rgba(255,255,255,.98)` | `rgba(15,23,42,.97)` | Menus and dialogs. |
| `gray-100` | `#f1f5f9` | `#1e293b` | Neutral chips, table header rows. |
| `gray-200` | `#e2e8f0` | `#2c3a52` | Stronger neutral fills: rank badges, progress tracks, skeletons. Text on it is `gray-600` or `foreground`. |

### Text

| Token | Light | Dark | Use |
|---|---|---|---|
| `foreground` | `#0f172a` | `#f8fafc` | Headings and body text. |
| `gray-600` | `#475569` | `#b2bfd2` | Secondary text: labels, table cells, descriptions. Also any helper text on `gray-200`, `brand-100` or a stronger tint. |
| `muted-foreground` = `gray-500` | `#5b6b80` **7c** (today `#64748b`) | `#9aa8bd` **7c** (today `#94a3b8`) | Helper text, meta, timestamps, placeholders. **The lightest color allowed for text**, and only on the page, secondary background, cards and `gray-100`. |
| `gray-400` | `#94a3b8` | `#64748b` | Decorative icons and dividers only. Never text, never an icon that carries meaning on its own. |

### Brand

| Token | Light | Dark | Use |
|---|---|---|---|
| `brand-50` / `brand-100` | `#eff6ff` / `#dbeafe` | `#172554` / `#1e3a8a` | Tinted backgrounds: selected rows, info panels, the active nav item. |
| `brand-600` (= `primary`) | `#2563eb` | `#60a5fa` | Links, active states, the focus ring, chart bars. |
| `brand-700` | `#1d4ed8` | `#93c5fd` | Brand text on a tint (`bg-brand-50`), and secondary-button text. |
| `.btn` fill | `#1d4ed8` → `#2563eb` | same | Primary buttons, with white text (5.17:1 or better along the whole gradient). |

The full scale (50–900) is in `globals.css`. Use the roles above; the other steps are for decoration such as washes and gradients.

### Status (7c)

Four statuses, each with four roles. Today's badge colors are these values, so badges look the same after 7c.

| Status | Text (`text-success`) | Soft background (`bg-success-soft`) | Line (`border-success-line`) | Solid (`bg-success-solid`) |
|---|---|---|---|---|
| **success**, light | `#047857` | emerald at 12% | emerald at 30% | `#059669` |
| **success**, dark | `#34d399` | emerald at 14% | emerald at 35% | `#10b981` |
| **warning**, light | `#b45309` | amber at 12% | amber at 35% | `#d97706` |
| **warning**, dark | `#fbbf24` | amber at 14% | amber at 35% | `#f59e0b` |
| **danger**, light | `#b91c1c` | red at 10% | red at 30% | `#dc2626` |
| **danger**, dark | `#f87171` | red at 14% | red at 35% | `#ef4444` |
| **info**, light | `#1d4ed8` | blue at 10% | blue at 30% | `#2563eb` |
| **info**, dark | `#93c5fd` | blue at 14% | blue at 35% | `#60a5fa` |

- **Text** is for words and icons placed next to words.
- **Soft** and **line** together make a callout or a badge.
- **Solid** is for graphics with no text on them: a status dot, a bar, an icon standing alone.
  - **Never put text on a solid.** White on dark-mode `#ef4444` is 3.8:1.
  - A destructive button is `.btn-danger` (`#b91c1c`, white text 6.47:1, fixed in both themes).
- **Rating stars** (`rating`, 7c): `#d97706` light, `#fbbf24` dark. The number is always printed next to the stars.

### Borders and focus

| Token | Light | Dark | Use |
|---|---|---|---|
| `border` / `card-border` | blue at 14% / 10% | blue at 22% / 16% | Decorative edges of cards and dividers. They need no contrast, because the card's content identifies it. |
| `input-border` | `#7c8ba1` **7c** (today `border`) | `#64748b` **7c** | Inputs, selects and text areas: the edge is what tells you it's a field, so it is 3:1. |
| Focus ring | 2 px `brand-600` outline, 2 px offset | same token | Every focusable element (`:focus-visible` in `globals.css`). `.input` replaces the outline with a `brand-500` border and a 3 px `ring` glow (`#3b82f6`, 3.68:1 on white). |

### Category covers

A course without an uploaded thumbnail gets a generated cover (`CourseCover`): the category group's color, the title in white, English and Amharic labels, and the woven band.

| Group | Color | White text |
|---|---|---|
| tech | `#1d4ed8` | 6.70:1 |
| business | `#b45309` | 5.02:1 |
| freelancing | `#6d28d9` | 7.10:1 |
| healthcare | `#047857` | 5.48:1 |
| other | `#475569` | 7.58:1 |

The covers don't change in dark mode. The OG share images use the same colors.

### The flag

Green `#078930`, yellow `#fcdd09` and red `#da121a`.
- **Where:**
  - the woven band on covers and certificates;
  - section edges;
  - the logo underline (`.gradient-ethiopia`).
- **Never:**
  - as text (yellow on white is 1.36:1);
  - as a status;
  - behind text;
  - as a large fill.

## Components: which class to use

| Need | Use |
|---|---|
| The main action in a view | `.btn`. Use one per view or section. |
| Other actions | `.btn-secondary`, or `.btn-ghost` for quiet ones. |
| Destructive or money-moving action | `.btn-danger`, behind a confirmation dialog. |
| A status word | `.badge-success`, `.badge-warn`, `.badge-danger`, `.badge-info`, `.badge-neutral`, with the word inside. |
| A callout or banner | `bg-warning-soft border border-warning-line text-warning` plus an icon (7c; today the amber classes). |
| A form error | `text-danger` on the message, linked with `aria-describedby` (the `Field` component does this). |
| A link in text | `text-brand-600`, with `hover:text-brand-700` and an underline on hover. |
| Progress | `.progress-track` with `.progress-fill`: a solid `brand-600` fill (7c; today a `#2563eb`→`#60a5fa` gradient, whose light end is 2.2:1 on the track). The fill must be 3:1 on its track. A bar in a status color (an upload that failed, password strength) always prints its label, because warning amber is under 3:1 on a gray track. |
| A chart | `Bars`: solid `brand-600` bars (7c; today `brand-500/80`), values printed. A second series, when one is needed, uses the category colors in table order, with direct labels instead of a legend. |
| Disabled | The `disabled` or `aria-disabled` styles in `globals.css` (50% opacity plus a not-allowed cursor). Disabled controls are exempt from contrast, but must still look disabled. |
| A brand panel (an always-dark hero or banner) | `.brand-panel` (7c): a fixed blue gradient with white text. |

## Do and don't

- **Do** pick the role, then check it in both themes. **Don't** pair `text-red-600` with a `dark:` variant, because one of the two halves always gets forgotten.
- **Do** put a word next to every status color. **Don't** use a colored dot alone.
- **Do** use `.btn` for filled buttons. **Don't** write `bg-brand-600 text-white` or `bg-red-600 text-white`.
- **Do** keep helper text at `text-gray-500`/`text-muted-foreground` or darker. **Don't** use `text-gray-400` for text.
- **Do** keep the flag for structure. **Don't** use flag red for errors or flag green for success.
- **Do** switch helper text to `gray-600` on `gray-200`, `brand-100` or a stronger tint. **Don't** put muted text there, or any text on `background-tertiary`.

## Contrast table

Each row is checked on the surfaces it names, and the ratio is the lowest of them.
- Soft colors and the progress track (blue at 12%) are composited over the page first.
- "Card" is the card color over the page.
- The formula is WCAG 2.x relative luminance.

Phase 7c adds a test, `web/src/lib/color-tokens.test.ts`, that recomputes these pairs from `globals.css` on every run, so a token change that breaks one fails CI. The rows marked 7c above are the target values.

| Theme | Pair | Color | Checked on | Lowest ratio | Needs | |
|---|---|---|---|---|---|---|
| light | foreground | `#0f172a` | page, secondary, card, gray-100, gray-200, brand-50, brand-100 | 14.48 | 4.5 | pass |
| light | secondary text (`gray-600`) | `#475569` | page, secondary, card, gray-100, gray-200, brand-50, brand-100 | 6.15 | 4.5 | pass |
| light | muted text (`muted-foreground`, `gray-500`) | `#5b6b80` | page, secondary, card, gray-100 | 4.97 | 4.5 | pass |
| light | link / brand text (`brand-600`) | `#2563eb` | page, secondary, card | 5.00 | 4.5 | pass |
| light | brand text on tints (`brand-700`) | `#1d4ed8` | page, card, gray-100, brand-50, brand-100 | 5.49 | 4.5 | pass |
| light | input border | `#7c8ba1` | page, secondary, card | 3.35 | 3 | pass |
| light | focus ring | `#2563eb` | page, secondary, card | 5.00 | 3 | pass |
| light | chart bar | `#2563eb` | page, secondary, card | 5.00 | 3 | pass |
| light | progress fill | `#2563eb` | track, gray-200 | 4.19 | 3 | pass |
| light | rating star fill | `#d97706` | page, secondary, card | 3.08 | 3 | pass |
| light | success text | `#047857` | page, card, its soft tint | 4.91 | 4.5 | pass |
| light | success solid | `#059669` | page, secondary | 3.64 | 3 | pass |
| light | warning text | `#b45309` | page, card, its soft tint | 4.58 | 4.5 | pass |
| light | warning solid | `#d97706` | page, secondary | 3.08 | 3 | pass |
| light | danger text | `#b91c1c` | page, card, its soft tint | 5.66 | 4.5 | pass |
| light | danger solid | `#dc2626` | page, secondary | 4.67 | 3 | pass |
| light | info text | `#1d4ed8` | page, card, its soft tint | 5.99 | 4.5 | pass |
| light | info solid | `#2563eb` | page, secondary | 5.00 | 3 | pass |
| dark | foreground | `#f8fafc` | page, secondary, card, gray-100, gray-200, brand-50, brand-100 | 9.90 | 4.5 | pass |
| dark | secondary text (`gray-600`) | `#b2bfd2` | page, secondary, card, gray-100, gray-200, brand-50, brand-100 | 5.56 | 4.5 | pass |
| dark | muted text (`muted-foreground`, `gray-500`) | `#9aa8bd` | page, secondary, card, gray-100 | 6.07 | 4.5 | pass |
| dark | link / brand text (`brand-600`) | `#60a5fa` | page, secondary, card | 5.75 | 4.5 | pass |
| dark | brand text on tints (`brand-700`) | `#93c5fd` | page, card, gray-100, brand-50, brand-100 | 5.74 | 4.5 | pass |
| dark | input border | `#64748b` | page, secondary, card | 3.07 | 3 | pass |
| dark | focus ring | `#60a5fa` | page, secondary, card | 5.75 | 3 | pass |
| dark | chart bar | `#60a5fa` | page, secondary, card | 5.75 | 3 | pass |
| dark | progress fill | `#60a5fa` | track, gray-200 | 4.50 | 3 | pass |
| dark | rating star fill | `#fbbf24` | page, secondary, card | 8.76 | 3 | pass |
| dark | success text | `#34d399` | page, card, its soft tint | 7.46 | 4.5 | pass |
| dark | success solid | `#10b981` | page, secondary | 5.77 | 3 | pass |
| dark | warning text | `#fbbf24` | page, card, its soft tint | 8.50 | 4.5 | pass |
| dark | warning solid | `#f59e0b` | page, secondary | 6.81 | 3 | pass |
| dark | danger text | `#f87171` | page, card, its soft tint | 5.63 | 4.5 | pass |
| dark | danger solid | `#ef4444` | page, secondary | 3.89 | 3 | pass |
| dark | info text | `#93c5fd` | page, card, its soft tint | 8.32 | 4.5 | pass |
| dark | info solid | `#60a5fa` | page, secondary | 5.75 | 3 | pass |
| both | white on the primary button, darker end | `#1d4ed8` | its fill | 6.70 | 4.5 | pass |
| both | white on the primary button, lighter end | `#2563eb` | its fill | 5.17 | 4.5 | pass |
| both | white on the danger button | `#b91c1c` | its fill | 6.47 | 4.5 | pass |
| both | white on cover: tech | `#1d4ed8` | its fill | 6.70 | 4.5 | pass |
| both | white on cover: business | `#b45309` | its fill | 5.02 | 4.5 | pass |
| both | white on cover: freelancing | `#6d28d9` | its fill | 7.10 | 4.5 | pass |
| both | white on cover: healthcare | `#047857` | its fill | 5.48 | 4.5 | pass |
| both | white on cover: other | `#475569` | its fill | 7.58 | 4.5 | pass |

## Adding or changing a color

1. **Look for an existing role first.** Most needs are covered by surfaces, text, brand or status.
2. **For a new role:**
   - declare it in both `:root` and `.dark` in `globals.css`, as RGB channels if it needs alpha;
   - map it in `tailwind.config.ts`;
   - add its pairs to `color-tokens.test.ts`;
   - add a row here.
3. **Check it in both themes:**
   - the contrast test;
   - the axe pass in `web/e2e/a11y.spec.ts` (light and dark);
   - a screenshot of each theme in the PR.
4. Don't add a Tailwind palette class or a hex value to a component. The guard test (7c) lists the few files allowed to hold literal colors: the category data, the OG images, the manifest and the error page.

## What Phase 7c changes

- It adds the status, `rating` and `input-border` tokens, and points the `.badge-*` classes at them.
- It retunes `gray-500`/`muted-foreground` (helper text gets slightly darker in both themes).
- It replaces about 360 Tailwind palette classes in 51 files with roles. In 13 of those places a light-only status color was unreadable in dark mode.
- It makes chart bars and progress fills solid `brand-600`, and the rating stars `rating`.
- It adds `.brand-panel` for the always-dark hero panels.
- It adds two guard tests (contrast pairs, no raw colors) and axe runs in both themes on the educator, institution, admin and QO pages.
