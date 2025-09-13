/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/**/*.{html,js,jsx,ts,tsx}', './public/**/*.html'],
  theme: {
    extend: {
      colors: {
        'kiln-ember': '#F97316',
        'craft-blue': '#609ACF',
        'warm-paper': '#F9F1E4',
        'text-charcoal': '#1F2937',
        shadow: '#E5E3DC',
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'monospace'],
      },
      borderRadius: {
        soft: '12px',
      },
      animation: {
        glow: 'glow 2s ease-in-out infinite',
        fire: 'fire 3s ease-in-out infinite',
      },
      keyframes: {
        glow: {
          '0%, 100%': { filter: 'drop-shadow(0 0 5px #F97316)' },
          '50%': { filter: 'drop-shadow(0 0 10px #F97316)' },
        },
        fire: {
          '0%, 100%': { transform: 'scale(1) rotate(0deg)' },
          '25%': { transform: 'scale(1.05) rotate(1deg)' },
          '50%': { transform: 'scale(1.1) rotate(-1deg)' },
          '75%': { transform: 'scale(1.05) rotate(1deg)' },
        },
      },
    },
  },
  plugins: [],
};
