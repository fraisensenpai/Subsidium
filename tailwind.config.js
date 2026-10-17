/** @type {import('tailwindcss').Config} */
export default {
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        base: "rgb(var(--c-base) / <alpha-value>)",
        panel: "rgb(var(--c-panel) / <alpha-value>)",
        panel2: "rgb(var(--c-panel2) / <alpha-value>)",
        sunken: "rgb(var(--c-sunken) / <alpha-value>)",
        border: "rgb(var(--c-border) / <alpha-value>)",
        "border-strong": "rgb(var(--c-border-strong) / <alpha-value>)",
        ink: "rgb(var(--c-ink) / <alpha-value>)",
        muted: "rgb(var(--c-muted) / <alpha-value>)",
        accent: "rgb(var(--c-accent) / <alpha-value>)",
        "accent-dim": "rgb(var(--c-accent-dim) / <alpha-value>)",
        good: "rgb(var(--c-good) / <alpha-value>)",
        bad: "rgb(var(--c-bad) / <alpha-value>)",
        warn: "rgb(var(--c-warn) / <alpha-value>)",
        // Fixed-ish brand green for the "Subsidium" wordmark/logo.
        brand: "rgb(var(--c-brand) / <alpha-value>)",
      },
      fontFamily: {
        sans: [
          "Segoe UI Variable Text",
          "Segoe UI Variable",
          "Segoe UI",
          "ui-sans-serif",
          "system-ui",
          "sans-serif",
        ],
        mono: [
          "Cascadia Code",
          "Cascadia Mono",
          "Consolas",
          "ui-monospace",
          "SFMono-Regular",
          "monospace",
        ],
      },
      borderRadius: {
        xl: "10px",
        "2xl": "13px",
      },
    },
  },
  plugins: [],
};
