// ─────────────────────────────────────────────────────────────────────────────
// Auto / Light / Dark, as a real choice rather than an OS reading.
//
// The whole mechanism is `color-scheme`. Every token in template.html is declared ONCE with
// `light-dark(…)`, so a theme is chosen by telling the document which half to resolve — nothing is
// re-declared and nothing re-renders. `<html data-theme="light|dark">` forces a side; no attribute
// at all is Auto, and stays the default for anyone who never touches the control.
//
// The stored choice is applied by a tiny inline script in <head> BEFORE the stylesheet, so a reader
// who has chosen dark never sees a white flash on load. This module only has to keep the attribute
// and the storage key in step afterwards.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Storage key. `localStorage` is per ORIGIN, so several projects sharing one dashboard domain via
 * `dashboard.path-prefix` share the choice — which is what a reader expects from a site-wide theme
 * control, rather than having to set it again per project.
 *
 * Must stay in step with the pre-paint script in template.html; dashboard-theme.test.ts pins that.
 */
export const THEME_KEY = "gitfather:theme";

export type Theme = "auto" | "light" | "dark";

const THEMES: { value: Theme; label: string }[] = [
  { value: "auto", label: "Auto" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

// Every storage access is guarded: `localStorage` THROWS rather than returning null when the page
// is opened from file:// or with site data blocked, and a dashboard that white-screens because a
// reader has strict privacy settings would be a poor trade for remembering a colour.
function stored(): Theme | null {
  try {
    const t = localStorage.getItem(THEME_KEY);
    return t === "light" || t === "dark" ? t : null;
  } catch {
    return null;
  }
}

/** The current choice — the attribute the pre-paint script set, or Auto. */
export function readTheme(): Theme {
  const attr = document.documentElement.getAttribute("data-theme");
  return attr === "light" || attr === "dark" ? attr : stored() ?? "auto";
}

/** Apply a choice and remember it. Auto REMOVES both, so the page follows the OS again. */
export function applyTheme(theme: Theme): void {
  if (theme === "auto") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", theme);
  try {
    if (theme === "auto") localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, theme);
  } catch {
    /* the choice still applies to this page; it just won't outlive it */
  }
}

/**
 * The control: three real buttons in a pill, not a checkbox pretending to be a switch — there are
 * three states, and `aria-pressed` says which one is live. Nothing here re-renders the grid; the
 * SVG takes its colours from the same CSS variables the rest of the page does.
 */
export function themeControl(): HTMLElement {
  const group = document.createElement("div");
  group.className = "theme";
  group.setAttribute("role", "group");
  group.setAttribute("aria-label", "Colour theme");

  const buttons: { value: Theme; el: HTMLButtonElement }[] = THEMES.map(({ value, label }) => {
    const el = document.createElement("button");
    el.type = "button";
    el.className = "theme-btn";
    el.textContent = label;
    el.addEventListener("click", () => {
      applyTheme(value);
      sync();
    });
    group.appendChild(el);
    return { value, el };
  });

  function sync(): void {
    const current = readTheme();
    for (const b of buttons) b.el.setAttribute("aria-pressed", String(b.value === current));
  }
  sync();
  return group;
}
