import type { Config } from 'tailwindcss';

/**
 * Theme tokens are CSS variables declared in globals.css so the whole palette
 * flips between light and dark with the `.dark` class (template parity).
 * `brand` and `gray` use RGB channels to keep Tailwind alpha modifiers working.
 */
const channel = (name: string) => `rgb(var(--${name}) / <alpha-value>)`;

/**
 * A status role (docs/COLOR_SYSTEM.md): `text-success` for words, `bg-success-soft` with
 * `border-success-line` for a callout or badge, and `bg-success-solid` for a graphic with no text on it.
 */
const status = (name: string) => ({
  DEFAULT: channel(name),
  soft: `var(--${name}-soft)`,
  line: `var(--${name}-line)`,
  solid: channel(`${name}-solid`),
});

const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        background: 'var(--background)',
        'background-secondary': 'var(--background-secondary)',
        'background-tertiary': 'var(--background-tertiary)',
        foreground: 'var(--foreground)',
        'muted-foreground': 'var(--muted-foreground)',
        card: 'var(--card)',
        'card-border': 'var(--card-border)',
        'input-bg': 'var(--input-background)',
        primary: {
          DEFAULT: channel('brand-600'),
          foreground: '#ffffff',
        },
        brand: {
          50: channel('brand-50'),
          100: channel('brand-100'),
          200: channel('brand-200'),
          300: channel('brand-300'),
          400: channel('brand-400'),
          500: channel('brand-500'),
          600: channel('brand-600'),
          700: channel('brand-700'),
          800: channel('brand-800'),
          900: channel('brand-900'),
        },
        gray: {
          50: channel('gray-50'),
          100: channel('gray-100'),
          200: channel('gray-200'),
          300: channel('gray-300'),
          400: channel('gray-400'),
          500: channel('gray-500'),
          600: channel('gray-600'),
          700: channel('gray-700'),
          800: channel('gray-800'),
          900: channel('gray-900'),
        },
        success: status('success'),
        warning: status('warning'),
        danger: status('danger'),
        info: status('info'),
        rating: channel('rating'),
      },
      borderColor: {
        DEFAULT: 'var(--border)',
        'input-border': 'var(--input-border)',
      },
      fontFamily: {
        // next/font variables (app/fonts.ts)
        sans: ['var(--font-inter)', 'var(--font-ethiopic)', 'system-ui', '-apple-system', 'sans-serif'],
        ethiopic: ['var(--font-ethiopic)', 'var(--font-inter)', 'sans-serif'],
      },
      boxShadow: {
        glass: 'var(--shadow-glass)',
        elevated: 'var(--shadow-elevated)',
        floating: 'var(--shadow-floating)',
        hover: 'var(--shadow-hover)',
      },
      // The motion tokens in globals.css (`duration-fast`, `ease-out-quart` and so on).
      transitionDuration: {
        fast: 'var(--dur-fast)',
        base: 'var(--dur-base)',
        slow: 'var(--dur-slow)',
      },
      // DEFAULT: a bare `transition` uses the UI-feedback easing, so there is no third easing.
      transitionTimingFunction: {
        DEFAULT: 'var(--ease-out-quart)',
        'out-quart': 'var(--ease-out-quart)',
        'out-expo': 'var(--ease-out-expo)',
      },
      keyframes: {
        // Only a `from`: the resting style is the end state (see globals.css).
        'fade-in-up': {
          from: { opacity: '0.01', transform: 'translateY(var(--rise))' },
        },
      },
      animation: {
        'fade-in-up': 'fade-in-up var(--dur-base) var(--ease-out-expo) backwards',
      },
    },
  },
  plugins: [],
};

export default config;
