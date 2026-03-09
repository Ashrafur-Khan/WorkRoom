# WorkRoom
Focus sessions that keep you on-task by coupling a lightweight goal/timer workflow with aggressive page blocking. WorkRoom began as a “distraction killer” prototype; this README explains how it works today and how to extend it—no React knowledge required.

## Overview
- **Problem**: A user sets a goal, starts a timer, then drifts to social media before time is up.
- **Solution**: WorkRoom stores the session (goal + duration) locally, drives a Chrome alarm, and actively inspects every open tab. When it detects a distraction it overlays a nudge and flashes a warning badge, while productive sites stay green.
- **Tech stack**: Manifest V3 Chrome extension built with TypeScript and Vite. The popup UI is plain DOM manipulation; background/content scripts run on Chrome APIs only.

## Current Capabilities
- Start/stop a session from the popup: enter a goal and minutes, hit **Start session**, and watch a live countdown.
- Persistent state: session data lives in `chrome.storage.local`, so reopening the popup picks up where you left off.
- Alarm + notifications: a Chrome alarm fires when the timer completes, clears the badge, resets the session, and surfaces a “session complete” notification.
- Heuristic classification: `src/lib/classifier.ts` mixes static block/allow lists with goal-keyword matching to label a tab as `on-task`, `off-task`, or `ambiguous`.
- On-page enforcement: off-task tabs receive a red badge plus a full-page overlay with a “Let’s get back to work!” button.

## Architecture & Flow
| Piece | Location | Responsibility |
| --- | --- | --- |
| Manifest | `apps/extension/manifest.json` | Declares permissions (`storage`, `tabs`, `notifications`, `alarms`), references the background service worker and popup, and injects the content script on `<all_urls>`. |
| Popup UI | `src/popup/popup.html/.ts/.css` | Vanilla DOM inputs for goal/duration. Manages state locally, persists via `chrome.storage.local`, and creates/clears alarms. Sends a `START_SESSION` message so the background script sweeps every tab immediately. |
| Background worker | `src/background/index.ts` | Listens for alarms, tab updates, and activation events. It fetches session state, uses `classifyUrl`, updates badges, and asks content tabs to block themselves when needed. |
| Classifier | `src/lib/classifier.ts` | Currently a purely deterministic heuristic: user-configurable allow/block arrays (currently empty placeholders), well-known distraction/productive domains, and fuzzy goal-keyword matching against the tab title. |
| Session helpers | `src/lib/session-utilities.ts`, `src/types.ts` | Define the `SessionState` union and helpers (`getSessionStatus`, `createIdleState`), ensuring consistent shape when the session ends. |
| Content script | `src/content/*` | Reacts to `SESSION_COMPLETE` and `BLOCK_PAGE` messages. Renders toast notifications and a modal overlay, and temporarily disables scrolling on blocked pages. |
| Build tooling | `apps/extension/vite.config.ts` + root `package.json` | Vite bundles background/popup/content scripts; `npm run build:extension` copies `manifest.json` and `workicon.png` into `dist/` for unpacked installs. |

## Development Workflow
1. **Install deps**: `npm install`.
2. **Run locally**: `npm run dev:extension` starts Vite in watch mode and outputs assets to `apps/extension/dist`.
3. **Load in Chrome**: `chrome://extensions` → enable Developer Mode → **Load unpacked** → select `apps/extension/dist`.
4. **Build for release**: `npm run build:extension` bundles production assets and copies manifest/icon into `dist`.

## How It Works (Step-by-Step)
1. **Open the popup** and type a clear goal (e.g., “Study Econ Chapter 5”) plus a duration in minutes.
2. **Input validation** enables the Start button only when both fields are filled with positive data.
3. **Start session**:
   - The popup stores `{ isRunning: true, goal, durationMinutes, startTime }` in `chrome.storage.local`.
   - It schedules a Chrome alarm (`WORKROOM_TIMER`) for `durationMinutes`.
   - It sends `START_SESSION` to the background worker so all open tabs are classified immediately.
4. **Background monitoring**:
   - Every time a tab finishes loading or becomes active, `runSecurityCheck` loads the session state.
   - `classifyUrl(url, title, goal)` labels the tab. `off-task` tabs get a red “BAD” badge and a `BLOCK_PAGE` message; `on-task` tabs get a green “GOOD” badge; everything else clears the badge.
5. **Content enforcement**:
   - When a tab receives `BLOCK_PAGE`, it injects a full-screen overlay reminding the user of their goal and provides a “go back” action (currently `history.back()`).
   - If the alarm fires, the background script resets the session, removes badges, shows a browser notification, and emits `SESSION_COMPLETE` so the content script displays a celebratory toast.
6. **Stopping early**: The popup’s Stop button clears the alarm and saves `{ isRunning: false }`, which removes badges and allows navigation everywhere.

## Classification Limits & Future ML Path
- The block/allow lists are hard-coded arrays; they are empty now and not user-configurable.
- Domain checks only look at hostname substrings, so `news.youtube.com` is treated like `youtube.com`.
- Keyword matching is simplistic: words shorter than four letters are ignored, casing is lowered, and a single match in the title counts as “on-task,” even if the content is a distraction.
- **Client-side ML vision**: keep the classifier in `src/lib/classifier.ts`, but replace heuristic steps 2–4 with a lightweight model (e.g., TensorFlow.js or ONNX runtime) that scores a vector of features (domain embeddings, page text snippets, current goal). Run inference in the background worker, cache results per domain, and expose a fallback path when the model cannot load (stay with heuristics). Document privacy: all classification happens locally; no browsing data leaves the device.

## Roadmap & Future Work
- Configurable lists and profiles stored in sync storage so users can tailor block/allow behavior.
- Rich goal context (categories, tags) so the classifier can understand “study vs. design vs. deep work.”
- Client-side ML pipeline: embed-friendly model, local feature extraction (title + meta description + limited body text), and learning mode where the user can mark misclassified pages to retrain offline.
- Enhanced UX: allow “snooze for 2 minutes,” more accessible overlay (focus trapping, keyboard controls), and optional “focus stats” history once persistence is added.
- Telemetry/testing: add automated tests for session logic and classification, plus optional logging to aid debugging (still stored locally to honor privacy).

## Contact & Contributing
- Issues and feature requests: open a ticket in the GitHub repo.
- Pull requests welcome—run the dev build, describe manual testing, and note how your change affects the popup/background/content flow.
