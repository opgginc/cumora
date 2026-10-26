# Next redesign (`src/next/`): rules for changing it

This folder is a fork-only UI. `README.md` here says what it is and how to run it; this file says how to change it without breaking the classic UI, the upstream merge, or the feel.

## Smoothness comes first

The redesign exists to feel like a native app. Every animation must run at the display's full frame rate with no dropped frames, on the Fold phones and in the desktop app alike. A change that makes motion stutter is a regression even when it is otherwise correct, so treat jank like a failing test.

- Animate only `transform`, `opacity`, `clip-path` and `filter`. Never animate `width`, `height`, `top`, `left`, `margin` or `padding` from JavaScript.
- Never read layout (`getBoundingClientRect`, `offsetHeight`, `scrollHeight`) inside an animation frame or a render. Measure once with `ResizeObserver` and keep the number.
- The one accepted exception to compositor-only motion is collapsing a chat-list group: it uses the CSS grid `grid-template-rows: 1fr → 0fr` transition, so no JavaScript measures anything, but every frame runs a layout pass over the rooms below the group. That cost is acceptable only because the chat list is short. Do not use this transition on a long list, and do not drive height with framer-motion's `height: 'auto'`. Anything else that expands draws its content at once and fades it in with `nx-rise`.
- The other accepted exception is the bloub avatar (`bloub/`), which rewrites SVG path attributes every frame because that is the animation. Keep its cost bounded: one requestAnimationFrame loop for every avatar (`bloub/director.ts`), one engine per agent shared by all of that agent's avatars, nothing drawn for a view off screen, and React never re-rendering per frame (the director writes attributes into an svg React rendered once).
- Lists that can grow past a screen use `react-virtuoso`, with memoized rows that select their own slice of a store. A new message, a streaming reply or a reaction must re-render one row, not the list. The chat list (`chat/Sidebar.tsx`) is the explicit exception: it renders every room as plain DOM, without virtualization. Its rows are memoized, and a store update that does not change the list (such as an unchanged layout reload) must not re-render them.
- Use the motion tokens (`--duration-quick/fast/medium/slow`, `--ease-smooth-out`) and the framer presets in `ui/primitives.tsx` (`T_QUICK`, `T_FAST`, `SPRING_SHEET`). Entrances play once per item per session, never again on remount.
- Never use `transition: all`, and never animate while data is loading in a way that blocks the main thread.
- Drag feedback never moves the rows under the pointer: drop lines are pseudo-elements outside the flow, and a drop zone that appears when a drag starts either fills space that was already free or floats on a sticky zero-height anchor. Drag state lands on the frame after `dragstart`, once the browser has taken the drag image.
- Check it before you hand it over: scroll a long room, open and close the keyboard, collapse a group, drag a room, and watch a performance trace (no long tasks, frames at 16.7 ms or better). On a phone, check the real device (the Fold 7), not only a desktop browser.

## Every layout and action, on three screens

Design and check every layout and every action for all three screens the app runs on, not only the one you are looking at:

- **Phone:** the Fold 8 cover screen (about 555 × 876 CSS px, touch). Stack layout, tab bar, bottom sheets, the keyboard.
- **Fold 8 unfolded:** the inner screen, a near-square touch screen that lands in the split layout with a coarse pointer. Touch rules apply even though the layout is the tablet one: no hover-only or drag-only action, 44px targets.
- **PC:** the desktop app and the web with a mouse and keyboard. Full layout, hover, right-click, drag, shortcuts.

An action that exists on one screen needs a way to do it on the others (a mouse drag needs a long-press menu entry on touch, a hover reveal needs a tap path). On the Fold 7 the cover screen stands in for the Fold 8 cover with `wm size 1248x1972` + `wm density 360`, and the main screen stands in for the unfolded one.

## Haptics

The phone app vibrates only where it tells the user something: a click for a tap on a room in the chat list, a section in the tab bar or rail, or a reaction; a deeper click when a press turns into a hold; a tick when a message swiped left reaches the point where letting go replies; one click when a message leaves; and a double click when someone else's message arrives in the room on screen. Use `haptic(kind)` from `haptics.ts`, never `@capacitor/haptics` or the classic helpers in `lib/native.ts`. On Android it plays the system's own effects through `NxHapticsPlugin` (`android/app/src/main/java/io/cumora/app/`), which follow the user's touch-feedback setting; `@capacitor/haptics` would play fixed vibration waveforms that feel like a buzz. On the web and in the desktop app it does nothing.

