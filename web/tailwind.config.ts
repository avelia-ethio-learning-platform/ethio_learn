import type { Config } from 'tailwindcss';

/**
 * Theme tokens are CSS variables declared in globals.css so the whole palette
 * flips between light and dark with the `.dark` class (template parity).
 * `brand` and `gray` use RGB channels to keep Tailwind alpha modifiers working.
 */
const channel = (name: string) => `rgb(var(--${name}) / <alpha-value>)`;

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
      },
      borderColor: {
        DEFAULT: 'var(--border)',
      },
      fontFamily: {
        sans: ['Inter', 'Noto Sans Ethiopic', 'system-ui', '-apple-system', 'sans-serif'],
        ethiopic: ['Noto Sans Ethiopic', 'Inter', 'sans-serif'],
      },
      boxShadow: {
        glass: 'var(--shadow-glass)',
        elevated: 'var(--shadow-elevated)',
        floating: 'var(--shadow-floating)',
        hover: 'var(--shadow-hover)',
      },
      transitionTimingFunction: {
        'out-quart': 'cubic-bezier(0.25, 1, 0.5, 1)',
        'out-expo': 'cubic-bezier(0.16, 1, 0.3, 1)',
      },
      keyframes: {
        float: {
          '0%, 100%': { transform: 'translateY(0px)' },
          '50%': { transform: 'translateY(-8px)' },
        },
        'fade-in-up': {
          from: { opacity: '0', transform: 'translateY(14px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        'fade-in': {
          from: { opacity: '0' },
          to: { opacity: '1' },
        },
        shimmer: {
          '0%': { backgroundPosition: '-400px 0' },
          '100%': { backgroundPosition: '400px 0' },
        },
        'spin-slow': {
          from: { transform: 'rotate(0deg)' },
          to: { transform: 'rotate(360deg)' },
        },
        'pulse-soft': {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.85' },
        },
      },
      animation: {
        float: 'float 10s ease-in-out infinite',
        'float-delayed': 'float 10s ease-in-out -4s infinite',
        'fade-in-up': 'fade-in-up 0.6s cubic-bezier(0.16, 1, 0.3, 1) both',
        'fade-in': 'fade-in 0.5s ease-out both',
        shimmer: 'shimmer 1.6s linear infinite',
        'spin-slow': 'spin-slow 22s linear infinite',
        'pulse-soft': 'pulse-soft 5s ease-in-out infinite',
      },
    },
  },
  plugins: [],
};

export default config;
