'use client';

import { useEffect, useRef, useState } from 'react';
import { findPrimaryAction, scrollBehavior, type PrimaryActionKind } from '@/lib/course-page';

/**
 * Below `lg`: a fixed bar shown once the buy box's primary action (inside the
 * element with `targetId`) scrolls out of view. Its button mirrors the box's primary action (the control
 * marked `data-primary-action`) and scrolls to and focuses it; it has no enroll
 * logic of its own. When the box has no enabled primary action (a non-learner,
 * gift mode, a payment in progress) the bar is not shown at all. For an enrolled
 * viewer the bar shows "Continue learning" without the price.
 * While visible it publishes its height as `--buy-bar-h`, which the page body and
 * the waking-up notice use to stay clear of it.
 */
export function MobileBuyBar({ targetId, price }: { targetId: string; price: string }) {
  const [outOfView, setOutOfView] = useState(false);
  const [action, setAction] = useState<{ label: string; kind: PrimaryActionKind } | null>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const show = outOfView && action !== null;

  useEffect(() => {
    const target = document.getElementById(targetId);
    if (!target) return;
    // Watch the primary button (the aside when there is none), so the bar shows whenever the button is out of view.
    let intersections: IntersectionObserver | undefined;
    let watched: Element | undefined;
    const watch = (el: Element) => {
      if (!intersections || el === watched) return;
      if (watched) intersections.unobserve(watched);
      watched = el;
      intersections.observe(el);
    };
    const sync = () => {
      const found = findPrimaryAction(target);
      watch(found?.el ?? target);
      setAction((prev) => {
        if (!found) return prev === null ? prev : null;
        return prev && prev.label === found.label && prev.kind === found.kind ? prev : { label: found.label, kind: found.kind };
      });
    };
    if (typeof IntersectionObserver !== 'undefined') {
      intersections = new IntersectionObserver(([entry]) => setOutOfView(!entry.isIntersecting));
    }
    sync();
    // The enroll panel renders after auth and status load, and changes with the mode tabs.
    const mutations = new MutationObserver(sync);
    mutations.observe(target, { subtree: true, childList: true, attributes: true, characterData: true });
    return () => {
      mutations.disconnect();
      intersections?.disconnect();
    };
  }, [targetId]);

  useEffect(() => {
    const root = document.documentElement;
    const publish = () => {
      // offsetHeight is 0 at lg and up, where the bar is display: none.
      const h = show ? (barRef.current?.offsetHeight ?? 0) : 0;
      if (h > 0) root.style.setProperty('--buy-bar-h', `${h}px`);
      else root.style.removeProperty('--buy-bar-h');
    };
    publish();
    window.addEventListener('resize', publish);
    return () => {
      window.removeEventListener('resize', publish);
      root.style.removeProperty('--buy-bar-h');
    };
  }, [show]);

  if (!show || !action) return null;

  const goToAction = () => {
    const box = document.getElementById(targetId);
    const found = findPrimaryAction(box);
    if (!box || !found) return;
    box.scrollIntoView({ behavior: scrollBehavior(), block: 'center' });
    found.el.focus({ preventScroll: true });
  };

  return (
    <div
      ref={barRef}
      className="fixed inset-x-0 bottom-0 z-40 flex items-center justify-between gap-3 bg-background px-4 py-3 shadow-floating lg:hidden"
      style={{ borderTop: '1px solid var(--border)' }}
    >
      {action.kind !== 'continue' && <p className="gradient-text-blue min-w-0 truncate text-lg font-extrabold">{price}</p>}
      <button type="button" className={`btn shrink-0 !px-5 ${action.kind === 'continue' ? 'w-full' : ''}`} onClick={goToAction}>
        {action.label}
      </button>
    </div>
  );
}
