import type { Variants } from 'framer-motion';

/**
 * The framer side of the motion tokens in globals.css (--dur-*, --ease-*, --stagger, --rise).
 * Change a number in both places. CSS does most of the motion; framer only does exits,
 * the header's shared underline and the Home reveals.
 */
export const dur = { fast: 0.12, base: 0.2, slow: 0.32 } as const;
export const ease = { quart: [0.25, 1, 0.5, 1], expo: [0.16, 1, 0.3, 1] } as const;
const STAGGER = 0.04;
/** The only enter distance, in px. */
export const RISE = 8;

/** A page-level reveal: opacity plus a short rise. */
export const rise: Variants = {
  hidden: { opacity: 0, y: RISE },
  visible: { opacity: 1, y: 0, transition: { duration: dur.slow, ease: ease.expo } },
};

/** Staggers its `rise` children; six cards all start within 200 ms. */
export const listStagger: Variants = {
  hidden: {},
  visible: { transition: { staggerChildren: STAGGER } },
};

/** Small menus (the bell, the theme menu): a quick scale from the trigger; the exit is faster than the enter. */
export const popover: Variants = {
  hidden: { opacity: 0, scale: 0.98, transition: { duration: dur.fast / 2, ease: ease.quart } },
  visible: { opacity: 1, scale: 1, transition: { duration: dur.fast, ease: ease.quart } },
};

/** `whileInView` reveals run once, when the element is 60 px into the screen. */
export const inView = { once: true, margin: '-60px' } as const;
