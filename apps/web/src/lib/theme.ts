export const THEME_COOKIE = "sentra-theme";
export const THEME_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

export const THEMES = ["light", "dark", "system"] as const;
export type Theme = (typeof THEMES)[number];

/** The cookie is user-controlled, so only allow-listed values are ever used; anything else is `system`. */
export function parseTheme(value: string | undefined): Theme {
  return THEMES.find((theme) => theme === value) ?? "system";
}

/** Class for <html>: an explicit choice forces that theme; `system` leaves it to the OS via CSS. */
export function themeClass(theme: Theme): "light" | "dark" | undefined {
  return theme === "system" ? undefined : theme;
}
