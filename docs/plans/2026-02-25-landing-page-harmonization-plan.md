# Landing Page Harmonization Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Restyle `docs/index.html` to match the app's dev-tool aesthetic from `public/index.html`.

**Architecture:** Single-file change. Replace CSS variables, swap fonts, add nav bar, compact hero, restyle all components. No new files, no build step, no tests (static HTML).

**Tech Stack:** HTML, CSS, Google Fonts (Inter, JetBrains Mono)

**Design doc:** `docs/plans/2026-02-25-landing-page-harmonization-design.md`

---

### Task 1: Replace CSS variables and fonts

**Files:**
- Modify: `docs/index.html:1-50` (`:root`, Google Fonts link, body styles)

**Step 1: Replace Google Fonts import**

Change line 10 from Bitter/Source Serif to Inter + JetBrains Mono:

```html
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
```

**Step 2: Replace `:root` variables**

Replace the entire `:root` block (lines 12-24) with:

```css
:root {
  --bg: #1a1a1a;
  --bg-panel: #161616;
  --bg-item: #1e1e1e;
  --bg-item-hover: #252525;
  --border: #2a2a2a;
  --border-light: #333;
  --text: #e0e0e0;
  --text-dim: #777;
  --text-muted: #555;
  --accent: #8ab4f8;
  --green: #4ade80;
  --red: #f28b82;
  --amber: #fbbf24;
}
```

**Step 3: Update body styles**

```css
body {
  font-family: "Inter", system-ui, -apple-system, sans-serif;
  color: var(--text);
  line-height: 1.7;
  background: var(--bg);
  font-size: 16px;
  -webkit-font-smoothing: antialiased;
}
```

**Step 4: Remove grain overlay**

Delete the entire `body::after` block (lines 39-48).

**Step 5: Commit**

```bash
git add docs/index.html
git commit -m "style(landing): replace color palette and fonts with app tokens"
```

---

### Task 2: Add nav bar and compact hero

**Files:**
- Modify: `docs/index.html` — CSS (hero section, new header styles) and HTML (add `<header>`, restructure hero)

**Step 1: Add header CSS**

Add new styles after the reset (`* { ... }`):

```css
header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.5rem 1rem;
  border-bottom: 1px solid var(--border);
  background: var(--bg-panel);
  position: sticky;
  top: 0;
  z-index: 100;
}

.header-left {
  display: flex;
  align-items: center;
  gap: 1rem;
}

.header-logo {
  width: 24px;
  height: 24px;
  border-radius: 3px;
  object-fit: cover;
}

.header-left h1 {
  font-family: "JetBrains Mono", monospace;
  font-size: 0.85rem;
  font-weight: 600;
  letter-spacing: 0.05em;
}

.nav-link {
  color: var(--text-dim);
  text-decoration: none;
  font-family: "JetBrains Mono", monospace;
  font-size: 0.7rem;
  padding: 0.2rem 0.5rem;
  border: 1px solid var(--border);
  border-radius: 3px;
  border-bottom: 1px solid var(--border);
  transition: all 0.15s;
}

.nav-link:hover {
  color: var(--text);
  border-color: var(--border-light);
  background: var(--bg-item);
}
```

**Step 2: Restyle hero to compact**

Replace existing `.hero` and children CSS with:

```css
.hero {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 64px 32px;
  border-bottom: 1px solid var(--border);
}

.hero-inner {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 48px;
  align-items: center;
  max-width: 900px;
}

.hero-portrait {
  width: 140px;
  height: 140px;
  border-radius: 4px;
  border: 1px solid var(--border);
  box-shadow: 0 12px 32px rgba(0,0,0,0.3);
  object-fit: cover;
}

.hero-text h1 {
  font-family: "JetBrains Mono", monospace;
  font-size: 2.5rem;
  font-weight: 700;
  color: var(--text);
  letter-spacing: -0.02em;
  line-height: 1;
  margin-bottom: 6px;
}

.hero-subtitle {
  font-family: "JetBrains Mono", monospace;
  font-size: 0.8rem;
  color: var(--text-dim);
  font-weight: 400;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  margin-bottom: 20px;
}

.hero-quote {
  font-style: italic;
  color: var(--text-dim);
  font-size: 1.05rem;
  line-height: 1.5;
  margin-bottom: 24px;
  max-width: 420px;
}

.hero-quote span {
  color: var(--text-muted);
  font-style: normal;
  font-size: 0.8rem;
}
```

**Step 3: Restyle buttons**

