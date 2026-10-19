import { expect, test, type Locator, type Page } from './test';
import { learnerCertificateUid } from './support';

// P1-57: with reduced motion on, the hero heading is fully opaque at first
// paint, not faded in after hydration.
test.use({ reducedMotion: 'reduce' });

test('the home hero heading is opaque at first paint', async ({ page }) => {
  // Record the heading's effective opacity (its own times every ancestor's) the
  // moment the browser reports first-contentful-paint.
  await page.addInitScript(() => {
    // null when the heading isn't in the first paint at all, so the check below fails rather than passing on nothing.
    const effectiveOpacity = (el: Element | null): number | null => {
      if (!el) return null;
      let o = 1;
      for (let node: Element | null = el; node; node = node.parentElement) o *= Number(getComputedStyle(node).opacity);
      return o;
    };
    new PerformanceObserver((list, observer) => {
      if (!list.getEntriesByName('first-contentful-paint').length) return;
      (window as unknown as { __heroOpacity: number | null }).__heroOpacity = effectiveOpacity(document.querySelector('main h1'));
      observer.disconnect();
    }).observe({ type: 'paint', buffered: true });
  });

  await page.goto('/');
  const h1 = page.locator('main h1').first();
  await expect(h1).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __heroOpacity?: number | null }).__heroOpacity)).toBe(1);
  await expect(h1).toHaveCSS('opacity', '1');
});

// Phase 12a: under reduced motion nothing animates in. Both probes record at mount, so a skipped
// reduced-motion rule fails them, and the no-preference controls at the end prove they can fail.
// - CSS enters (.route-enter, .fade-in, the dialog): the element's own animations when it mounts or opens.
// - Framer surfaces (menus, the bell panel): the distinct transforms they pass through after mount.
type Probe = { css: { cls: string; n: number }[]; framer: Record<string, number> };

async function installProbe(page: Page) {
  await page.addInitScript(() => {
    const probe: Probe = { css: [], framer: {} };
    (window as unknown as { __probe: Probe }).__probe = probe;
    const ENTERS = ['route-enter', 'fade-in', 'dialog-enter'];
    const still = (t: string) => t === 'none' || t === 'matrix(1, 0, 0, 1, 0, 0)';
    const cssEnter = (el: Element) => {
      const cls = ENTERS.find((c) => el.classList.contains(c));
      if (!cls) return;
      // getAnimations() resolves style, so a CSS animation exists here unless the rule removed it.
      const n = el.getAnimations({ subtree: true }).filter((a) => (a.effect as KeyframeEffect | null)?.target === el).length;
      probe.css.push({ cls, n });
    };
    // Every frame for 250 ms after mount, collect the distinct transforms the surface passes through.
    // Under reduce framer snaps from the start position to rest (one value at most); with motion
    // allowed every enter here passes through in-between values on its way.
    const framer = (el: Element) => {
      const start = performance.now();
      const seen = new Set<string>();
      const read = () => {
        const t = getComputedStyle(el).transform;
        if (!still(t)) seen.add(t);
        if (performance.now() - start < 250) return void requestAnimationFrame(read);
        probe.framer[el.id] = seen.size;
      };
      requestAnimationFrame(read);
    };
    new MutationObserver((records) => {
      for (const r of records) {
        if (r.type === 'attributes') {
          if ((r.target as HTMLDialogElement).open) cssEnter(r.target as Element);
          continue;
        }
        for (const node of Array.from(r.addedNodes)) {
          if (!(node instanceof Element)) continue;
          for (const el of [node, ...Array.from(node.querySelectorAll('.route-enter, .fade-in, [id]'))]) {
            if (!(el instanceof HTMLDialogElement)) cssEnter(el);
            if (el.id && !(el.id in probe.framer)) framer(el);
          }
        }
      }
    }).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['open'] });
  });
}

const probeOf = (page: Page) => page.evaluate(() => (window as unknown as { __probe: Probe }).__probe);

/** How many distinct transforms the surface passed through in its first 250 ms (waits for the reading). */
async function framerMoved(page: Page, surface: Locator) {
  const id = (await surface.getAttribute('id'))!;
  await expect.poll(async () => (await probeOf(page)).framer[id], { message: `a reading for #${id}` }).not.toBeUndefined();
  return (await probeOf(page)).framer[id];
}

/** The most animations any CSS enter of this class had when it mounted (fails if none mounted). */
async function cssEnterAnimations(page: Page, cls: string) {
  await expect.poll(async () => (await probeOf(page)).css.filter((e) => e.cls === cls).length, { message: `a .${cls} mounted` }).toBeGreaterThan(0);
  return Math.max(...(await probeOf(page)).css.filter((e) => e.cls === cls).map((e) => e.n));
}

async function openMobileMenu(page: Page) {
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto('/courses');
  // Hydrated and idle, so a busy main thread can't skip the frames the probe samples.
  await page.waitForLoadState('networkidle');
  const burger = page.getByRole('button', { name: 'Menu' });
  await burger.click();
  return page.locator(`[id="${await burger.getAttribute('aria-controls')}"]`);
}

