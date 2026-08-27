/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        panel: {
          DEFAULT: '#FFFFFF',
          raised: '#F8FAFC',
          inset: '#F1F5F9',
          hover: '#E8F0F7',
        },
        ink: {
          DEFAULT: '#1F2937',
          dim: '#526274',
          faint: '#7B8794',
        },
        line: {
          DEFAULT: '#CBD5E1',
          soft: '#E2E8F0',
        },
        amber: '#B45309',
        signal: '#047857',
        alert: '#B91C1C',
      },
      fontFamily: {
        legend: ['Georgia', 'Times New Roman', 'serif'],
        sans: ['"Trebuchet MS"', 'Verdana', 'sans-serif'],
        mono: ['"Courier New"', 'monospace'],
      },
      letterSpacing: {
        legend: '0.03em',
      },
      boxShadow: {
        panel: '0 1px 3px rgba(15, 23, 42, 0.08)',
        lift: '0 12px 28px rgba(15, 23, 42, 0.16)',
      },
      keyframes: {
        'meter-in': {
          '0%': { transform: 'scaleY(0.2)', opacity: '0.3' },
          '100%': { transform: 'scaleY(1)', opacity: '1' },
        },
        sweep: {
          '0%': { transform: 'translateX(-100%)' },
          '100%': { transform: 'translateX(300%)' },
        },
        'fade-up': {
          '0%': { opacity: '0', transform: 'translateY(4px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
      },
      animation: {
        'meter-in': 'meter-in 260ms ease-out both',
        sweep: 'sweep 1.1s ease-in-out infinite',
        'fade-up': 'fade-up 180ms ease-out both',
      },
    },
  },
  plugins: [],
}
