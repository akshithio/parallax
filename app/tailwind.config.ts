import type { Config } from 'tailwindcss'

// Make Tailwind's `/NN` opacity modifiers work with our CSS-variable colors
// (which are already full rgba/oklch values). Mirrors Tailwind v4 behaviour by
// emitting color-mix() instead of the rgb(var / alpha) form, which is invalid
// for non-triplet vars and was silently dropping backgrounds/borders.
// Returns `any` because Tailwind accepts a color *function* at runtime, but its
// TS types only allow strings for `extend.colors`.
function v(name: string): any {
  return ({ opacityValue }: { opacityValue?: string }) =>
    opacityValue === undefined
      ? `var(${name})`
      : `color-mix(in srgb, var(${name}) calc(${opacityValue} * 100%), transparent)`
}

const config: Config = {
  // The app themes via a `.dark` class (toggled in _document + the ⌘K palette),
  // so `dark:` utilities must track that class — NOT the OS `prefers-color-scheme`
  // (Tailwind's default). Without this, dark: variants follow the OS and disagree
  // with the actual in-app theme.
  darkMode: 'class',
  content: [
    './pages/**/*.{ts,tsx}',
    './components/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        background: v('--background'),
        foreground: v('--foreground'),
        card: {
          DEFAULT: v('--card'),
          foreground: v('--card-foreground'),
        },
        popover: {
          DEFAULT: v('--popover'),
          foreground: v('--popover-foreground'),
        },
        primary: {
          DEFAULT: v('--primary'),
          foreground: v('--primary-foreground'),
        },
        secondary: {
          DEFAULT: v('--secondary'),
          foreground: v('--secondary-foreground'),
        },
        muted: {
          DEFAULT: v('--muted'),
          foreground: v('--muted-foreground'),
        },
        accent: {
          DEFAULT: v('--accent'),
          foreground: v('--accent-foreground'),
        },
        destructive: v('--destructive'),
        border: v('--border'),
        input: v('--input'),
        ring: v('--ring'),
        success: v('--success'),
        warning: v('--warning'),
        sidebar: v('--sidebar'),
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
        xl: 'calc(var(--radius) + 4px)',
        '2xl': 'calc(var(--radius) + 8px)',
      },
      fontFamily: {
        sans: ['-apple-system', 'BlinkMacSystemFont', 'SF Pro Text', 'SF Pro Display', 'Helvetica Neue', 'sans-serif'],
        mono: ['SF Mono', 'SFMono-Regular', 'JetBrains Mono', 'Consolas', 'Liberation Mono', 'Menlo', 'monospace'],
      },
      keyframes: {
        'fade-in': {
          from: { opacity: '0', transform: 'translateY(4px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        'pop-in': {
          from: { opacity: '0', transform: 'scale(0.98) translateY(4px)' },
          to: { opacity: '1', transform: 'scale(1) translateY(0)' },
        },
        spin: {
          to: { transform: 'rotate(360deg)' },
        },
      },
      animation: {
        'fade-in': 'fade-in 0.18s ease both',
        'pop-in': 'pop-in 0.14s ease both',
        spin: 'spin 0.7s linear infinite',
      },
      maxWidth: {
        '3xl': '48rem',
      },
    },
  },
  plugins: [],
}

export default config
