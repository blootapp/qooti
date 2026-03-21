# Qooti — Modal Design System Specification
**Version 1.0 · Design & Engineering Reference**

---

## 1. Overview

This document defines the design rules, behavior, and implementation guidelines for every popup modal used across the Qooti app. All modals must follow these specifications exactly to ensure a consistent, cohesive interface.

Qooti uses a **macOS-inspired dark UI**. Modals inherit the app's near-black color palette and follow Apple Human Interface Guidelines adapted for Qooti's brand.

---

## 2. Color Tokens

These are the canonical values for every modal in the app. Never use hardcoded colors outside of these tokens.

| Token | Value | Usage |
|---|---|---|
| `--modal-bg` | `#111112` | Modal body background |
| `--modal-titlebar-bg` | `#0e0e0f` | Titlebar background |
| `--modal-border` | `rgba(255,255,255,0.07)` | Outer modal border |
| `--modal-divider` | `rgba(255,255,255,0.06)` | Internal section dividers |
| `--modal-surface` | `#181819` | Inset card / tutorial surfaces |
| `--modal-surface-hover` | `#1d1d1f` | Hover state for cards |
| `--modal-overlay-bg` | `rgba(0,0,0,0.88)` | Full-screen dimmed overlay behind modal |
| `--text-primary` | `rgba(255,255,255,0.88)` | Headings, important labels |
| `--text-secondary` | `rgba(255,255,255,0.55)` | Subheadings, descriptions |
| `--text-tertiary` | `rgba(255,255,255,0.30)` | Captions, metadata, section labels |
| `--text-muted` | `rgba(255,255,255,0.20)` | Footnotes, legal, de-emphasised notes |
| `--text-code` | `rgba(255,255,255,0.55)` | Inline code snippets |
| `--code-bg` | `rgba(255,255,255,0.07)` | Inline code background |
| `--code-border` | `rgba(255,255,255,0.07)` | Inline code border |
| `--btn-cancel-bg` | `rgba(255,255,255,0.06)` | Cancel / secondary button |
| `--btn-cancel-hover` | `rgba(255,255,255,0.09)` | Cancel button hover |
| `--btn-cancel-text` | `rgba(255,255,255,0.55)` | Cancel button label |
| `--btn-primary-bg` | `#1a6be8` | Primary action button |
| `--btn-primary-hover` | `#2478f5` | Primary button hover |
| `--btn-danger-bg` | `#c0392b` | Destructive action button |
| `--btn-danger-hover` | `#e74c3c` | Destructive button hover |
| `--step-num-bg` | `rgba(255,255,255,0.05)` | Numbered step circle background |
| `--step-num-border` | `rgba(255,255,255,0.09)` | Numbered step circle border |
| `--step-line` | `rgba(255,255,255,0.06)` | Connector line between steps |
| `--item-hover` | `rgba(255,255,255,0.03)` | Row/item hover state |
| `--tl-close` | `#ff5f57` | Close traffic light button |
| `--tl-max` | `#28c840` | Maximize traffic light button |
| `--shadow-modal` | `0 0 0 0.5px rgba(0,0,0,0.95), 0 40px 100px rgba(0,0,0,0.9), 0 8px 24px rgba(0,0,0,0.6)` | Modal drop shadow |
| `--shadow-primary-btn` | `0 1px 8px rgba(26,107,232,0.35)` | Primary button glow |

---

## 3. Typography

All modals use the system font stack:

```css
font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif;
```

| Element | Size | Weight | Color Token | Letter Spacing |
|---|---|---|---|---|
| Titlebar title | 12.5px | 600 | `--text-tertiary` | −0.01em |
| Section label (caps) | 10.5px | 600 | `--text-muted` | +0.07em (uppercase) |
| Modal heading | 15–16px | 600 | `--text-primary` | −0.022em |
| Subheading / description | 12.5px | 400 | `--text-secondary` | −0.005em |
| Step title | 13px | 600 | `--text-primary` × 0.78 | −0.015em |
| Step description | 12px | 400 | `--text-secondary` × 0.34 | −0.005em |
| Button label | 13px | 500 (cancel) / 600 (primary) | white / `--btn-cancel-text` | −0.01em |
| Inline code | 11px | 400 | `--text-code` | 0 |
| Footnote / note | 11px | 400 | `--text-muted` | −0.005em |

