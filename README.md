# WorkRoom
WorkRoom is a Manifest V3 Chrome extension for focus sessions. A user enters a goal and timer in the popup, the background monitors tabs during the session, and the content script blocks distracting pages with an in-page overlay.

## Overview
- Session state is stored locally in `chrome.storage.local`.
- Session completion is driven by a Chrome alarm.
- Classification is local-only and runs through TensorFlow.js + Universal Sentence Encoder in an offscreen document.
- The background service worker remains the policy and enforcement layer.
- When ML cannot produce a result, the background falls back to heuristics in `classifier.ts`.

## Current Stack
- TypeScript
- Vite
- Chrome Extension Manifest V3
- Background service worker
- Vanilla popup and content UI
- TensorFlow.js `3.21.0`
- Universal Sentence Encoder `1.3.3`
- TF.js WASM backend

## Current Architecture
| Piece | Location | Responsibility |
| --- | --- | --- |
| Manifest | `apps/extension/manifest.json` | Declares permissions, content script injection, background worker, popup, and the extension-page CSP needed for WASM. |
| Popup | `apps/extension/src/popup/*` | Starts and stops sessions, persists session state, and sends `START_SESSION` / `STOP_SESSION`. |
| Background | `apps/extension/src/background/index.ts` | Main orchestrator for alarms, tab updates, tab activation, runtime messages, and debug-log retrieval. |
| Security layer | `apps/extension/src/background/security.ts` | Applies classification results to badges and page blocking. |
| Classifier | `apps/extension/src/lib/classifier.ts` | Top-level decision layer. Calls offscreen ML, logs fallback, and owns heuristic fallback policy. |
| Offscreen bridge | `apps/extension/src/lib/offscreen-client.ts` | Creates/reuses the offscreen document and sends ML requests from background to offscreen. |
| Offscreen runtime | `apps/extension/src/offscreen/*` | Offscreen document entrypoint that owns TF.js/USE inference and emits ML debug events. |
| Model manager | `apps/extension/src/lib/model-manager.ts` | Offscreen-only TF.js setup, WASM path configuration, USE model loading, embedding cache, and ML scoring. |
| Content script | `apps/extension/src/content/*` | Shows the block overlay and session-complete toast inside the page. |
| Debug log | `apps/extension/src/background/debug-log.ts` | Stores a bounded ring buffer of debug events in `chrome.storage.session`. |

## ML Flow
1. The background sees a relevant tab event.
2. `classifier.ts` requests ML classification through `offscreen-client.ts`.
3. The offscreen document loads or reuses TF.js + USE and returns either:
   - a `ready` result with `classification` and numeric `score`, or
   - a `fallback` result with `error` and `score: null`
4. The background applies badge and blocking behavior.
5. If offscreen returns `fallback`, the background runs heuristic fallback from `classifier.ts`.

## Runtime Notes
- ML does not run in the service worker.
- The offscreen document exists because TF.js/USE requires a DOM-capable extension page.
- The extension enables WASM for extension pages via:
  - `"content_security_policy": { "extension_pages": "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'" }`
- The WASM backend is forced into a single-threaded path to avoid blob-worker failures in the extension runtime.
- Classification is privacy-preserving: no browsing data is sent to a remote service.

## Debugging and Observability
- Background logs use `[WorkRoom:bg]`.
- Offscreen logs use `[WorkRoom:offscreen]`.
- `GET_DEBUG_LOGS` returns recent debug entries from `chrome.storage.session`.
- `classification-complete` logs now include `modelState`, and when available also `classification` or `error`.
- `score: null` should now be read as a fallback-shaped ML response, not a successful scored classification.

## Development Workflow
1. Install dependencies:
   - `npm install`
2. Start extension development build:
   - `npm run dev:extension`
3. Load the unpacked extension from:
   - `apps/extension/dist`
4. Build production assets:
   - `npm run build:extension`
5. Run tests:
   - `npm test`

## Build Notes
- Dist artifacts are generated into `apps/extension/dist`.
- The build script copies:
  - `apps/extension/manifest.json`
  - `apps/extension/workicon.png`
  - TF.js WASM binaries
  - vendored or downloaded USE model assets

## Current Behavior
- `on-task` tabs get a green badge.
- `off-task` tabs get a red badge and a `BLOCK_PAGE` message to the content script.
- `ambiguous` tabs clear the badge.
- The content script shows a full-page overlay for blocked pages and a toast when the session ends.

## Known Limitations
- Some page-block messages can race content-script readiness on SPA-heavy sites like YouTube, producing:
  - `Could not establish connection. Receiving end does not exist.`
  This is currently treated as a non-fatal delivery race, separate from ML classification.
- Heuristic fallback is intentionally simple and title/domain based.
- The README may lag behind active development; the codebase is the source of truth.

## Important Files
- `apps/extension/src/lib/classifier.ts`
- `apps/extension/src/lib/model-manager.ts`
- `apps/extension/src/lib/offscreen-client.ts`
- `apps/extension/src/background/index.ts`
- `apps/extension/src/background/security.ts`
- `apps/extension/src/offscreen/offscreen.ts`

## Project Status
The extension is no longer heuristic-only. It now has an offscreen ML pipeline with background-owned fallback policy and improved debugging around ML failures. The next debugging step, when ML still falls back, is to inspect the logged `error` on the fallback response rather than treating `score: null` alone as the root cause.
