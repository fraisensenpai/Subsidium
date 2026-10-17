import { useEffect, useState } from "react";
import { MoonIcon, SunIcon } from "./icons";

const STORAGE_KEY = "subsidium-theme";

function applyTheme(theme: "light" | "dark") {
  document.documentElement.classList.toggle("dark", theme === "dark");
}

export function useTheme() {
  const [theme, setTheme] = useState<"light" | "dark">("dark");

  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    const initial: "light" | "dark" = stored === "light" ? "light" : "dark";
    setTheme(initial);
    applyTheme(initial);
  }, []);

  function toggle() {
    setTheme((prev) => {
      const next = prev === "dark" ? "light" : "dark";
      localStorage.setItem(STORAGE_KEY, next);
      applyTheme(next);
      return next;
    });
  }

  function set(next: "light" | "dark") {
    localStorage.setItem(STORAGE_KEY, next);
    applyTheme(next);
    setTheme(next);
  }

  return { theme, toggle, set };
}

export default function ThemeToggle({ theme, onToggle }: { theme: "light" | "dark"; onToggle: () => void }) {
  return (
    <button
      onClick={onToggle}
      title={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
      className="w-7 h-7 flex items-center justify-center rounded-md border border-border text-muted hover:text-ink hover:border-border-strong hover:bg-panel2 transition"
    >
      {theme === "dark" ? <SunIcon size={14} /> : <MoonIcon size={14} />}
    </button>
  );
}
