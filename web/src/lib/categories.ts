// Course categories for the frontend. The web app is a standalone workspace
// with no import from api/, so this mirrors CourseCategory in
// api/packages/contracts/src/enums.ts — keep the two in sync when adding a
// category. `icon` is an emoji used by cards/filters for a bit of visual life.
// This is the one source for a category's English label, Amharic label and colour
// group: CourseCover (Tailwind) and the OG image (Satori) both read this data.
// The Amharic labels are on the native-speaker review list; the five that have
// `cat_*` i18n keys must match them (pinned by categories.test.ts).

export type CategoryGroup = 'tech' | 'business' | 'freelancing' | 'healthcare' | 'other';

export interface CategoryMeta {
  value: string;
  label: string;
  /** Amharic label. */
  am: string;
  icon: string;
  /** One of five colour groups. */
  group: CategoryGroup;
}

/** Cover background per group. Dark enough for white text (WCAG AA). */
export const GROUP_COLORS: Record<CategoryGroup, string> = {
  tech: '#1d4ed8',
  business: '#b45309',
  freelancing: '#6d28d9',
  healthcare: '#047857',
  other: '#475569',
};

/** The woven band: thin stripes repeated along the cover edge, in order. */
export const BAND_COLORS: readonly string[] = ['#078930', '#fcdd09', '#da121a', '#ffffff', '#1d4ed8'];

export const COURSE_CATEGORIES: CategoryMeta[] = [
  { value: 'programming', label: 'Programming', am: 'ፕሮግራሚንግ', icon: '💻', group: 'tech' },
  { value: 'web_development', label: 'Web Development', am: 'የድር ልማት', icon: '🌐', group: 'tech' },
  { value: 'design', label: 'Graphic Design', am: 'ግራፊክ ዲዛይን', icon: '🎨', group: 'freelancing' },
  { value: 'video_editing', label: 'Video Editing', am: 'ቪዲዮ ኤዲቲንግ', icon: '🎬', group: 'freelancing' },
  { value: 'data_science', label: 'Data Science', am: 'ዳታ ሳይንስ', icon: '📊', group: 'tech' },
  { value: 'tech', label: 'Technology', am: 'ቴክኖሎጂ', icon: '🔧', group: 'tech' },
  { value: 'business', label: 'Business', am: 'ቢዝነስ', icon: '💼', group: 'business' },
  { value: 'marketing', label: 'Marketing', am: 'ማርኬቲንግ', icon: '📣', group: 'business' },
  { value: 'freelancing', label: 'Freelancing', am: 'ፍሪላንሲንግ', icon: '🧑‍💻', group: 'freelancing' },
  { value: 'finance', label: 'Finance', am: 'ፋይናንስ', icon: '💰', group: 'business' },
  { value: 'language', label: 'Language', am: 'ቋንቋ', icon: '🗣️', group: 'other' },
  { value: 'healthcare', label: 'Healthcare', am: 'ጤና', icon: '🩺', group: 'healthcare' },
  { value: 'agriculture', label: 'Agriculture', am: 'ግብርና', icon: '🌾', group: 'healthcare' },
  { value: 'arts', label: 'Arts & Music', am: 'ጥበብ እና ሙዚቃ', icon: '🎵', group: 'other' },
  { value: 'education', label: 'Education', am: 'ትምህርት', icon: '📚', group: 'other' },
  { value: 'other', label: 'Other', am: 'ሌላ', icon: '✨', group: 'other' },
];

const BY_VALUE = new Map(COURSE_CATEGORIES.map((c) => [c.value, c]));

/** Emoji for a category value (unknown → the "Other" sparkle). */
export function categoryIcon(value: string | null | undefined): string {
  return (value && BY_VALUE.get(value)?.icon) || '✨';
}

/** The entry for a category value; an unknown or missing value is the "other" entry. */
export function categoryMeta(value: string | null | undefined): CategoryMeta {
  return (value && BY_VALUE.get(value)) || BY_VALUE.get('other')!;
}

/** The English label for a category value (unknown → "Other"). */
export function categoryLabel(value: string | null | undefined): string {
  return categoryMeta(value).label;
}

/** True for an uploaded thumbnail; false for none and for the seed's placehold.co placeholder. */
export function hasRealThumbnail(url: string | null | undefined): url is string {
  if (!url) return false;
  try {
    const host = new URL(url).hostname;
    return host !== 'placehold.co' && !host.endsWith('.placehold.co');
  } catch {
    return true; // a relative path is a real upload
  }
}
