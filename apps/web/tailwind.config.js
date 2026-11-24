/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: '#000000',
        surface: '#0E0E10',
        'surface-2': '#141416',
        line: 'rgba(255,255,255,0.10)',
        muted: '#9A9A9A',
        dim: '#8A8A8A',
        link: '#C9D6FF',
        pass: '#8FE0A6',
        warn: '#F5C065',
        fail: '#FF9B80',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['"IBM Plex Mono"', 'ui-monospace', 'monospace'],
      },
    },
  },
  plugins: [],
};
