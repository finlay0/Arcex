# Arcex UI spec

Version 1, November 3, 2026, updated November 4. Covers the launch UI for Radar, Vault and MCP handoff, plus the backend work the UI needs. All products, numbers and screens in the wireframes are placeholders.

## Current direction (November 4, 2026)

**The structure is one table and one app page.** Clicking a row opens a single page with everything about that app: analytics, estimated revenue, model, every screen, ads, creators and the blueprint. There's no Vault tab or preview panel, and the interface doesn't use the words Vault or X-Ray. Where this section disagrees with anything below, this section wins. The prototype in `apps/web` follows it.

- **Table:** sortable headers, growth with a trend line, estimated revenue, first seen, a screen thumbnail, visible filter chips, All / Trending / Rising / New presets, and 50 rows a page. Sample data has 308 products to test scale.
- **Tracking:** add your own product, watch competitors and see their changes. Free accounts watch 3. Insider is unlimited, with email alerts.
- **Ads and Screens:** libraries across all apps. Screens can be filtered by step and monetization, which replaces patterns.
- **MCP & API:** paste-in connection, key management and API examples.
- **Limits:** 10 apps and 10 blueprint pulls a day, and reopening an app is free. This replaces the 5-a-day figures below.
- **Backend built:** coverage on Radar rows, sorting, filters and totals, activity and trend metrics from approved observations (null where not collected), draft-then-published manual revenue ranges and changes, tracking, own products, full-breakdown requests, the server-side gate and daily limit, and signed image links.
- **Frontend when connected:** show unknown values as a dash, label revenue as a range rather than an estimate unless a real model exists, and leave gaps in trend lines.
- **Backend still needed:** a revenue model, if one is ever built, wider change detection, and small thumbnail images for the table.
- **Coverage levels:** products are either "Full Screens" or "Signals Only". The table marks signals-only rows and has a Coverage filter. Signals-only pages show overview, ads, creators and public pricing plus a "Request full breakdown" button, without sign-in or using the daily limit. The 50 MB capture quota holds roughly 50 to 125 full products.

The look comes from Finlay's reference mockup, minus the preview panel.

**Layout**
- Pure black canvas (`#000`), with near-black panels, thin borders and teal only on selection, the live dot and ad signals.
- Top bar: Arcex logo, then search (⌘K), MCP and Sign in.
- Left rail: Radar, Vault, What's New, Arena (Soon), Saved, History, with a Live scan card at the bottom. The X-Ray workspace hides the rail for room.
- Radar is the homepage. There is no hero: the page opens on the "AI Product Radar" heading, a filter row and the table.
- Table columns: Product, Category, Ads (active), YT sponsors, Monetization, Last seen.
- Signed out: the table is full width with no panel, and gains a Screens column showing the product's public landing page plus a locked count of post-login screens.
- Signed in: the selected row opens a right preview panel with a screen carousel, Key Observations and an "Inspect X-Ray" button. Below 1280 px it becomes a slide-over.

**Sign-in gate:** the Radar table is public. For signed-out visitors, a row click opens the X-Ray on the product's first screen, blurred behind the sign-in gate. Closing the gate returns to the Radar. A shared link to a specific step still shows that one step without sign-in, and moving to another step asks for sign-in.

**Free core, optional Insider:** free accounts get 5 full X-Rays and 5 blueprint exports a day. Insider is $12/mo and removes those caps. It also adds collections and Request X-Ray priority. Only opening a full X-Ray spends the limit, and the signed-in panel keeps post-login screens locked until that product's X-Ray has been opened today. Upsells stay quiet: the rail, account menu, MCP dialog and limit modal. Where older sections below say 3 MCP pulls a week, this replaces them. The server must enforce the sign-in gate and X-Ray limit, because the current `/vault/:slug` and `/media/:id` routes are public. Blueprint export limits are already enforced.

**Connecting an agent:** the main path is a hosted MCP with no install and no npm: copy one instruction, paste it into any agent, and it connects to `/public/mcp`. Search needs no account. A free key, added to the connection as a Bearer header, unlocks blueprints. Where older sections mention `npx`, this replaces them.

