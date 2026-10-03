import { BAND_COLORS, GROUP_COLORS, categoryMeta } from '@/lib/categories';

export type CourseCoverSize = 'card' | 'strip';

const BAND_STRIPE_PX = 6;

// Hard-stop stripes, repeated: green, yellow, red, white, blue.
const BAND_BACKGROUND = `repeating-linear-gradient(90deg, ${BAND_COLORS.map(
  (c, i) => `${c} ${i * BAND_STRIPE_PX}px ${(i + 1) * BAND_STRIPE_PX}px`,
).join(', ')})`;

const SIZES: Record<CourseCoverSize, { box: string; title: string; labels: string }> = {
  // Catalog / home card: the card's price badge sits top right, so the labels leave room for it.
  card: { box: 'min-h-40 gap-3 px-5 pb-5 pt-4', title: 'text-lg leading-snug', labels: 'pr-24' },
  // Short, wide header strip for the top of the course page.
  strip: { box: 'min-h-28 gap-2 px-6 pb-4 pt-4 sm:px-8', title: 'text-xl leading-snug sm:text-2xl', labels: '' },
};

/**
 * The generated cover for a course without a real thumbnail: category colour, the
 * full title, English and Amharic category labels and the woven band. CSS only.
 * `decorative` hides it from assistive tech where the title is already next to it.
 */
export function CourseCover({
  title,
  category,
  size = 'card',
  decorative = false,
}: {
  title: string;
  category: string | null | undefined;
  size?: CourseCoverSize;
  decorative?: boolean;
}) {
  const meta = categoryMeta(category);
  const s = SIZES[size];
  return (
    <div
      className={`relative flex flex-col justify-between overflow-hidden text-white ${s.box}`}
      style={{ backgroundColor: GROUP_COLORS[meta.group] }}
      {...(decorative ? { 'aria-hidden': true } : { role: 'img', 'aria-label': `${title}, ${meta.label}` })}
    >
      <p className={`flex flex-wrap items-center gap-x-2 text-xs font-semibold text-white/80 ${s.labels}`}>
        <span className="uppercase tracking-wider">{meta.label}</span>
        <span aria-hidden>·</span>
        <span lang="am">{meta.am}</span>
      </p>
      <p className={`break-words font-bold ${s.title}`}>{title}</p>
      <span aria-hidden className="absolute inset-x-0 bottom-0 h-1.5" style={{ background: BAND_BACKGROUND }} />
    </div>
  );
}
