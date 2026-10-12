"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { parseTheme, themeClass, THEME_COOKIE, THEME_MAX_AGE_SECONDS, THEMES } from "@/lib/theme";
import type { Theme } from "@/lib/theme";
import { useState } from "react";

const LABELS: Record<Theme, string> = { light: "Light", dark: "Dark", system: "System" };

function readCookieTheme(): Theme {
  const entry = document.cookie.split("; ").find((c) => c.startsWith(`${THEME_COOKIE}=`));
  return parseTheme(entry?.slice(THEME_COOKIE.length + 1));
}

function applyTheme(theme: Theme) {
  // Not HttpOnly: the client writes it. It holds only light/dark/system.
  document.cookie = `${THEME_COOKIE}=${theme}; Path=/; SameSite=Lax; Max-Age=${THEME_MAX_AGE_SECONDS}`;
  const root = document.documentElement;
  root.classList.remove("light", "dark");
  const cls = themeClass(theme);
  if (cls) root.classList.add(cls);
}

export function ThemeToggle() {
  // Read lazily on the client; the menu is closed during SSR so the initial value is never rendered.
  const [theme, setTheme] = useState<Theme>(() =>
    typeof document === "undefined" ? "system" : readCookieTheme(),
  );
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="Theme">
          <Sun className="size-4 dark:hidden" aria-hidden />
          <Moon className="hidden size-4 dark:block" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuRadioGroup
          value={theme}
          onValueChange={(value) => {
            const next = parseTheme(value);
            setTheme(next);
            applyTheme(next);
          }}
        >
          {THEMES.map((option) => (
            <DropdownMenuRadioItem key={option} value={option}>
              {option === "system" && <Monitor aria-hidden className="size-4" />}
              {LABELS[option]}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