**UX additions**
- **What's New** (`/updates`): a feed of observed changes by day, with a count in the rail, a dot on changed rows and a "Changed This Week" filter. Needs a changes endpoint from the backend.
- **Row verdicts and trends:** each row's second line says what the product is plus one line of observed evidence. Ads and YT sponsors show their 7-day change.
- **Open sample:** one product opens fully without sign-in, marked "No sign-in". Needs a public sample route on the server.
- **Screens column:** the thumbnail is the paywall screen at a size too small to read, so it hints at what's inside without giving it away.
- **Evidence and analysis:** the X-Ray separates "Observed" (with a receipt) from "Arcex analysis". The Logic tab is labelled as inferred.
- **Phone handoff:** the agent drawer offers email, share and save on phones. Needs a send-email endpoint. The gate warns in-app browser users and offers to copy the link.
- **Build paths:** Onboarding, Credits, Paywalls and Viral loops links on the Radar open the matching Vault shelf.
- **First run:** signed-in users get a dismissible three-step checklist on the Radar.
- **Navigation:** the rail is the navigation where it's visible. The top links only appear on phones, tablets and the X-Ray. Arena has one Soon entry, in the rail.
- **Naming:** X-Ray is a product's full breakdown, Blueprint is what goes to your agent and Vault is the pattern library.

**Type:** Geist Sans everywhere, matching the reference. Geist Serif stays available through one token (`--font-display`).

**Left out for now:** the React Bits radar background (the reference is plain black), the Compare view and the revenue column, which comes back when the estimate model exists.

## 1. What the interface has to do

A viewer clicks a link on X or YouTube. Within five seconds they should think: "This is the real numbers and the real screens behind AI products, and I can put them straight into my agent."

Design rules:

1. **The product is the pitch.** The homepage shows live data right under a short hero. There is no separate marketing page.
2. **Show the screens early.** Screenshots are what nobody else has for these products, so they appear in the Radar table itself, not only behind a click.
3. **Every view ends in an action.** Each teardown leads to copying a blueprint, pulling it through MCP, saving it or comparing it.
4. **Keyboard first, phone friendly.** Desktop feels like Linear. Traffic from X is largely on phones, so mobile is a designed experience, not a shrunken table.
5. **Receipts are a feature.** Any number can open its source. In a space full of fake MRR screenshots, "click to see the receipt" is a selling point.
6. **Every screen is shareable.** Each step has its own URL and social card, so a stream moment or a tweet links to the exact paywall being discussed.

## 2. Structure and routes

| Route | Screen | Access |
| --- | --- | --- |
| `/` | Hero + Radar | Public |
| `/vault` | Pattern library | Public browse |
| `/vault/patterns/:slug` | One pattern across products | Public preview, sign-in for full |
| `/x/:slug` | X-Ray workspace (teardown) | Public preview, sign-in for full |
| `/x/:slug/:step` | Deep link to one step | Same as above |
| `/compare?apps=a,b,c&stage=paywall` | Side-by-side comparison | Signed in |
| `/connect` | MCP setup | Public |
| `/me` | Saved X-Rays, requests, plan, API keys | Signed in |
| `/pricing` | Free vs Insider | Public, unlinked until Insider launches |
| `/admin/review` | Draft review and publish queue | Admin |

Arena and Ship stay out of the nav until they have content. The layout has room for them as new top-level items.

**Radar vs Vault.** The earlier wireframe had an Apps/Patterns toggle inside Radar. Splitting them is simpler and gives each name a clear meaning:

- **Radar:** which products are worth looking at.
- **Vault:** how to build a specific thing, such as a credit gate or an onboarding quiz.
- **X-Ray:** the name for a single product's teardown. Both Radar and Vault lead into it.

## 3. Global shell

```
+----------------------------------------------------------------------------------+
| ARCEX    Radar   Vault              [ / Search ]   Request X-Ray   Connect MCP  (o) |
+----------------------------------------------------------------------------------+
```

- 52px sticky bar on the canvas colour, with a 1px bottom border that appears on scroll.
- **Search:** `/` or `Ctrl/Cmd+K` opens the command palette.
- **Connect MCP:** teal status dot once a key has been used.
- **Avatar (o):** `Sign in` for visitors. Signed-in users get Saved, Requests, API keys, Plan and Sign out.
- **Footer:** minimal, with methodology, terms, privacy, X, YouTube and a "Last updated" timestamp.

### Command palette

Grouped results: Products, Patterns, Actions. Actions include "Copy MCP setup", "Request an X-Ray" and "Filter: hard paywall". Typing `paywall` shows both the pattern and the products that use it. Enter opens, `Ctrl/Cmd+Enter` opens in a new tab.

## 4. Home: hero + Radar