```css
.btn {
  display: inline-block;
  font-family: "JetBrains Mono", monospace;
  font-size: 0.8rem;
  font-weight: 500;
  text-decoration: none;
  padding: 10px 24px;
  border: 1px solid var(--border-light);
  border-bottom: 1px solid var(--border-light);
  color: var(--accent);
  background: transparent;
  border-radius: 3px;
  transition: all 0.15s;
  letter-spacing: 0.02em;
}

.btn:hover {
  background: var(--accent);
  color: var(--bg);
  border-color: var(--accent);
}

.btn-ghost {
  border-color: var(--border);
  color: var(--text-dim);
}

.btn-ghost:hover {
  border-color: var(--text-dim);
  color: var(--text);
  background: transparent;
}
```

**Step 4: Add header HTML and remove scroll-hint**

Add `<header>` element before `<section class="hero">`:

```html
<header>
  <div class="header-left">
    <img class="header-logo" src="logo.png" alt="">
    <h1>ove</h1>
    <a class="nav-link" href="#features">features</a>
    <a class="nav-link" href="#getting-started">setup</a>
    <a class="nav-link" href="#commands">commands</a>
    <a class="nav-link" href="#deploy">deploy</a>
  </div>
  <a class="nav-link" href="https://github.com/jacksoncage/ove">github</a>
</header>
```

Remove the `<a href="#getting-started" class="scroll-hint">...</a>` element from the hero.

Remove the `.hero::before` CSS block (radial gradient).

Remove the `.scroll-hint` and `.scroll-hint svg` CSS blocks and the `@keyframes bobDown` animation.

**Step 5: Add `id="features"` and `id="commands"`**

Add `id="features"` to the "What Ove Does" section and `id="commands"` to the "Commands" section so nav links work.

**Step 6: Commit**

```bash
git add docs/index.html
git commit -m "style(landing): add nav bar and compact hero"
```

---

### Task 3: Restyle content sections

**Files:**
- Modify: `docs/index.html` — CSS for sections, features, quotes, code blocks, commands, pipeline, footer

**Step 1: Update section headers**

```css
h2 {
  font-family: "JetBrains Mono", monospace;
  font-size: 1.3rem;
  font-weight: 700;
  color: var(--text);
  margin-bottom: 8px;
  letter-spacing: -0.01em;
}

.section-note {
  color: var(--text-dim);
  font-style: italic;
  margin-bottom: 32px;
  font-size: 0.9rem;
}

h3 {
  font-family: "JetBrains Mono", monospace;
  font-size: 0.9rem;
  font-weight: 500;
  color: var(--accent);
  margin: 32px 0 10px;
  letter-spacing: 0.01em;
}
```

**Step 2: Update features grid**

```css
.features {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 1px;
  background: var(--border);
  border: 1px solid var(--border);
  margin-top: 32px;
}

.feature {
  padding: 24px 20px;
  background: var(--bg);
}

.feature-label {
  font-family: "JetBrains Mono", monospace;
  font-size: 0.65rem;
  text-transform: uppercase;
  letter-spacing: 0.12em;
  color: var(--text-muted);
  margin-bottom: 8px;
}

.feature h3 {
  font-family: "JetBrains Mono", monospace;
  font-size: 0.95rem;
  color: var(--text);
  margin: 0 0 8px;
  font-weight: 500;
}

.feature p {
  color: var(--text-dim);
  font-size: 0.85rem;
  line-height: 1.55;
  margin-bottom: 10px;
}

.feature code {
  font-family: "JetBrains Mono", monospace;
  font-size: 0.75rem;
  color: var(--accent);
  background: var(--bg-item);
  padding: 3px 8px;
  border: 1px solid var(--border);
  display: inline-block;
}
```

**Step 3: Update quotes**

```css
.ove-says {
  border-left: 2px solid var(--accent);
  padding: 14px 0 14px 20px;
  margin: 32px 0;
  font-style: italic;
  color: var(--text-dim);
  font-size: 0.95rem;
}

.ove-says .attr {
  display: block;
  font-style: normal;
  color: var(--text-muted);
  font-size: 0.75rem;
  margin-top: 6px;
  font-family: "JetBrains Mono", monospace;
}
```

**Step 4: Update code blocks and inline code**

