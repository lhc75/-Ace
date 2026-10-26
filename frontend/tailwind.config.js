/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      // Cherry Studio 圆角体系: sm 6 / md 8 / lg 10 / xl 14 / 2xl 18
      borderRadius: {
        sm: '0.375rem',
        md: '0.5rem',
        lg: '0.625rem',
        xl: '0.875rem',
        '2xl': '1.125rem',
      },
      colors: {
        bg: {
          primary: 'rgb(var(--c-bg-primary) / <alpha-value>)',
          secondary: 'rgb(var(--c-bg-secondary) / <alpha-value>)',
          tertiary: 'rgb(var(--c-bg-tertiary) / <alpha-value>)',
          hover: 'rgb(var(--c-bg-hover) / <alpha-value>)',
        },
        accent: {
          blue: 'rgb(var(--c-accent-blue) / <alpha-value>)',
          strong: 'rgb(var(--c-accent-strong, var(--c-accent-blue)) / <alpha-value>)',
          soft: 'rgb(var(--c-accent-soft, var(--c-bg-tertiary)) / <alpha-value>)',
          green: 'rgb(var(--c-accent-green) / <alpha-value>)',
          red: 'rgb(var(--c-accent-red) / <alpha-value>)',
          amber: 'rgb(var(--c-accent-amber) / <alpha-value>)',
        },
        text: {
          primary: 'rgb(var(--c-text-primary) / <alpha-value>)',
          secondary: 'rgb(var(--c-text-secondary) / <alpha-value>)',
          muted: 'rgb(var(--c-text-muted) / <alpha-value>)',
          tertiary: 'rgb(var(--c-text-tertiary, var(--c-text-muted)) / <alpha-value>)',
        },
      },
    },
  },
  plugins: [],
}