```
+----------------------------------------------------------------------------------+
|  ● LIVE  Updated 2h ago                                                           |
|                                                                                  |
|  See what's actually making money in AI.          +---------------------------+  |
|  Copy the funnel into Claude Code.                | [Ad] > [Quiz] > [Paywall] |  |
|                                                   |  auto-cycling real X-Ray  |  |
|  Revenue estimates, ad history, and every screen  |  > Blueprint ready        |  |
|  from signup to paywall for the AI products       +---------------------------+  |
|  winning right now.                                                              |
|                                                                                  |
|  [ Explore the Radar ]   $ npx arcex init      [copy]                            |
|                                                                                  |
|  142 products  ·  1,204 screens  ·  8,310 ads tracked  ·  61 blueprints          |
+----------------------------------------------------------------------------------+
|  [All] [Video] [Coding] [Sales] [Consumer] | Model v | Ads 30d+ | Sponsored | Blueprint | Sort: Trending v |
+----------------------------------------------------------------------------------+
|  PRODUCT            EST. REVENUE     DISTRIBUTION        FUNNEL            MODEL  |
|----------------------------------------------------------------------------------|
|  [i] Example App    $40-70k/mo ▲     14 ads · 74d        [][][][][]▣ 8      Credit|
|      AI captions    ●●●○             19 creators  ~spark  ◐ preview on hover  gate|
|----------------------------------------------------------------------------------|
|  [i] Example Two    $10-25k/mo       9 ads · 51d         [][][]▣ 7          Hard  |
|      Faceless video ●●○○             31 creators  ~spark                     trial|
+----------------------------------------------------------------------------------+
```

### Hero

- Compact: no more than about 40% of a 1080p viewport, so the table is visible without scrolling.
- The right-hand preview cycles through a real published X-Ray and links to it.
- Signed-in users get no hero. The page starts with a one-line stats strip and the table.
- The primary button scrolls to the Radar and sets focus on the table. Sign-in is asked for later, at the moment of highest intent.

### Table columns

| Column | Contents | Notes |
| --- | --- | --- |
| Product | Icon, name, one-line description, category | Saved state shows as a small marker |
| Est. revenue | Monthly range, trend arrow, confidence dots | Hover opens "How this is estimated". Hidden until the model ships |
| Distribution | Active ads, longest ad in days, creator count, 30-day sparkline | Hover shows Meta start date, days Arcex has seen it and the latest creator video |
| Funnel | Row of tiny screen thumbnails ending in a highlighted paywall, plus step count | The visual signature of the product. Hover enlarges a filmstrip |
| Model | Tag such as Credit gate, Hard trial, Watermark, Usage, Subscription | Click to filter |
| Blueprint | Bolt icon when a blueprint exists | Shown at wide widths, otherwise inside Funnel |

### Behaviour

- The whole row is clickable. Hover raises the row surface and reveals `Open X-Ray →`.
- Rows are 72px tall so the thumbnails read.
- The header sticks below the nav. Clicking a sortable header sorts by revenue, ads, creators, newest or trending.
- Keyboard: `j`/`k` move, Enter opens, `s` saves, `x` adds to compare.
- Filters and sort live in the URL, so any filtered view can be shared. Returning from an X-Ray restores scroll position and filters.
- Up to 3 rows can be ticked for compare. A floating bar then shows `Compare 3 →`.
- Page size 25 with infinite scroll and a visible count.
- A "New this week" chip filters to recently added or changed products.

### Monetization labels

| API value | Label |
| --- | --- |
| `hard_trial_gate` | Hard trial |
| `credit_exhaustion` | Credit gate |
| `watermark_export` | Watermark |
| `usage_based` | Usage |
| `free_viral_utility` | Free viral |
| `subscription` | Subscription |

Unknown shows as a quiet dash.

## 5. X-Ray workspace

This is the centre of the product. It behaves like a viewer rather than an article, locked to the viewport on desktop.

```
+----------------------------------------------------------------------------------+
| ← Radar   [i] Example App  example.com ↗   Video                [Save] [Compare]   |
|           $40-70k/mo est.  ·  Longest ad 74d  ·  19 creators  ·  Stripe  ·  Next.js |
|                                                       [ ⚡ Send to my agent ]      |
+----------------------------------------------------------------------------------+
| ACQUISITION ─ LANDING ─ SIGNUP ─ ONBOARDING ─ ─ ─ ACTIVATION ─ PAYWALL ─ RETENTION |
|     (9)        (1)       (1)       ● ● ●            (1)         ▣ (1)      (1)     |
+-----------------------------------------------------+----------------------------+
|                                                     | Breakdown | Logic | Agent  |
|                                                     |----------------------------|
|         +-----------------------------------+       | STEP 6 OF 8 · PAYWALL      |
|         |                                   |       | Post-quiz hard wall        |
|         |          REAL SCREENSHOT          |       |                            |
|         |                ①                  |       | Why it works               |
|         |        ②                          |       | The user has invested 90   |
|         |                                   |       | seconds before seeing a    |
|         +-----------------------------------+       | price...                   |
|                                                     |                            |
|                                                     | How it protects AI costs   |
|  ← Prev        Step 6 of 8        Next →            | Pricing tricks             |
|                                                     | ① ② linked to pins         |
|                                                     | [Receipt: captured Nov 2]  |
|                                                     | [ Copy step spec ]         |
+-----------------------------------------------------+----------------------------+
```