test.describe('reduced motion', () => {
  test.beforeEach(({ page }) => installProbe(page));

  test('the mobile menu opens at rest, and its first link works at once', async ({ page }) => {
    const menu = await openMobileMenu(page);
    expect(await framerMoved(page, menu), 'transform steps in the menu').toBeLessThanOrEqual(1);
    await expect(menu).toHaveCSS('opacity', '1');
    await menu.getByRole('link', { name: 'Home' }).click({ timeout: 1000 });
    await expect(page).toHaveURL(/\/$/);
  });

  test('the theme menu opens at rest, and its first option works at once', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');
    const trigger = page.getByRole('button', { name: 'Theme' }).first();
    await trigger.click();
    const menu = page.locator(`[id="${await trigger.getAttribute('aria-controls')}"]`);
    expect(await framerMoved(page, menu), 'transform steps in the menu').toBeLessThanOrEqual(1);
    await expect(menu).toHaveCSS('opacity', '1');
    await menu.getByRole('button', { name: 'Light' }).click({ timeout: 1000 });
    await expect(menu).toHaveCount(0);
  });

  test('a catalog change shows the new results with no enter animation', async ({ page }) => {
    await page.goto('/courses');
    // .last(): a keyed grid swap can briefly hold the old and new grids, and a bare locator then fails strict mode.
    const results = page.getByTestId('results');
    await expect(results.last()).toBeVisible();
    await page.getByLabel('Sort by').selectOption({ label: 'Newest' });
    await expect(page).toHaveURL(/[?&]sort=new(&|$)/);
    // The swap is done once only the new grid is left.
    await expect(results).toHaveCount(1);
    await expect(results).toBeVisible();
    expect(await cssEnterAnimations(page, 'fade-in')).toBe(0);
  });

  test.describe('signed in as a learner', () => {
    test.use({ loggedInAs: 'learner' });

    test('the notification panel opens at rest', async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto('/dashboard');
      const bell = page.getByRole('button', { name: /^Notifications/ }).first();
      await bell.click();
      const panel = page.locator(`[id="${await bell.getAttribute('aria-controls')}"]`);
      expect(await framerMoved(page, panel), 'transform steps in the panel').toBeLessThanOrEqual(1);
      await expect(panel).toHaveCSS('opacity', '1');
    });

    for (const path of ['/dashboard', '/messages', '/account']) {
      test(`${path} (under a template.tsx) has no enter animation`, async ({ page }) => {
        await page.goto(path);
        expect(await cssEnterAnimations(page, 'route-enter')).toBe(0);
      });
    }
  });

  for (const [role, path] of [['educator', '/teach'], ['platform_admin', '/admin']] as const) {
    test.describe(`signed in as ${role}`, () => {
      test.use({ loggedInAs: role });

      test(`${path} (under a template.tsx) has no enter animation`, async ({ page }) => {
        await page.goto(path);
        expect(await cssEnterAnimations(page, 'route-enter')).toBe(0);
      });
    });
  }

  test.describe('signed in as platform_admin', () => {
    test.use({ loggedInAs: 'platform_admin' });

    test('the confirm dialog opens with no enter animation, and Cancel works at once', async ({ page }) => {
      await page.goto('/admin?tab=users');
      await expect(page.getByRole('tab', { name: 'Users' })).toHaveAttribute('aria-selected', 'true');
      await page.getByRole('button', { name: 'Suspend', exact: true }).first().click();
      const dialog = page.getByRole('dialog', { name: /^Suspend / });
      await expect(dialog).toBeVisible();
      expect(await cssEnterAnimations(page, 'dialog-enter')).toBe(0);
      await dialog.getByRole('button', { name: 'Cancel' }).click({ timeout: 1000 });
      await expect(dialog).toBeHidden();
    });
  });
});

// Controls: with motion allowed, the same probes do see the enters, so the checks above can fail.
test.describe('motion allowed (controls)', () => {
  test.use({ reducedMotion: 'no-preference', loggedInAs: 'learner' });
  test.beforeEach(({ page }) => installProbe(page));

  test('the probes see the mobile menu move and a route fade in', async ({ page }) => {
    const menu = await openMobileMenu(page);
    expect(await framerMoved(page, menu), 'transform steps in the menu').toBeGreaterThan(1);
    await page.goto('/dashboard');
    expect(await cssEnterAnimations(page, 'route-enter')).toBeGreaterThan(0);
  });
});

// Phase 12b: the payment-return states and the certificate page under reduced motion.
/** Fully opaque and not transformed (toBeVisible ignores both). */
async function expectAtRest(el: Locator) {
  await expect(el).toBeVisible();
  await expect(el).toHaveCSS('opacity', '1');
  await expect(el).toHaveCSS('transform', 'none');
}

test.describe('signed in as a learner, 12b', () => {
  test.use({ loggedInAs: 'learner' });

  test('payment return: the confirmed state is at rest, and "Start learning" has focus', async ({ page }) => {
    await page.route('**/api/v1/payments/reconcile', (route) => route.fulfill({ json: { status: 'confirmed' } }));
    await page.goto('/payment/return?course_id=demo-course&tx_ref=demo-tx');
    const start = page.getByRole('link', { name: 'Start learning' });
    await expect(start).toBeFocused();
    await expectAtRest(start.locator('xpath=..'));
    await start.click({ timeout: 1000, trial: true });
  });
});

test('a valid certificate: the card and the flag band are at rest and fully opaque', async ({ page, request }) => {
  const uid = await learnerCertificateUid(request);
  await page.goto(`/verify/${uid}`);
  await expectAtRest(page.locator('main .card').first());
  await expectAtRest(page.locator('main .band-wipe'));
});
