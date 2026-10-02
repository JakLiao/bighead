/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        cream: "#FFF8EE",
        pink: "#FFD8E1",
        brick: "#FF6B6B",
        brown: "#5C4D3C",
        deepblue: "#1A1A2E",
      },
      fontFamily: {
        retro: ["'Press Start 2P'", "system-ui", "sans-serif"],
        body: ["system-ui", "sans-serif"],
      },
    },
  },
  plugins: [],
};
