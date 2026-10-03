'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * Below `lg`: a fixed bar with the price and a primary button, shown once the
 * buy box (the element with `targetId`) scrolls out of view. The button scrolls
 * to the box and focuses its primary action; it has no enroll logic of its own.
 * While visible it publishes its height as `--buy-bar-h`, which the page body and
 * the waking-up notice use to stay clear of it.
 */
export function MobileBuyBar({ targetId, price, actionLabel }: { targetId: string; price: string; actionLabel: string }) {
  const [show, setShow] = useState(false);
  const barRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const target = document.getElementById(targetId);
    if (!target || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(([entry]) => setShow(!entry.isIntersecting));
    observer.observe(target);
    return () => observer.disconnect();
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

  if (!show) return null;

  const goToAction = () => {
    const box = document.getElementById(targetId);
    if (!box) return;
    const action = box.querySelector<HTMLElement>('.btn');
    box.scrollIntoView({ behavior: 'smooth', block: 'center' });
    (action ?? box).focus({ preventScroll: true });
  };

  return (
    <div
      ref={barRef}
      className="fixed inset-x-0 bottom-0 z-40 flex items-center justify-between gap-3 bg-background px-4 py-3 shadow-floating lg:hidden"
      style={{ borderTop: '1px solid var(--border)' }}
    >
      <p className="gradient-text-blue min-w-0 truncate text-lg font-extrabold">{price}</p>
      <button type="button" className="btn shrink-0 !px-5" onClick={goToAction}>
        {actionLabel}
      </button>
    </div>
  );
}
