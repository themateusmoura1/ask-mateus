import { Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";

/** The site title with the name picked out in blue. */
export function Title({ text, className }: { text: string; className?: string }) {
  const [first, ...rest] = text.split(" ");
  return (
    <h1 className={className}>
      {first} <span className="text-primary dark:text-link">{rest.join(" ")}</span>
    </h1>
  );
}

/**
 * Light is the default. The toggle switches to dark and remembers the choice
 * on this device. /theme.js applies a saved choice before the page paints.
 */
export function useTheme() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"));
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", dark ? "#0e1118" : "#f6f7fe");
    try {
      localStorage.setItem("theme", dark ? "dark" : "light");
    } catch {
      /* the choice just won't be remembered */
    }
  }, [dark]);
  return { dark, toggle: () => setDark((d) => !d) };
}

export function ThemeToggle({ dark, onToggle, className }: { dark: boolean; onToggle: () => void; className?: string }) {
  return (
    <Button
      variant="outline"
      size="icon-lg"
      className={className}
      onClick={onToggle}
      aria-pressed={dark}
      aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
    >
      {dark ? <Sun /> : <Moon />}
    </Button>
  );
}
