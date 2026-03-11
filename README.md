# WorkRoom
WorkRoom is a Manifest V3 Chrome extension for focus sessions. A user enters a goal and timer in the popup, the background monitors tabs during the session, and the content script blocks distracting pages with an in-page overlay.

## Overview
- Session state is stored locally in `chrome.storage.local`.
- Session completion is driven by a Chrome alarm.
- Classification is local-only and runs through TensorFlow.js + Universal Sentence Encoder in an offscreen document.
- The background service worker remains the policy and enforcement layer.
- When ML cannot produce a result, the background falls back to heuristics in `classifier.ts`.
- Already-open tabs can now be blocked even after extension reload or late activation because the background can reinject the content script and retry delivery when a tab has no receiver.

## Current Stack
- TypeScript
- Vite
- Chrome Extension Manifest V3
- Background service worker
- Vanilla popup and content UI
- TensorFlow.js `3.21.0`
- Universal Sentence Encoder `1.3.3`
- TF.js WebGL backend with CPU fallback
- Chrome `offscreen` and `scripting` APIs

## Current Architecture
| Piece | Location | Responsibility |
| --- | --- | --- |
| Manifest | `apps/extension/manifest.json` | Declares permissions, host access, content script injection, background worker, popup, and extension-page CSP for the offscreen ML runtime. |
| Popup | `apps/extension/src/popup/*` | Starts and stops sessions, persists session state, and sends `START_SESSION` / `STOP_SESSION`. |
| Background | `apps/extension/src/background/index.ts` | Main orchestrator for alarms, tab updates, tab activation, runtime messages, and debug-log retrieval. |
| Security layer | `apps/extension/src/background/security.ts` | Applies classification results to badges, blocks off-task tabs, and reinjects content scripts into already-open tabs when message delivery has no receiver. |
| Classifier | `apps/extension/src/lib/classifier.ts` | Top-level decision layer. Calls offscreen ML, logs fallback, and owns heuristic fallback policy. |
| Offscreen bridge | `apps/extension/src/lib/offscreen-client.ts` | Creates/reuses the offscreen document and sends ML requests from background to offscreen. |
| Offscreen runtime | `apps/extension/src/offscreen/*` | Offscreen document entrypoint that owns backend selection, TF.js/USE inference, and ML debug events. |
| Model manager | `apps/extension/src/lib/model-manager.ts` | Offscreen-only TF.js setup, WebGL-first backend selection with CPU fallback, USE model loading, embedding cache, and ML scoring. |
| Content script | `apps/extension/src/content/*` | Shows the block overlay and session-complete toast inside the page. |
| Debug log | `apps/extension/src/background/debug-log.ts` | Stores a bounded ring buffer of debug events in `chrome.storage.session`. |

## ML Flow
1. The background sees a relevant tab event.
2. `classifier.ts` requests ML classification through `offscreen-client.ts`.
3. The offscreen document selects a backend, preferring `webgl` and falling back to `cpu` if needed.
4. The offscreen document loads or reuses TF.js + USE and returns either:
   - a `ready` result with `classification` and numeric `score`, or
   - a `fallback` result with `error` and `score: null`
5. The background applies badge and blocking behavior.
6. If the tab is off-task and has no live content-script receiver, the background injects the content CSS/JS into that tab and retries `BLOCK_PAGE` once.
7. If offscreen returns `fallback`, the background runs heuristic fallback from `classifier.ts`.

## Runtime Notes
- ML does not run in the service worker.
- The offscreen document exists because TF.js/USE requires a DOM-capable extension page.
- The extension enables WASM for extension pages via:
  - `"content_security_policy": { "extension_pages": "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'" }`
- Classification is privacy-preserving: no browsing data is sent to a remote service.
- The extension requests `host_permissions: ["<all_urls>"]` and `scripting` permission so it can classify pages by URL/title and recover page blocking for already-open tabs when no content-script receiver is available.
- Programmatic reinjection is only attempted for script-injectable URLs such as `http:`, `https:`, and `file:`. Restricted browser pages like `chrome://` remain non-blockable.

## Debugging and Observability
- Background logs use `[WorkRoom:bg]`.
- Offscreen logs use `[WorkRoom:offscreen]`.
- `GET_DEBUG_LOGS` returns recent debug entries from `chrome.storage.session`.
- `classification-complete` logs include `modelState`, backend, and when available also `classification` or `error`.
- `model-loading` / `model-ready` events reflect the actual backend attempt and the selected backend.
- When WebGL fails and CPU is selected, offscreen debug metadata includes downgrade context.
- Background delivery logs distinguish normal block delivery from:
  - `block-message-recovered` after reinjecting the content script, and
  - `block-message-skipped` / `block-message-failed` when delivery cannot be recovered.
- `score: null` should be read as a fallback-shaped ML response, not a successful scored classification.

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
  - vendored or downloaded USE model assets

## Current Behavior
- Starting a session triggers an immediate sweep across all open tabs.
- `on-task` tabs get a green badge.
- `off-task` tabs get a red badge and a `BLOCK_PAGE` message to the content script.
- If an already-open off-task tab has no content-script receiver, the background injects the content script and CSS into that tab and retries the block once.
- `ambiguous` tabs clear the badge.
- The content script shows a full-page overlay for blocked pages and a toast when the session ends.
- Heuristic fallback still exists and is intentionally simple: domain allow/block lists plus title keyword matching against the user goal.

## Known Limitations
- Some browser-owned or restricted pages cannot be script-injected, so they can be classified and badged but not overlaid.
- SPA-heavy sites can still produce timing edge cases around navigation and message delivery, though the background now retries by reinjecting the content script when possible.
- Heuristic fallback is intentionally simple and title/domain based.
- The extension has unit coverage for core classifier and security flows, but it does not yet have browser-level end-to-end coverage.
- The README may lag behind active development; the codebase is the source of truth.

## Important Files
- `apps/extension/src/lib/classifier.ts`
- `apps/extension/src/lib/model-manager.ts`
- `apps/extension/src/lib/offscreen-client.ts`
- `apps/extension/src/background/index.ts`
- `apps/extension/src/background/security.ts`
- `apps/extension/src/offscreen/offscreen.ts`

## Project Status
The extension is beyond the original heuristic-only prototype. It now has:
- an offscreen ML pipeline using USE with WebGL-first backend selection and CPU fallback,
- background-owned heuristic fallback policy,
- reinjection-based recovery for blocking already-open off-task tabs,
- bounded debug-log storage for background and offscreen events, and
- unit coverage for the main classifier, backend-selection, and security/blocking flows.

There is still a lot I have to do. The extension is still a bit slow, and the main remaining work before broad public release is product hardening rather than core capability: privacy/disclosure materials, broader manual QA across sites, and end-to-end validation of real browser flows.