```css
pre {
  background: var(--bg-panel);
  border: 1px solid var(--border);
  padding: 16px 18px;
  overflow-x: auto;
  font-size: 0.8rem;
  margin: 14px 0;
  line-height: 1.65;
  position: relative;
  border-radius: 3px;
}

pre::before {
  content: attr(data-label);
  position: absolute;
  top: 0;
  right: 0;
  font-family: "JetBrains Mono", monospace;
  font-size: 0.6rem;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--text-muted);
  padding: 4px 10px;
  background: var(--bg-item);
  border-left: 1px solid var(--border);
  border-bottom: 1px solid var(--border);
  border-radius: 0 3px 0 3px;
}

code {
  font-family: "JetBrains Mono", monospace;
  font-size: 0.85em;
}

pre code {
  color: var(--text);
  font-size: 1em;
}

p code {
  background: var(--bg-item);
  border: 1px solid var(--border);
  padding: 1px 6px;
  color: var(--accent);
  font-size: 0.82em;
  border-radius: 2px;
}
```

**Step 5: Update command grid**

```css
.cmd-grid dt {
  font-family: "JetBrains Mono", monospace;
  font-size: 0.78rem;
  color: var(--accent);
  background: var(--bg-panel);
  white-space: nowrap;
  border-right: 1px solid var(--border);
}

.cmd-grid dd {
  color: var(--text-dim);
}
```

Update `.cmd-grid` border to use `var(--border)` and `dt`/`dd` border-bottom likewise.

**Step 6: Update pipeline steps**

Replace copper references:

```css
.pipeline .step-n {
  color: var(--text-muted);
}

.pipeline .step-arrow {
  color: var(--border-light);
}
```

**Step 7: Update install bar**

```css
.install-bar {
  background: var(--bg-panel);
  border-bottom: 1px solid var(--border);
  padding: 16px 32px;
  text-align: center;
}

.install-bar code {
  font-family: "JetBrains Mono", monospace;
  font-size: 0.82rem;
  color: var(--accent);
  letter-spacing: -0.02em;
}

.install-bar code::before {
  content: "$ ";
  color: var(--text-muted);
}
```

**Step 8: Update links, strong, footer**

```css
a {
  color: var(--accent);
  text-decoration: none;
  border-bottom: 1px solid var(--border);
  transition: border-color 0.15s;
}

a:hover {
  border-bottom-color: var(--accent);
}

strong {
  color: var(--text);
  font-weight: 500;
}
```

Footer:

```css
footer {
  padding: 40px 32px;
  text-align: center;
  color: var(--text-dim);
  font-size: 0.78rem;
  border-top: 1px solid var(--border);
  font-family: "JetBrains Mono", monospace;
  letter-spacing: 0.02em;
}

footer a {
  color: var(--text-muted);
  border-bottom: none;
}

footer a:hover {
  color: var(--accent);
}
```

**Step 9: Update numbered steps list**

```css
.steps li::before {
  color: var(--text-muted);
}

.steps li {
  border-bottom: 1px solid var(--border);
}
```

**Step 10: Update section borders**

```css
.section {
  padding: 64px 0;
  border-bottom: 1px solid var(--border);
}
```

**Step 11: Update responsive breakpoint**

Keep the media query at `max-width: 700px` but ensure all references use new variable names. Specific changes:
- `.hero-text h1 { font-size: 2rem; }` (was 3rem)
- `.hero-portrait { width: 120px; height: 120px; }` (was 160px)

**Step 12: Update animations**

Keep fadeUp animations but update selectors to match new compact hero sizing. No copper references to fix in animations.

**Step 13: Commit**

```bash
git add docs/index.html
git commit -m "style(landing): restyle all content sections with app design tokens"
```

---

### Task 4: Verify and clean up

**Files:**
- Modify: `docs/index.html` — final pass

**Step 1: Search for any remaining old variable references**

Search the file for any remaining `var(--base)`, `var(--surface)`, `var(--raised)`, `var(--subtle)`, `var(--copper`, `var(--text-bright)`, `var(--muted)` references. Replace any found.

**Step 2: Search for remaining serif font references**

Search for `Bitter`, `Source Serif`, `Georgia`, `serif`. Remove any found.

**Step 3: Open in browser and visually verify**

Open `docs/index.html` in browser. Check:
- Nav bar renders with logo, links scroll to sections
- Hero is compact, not full viewport
- All text is readable (no warm tones remaining)
- Code blocks and command grid use blue accent
- Quotes have blue left border
- Mobile responsive still works (resize to 400px)

**Step 4: Final commit**

```bash
git add docs/index.html
git commit -m "style(landing): clean up remaining old variable references"
```