| Kind | When | Android |
| --- | --- | --- |
| `press` | A tap on an element marked `data-haptic`: when the finger lands, or inside a scroller when the tap's click arrives. Only the touch layer fires it. | `GESTURE_START` |
| `hold` | A press turned into a hold: a long-press menu, a drag lift. | `LONG_PRESS` |
| `threshold` | A swipe reached the point where letting go acts: a message swiped left far enough to reply. | `GESTURE_THRESHOLD_ACTIVATE` (API 34+) |
| `sent` | A message leaves: the composer sends it, or a failed one is retried. | `CONFIRM` |
| `received` | Someone else's message arrives in the room on screen. | `EFFECT_DOUBLE_CLICK` (API 33+) |
| `success` / `error` | An action the user waited on (its button shows busy) finished or failed; `error` also for a failed copy. | `CONFIRM` / `REJECT` |

- Touch haptics are opt-in. The touch layer (`bindPressHaptics`, bound once in `NextApp`) plays one `press` per tap on an element marked `data-haptic`. Only rooms in the chat list (rows and pinned tiles), the sections of the tab bar and rail, and reaction chips carry it, because the screen answers those late (a room or section loads) or barely (a count changes). Do not mark more places unless the owner asks: a click on every button was too much.
- Nothing vibrates when a finger lands inside a scroller, however long it rests there, because the finger may be starting a scroll. A `press` there plays when the tap's click arrives; moving more than 8 px, a `pointercancel` or a `hold` ends the touch silently, and so does a lift without a click (a tap that stopped a fling). Outside a scroller the press plays when the finger lands. A scroller is an ancestor with `overflow: auto` or `scroll` whose content overflows it, so the chat list and the transcript count, and the rail only once its sections overflow.
- Nothing vibrates while a finger rests on a press: a vibration that runs on feels like a buzz, not a button, so a hold plays only its one `hold`.
- `received` is the only haptic without a touch. `useReceivedHaptic` in `chat/ChatView.tsx` plays it on the live `message.new` event for a message someone else wrote (text, attachment, email or poll; not agent work rows or system lines) in an unmuted room on screen while the app is visible, at most once every 2 seconds. Opening a room and the catch-up after a reconnect play nothing.
- No haptic for anything else: scrolling, typing, hover, opening or closing a sheet, store updates, timers, or a copy that worked (its button shows a check). A background failure the user did not just cause stays silent.
- Fire `hold`, `threshold`, `sent`, `success` and `error` at the interaction, in the same handler as the visual change, not inside a shared action, a store or an effect. `useHold` fires `hold`, and the message swipe (`useSwipeReply` in `chat/MessageList.tsx`) fires `threshold`.

## Isolation

- Everything lives in `src/next/`. Classic files are touched only at their seams: `App.tsx` (mount branch, design choice and sign-in fallback), `components/Message.tsx` (exported artifact cards, and `data-agent-id` on an agent's @mention chip), `components/AuthScreen.tsx` (exported `useSignIn` and parts), `stores/messages.ts` (keeps `createdAt`), `stores/conversations.ts` and `lib/conversationRow.ts` (a Calendar firing does not touch the chat-list row; the preview's own-author prefix goes through `t('common.you')`, and a language switch reloads the rows), `electron/main.cjs` (serves `index.html` for client-side routes), `components/AuthGate.tsx` (gives the session probe a deadline and retries network trouble, so a phone on a bad network neither hangs on "loading…" nor gets signed out), `android/.../MainActivity.java` (registers `NxHapticsPlugin`), `components/AgentEditor.tsx` (takes the Look Studio as its avatar fields and saves it with the profile), `lib/i18n.ts` (registers the Korean locale) with `locales/ko.ts` (Korean only for the classic strings the redesign shows through classic components; every other classic key falls back to English). Every other classic file is read, never restyled. Each new seam is a future merge conflict with upstream, so add one only when there is no way around it.
- CSS: tokens are scoped to `html.nx`, and every class starts with `nx-` (`nx-<section>-*` inside a section), so nothing leaks into the classic UI. No global selectors (`body`, `:root`, bare elements) outside `html.nx`.
- Classic components reused inside the redesign pick up the new palette through the legacy token remap at the end of `styles/tokens.css`.
- Strings: `useNT()` from `i18n.ts`. Core keys are in `locales/en.ts`, `locales/zh-CN.ts` and `locales/ko.ts`, section keys in `sections/<name>/strings.ts` (prefixed `<name>.`). English is the source of truth. Korean is typed complete (`Record`, where zh-CN is `Partial`), so a new English key needs its Korean in the same change. Delete a key in every locale when the last use goes.
- zustand v5 compares selector results by identity: a selector that builds an object or array needs `useShallow`, or the component re-renders forever.

