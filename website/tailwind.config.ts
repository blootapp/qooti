import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        bg: "#0a0a0a",
        surface: "#111111",
        surface2: "#181818",
        accent: "#4eabfb",
        border: "rgba(255,255,255,0.07)",
        muted: "rgba(240,240,238,0.38)",
        muted2: "rgba(240,240,238,0.16)",
      },
      fontFamily: {
        sans: ["var(--font-geist)", "Geist", "system-ui", "sans-serif"],
      },
    },
  },
  plugins: [],
};
export default config;
