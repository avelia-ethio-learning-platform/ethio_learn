// Course categories for the frontend. The web app is a standalone workspace
// with no import from api/, so this mirrors CourseCategory in
// api/packages/contracts/src/enums.ts — keep the two in sync when adding a
// category. `icon` is an emoji used by cards/filters for a bit of visual life.

export interface CategoryMeta {
  value: string;
  label: string;
  icon: string;
}

export const COURSE_CATEGORIES: CategoryMeta[] = [
  { value: 'programming', label: 'Programming', icon: '💻' },
  { value: 'web_development', label: 'Web Development', icon: '🌐' },
  { value: 'design', label: 'Graphic Design', icon: '🎨' },
  { value: 'video_editing', label: 'Video Editing', icon: '🎬' },
  { value: 'data_science', label: 'Data Science', icon: '📊' },
  { value: 'tech', label: 'Technology', icon: '🔧' },
  { value: 'business', label: 'Business', icon: '💼' },
  { value: 'marketing', label: 'Marketing', icon: '📣' },
  { value: 'freelancing', label: 'Freelancing', icon: '🧑‍💻' },
  { value: 'finance', label: 'Finance', icon: '💰' },
  { value: 'language', label: 'Language', icon: '🗣️' },
  { value: 'healthcare', label: 'Healthcare', icon: '🩺' },
  { value: 'agriculture', label: 'Agriculture', icon: '🌾' },
  { value: 'arts', label: 'Arts & Music', icon: '🎵' },
  { value: 'education', label: 'Education', icon: '📚' },
  { value: 'other', label: 'Other', icon: '✨' },
];

const BY_VALUE = new Map(COURSE_CATEGORIES.map((c) => [c.value, c]));

/** Human-readable label for any stored category value (unknown → "Other"). */
export function categoryLabel(value: string | null | undefined): string {
  return (value && BY_VALUE.get(value)?.label) || 'Other';
}

/** Emoji for a category value (unknown → the "Other" sparkle). */
export function categoryIcon(value: string | null | undefined): string {
  return (value && BY_VALUE.get(value)?.icon) || '✨';
}