## Fork-only data: SQLite, not Postgres

Data that only this fork needs lives in the fork's SQLite store (`server/src/fork/store.ts`, file `server/data/fork.sqlite`, the `forkdata` volume in the deploy repo), behind `/api/fork` (`server/src/fork/router.ts`). Never add a table or migration to upstream's Postgres for a fork feature. Add a migration step to `MIGRATIONS` in `store.ts` (it versions the schema with `PRAGMA user_version`), scope rows by `(company_id, user_id)` or `company_id`, and extend `server/src/__tests__/fork-store.test.ts`.

Fork routes may read upstream Postgres but never write it. Import `../db/pool.js` inside the handler: it loads `env.ts`, which exits without `OPENAI_API_KEY`, so a top-level import kills `node --test`. A room-scoped route checks `conversation_members` itself and answers 404, like a missing room, because the fork router only receives `requireCompany`. Text an agent wrote (its memory, a run summary, a command line) can quote any room, so show it only when every room it could come from is the viewer's, or only to owners and admins. The Handbook (`server/src/fork/handbook.ts`) does the latter, and shows a person's message only to members of its room. Run such text through `server/src/fork/redact.ts` before it leaves the server. When fork code must put something into upstream's data, it calls an upstream function that writes it: a trigger firing (`server/src/fork/triggers.ts`) posts its message through the calendar's `postDispatchMessage`, never with SQL of its own.

The chat list's layout is the first user of it: `chat/roomLayout.ts` keeps custom categories (their order and whether they are hidden), which category each room is in, collapsed groups, and the order of the pinned tiles. Pinning itself is upstream's `conversations.pinned`, shared by every member, so only the order is personal. Renames, deletes, moves, hides, collapses and tile moves update locally first and reload the server's copy when a write fails. Creating a category waits for the server, because the server assigns the id; its dialog stays open and busy until the answer arrives and shows an error on failure. Writes reach the server one at a time in the order they were made, and the store is cleared when the user or workspace changes.

## Design system

- Tokens (`styles/tokens.css`): `--background --card --popover --foreground --muted-foreground --primary --accent --muted --border --input --selected --live --warn --destructive`, light and dark (`html.dark`, driven by the existing appearance store).
- Type scale only: `--text-kpi` 24, `--text-title` 14, `--text-body` 13, `--text-caption` 12, `--text-micro` 11. Message text uses 14. The one exception is 16px for editable text on touch (iOS zooms anything smaller).
- Spacing steps 4/8/12/16; no padding above 16px. Same padding on all sides for boxes; asymmetric only on buttons and chips.
- One elevation: `var(--shadow-card)` (none in dark), floating layers `var(--shadow-float)`.
- Numbers, ids and times use `.nx-mono`.
- What agents are doing takes the same space for one agent or twenty: agents at work sit on the composer bar (`chat/WorkingHeads.tsx`), out of the flow, so they never add rows to the transcript or change the composer's height (the transcript pads by it, so a taller composer moves every message).
- Never: left accent borders, KPI/stat tiles, eyebrow labels, hero + 3-column feature grids, decorative gradients.
- Touch (`@media (pointer: coarse)`): 44px targets, menus become bottom sheets, and anything a mouse does by hover or drag must also be reachable by long-press (rooms move between categories from the long-press menu).
- Hover styles go inside `@media (hover: hover)`, or they stick after a tap.
- Icons from the shared set have no intrinsic size; size every `svg` you place (buttons get 16px from `.nx-btn svg`).