Inline code must use:
```css
font-family: 'SF Mono', 'Menlo', monospace;
```

---

## 4. Modal Anatomy

Every modal is composed of three fixed sections in this exact order:

```
┌────────────────────────────────────┐
│           TITLEBAR                 │  46px tall
├────────────────────────────────────┤
│                                    │
│           BODY                     │  Variable height, padding: 26px
│                                    │
├────────────────────────────────────┤
│           FOOTER                   │  Padding: 0 26px 22px
└────────────────────────────────────┘
```

### 4.1 Titlebar

- Height: `46px`
- Background: `--modal-titlebar-bg`
- Bottom border: `1px solid --modal-divider`
- Title: centered absolutely, `position: absolute; left: 50%; transform: translateX(-50%)`
- Traffic light buttons: **right-aligned only**
- Only two buttons: **Maximize (green)** and **Close (red)**. The minimize/hide (yellow) button is never used.

```
[ empty left spacer ] [ Centered Title ] [ 🟢 maximize · 🔴 close ]
```

Traffic light button specs:
- Size: `12px × 12px`, `border-radius: 50%`
- Gap between buttons: `8px`
- Icon glyphs appear only on hover of the button group (not individually)
- Maximize icon: `⤢` at `7px`
- Close icon: `✕` at `6.5px`
- Icon color: `rgba(0,0,0,0.5)`
- Box shadow: `0 0 0 0.5px rgba(0,0,0,0.3), inset 0 0.5px 0 rgba(255,255,255,0.18)`

### 4.2 Body

- Padding: `26px 26px 20px`
- Display: `flex, flex-direction: column`
- Gap between sections: `20px`
- Internal section dividers: `1px solid --modal-divider`

### 4.3 Footer

- Padding: `0 26px 22px`
- Display: `flex`, `gap: 9px`
- Contains action buttons only — no text, no links

---

## 5. Window Modes & Responsive Behavior

This is the most critical behavioral rule in the system. The modal has two distinct display modes depending on the state of the Qooti app window.

### 5.1 Qooti App in Windowed (Non-Fullscreen) Mode

When the Qooti app is running in a smaller, non-maximised window:

- The modal **covers the entire Qooti app window** — it fills 100% of the app's width and height
- The modal is **not** a floating mini-window — it becomes a full-app overlay
- This prevents the modal from appearing tiny or detached when the app frame is small
- The overlay background (`--modal-overlay-bg`) fills the app frame behind the modal content

**Implementation:** Detect the app window size. If the window is below the "maximised" threshold (e.g. `window.innerWidth < 1100 || window.innerHeight < 700`), apply the full-cover class:

```css
/* Full-cover mode (windowed/small app frame) */
.modal.full-cover {
  position: fixed;
  inset: 0;
  width: 100%;
  height: 100%;
  border-radius: 0;
  border: none;
  box-shadow: none;
}

.modal.full-cover .titlebar {
  border-radius: 0;
}
```

In full-cover mode:
- Border radius: `0` (no rounded corners — it fills the frame edge to edge)
- Box shadow: none
- All internal layout, typography, and spacing remain identical

### 5.2 Qooti App in Fullscreen (Maximised) Mode

When the Qooti app is running fullscreen or maximised:

- The modal appears as a **centered mini floating window**
- Width: `620px` (fixed)
- Height: auto (content-driven)
- Border radius: `14px`
- Positioned centered over the app with the dimmed overlay behind it
- Box shadow: `--shadow-modal`

```css
/* Mini window mode (fullscreen/maximised app) */
.modal.mini-window {
  width: 620px;
  border-radius: 14px;
  box-shadow: var(--shadow-modal);
  position: relative;
}
```

### 5.3 Maximize Button Behavior (Inside the Modal)

The green maximize button (`🟢`) inside the modal titlebar controls the modal's own size:

