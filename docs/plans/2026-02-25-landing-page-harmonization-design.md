# Landing Page Harmonization Design

**Date:** 2026-02-25
**Goal:** Update the GitHub Pages landing page (`docs/index.html`) to match the local app's dev-tool aesthetic (`public/index.html`).

## Direction

Option B: "Dev-first" — the app's clean monospace/IDE look becomes the shared visual identity. The landing page drops its editorial serif/copper warmth and adopts the app's cool palette, monospace headings, and flat styling.

## Color Palette

Adopt the app's CSS variables exactly:

| Landing page (old) | App (new)            | Purpose        |
|--------------------|----------------------|----------------|
| `--base: #1a1714`  | `--bg: #1a1a1a`      | Background     |
| `--surface: #232019`| `--bg-panel: #161616`| Panel bg       |
| `--raised: #2c2822`| `--bg-item: #1e1e1e` | Raised surface |
| `--subtle: #3a3430`| `--border: #2a2a2a`  | Borders        |
| —                  | `--border-light: #333`| Light borders  |
| `--text: #d4cdc4`  | `--text: #e0e0e0`    | Body text      |
| `--text-bright`    | `--text` (same)      | Headings       |
| `--muted: #8a7e72` | `--text-dim: #777`   | Muted text     |
| `--copper*` (all)  | `--accent: #8ab4f8`  | Accent color   |
| `--red: #b85c4e`   | `--red: #f28b82`     | Error/red      |
| —                  | `--green: #4ade80`   | Success        |
| —                  | `--amber: #fbbf24`   | Warning        |

## Typography

- **Headings, nav, labels, code**: JetBrains Mono (already loaded, promoted to primary)
- **Body paragraphs**: `Inter, system-ui, -apple-system, sans-serif`
- **Drop**: Bitter, Source Serif 4 (all serif fonts removed)
- **Google Fonts**: Replace Bitter/Source Serif imports with Inter (400, 500)

## Navigation

New sticky nav bar matching app header:

```
[logo] ove   [features] [setup] [commands] [deploy]   [github]
```

- `--bg-panel` background, 1px `--border` bottom border
- Small pill-shaped nav links styled like app's `.nav-link`
- Links scroll to page sections
- GitHub link goes to repo

## Hero

Compact section (~40vh, not 100vh):

- Portrait left (~140px), name + subtitle + quote + buttons right
- Same grid layout, tighter spacing
- No scroll hint, no radial gradient — flat `--bg`
- Buttons: monospace, `--accent` border/hover

## Ove Quotes

Keep all quotes, restyle:

- Left border: `--accent` (#8ab4f8)
- Text color: `--text-dim` (#777)
- Attribution: JetBrains Mono
- Smaller, less prominent

## Components

- Feature grid labels/headings: `--accent` instead of copper
- Code blocks: `--bg-panel` bg, `--border` border, `--accent` for inline code
- Command grid dt: `--accent` text on `--bg-panel`
- All borders: `--border` (#2a2a2a)

## Remove

- Grain texture overlay (`body::after`)
- All serif font references (Bitter, Source Serif 4, Georgia)
- All warm/copper CSS variables
- Radial gradient on hero (`hero::before`)
- Full-viewport hero height (100vh -> ~40vh)
- `.scroll-hint` element and its animation

## Keep

- All content sections and text
- Responsive mobile breakpoints
- fadeUp animations (subtle, fine)
- Install bar (restyle with accent)
- Footer (restyle to match)