## Native shells

- Android's WebView shrinks the layout viewport when the keyboard opens; iOS (Capacitor `Keyboard.resize: 'none'`) does not. Lift bottom-anchored UI by `var(--nx-kb)`, which is the keyboard height on iOS only. Never add `--kb-height` directly.
- The bottom safe area can be 0 on Android with gesture navigation; do not rely on it for spacing.
- Phone chrome keys off `useCoarse()`, not width.

## Building blocks

- `router.ts`: the URL is the state. `href({ section, id, panel, peek, params })`, `withRoute`, `navigate(to, { replace })`, `goBack(fallback)`, `linkClick`, `useRoute()`. `projectRoute` mirrors the route into `useApp` for classic code; `bindLegacyWrites` turns classic `useApp` writes into navigations.
- `layout.ts`: `stack` (< 720px, pushed screens), `split` (< 1180px), `full`.
- A pushed screen (`useSwipeBack` from the classic `mobile/`) follows any sideways swipe that starts on it, through native touch listeners on its layer. A gesture inside one that takes sideways swipes, like the message swipe in `chat/MessageList.tsx`, listens natively on its own element, picks its direction at the same 8 px, and stops the propagation of the moves it takes. React runs its handlers at the root, too late to keep the swipe-back from moving the screen.
- `bloub/engine/` is jeremy-prt/bloub's `src/bot/` (MIT, its LICENSE beside it), copied as is so a newer version can be copied over it. The only local change is the line marked `cumora:` in `face.ts`; carry it over on an update. Its numbers are measurements of a reference video, not settings: never round or tidy them. Everything cumora-specific (status mapping, drawing, storage) lives outside `engine/`. Accessories (`bloub/accessories.ts`) read the engine's private `pts`, the outline of its last sample; after an update, `tests/bloub-accessories.test.ts` fails if the engine renames it or stops keeping it.
- `agentMenu.tsx`: the agent menu. Anything new that names an agent (an avatar, a name, a chip) gets it by carrying `data-agent-id` (`agentRef(p)` from `agentRefs.ts`): one listener on the app's root opens the menu on a click, a right-click, Enter or Space and the context-menu key, before React's handlers run, and `useHold` starts no hold for a touch that lands on such an element, except on iOS, which turns no long press into a contextmenu (there the row keeps its own hold menu). An element whose click opens something else (a list row) opens it with `useHold` and `openAgentMenu` instead. Its panes open with `openAgentPane`, never with a route of their own.
- `ui/primitives.tsx`: `IconButton`, `Segmented`, `Switch`, `Menu` + `useMenu` (a one-character `shortcut` picks its item while the menu is open; `detail` puts quiet text at the end of a row), `Dialog`, `Kbd`, `Spinner`, `Portal`. `ui/Avatar.tsx`, `ui/icons.tsx`, `hooks.ts` (`useNow`, `useHold`, `useOpenDirect`, `useAdmin` for the owner and admin gate, `openPalette`), `format.ts` (dates in the viewer's timezone).
- framer-motion 11 (fixed in 12.4.7) never releases a `layout`, `layoutId` or `drag` element that unmounts inside an `AnimatePresence` child, and that presence then never finishes its exit: a dialog, sheet or pushed screen closes but leaves its invisible layer over the page, taking every click. An element like that which mounts and unmounts while its screen stays (a selection pill) goes inside `<PresenceContext.Provider value={null}>`, as the pill in `Segmented` does.
- Sections: `sections/index.ts` maps each section to a lazy `sections/<name>/index.tsx` that receives `SectionProps`. A section owns its folder (components, `<name>.css`, `strings.ts`). A section not rebuilt yet renders its classic screen through `ClassicFrame`.
- Loading: skeletons only for a first load; spinners scoped to the region or control that waits (`aria-busy`).

## Before you hand a change over

1. `npx tsc --noEmit -p .` and `npx biome lint src/next` pass.
2. The change works on the phone, on the Fold 8 unfolded and on PC (see the three screens above), in light and dark.
3. The smoothness checks above pass on the device the change affects.
4. The Android APK (`scripts/android.sh` in the deploy repo) is rebuilt when the change is meant for the phone.
