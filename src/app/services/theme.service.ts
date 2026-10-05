import { Injectable } from '@angular/core';

const KEY = 'fa.theme.vars';

// The coach app wears the same palette variables as the athlete app. Nothing is set until a theme is chosen on the
// Themes page, so the stylesheets' own fallbacks (the original navy and cyan) show by default.
@Injectable({ providedIn: 'root' })
export class ThemeService {
  private applied: string[] = [];

  init() {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) this.apply(JSON.parse(raw));
    } catch { /* storage unavailable or corrupt */ }
  }

  get active(): boolean {
    try { return !!localStorage.getItem(KEY); } catch { return false; }
  }

  apply(vars: Record<string, string>) {
    this.clearVars();
    const root = document.documentElement;
    for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
    this.applied = Object.keys(vars);
    try { localStorage.setItem(KEY, JSON.stringify(vars)); } catch { /* storage unavailable */ }
  }

  reset() {
    this.clearVars();
    try { localStorage.removeItem(KEY); } catch { /* storage unavailable */ }
  }

  private clearVars() {
    const root = document.documentElement;
    for (const k of this.applied) root.style.removeProperty(k);
    this.applied = [];
  }
}