### Header

Two lines: identity and the summary metrics. The metrics are the same ones as Radar, so users stay oriented. `Send to my agent` is the only filled button on the screen.

### Stage rail

- Stages in order: Acquisition, Landing, Signup, Onboarding, Activation, Paywall, Retention.
- Stages with several steps show one dot per step. The paywall node gets the accent colour.
- A stage with nothing captured stays on the rail, dimmed, so every X-Ray has the same shape and products are easy to compare.
- Keys: `←`/`→` move one step. `1`-`7` jump to a stage. `[` and `]` move to the previous or next X-Ray in the current Radar results, so people can binge.

### Viewer panel

- Screenshot fits the available height on a dark stage with a thin frame.
- Numbered pins sit on the screenshot. Hovering a pin highlights its note in the dock, and the reverse.
- Click to zoom; drag to pan. Images preload for adjacent steps, so stepping feels instant.

### The Acquisition stage uses a different layout

It has no single screenshot, so the panel changes to:

- **Ad timeline:** a horizontal bar per ad, running from start date to last seen, sorted by longest. This is the signature visual for ads: long bars read instantly as "this one keeps running". Hover shows the creative.
- **Creatives gallery:** thumbnails filterable by Meta, Google and active or ended.
- **Creators and clips:** video thumbnail, channel, views, date, sponsored or mention tag and link.

### Inspector dock

Fixed at 380px with three tabs. The selected tab persists as the user steps through.

1. **Breakdown:** step title, why it works, how it protects AI costs, pricing tricks, pin notes, receipt link.
2. **Logic:** the conditions and transitions behind this step, for example `credits_remaining = 0 → open upgrade modal`.
3. **Agent:** this step's spec with `Copy step spec`, and a link to the whole blueprint.

### Paywall step extras

The Paywall stage adds a compact state diagram drawn from `paywall_mechanics.states` and `transitions`, credit rules as a short table, and pricing plans side by side.

### Below or beside the flow

A "Similar" row shows X-Rays that use the same paywall pattern, and offers `Compare`. This creates the loop from one product into the next.

## 6. Agent handoff

`Send to my agent` opens a 520px right-hand drawer.

```
+------------------------------------------------+
| Send to my agent                           [x] |
| Example App: quiz + hard paywall               |
|------------------------------------------------|
| [ Claude Code ] [ Cursor ] [ Codex ] [ Other ] |
|                                                |
| PASTE THIS PROMPT                              |
| +--------------------------------------------+ |
| | Build this onboarding and paywall pattern  | |
| | in my project. Adapt it to my stack...     | |
| +--------------------------------------------+ |
|                     [ Copy prompt + full spec ]|
|                                                |
| USE MCP INSTEAD                                |
| $ npx arcex init                        [copy] |
| Then: "Use Arcex to pull example-app"   [copy] |
|                                                |
| What's in the spec: schema · middleware ·      |
| states · UI tree · pricing logic  [Preview v]  |
| Recommended stack: Auth · DB · Billing         |
+------------------------------------------------+
```

- Copying the prompt is the default path. It works immediately, with no install.
- Tool tabs change the command and the wording of the prompt, and the tool used is remembered.
- A successful copy changes the button to `Copied. Paste into Claude Code`.
- Recommended stack links are partner links, with disclosure text from the `partners` table.
- On phones, the drawer's main action is `Save to my list` plus `Send to my email`, since nobody runs Claude Code from X on a phone.

### `/connect`

One page per tool with a working config, a test prompt and a live "Connected ✓" state the first time a key is used.

## 7. Sign-in and limits

### When sign-in appears

Per the agreed direction, opening a row triggers the gate.

| Visitor | Sees |
| --- | --- |
| Clicks a Radar row | X-Ray opens behind the modal, with the first screens blurred |
| Arrives by a shared X-Ray link | Header metrics and the linked step fully visible. The modal appears on the next step or on any copy action |
| Search crawlers | Product name, description, metrics and step titles, so pages can rank |