- **When modal is in mini-window mode** → clicking maximize expands the mini-window into a **full-screen page** that covers the **entire screen of the app**. The modal fills 100% of the app viewport (inset 0, full width and height, border-radius 0). As a result, the **modal titlebar disappears** in this mode — the modal is no longer a floating window with a title bar, but a full-screen view, so the titlebar is hidden to maximise content area and avoid redundancy.
- **When modal is already full-screen** → clicking the button (now showing a restore icon `⊡`) shrinks it back to mini-window mode and the **titlebar reappears**.
- The transition must be animated: `transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1)`
- The icon on the maximize button toggles between `⤢` (expand) and `⊡` (restore)

**Summary:** Maximise turns the modal into a full-screen page; the modal titlebar is hidden in full-screen and shown again when restored to mini-window.

**Implementation logic:**

```javascript
let isMaximised = false;

function toggleMaximise(modal) {
  isMaximised = !isMaximised;
  modal.classList.toggle('modal-fullscreen', isMaximised);
  updateMaxButton();
}

// CSS: full-screen = cover entire app, no titlebar
.modal-fullscreen {
  position: fixed !important;
  inset: 0 !important;
  width: 100% !important;
  height: 100% !important;
  max-width: none !important;
  border-radius: 0 !important;
  box-shadow: none !important;
  overflow-y: auto;
}

.modal-fullscreen .titlebar {
  display: none; /* Titlebar disappears in full-screen mode */
}
```

---

## 6. Overlay (Backdrop)

Every modal must render over a full-screen overlay:

```css
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.88);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 999;
}
```

- Clicking the overlay (outside the modal) dismisses the modal
- Pressing `Escape` dismisses the modal
- The overlay appears/disappears with `opacity` transition: `0.2s ease`
- The modal itself animates in with: `transform: scale(0.94) → scale(1)` over `0.28s cubic-bezier(0.34, 1.4, 0.64, 1)`

---

## 7. Buttons

### 7.1 Sizing

```css
.btn {
  height: 34px;
  border-radius: 7px;
  font-size: 13px;
  letter-spacing: -0.01em;
  border: none;
  cursor: pointer;
  transition: all 0.15s;
  flex: 1; /* buttons share equal width in footer */
}

.btn:active { transform: scale(0.97); }
```

### 7.2 Cancel / Secondary Button

```css
.btn-cancel {
  background: rgba(255,255,255,0.06);
  color: rgba(255,255,255,0.55);
  border: 1px solid rgba(255,255,255,0.07);
  font-weight: 500;
}
.btn-cancel:hover { background: rgba(255,255,255,0.09); }
```

### 7.3 Primary Action Button

```css
.btn-primary {
  background: #1a6be8;
  color: #ffffff;
  font-weight: 600;
  box-shadow: 0 1px 8px rgba(26,107,232,0.35);
}
.btn-primary:hover {
  background: #2478f5;
  box-shadow: 0 2px 14px rgba(26,107,232,0.5);
}
```

### 7.4 Destructive Action Button

Used for delete, disconnect, remove, or irreversible actions:

```css
.btn-danger {
  background: #c0392b;
  color: #ffffff;
  font-weight: 600;
  box-shadow: 0 1px 8px rgba(192,57,43,0.35);
}
.btn-danger:hover {
  background: #e74c3c;
  box-shadow: 0 2px 14px rgba(231,76,60,0.5);
}
```

### 7.5 Button Layout Rules

- Footer always uses a `flex` row layout
- Cancel button is always on the **left**
- Primary / destructive action is always on the **right**
- Both buttons have `flex: 1` — they share equal width
- Never stack buttons vertically unless the modal is in full-cover/fullscreen mode and content demands it

---

## 8. Content Patterns

### 8.1 Header Row (Icon + Title + Description)

Every modal that explains a process or feature begins with a header row:

```
[ Service Icon 44×44 ] [ Title (15–16px bold) ]
                        [ Subtitle description (12.5px muted) ]
```

- Icon: `44×44px`, `border-radius: 11px`
- Gap between icon and text: `14px`
- Service icons use the brand color of the external service (e.g., Telegram blue)
- If no external service icon applies, use a Qooti-brand neutral icon

