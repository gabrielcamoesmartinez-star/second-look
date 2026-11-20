import type { Config } from 'tailwindcss';

// Stage 1 uses a minimal palette from the brand tokens; the full design system is Stage 4.
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: '#000000',
        surface: '#0E0E10',
        'surface-2': '#141416',
        muted: '#9A9A9A',
        dim: '#8A8A8A',
        link: '#C9D6FF',
        pass: '#8FE0A6',
        warn: '#F5C065',
        fail: '#FF9B80',
      },
      borderColor: { line: 'rgba(255,255,255,.10)' },
      fontFamily: { mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'] },
    },
  },
} satisfies Config;