The second row is what keeps links on X working: a tweet about a paywall shows that paywall, then asks for sign-in.

### Gate modal

```
+-------------------------------------------+
|  FREE ACCESS                              |
|  See all 8 screens inside Example App     |
|                                           |
|  ✓ Every screen from signup to paywall    |
|  ✓ Ad history and creator sponsors        |
|  ✓ Blueprint for Claude Code and Cursor   |
|                                           |
|  [ Continue with X ]                      |
|  [ Continue with GitHub ]                 |
|                                           |
|  Free, one click, no card.                |
+-------------------------------------------+
```

After sign-in the user returns to the exact step they were on. No welcome tour. Dismissing the modal returns them to Radar.

### Daily limit

A user gets 5 X-Rays per day. Re-opening one they've already unlocked is free. A small `3 of 5 today` counter in the avatar menu turns visible in the header at 1 remaining.

Modal: **"That's your 5 free X-Rays today."** Body: "Resets in 14h 22m. Insider gets unlimited X-Rays and MCP pulls." Buttons: `Go Insider` and `Come back tomorrow`.

### Experiments

Run through PostHog feature flags:

- Gate on row click vs gate on step 3.
- 5 vs 10 daily X-Rays.
- Hero headline variants.

## 8. Vault

`/vault` is browsed by what the builder is working on, not by company.

```
| What are you building?                                                     |
| [Activation] [Credits & metering] [Paywalls] [Pricing] [Viral loops]       |
|                                                                            |
| +----------------+ +----------------+ +----------------+ +----------------+ |
| | [fanned shots] | | [fanned shots] | | [fanned shots] | | [fanned shots] | |
| | Sunk-cost quiz | | Watermark gate | | $1 trial       | | Daily credits  | |
| | 12 products    | | 8 products     | | 6 products     | | 15 products    | |
| +----------------+ +----------------+ +----------------+ +----------------+ |
```

A pattern page has a short explanation, a gallery of that same moment across products, filters by category, `Compare`, and `Copy pattern spec`. Clicking any screen opens that product's X-Ray at that step.

The first four shelves match the moments in a build when someone needs help: first users bouncing, AI costs, nobody upgrading, and getting users to share. This is what brings people back mid-build rather than only when hunting for an idea.

### Compare

Up to three products in columns, with stages aligned in rows and synced stepping. Default stage is Paywall. It gives the best screenshots for X and Shorts, so it has a `Share` button that produces a card.

## 9. Account

`/me` has four tabs: **Saved** (X-Rays and patterns, with a "changed since you saved" dot), **Requests** (status of X-Ray requests), **Plan** and **API keys**.

**Request X-Ray:** a one-field modal for a URL, with an optional note and an `It's my product` checkbox. Confirmation: "It's in the queue. We pick from this list live on stream." The public queue with votes can later become the start of Ship.

## 10. States

| Situation | Treatment |
| --- | --- |
| First load | Skeleton rows matching exact table layout. No spinners |
| Stepping through an X-Ray | Instant from preload, with a blur-up if the image isn't ready |
| Metric not available yet | Quiet dash, never a `0` |
| Stage not captured | Dimmed rail node. Panel says "Not captured yet" with `Request this` |
| Filter returns nothing | "No matches" with `Clear filters` and `Request an X-Ray` |
| Copy succeeds | Button text changes for 2s. No toast |
| API or network error | Inline panel with `Retry`. Existing content stays on screen |
| Screenshot link expired | Silent re-fetch and retry |
| Rate limited | Daily limit modal, or "Slow down a sec" for burst limits |
| Maintenance | Radar stays readable from cache where possible |

## 11. Mobile

- **Radar:** cards with icon, name, revenue, ads, creators, model tag and a swipeable filmstrip. Filters sit in a horizontal chip row that opens a bottom sheet.
- **X-Ray:** full-width screenshot on top, with stage rail as a horizontal scroller. Swipe to change step. The dock becomes a bottom sheet, half open by default.
- **Sticky bottom bar:** `Save` and `Send to my agent`.
- **Compare:** one column at a time with a swipe between products.
- Touch targets at least 44px. No hover-only information: tap opens what hover shows on desktop.

## 12. Visual design

Direction: **Precision Carbon.** Near-monochrome surfaces, sharp type and one electric accent. It should feel like Linear crossed with DexScreener. Colourful screenshots of other people's products are the visual payoff, and the neutral UI lets them stand out.

All values are CSS variables, so the accent can be swapped in one line.

### Colour