### 8.2 Section Labels

Used above every logical group (steps, settings, related links):

```css
.section-label {
  font-size: 10.5px;
  font-weight: 600;
  color: rgba(255,255,255,0.22);
  letter-spacing: 0.07em;
  text-transform: uppercase;
  margin-bottom: 10px;
}
```

Examples: `HOW IT WORKS`, `NEED HELP?`, `SETTINGS`, `CONNECTED ACCOUNTS`

### 8.3 Numbered Step List

Used for instructional/onboarding modals:

- Each step: `flex row`, `gap: 13px`, `padding: 10px`, `border-radius: 9px`
- Step number circle: `22×22px`, `border-radius: 50%`
- Connector line between steps: `1px wide`, `min-height: 14px`, hidden on last step
- Step title: `13px / 600 / rgba(255,255,255,0.76)`
- Step description: `12px / 400 / rgba(255,255,255,0.34)`, `line-height: 1.65`
- Hovering a step row: `background: rgba(255,255,255,0.03)`

### 8.4 Inline Code Snippets

For file names, commands, or technical values within descriptions:

```css
code {
  font-family: 'SF Mono', 'Menlo', monospace;
  font-size: 11px;
  color: rgba(255,255,255,0.55);
  background: rgba(255,255,255,0.07);
  border: 1px solid rgba(255,255,255,0.07);
  padding: 1px 5px;
  border-radius: 4px;
}
```

### 8.5 Card / Tutorial Row

For embedded video tutorials, help links, or external resources:

```
┌──────────────────────────────────────────────┐
│ [Thumbnail 84×54] │ Title (12.5px bold)      │ › │
│                   │ Meta (11px muted)         │   │
└──────────────────────────────────────────────┘
```

- Border radius: `9px`
- Background: `--modal-surface` (`#181819`)
- Border: `1px solid rgba(255,255,255,0.06)`
- Hover: `background: --modal-surface-hover`
- Arrow `›` on right: `rgba(255,255,255,0.15)`, `17px`
- Entire card is clickable

### 8.6 Footnote / Supported Media Note

A single line of supporting information at the bottom of the body, before the footer:

```
✓ Supported: images, videos, and GIFs from Telegram exports.
```

- Font: `11px / rgba(255,255,255,0.20)`
- Icon: small SVG circle-check, `11×11px`, `stroke: rgba(255,255,255,0.18)`

### 8.7 Toggle Rows (Settings Modals)

For on/off settings within a modal:

```
[ Label (13px bold) ]  [ subtext (11.5px muted) ]     [ ● toggle ]
```

- Row background: `rgba(255,255,255,0.04)`, `border-radius: 8px`, `padding: 10px 12px`
- Toggle track (off): `rgba(255,255,255,0.15)`
- Toggle track (on): `#1a6be8`
- Toggle thumb: `#ffffff`, with drop shadow

### 8.8 Input Fields (Form Modals)

```css
input, select, textarea {
  background: rgba(255,255,255,0.05);
  border: 1px solid rgba(255,255,255,0.08);
  border-radius: 7px;
  color: rgba(255,255,255,0.85);
  font-size: 13px;
  padding: 8px 12px;
  font-family: inherit;
  outline: none;
  transition: border-color 0.15s, box-shadow 0.15s;
}

input:focus {
  border-color: #1a6be8;
  box-shadow: 0 0 0 3px rgba(26,107,232,0.18);
  background: rgba(255,255,255,0.07);
}

input::placeholder {
  color: rgba(255,255,255,0.22);
}
```

Field labels: `11.5px / 500 / rgba(255,255,255,0.40)`, `margin-bottom: 5px`

---

## 9. Animation & Transitions

