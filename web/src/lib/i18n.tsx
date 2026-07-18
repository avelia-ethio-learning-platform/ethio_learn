'use client';

import { createContext, useCallback, useContext, useEffect, useState } from 'react';

/**
 * Lightweight en/am i18n for the UI chrome. Course content itself stays in the
 * language the educator authored it in. Amharic strings cover navigation, auth
 * and the learner-facing surfaces.
 */
export type Locale = 'en' | 'am';

/** Exported for tests (key-parity check) and future locale tooling. */
export const dictionaries = {
  en: {
    courses: 'Courses',
    my_learning: 'My Learning',
    teach: 'Teach',
    institution: 'Institution',
    review_queue: 'Review Queue',
    admin: 'Admin',
    login: 'Log in',
    signup: 'Sign up',
    logout: 'Log out',
    search_placeholder: 'Search courses…',
    search: 'Search',
    hero_title: 'Learn real skills from Ethiopian experts',
    hero_sub:
      'Video courses in tech, business, freelancing and healthcare — priced in ETB, paid with Telebirr, CBE Birr and 18+ Ethiopian banks through Chapa, with publicly verifiable certificates.',
    all: 'All',
    free: 'Free',
    freemium: 'Freemium',
    paid: 'Paid',
    no_courses: 'No published courses match yet.',
    become_educator: 'Become an educator',
    enroll_free: 'Enroll for free',
    buy_with_chapa: 'Buy with Chapa',
    continue_learning: 'Continue learning →',
    login_to_enroll: 'Log in to enroll',
    course_content: 'Course content',
    learner_reviews: 'Learner reviews',
    free_preview: 'Free preview',
    email: 'Email',
    password: 'Password',
    full_name: 'Full name',
    create_account: 'Create your account',
    forgot_password: 'Forgot password?',
    enrolled_courses: 'Enrolled courses',
    certificates: 'Certificates',
    payment_history: 'Payment history',
    refund_requests: 'Refund requests',
    progress: 'complete',
    verify_valid: 'Valid certificate',
    verify_invalid: 'Not a valid certificate',
    lang_name: 'አማርኛ',
  },
  am: {
    courses: 'ኮርሶች',
    my_learning: 'ትምህርቴ',
    teach: 'አስተምር',
    institution: 'ተቋም',
    review_queue: 'የግምገማ ወረፋ',
    admin: 'አስተዳደር',
    login: 'ግባ',
    signup: 'ተመዝገብ',
    logout: 'ውጣ',
    search_placeholder: 'ኮርሶችን ፈልግ…',
    search: 'ፈልግ',
    hero_title: 'ከኢትዮጵያ ባለሙያዎች እውነተኛ ክህሎቶችን ይማሩ',
    hero_sub:
      'በቴክኖሎጂ፣ ቢዝነስ፣ ፍሪላንሲንግ እና ጤና ዘርፎች የቪዲዮ ኮርሶች — በብር ዋጋ፣ በቴሌብር፣ CBE ብር እና 18+ የኢትዮጵያ ባንኮች በቻፓ በኩል ይክፈሉ፣ በይፋ የሚረጋገጡ ሰርተፍኬቶች ያግኙ።',
    all: 'ሁሉም',
    free: 'ነፃ',
    freemium: 'ፍሪሚየም',
    paid: 'የሚከፈል',
    no_courses: 'ምንም የታተመ ኮርስ አልተገኘም።',
    become_educator: 'አስተማሪ ይሁኑ',
    enroll_free: 'በነፃ ይመዝገቡ',
    buy_with_chapa: 'በቻፓ ይግዙ',
    continue_learning: 'መማር ይቀጥሉ →',
    login_to_enroll: 'ለመመዝገብ ይግቡ',
    course_content: 'የኮርስ ይዘት',
    learner_reviews: 'የተማሪ ግምገማዎች',
    free_preview: 'ነፃ ቅድመ-እይታ',
    email: 'ኢሜይል',
    password: 'የይለፍ ቃል',
    full_name: 'ሙሉ ስም',
    create_account: 'መለያ ይፍጠሩ',
    forgot_password: 'የይለፍ ቃል ረሱ?',
    enrolled_courses: 'የተመዘገቡ ኮርሶች',
    certificates: 'ሰርተፍኬቶች',
    payment_history: 'የክፍያ ታሪክ',
    refund_requests: 'የገንዘብ ተመላሽ ጥያቄዎች',
    progress: 'ተጠናቋል',
    verify_valid: 'ትክክለኛ ሰርተፍኬት',
    verify_invalid: 'ትክክለኛ ሰርተፍኬት አይደለም',
    lang_name: 'English',
  },
} as const;

export type TKey = keyof (typeof dictionaries)['en'];

const I18nContext = createContext<{ locale: Locale; t: (k: TKey) => string; toggle: () => void }>({
  locale: 'en',
  t: (k) => dictionaries.en[k],
  toggle: () => undefined,
});

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [locale, setLocale] = useState<Locale>('en');

  useEffect(() => {
    const saved = localStorage.getItem('el_locale');
    if (saved === 'am' || saved === 'en') setLocale(saved);
  }, []);

  const toggle = useCallback(() => {
    setLocale((prev) => {
      const next = prev === 'en' ? 'am' : 'en';
      localStorage.setItem('el_locale', next);
      document.documentElement.lang = next;
      return next;
    });
  }, []);

  const t = useCallback((k: TKey) => dictionaries[locale][k] ?? dictionaries.en[k], [locale]);

  return <I18nContext.Provider value={{ locale, t, toggle }}>{children}</I18nContext.Provider>;
}

export function useT() {
  return useContext(I18nContext);
}