```css
--canvas:        #07080A;
--surface-1:     #0F1012; /* table, panels */
--surface-2:     #16181B; /* hover, active row */
--surface-3:     #1E2025; /* modal, drawer, menu */
--border:        rgba(255,255,255,.07);
--border-strong: rgba(255,255,255,.13);
--highlight:     inset 0 1px 0 rgba(255,255,255,.06);

--text-1: #F4F4F6;
--text-2: #A7ABB4;
--text-3: #6E727B;

--accent:     #00F5D4; /* live state, selection, paywall node */
--accent-dim: rgba(0,245,212,.12);

--signal-ads:     #FF7A45;
--signal-creator: #4CC2FF;
--signal-revenue: #5EE38A;
--signal-danger:  #FF5C5C;

--button-bg: #F4F4F6;
--button-fg: #07080A;
```

Accent stays under about 2% of the screen. The primary button is off-white rather than teal, which makes the accent feel like data.

### Type

All three come from the `geist` npm package.

- **Display:** Geist Serif, Vercel's new high-contrast display serif. Hero 64/68, X-Ray product names 28/32, pattern titles and modal headlines 24/28. It's the one element that stops Arcex looking like every other dark developer tool: a sharp editorial headline over dense terminal data. It only ships in Regular so far and is built for display, so it never goes below about 20px or inside tables.
- **UI:** Geist Sans. Section 15/20 semibold, body 14/20, small 12/16.
- **Numbers and code:** Geist Mono with tabular figures. Everything countable uses mono, which gives the data-terminal feel.
- **Column headers:** 11px mono, uppercase, +0.06em, `--text-3`.
- **Optional detail:** Geist Serif's dot variants (square, triangle) could be a small brand mark on hero wordmarks. Try it during the build and keep it only if it looks intentional.

### Space, shape, depth

- 4px grid. Table padding 16px horizontally. Panel gaps 12px.
- Radius: 6px controls, 8px panels, 12px modals. Screenshots 6px.
- Depth comes from surface steps and the top `--highlight`, not shadows. Only modals and drawers get a large soft shadow.
- No background effects inside the working app. Effects live in the hero and a few moments listed under React Bits below.

### Motion

- Row hover 80ms. Tabs and panels 120ms. Drawer and modal 180ms with a soft ease-out.
- Screenshots crossfade at 120ms with a 6px slide in the direction of travel.
- Numbers count up once on first load in the hero stats only.
- The live dot and the hero radar are the only things that loop.
- Everything respects `prefers-reduced-motion`.

### React Bits

React Bits provides the wow moments. The rule of thumb: it goes where people look, never where they work.

| Where | Component | Treatment |
| --- | --- | --- |
| Hero background | **Radar** | The sweep and moving contacts sit behind the headline, in the accent colour on the canvas. It's literally the product name, and it makes a great opening shot for Shorts and stream overlays |
| Hero stats | A count-up number component | Once on first load |
| Hero headline | A subtle text reveal | Once, under 600ms |
| Gate modal and social share moments | A border glow or spotlight card | Sparingly, to make the moment feel premium |
| Empty Radar results and 404 | Radar, small and slow | Keeps the brand consistent |

Keep it out of the Radar table, X-Ray viewer, inspector dock and agent drawer. Those need to feel instant and stay out of the way of the screenshots.

Setup and performance:

- Install through the shadcn CLI: `npx shadcn@latest add @react-bits/Radar-TS-TW`. The source is copied into the repo, so it can be tuned to our tokens.
- Load background effects after first paint, so the headline and table never wait for them.
- Pause when scrolled out of view or the tab is hidden.
- Use a static frame on low-power phones and with `prefers-reduced-motion`.
- Fade the radar out as the user scrolls into the table, and don't render it for signed-in users, who have no hero.
- The maintainer says using the free library inside a commercial app is fine, with limits on redistributing the components themselves. Check the LICENSE file when installing.

### Core components

`Nav`, `CommandPalette`, `FilterChip`, `DataTable`, `RadarRow`, `FunnelStrip`, `Sparkline`, `RevenueRange`, `ConfidenceDots`, `MetricHover`, `StageRail`, `ScreenViewer`, `Pin`, `InspectorDock`, `AdTimeline`, `CreativeCard`, `CreatorRow`, `StateDiagram`, `CodeLine` (with copy), `AgentDrawer`, `GateModal`, `LimitModal`, `PatternCard`, `CompareGrid`, `Skeleton`.

### shadcn/ui

