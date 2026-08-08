"use client";
import { useEffect, useState } from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import { cn } from "../ui/cn";

// Desktop-shell theme control — the mockup's `.theme-seg` segmented switch
// (auto / light / dark) with the active button in accent. Same persistence as
// the legacy ThemeSwitcher (localStorage `hooop-theme`, re-read pre-paint in
// layout.tsx), reimplemented so the default dashboard stays frozen.

type Theme = "auto" | "light" | "dark";
const KEY = "hooop-theme";

function systemPrefersDark(): boolean {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}
function apply(theme: Theme): void {
  const dark = theme === "dark" || (theme === "auto" && systemPrefersDark());
  document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
}

const OPTIONS: { value: Theme; label: string; Icon: typeof Sun }[] = [
  { value: "auto", label: "Match system", Icon: Monitor },
  { value: "light", label: "Light", Icon: Sun },
  { value: "dark", label: "Dark", Icon: Moon },
];

export function ShellThemeSwitcher() {
  const [theme, setTheme] = useState<Theme>("auto");
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const stored = localStorage.getItem(KEY);
    setTheme(stored === "light" || stored === "dark" ? stored : "auto");
    setReady(true);
  }, []);

  useEffect(() => {
    if (theme !== "auto") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => apply("auto");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [theme]);

  function choose(next: Theme) {
    setTheme(next);
    localStorage.setItem(KEY, next);
    apply(next);
  }

  return (
    <div role="group" aria-label="Theme" className="theme-seg">
      {OPTIONS.map(({ value, label, Icon }) => {
        const active = ready && theme === value;
        return (
          <button
            key={value}
            type="button"
            title={label}
            aria-label={label}
            aria-pressed={active}
            onClick={() => choose(value)}
            className={cn("w-7 h-7", active && "is-on")}
          >
            <Icon className="w-3.5 h-3.5" />
          </button>
        );
      })}
    </div>
  );
}