| Event | Property | Value |
|---|---|---|
| Overlay appear | `opacity` | `0 → 1`, `0.2s ease` |
| Overlay disappear | `opacity` | `1 → 0`, `0.2s ease` |
| Modal enter | `transform + opacity` | `scale(0.94) opacity(0) → scale(1) opacity(1)`, `0.28s cubic-bezier(0.34,1.4,0.64,1)` |
| Modal exit | `transform + opacity` | `scale(1) → scale(0.94)`, `0.18s ease` |
| Modal maximize/restore | `all` | `0.3s cubic-bezier(0.4, 0, 0.2, 1)` |
| Button hover | `background, box-shadow` | `0.15s ease` |
| Button press | `transform` | `scale(0.97)`, instant |
| Card hover | `background` | `0.15s ease` |
| Step row hover | `background` | `0.15s ease` |
| Traffic light icons | `opacity` | `0 → 1`, `0.12s ease` on group hover |

---

## 10. Z-Index Layering

| Layer | Z-Index | Element |
|---|---|---|
| App content | 1–100 | Normal UI |
| Modal overlay | 999 | Dimmed backdrop |
| Modal window | 1000 | The modal itself |
| Video/media overlay | 1100 | Secondary overlays inside modals |
| Tooltip | 1200 | Any tooltips within a modal |

---

## 11. Modal Width & Height

| Mode | Width | Height | Border Radius |
|---|---|---|---|
| Mini window (fullscreen app) | `620px` fixed | Auto / content | `14px` |
| Full-cover (windowed app) | `100%` of app frame | `100%` of app frame | `0` |
| Maximised via button | `100vw` / `100vh` | Full page | `0` |

The body should never be taller than `80vh` in mini-window mode. If content overflows, add `overflow-y: auto` to `.modal-body` with a styled scrollbar:

```css
.modal-body::-webkit-scrollbar { width: 5px; }
.modal-body::-webkit-scrollbar-track { background: transparent; }
.modal-body::-webkit-scrollbar-thumb {
  background: rgba(255,255,255,0.12);
  border-radius: 3px;
}
```

---

## 12. Modal Types Reference

The following modal types exist in Qooti. Each uses the same shell (titlebar + body + footer) but varies in its body content pattern.

| Modal Type | Body Pattern | Primary Action |
|---|---|---|
| **Import / Migration** | Header row + step list + tutorial card + note | "Select folder" / "Start import" |
| **Confirmation / Alert** | Icon + title + description + optional detail | "Confirm" or "Delete" (danger) |
| **Settings** | Section labels + toggle rows + input fields | "Save changes" |
| **Onboarding** | Header + step list + progress indicator | "Continue" / "Get started" |
| **Media Preview** | Full-bleed image/video + minimal overlay controls | "Download" / "Share" |
| **Error / Warning** | Warning icon + error title + description + suggestion | "Retry" / "Dismiss" |
| **Form / Input** | Header + labeled input fields + validation messages | "Submit" / "Create" |
| **Connection / Auth** | Service icon + description + permission list | "Connect" / "Authorise" |

---

## 13. Accessibility

- All modals must trap keyboard focus when open — Tab cycles only within the modal
- `Escape` key always closes the modal (equivalent to Cancel)
- Interactive elements must have visible focus rings: `outline: 2px solid #1a6be8; outline-offset: 2px`
- All icon-only buttons must have `aria-label` attributes
- Modal container must use `role="dialog"` and `aria-modal="true"`
- Titlebar title must be referenced with `aria-labelledby` on the dialog element
- Color contrast for all text must meet WCAG AA (4.5:1 for body text, 3:1 for large text)

---

## 14. Do's and Don'ts

### ✅ Do
- Always place the title centered in the titlebar
- Always place traffic lights on the right, using only green and red
- Always use the exact color tokens from Section 2
- Always animate modals in and out — never show them instantly
- Always include a Cancel button as the leftmost footer button
- Always blur the backdrop overlay
- Switch to full-cover mode when the app window is small/windowed

### ❌ Don't
- Never use the yellow (minimize) traffic light button
- Never place traffic lights on the left side
- Never use hardcoded colors outside the defined token set
- Never stack footer buttons vertically in mini-window mode
- Never open a modal without a backdrop overlay
- Never skip animations — abrupt transitions feel broken
- Never allow the modal to appear outside the app frame bounds
- Never use border radius on modals in full-cover or maximised mode