Recommended, in three tiers (final call is Finlay's):

- **Use as the base:** dialog, drawer, tooltip, dropdown menu, tabs, sheet, command (built on `cmdk`) and button, all restyled with our tokens. These handle keyboard and focus properly, and React Bits already installs through the same CLI.
- **Use blocks where speed matters more than identity:** `/me`, settings, API keys and `/admin/review`.
- **Build custom:** `RadarRow`, `FunnelStrip`, `StageRail`, `ScreenViewer`, `AdTimeline`, `InspectorDock` and `CompareGrid`. These are the product's identity, and stock blocks would make Arcex look like every other shadcn site. The table can still use the shadcn data table pattern with TanStack Table underneath.

### Accessibility

WCAG AA contrast, checked for every token pair during the build. Visible focus rings in the accent colour. All pins and hover content reachable by keyboard. Screenshots have alt text from the step title and notes. Metric colours always come with a label or icon.

## 13. Copy

### Main lines

- **H1:** See what's actually making money in AI. Copy the funnel into Claude Code.
- **Sub:** Revenue estimates, ad history, and every screen from signup to paywall for the AI products winning right now.
- **Primary CTA:** Explore the Radar
- **Page title:** Arcex: See what's making money in AI
- **Share line:** The real numbers and real screens behind AI products.

**Hero A/B alternatives:**

- See inside the AI apps making real money.
- Stop guessing what works. Copy what's already winning.
- Every screen between "sign up" and "pay". Ready for your agent.

### Interface text

| Where | Text |
| --- | --- |
| Radar heading | The Radar |
| Radar sub | What's taking off in AI right now |
| Row hover | Open X-Ray → |
| Vault heading | What are you building? |
| Vault sub | Real onboarding, credit and paywall patterns, ready for your agent |
| Primary X-Ray button | ⚡ Send to my agent |
| Dock tabs | Breakdown · Logic · Agent |
| Receipt link | Receipt: captured Nov 2 |
| Revenue hover | Estimated from public signals. See how → |
| Empty stage | Not captured yet. Request this → |
| Request button | Request X-Ray |
| Request confirmation | It's in the queue. We pick from this list live on stream. |
| New user, first X-Ray done | Nice. Press ← → to step through, or send it to your agent. |

### Social cards

Each X-Ray and step gets a 1200×630 card: product icon and name, two big metrics, a three-screen filmstrip ending on the paywall, and the arcex.dev mark. Step links show that exact screen large, so tweets lead with the most interesting image.

## 14. Analytics

PostHog: capture, session replay, heatmaps and feature flags. Set hard free-tier caps with no paid overflow, and mask user-identifying fields in replays.

Core events: `radar_filter`, `row_open`, `gate_shown`, `signin_complete`, `step_view`, `blueprint_copy`, `mcp_setup_copy`, `save`, `compare_open`, `request_xray`, `limit_hit`, `share_click`.

Main measures:

- Visit → sign-in
- Sign-in → first blueprint copy
- Returning within 7 days
- X-Rays viewed per user
- Sign-ups by source (each Short or stream link gets its own UTM)

## 15. Frontend setup

- **Stack:** React Router 7 with server rendering, running as a Cloudflare Worker named `arcex-web` on arcex.dev, Tailwind with the tokens above, shadcn/ui, React Bits and the `geist` font package. Server rendering gives crawlers and social cards real pages. Staying on Cloudflare keeps everything together.
- **API routing:** `arcex.dev/api/*` goes to `arcex-api`, so session cookies are same-site.
- **Location:** `apps/web` in this repo, using the existing pnpm workspace.
- **Replaces:** the arcex.dev waitlist site. Existing Loops signups get a launch email.
- **Prototype:** `apps/web` currently runs as a Vite single-page app on sample data. Server rendering and the API connection come when it becomes the real frontend.
- **Testing:** Claude runs its own browser checks. Terra is for ChatGPT agents.

## 16. Build order

1. **Foundation:** app skeleton, tokens, nav, palette, deployment, API proxy.
2. **Radar:** hero, table, filters, sort, filmstrips, URL state, mobile cards.
3. **X-Ray:** stage rail, viewer, pins, dock, Acquisition layout, ad timeline, paywall diagram.
4. **Accounts:** sign-in, gate, daily limit, saves, `/me`.
5. **Agent:** drawer, prompts per tool, `/connect`.
6. **Vault:** pattern pages, compare.
7. **Growth:** social cards, Request X-Ray, PostHog, experiments.
8. **Admin:** `/admin/review`. Can move earlier if publishing through the API becomes slow.
9. **Revenue:** switch the estimate column on when the model is ready.

Steps 1 to 5 are a complete, launchable product. Each also makes good stream content, particularly the ad timeline and the viewer.

## 17. Backend change list

### Needed for launch

| # | Change | Why | Where |
| --- | --- | --- | --- |
| 1 | Add Radar summary fields: active ads, longest ad days, creator count, 30-day sparkline, step count, thumbnail asset IDs, has blueprint, detected stack, last updated | The table needs them, and today rows only have product fields plus `observations` | `src/catalog.ts` |
| 2 | Add Radar sort (`trending`, `revenue`, `ads`, `creators`, `new`), filters (`hasCreators`, `hasBlueprint`, `new`) and a total count | Filter bar and sort | `src/catalog.ts` |
| 3 | Split `/vault/:slug` into a public preview and a full response. Anonymous users get metrics, step titles and the linked step | Enforces the gate on the server | `src/catalog.ts` |
| 4 | Add a `vault_unlocks` table (`user_id`, `product_id`, `day`) and return `{used, limit, resetsAt}`. Insider is unlimited | The 5-a-day rule counts distinct X-Rays, which the `rateLimit` hit counter can't do | New migration, `src/catalog.ts` |
| 5 | Serve full-funnel screenshots through short-lived signed tokens, tied to the same access rules | `GET /media/:id` is public for any approved asset, which would bypass the gate | `src/media.ts` |
| 6 | Add thumbnail and display image variants with dimensions, in WebP, at ingest | Filmstrips and fast stepping, inside the 50 MB storage cap | `scripts/`, `src/media.ts`, `assets` table |
| 7 | Add structured step analysis to `funnel_steps`: `analysis` JSON with why it works, AI cost notes, pricing notes, logic and pins (`x`, `y`, `note`) | The dock and pins. Today there's one `annotation` text field | New migration, `src/contracts.ts`, research tools |
| 8 | Add `GET /stats`: products, screens, ads, blueprints, last updated | Hero strip and timestamp | `src/catalog.ts` |
| 9 | Run the site and API on the same domain, and add a safe return-to path on sign-in | Cookies, and returning to the exact step | `wrangler.jsonc`, `src/auth.ts` |
| 10 | Set up the X developer app, and test GitHub and X customer sign-in end to end | Both gate buttons need to work | Provider setup, `src/auth.ts` |
| 11 | Publish `arcex` to npm. The `init` command that writes client config is built | The `npx arcex init` command in the UI needs to work. It's currently installed from a GitHub tarball | `packages/mcp` |
| 12 | Allow free-tier keys with 3 blueprint pulls a week, keeping Insider rechecks intact. Tier limits are enforced on the server | Today blueprint export over MCP is Insider-only | `src/auth.ts`, `src/catalog.ts` |
| 13 | Add the tool-specific prompt to the blueprint export response | Agent drawer | `src/catalog.ts` |

### Needed soon after

| # | Change | Why |
| --- | --- | --- |
| 14 | `revenue_estimates` table: product, low, high, currency, confidence, method version, inputs, computed at. Keep history for trends. Add it to Radar and X-Ray | The revenue column. Stored separately from observed data, so the model can improve without touching evidence |
| 15 | `patterns` and `pattern_examples` tables, linking to specific funnel steps. Add `GET /patterns` and `GET /patterns/:slug` | Vault pages |
| 16 | `GET /compare?apps=&stage=` with aligned steps | Compare view |
| 17 | `xray_requests` table, `POST /xray-requests`, an admin queue and votes later | Request X-Ray and the stream queue |
| 18 | Social card endpoint, generated on publish and cached | X and YouTube link previews |
| 19 | `GET /search` across products, patterns and step titles | Command palette |
| 20 | Change feed per product, plus "changed since you saved" on `/me/saves` | The return-visit loop |
| 21 | Admin endpoints for a review queue that lists drafts with their evidence and captures | `/admin/review` |
| 22 | Turn on daily collection when upfront research is done | "Updated 2h ago" and growing ad history |

### Existing endpoints that are already usable

`/radar`, `/vault/:slug`, `/blueprints/:id/export`, `/me`, `/me/saves`, `/me/collections`, `/auth/:provider/start`, `/auth/:provider/callback`, `/auth/logout`, and `/billing`.

## 18. Decisions still open

- Which new Vercel font was meant. The spec assumes Geist Serif.
- Whether to use shadcn/ui as recommended in section 12.
- Accent colour. Teal is the default, and it's a one-line change.
- Daily limit: start at 5, then test.
- Insider launch timing and price. The spec keeps a slot for it either way.
