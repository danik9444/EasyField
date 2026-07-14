# Handoff: EasyField — AI Panel for DaVinci Resolve

## Overview
EasyField is an AI toolkit plugin for DaVinci Resolve, presented as a narrow, tall side panel (380×780 px design frame). It exposes 21 AI tools grouped in 5 categories (Footage, Image, Video, Motion, Audio) plus **SuperBrain** — a chat agent that plans and runs multi-tool jobs on the user's timeline. This package covers three screens: **Home** (tool browser), **Create Image** (full generation flow), and **SuperBrain** (agent chat with live plan execution).

## About the Design Files
The files in this bundle are **design references created in HTML** — clickable prototypes showing intended look and behavior, not production code to copy directly. The task is to **recreate these designs in the target environment**. For DaVinci Resolve, the natural target is a Workflow Integration plugin (Resolve's JS/HTML plugin surface) or an external companion app talking to Resolve's scripting API — if neither exists yet, choose the most appropriate stack and implement the designs there. All mock behaviors (fake generation, canned chat) must be wired to real backends.

## Fidelity
**High-fidelity.** Colors, typography, spacing, radii, copy, and interactions are final intent. Recreate pixel-perfectly using the codebase's patterns. The only placeholders are the striped image swatches (they stand in for real thumbnails/generated frames) and the canned chat content.

## Design Tokens

### Colors
- Page/backdrop behind panel: `#0A0A0D`
- Panel background: `#101015`; sheet/elevated surface: `#15151C`
- Surfaces on panel: `rgba(255,255,255,.04)` (cards), `.05` (inputs), `.06` (buttons/chips)
- Borders: `rgba(255,255,255,.07–.14)` (heavier = more interactive)
- Text: primary `#F5F5FA` / `#ECECF1`; body `#D8D8E0` / `#C9C9D4`; secondary `#9A9AAB` / `#8B8B99`; muted `#7A7A87` / `#5A5A66`
- **Accent (themeable, exposed as a setting): `#E26BD2` magenta.** Implement as CSS var `--ef-accent`; curated alternatives: `#5B8CFF`, `#3ED598`, `#FFB454`
- Brand gradient: `linear-gradient(90deg, #5B8CFF, var(--ef-accent))` (135deg for logo tile)
- Category colors: Footage `#9BA3B5` · Image `var(--ef-accent)` · Video `#5B8CFF` · Motion `#FFB454` · Audio `#3ED598`. Icon-tile tints = same color at ~12–13% alpha
- Success green: `#5EDC9B` (status dots, done checkmarks, result strips)
- Text on accent/gradient fills: near-black `#0E0E13` / `#14060F`
- Toast: bg `#22222B`, border `rgba(255,255,255,.14)`

### Typography
- Display/titles: **Space Grotesk** 500–700 (wordmark 17px/700; screen titles 15–15.5px/600)
- UI text: **Instrument Sans** 400–600 (tool names 12px/500; body 12.5px; descriptions 9.5–11px)
- Mono labels: **JetBrains Mono** 400–500, 7.5–9.5px, letter-spacing .06–.16em, UPPERCASE (section headers, statuses, timecodes, badges)
- All from Google Fonts.

### Spacing & Shape
- Panel: 380×780, radius 14, border `rgba(255,255,255,.09)`, shadow `0 24px 70px rgba(0,0,0,.55)`
- Screen padding: 14–18px; vertical rhythm between blocks: 12–18px
- Radii: cards/inputs 11–13; buttons 9–12; chips/pills 999; icon tiles 8; thumbnails 5–7
- Icon tiles: 28×28; icons: 15px, stroke 1.4, round caps
- Scrollbars: thin, 6px, thumb `rgba(255,255,255,.14)`

## Screens / Views

### 1. Home (tool browser)
- **Header**: 30×30 gradient logo tile (135deg blue→accent) with dark 4-point-star glyph; "EasyField" wordmark; "PRO" badge (gradient bg, mono 8.5px); spacer; 26px avatar circle (placeholder).
- **Ambient glow** (toggleable): blurred radial gradients (blue 28% + accent 30%) bleeding from the top edge, `filter: blur(26px)`, pointer-events none.
- **Search field**: full-width, `rgba(255,255,255,.05)` bg, radius 11, glyph + placeholder "Search 21 tools…" + `⌘F` key hint.
- **Tool sections** (scrollable, bottom padding 90px so content clears the floating bar): per category — mono uppercase label + hairline + zero-padded count ("02"/"05"); then a **2-column grid (gap 7px)** of tool cards.
- **Tool card**: 28×28 tinted icon tile (category color) + name (12px/500, ellipsis) + one-line description (9.5px, ellipsis). Hover: bg `.04→.08`, border `.07→.16`. Descriptions are written to fit without truncation at this width — keep them ≤ ~19 chars.
- **Floating SuperBrain bar**: pinned 14px from bottom, gradient-border pill (1px gradient border via padding-box/border-box technique, inner `#15151C`), star glyph in accent + "Ask SuperBrain to do it for you" + `⌘K`. Click → SuperBrain screen.

### 2. Create Image (opened from the "Create image" card)
- **Header**: 28px back button (‹) → Home; title "Create image"; pill badge "EF·IMAGE V3".
- **Reference frame card**: 52×32 thumbnail (real: current playhead frame), "Reference frame" + mono "⌖ FROM PLAYHEAD · 01:12:04", remove (✕) button. Real behavior: auto-attach the frame under the playhead; removable.
- **Prompt card**: borderless textarea inside a card (3 rows), char counter "142 / 800" bottom-right.
- **STYLE chips** (single-select): Photoreal / Cinematic / Anime / Product. Selected: accent border + accent 16% bg + white text; unselected: `.04` bg, `.11` border, `#9A9AAB`.
- **ASPECT segmented** (single-select, mono font): 16:9 / 9:16 / 1:1. Same selected treatment.
- **Generate button**: full-width gradient fill, dark text, star glyph, radius 12.
- **Generating state**: replaces button with a 2×2 grid of shimmer skeletons (diagonal light sweep, 1.2s linear infinite, staggered .15s) + blinking mono caption "DREAMING UP 4 FRAMES…". Mock duration 2.2s.
- **Results state**: 2×2 grid of frames (16:10, radius 11). Hover overlay: dark scrim + "→ Timeline". Click a tile = send that frame (toast). Action row: ghost "↺ Variations" (back to form) + gradient "Send to timeline" (toast "4 frames sent to timeline · V2").

### 3. SuperBrain (agent chat)
- **Header**: back button; 26px animated orb (radial blue→accent, gentle scale pulse 2.6s); "SuperBrain"; mono status line in green — idle: "CONNECTED TO TIMELINE 1", running: "EXECUTING · STEP n/3", done: "DONE · PLACED ON TIMELINE 1".
- **Suggestion chips**: "Cut to the beat" / "Teal & orange grade" / "Trailer voice-over". Hover: accent border.
- **User bubble**: right-aligned, max 82%, subtle blue→accent tinted gradient bg, radius 14/14/4/14.
- **Agent bubble**: left-aligned, max 94%; reply text; row of tool chips (dot in category color + tool name, pill); then:
  - **"Run plan · ~35s" button** (gradient). On click, replaced by a live step list.
  - **Step list**: LUTs (FOOTAGE) → Captions (MOTION) → Music (AUDIO). Each row: status mark (✓ green done / ● accent pulsing running / ○ gray queued), tool name, tiny category chip (mono 7.5px, category color), right-aligned mono meta ("✓ 2.0S" / "RUNNING" / "QUEUED"). Running row gets `rgba(255,255,255,.05)` bg; queued rows 50% opacity. Steps advance ~every 950ms in the mock.
  - **Result strip** (on completion): green-tinted card — thumbnail, "Grade, captions & score placed on **Timeline 1**", ghost "Undo" (reverts + toast "Reverted — timeline restored").
- **Input bar**: gradient-border pill, star glyph, input "Describe the edit you want…", 26px gradient send button.

### Toast (all screens)
Centered pill near the bottom (bottom: 74px), auto-dismisses after 1.7s. Used for: unimplemented tools ("Demo — try "Create image""), sends to timeline, undo confirmations.

## Interactions & Behavior
- Navigation: Home ↔ Create Image, Home ↔ SuperBrain (in-panel screen swaps; no browser routing needed).
- Only "Create image" opens a flow in the prototype; every other tool card toasts. In production each tool gets its own flow following the Create Image pattern (context card → parameters → primary action → progress → results → send to timeline/Media Pool).
- Hover states throughout: surface +4% white, border +~.08 alpha, or accent border on chips; buttons `filter: brightness(1.08–1.1)`.
- Animations: shimmer skeletons (1.2s linear, staggered); status-mark pulse (1s); orb pulse (2.6s ease-in-out); blinking captions (1.1s); progress feel > spinners.
- Keyboard: `⌘K` opens SuperBrain, `⌘F` focuses search (hints shown in UI; implement globally in the panel).

## State Management
- `screen: 'home' | 'create' | 'brain'`
- Create flow: `phase: 'form' | 'generating' | 'done'`, `style`, `aspect`, `prompt`, `referenceFrame` (nullable), selected result frames
- SuperBrain: message list; per-run `steps[{tool, status: 'queued'|'running'|'done', elapsed}]`, run status
- Toast: `{visible, message}` with 1.7s auto-hide
- Settings: `accent` (hex, default `#E26BD2`), `glow` (bool, default true)
- Data needs: tool catalog (static), timeline context from Resolve API (active timeline name, playhead timecode, fps, frame grab), generation jobs (async with progress), agent plan/execution stream, send-to-timeline / Media Pool import actions.

## Tool Catalog (names + card descriptions, final copy)
- **FOOTAGE**: Culling — Sort raw footage · B-roll — Auto-match b-roll · Upscale — Enhance up to 4K · Remove BG — No green screen · LUTs — Color match & grade
- **IMAGE**: Create image — Text to still frame · Create storyboard — Script to frames · Create avatar — Talking presenter · Edit image — Inpaint & retouch · Angles — New camera angles
- **VIDEO**: Create video — Text/image to clip · Edit video — Prompt-based edits · Extend video — Continue any shot · Transition — Generative morphs
- **MOTION**: Animations — Motion presets · Captions — Styled subtitles
- **AUDIO**: Music — Score to your cut · Sound effects — Foley on demand · Voice over — TTS narration · Transcribe — Speech to text · Beat detection — Cut markers on beat

## Assets
- Fonts: Space Grotesk, Instrument Sans, JetBrains Mono (Google Fonts).
- Icons: inline SVG line glyphs (16×16 viewBox, stroke 1.4, round caps), one per tool — defined as primitive shape lists in the prototype's logic (`glyphs()` in the HTML files); recreate as an icon set or swap for an equivalent minimal line-icon library.
- Logo: 4-point star polygon on gradient tile. No raster assets; striped swatches are placeholders for real thumbnails.

## Files
- `EasyField 1b.dc.html` — **the chosen design** (all three screens + interactions). Template markup at top, logic class + data at bottom.
- `EasyField Panel.dc.html` — exploration canvas (options 1a/1b/1c) for context only; do not implement 1a/1c.
