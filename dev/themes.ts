/** Home Assistant theme emulation for the dev harness: CSS variable sets on the page body. */

export const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
const COMMON = {
  "--success-color": "#43a047", "--warning-color": "#ffa600", "--error-color": "#db4437", "--info-color": "#039be5",
  "--text-primary-color": "#ffffff", "--accent-color": "#ff9800", "--primary-color": "#03a9f4",
  "--ha-card-border-width": "1px", "--ha-font-family-body": FONT,
};
export const THEMES: Record<string, Record<string, string>> = {
  dark: {
    ...COMMON, "color-scheme": "dark",
    "--primary-text-color": "#e1e1e1", "--secondary-text-color": "#9b9b9b", "--disabled-text-color": "#6f6f6f",
    "--card-background-color": "#1c1c1c", "--primary-background-color": "#111111", "--divider-color": "rgba(225,225,225,.12)",
    "--ha-card-background": "#1c1c1c", "--ha-card-border-radius": "12px", "--ha-card-box-shadow": "none",
    "--ha-card-border-color": "rgba(225,225,225,.12)", background: "#111111",
  },
  light: {
    ...COMMON, "color-scheme": "light",
    "--primary-text-color": "#212121", "--secondary-text-color": "#727272", "--disabled-text-color": "#bdbdbd",
    "--card-background-color": "#ffffff", "--primary-background-color": "#fafafa", "--divider-color": "rgba(0,0,0,.12)",
    "--ha-card-background": "#ffffff", "--ha-card-border-radius": "12px", "--ha-card-box-shadow": "none",
    "--ha-card-border-color": "rgba(0,0,0,.12)", background: "#fafafa",
  },
  "glass-dark": {
    ...COMMON, "color-scheme": "dark",
    "--primary-text-color": "#f5f5f5", "--secondary-text-color": "rgba(245,245,245,.7)", "--disabled-text-color": "rgba(245,245,245,.4)",
    "--card-background-color": "rgba(30,30,40,.45)", "--primary-background-color": "#1a1a2e", "--divider-color": "rgba(255,255,255,.18)",
    "--ha-card-background": "rgba(30,30,40,.45)", "--ha-card-backdrop-filter": "blur(18px)", "--ha-card-border-radius": "24px",
    "--ha-card-box-shadow": "0 8px 32px rgba(0,0,0,.35)", "--ha-card-border-color": "rgba(255,255,255,.18)",
    background: "linear-gradient(135deg,#ff6b6b 0%,#845ef7 35%,#22b8cf 70%,#51cf66 100%) fixed",
  },
  "glass-light": {
    ...COMMON, "color-scheme": "light",
    "--primary-text-color": "#1b1b1f", "--secondary-text-color": "rgba(27,27,31,.65)", "--disabled-text-color": "rgba(27,27,31,.35)",
    "--card-background-color": "rgba(255,255,255,.5)", "--primary-background-color": "#f0f4ff", "--divider-color": "rgba(0,0,0,.12)",
    "--ha-card-background": "rgba(255,255,255,.5)", "--ha-card-backdrop-filter": "blur(18px)", "--ha-card-border-radius": "24px",
    "--ha-card-box-shadow": "0 8px 32px rgba(60,60,120,.25)", "--ha-card-border-color": "rgba(255,255,255,.6)",
    background: "linear-gradient(135deg,#ffd6a5 0%,#fdffb6 25%,#9bf6ff 60%,#bdb2ff 100%) fixed",
  },
};


/** Apply a named theme to `document.body` (defaults to dark). Returns the resolved variables. */
export function applyTheme(name: string | null): Record<string, string> {
  const theme = THEMES[name ?? "dark"] ?? THEMES.dark!;
  for (const [key, value] of Object.entries(theme)) {
    if (key === "background") document.body.style.background = value;
    else document.body.style.setProperty(key, value);
  }
  document.body.style.fontFamily = FONT;
  document.body.style.color = theme["--primary-text-color"] ?? "";
  return theme;
}
