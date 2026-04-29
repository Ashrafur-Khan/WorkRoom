# WorkRoom
WorkRoom is a Manifest V3 Chrome extension for timed focus sessions. A user starts a session from the popup, the background classifies active tabs, and the content script blocks off-task pages with an in-page overlay that supports session-scoped allow and snooze actions.

## Stack
- TypeScript
- Vite
- Chrome Extension Manifest V3
- `@huggingface/transformers`
- ONNX Runtime Web in an offscreen document

## Architecture
| Piece | Location | Responsibility |
| --- | --- | --- |
| Manifest | `apps/extension/manifest.json` | Declares permissions, popup, background worker, content script, and extension-page CSP. |
| Popup | `apps/extension/src/popup/*` | Starts and stops sessions and persists normalized session state. |
| Background | `apps/extension/src/background/index.ts` | Orchestrates alarms, tab events, runtime messages, session lifecycle, and debug-log retrieval. |
| Security | `apps/extension/src/background/security.ts` | Applies classification results, handles second-pass page-signal extraction, honors session overrides, and recovers missing content-script receivers. |
| Classifier | `apps/extension/src/lib/classifier.ts` | Interprets ML responses and provides heuristic fallback when ML cannot return a usable result. |
| Offscreen bridge | `apps/extension/src/lib/offscreen-client.ts` | Serializes offscreen lifecycle, sends ML requests, and validates ML responses. |
| Offscreen runtime | `apps/extension/src/offscreen/*` | Owns model lifetime and ONNX Runtime inference. |
| Model manager | `apps/extension/src/lib/model-manager.ts` | Loads the packaged model, checks runtime assets, caches embeddings, and computes cosine-similarity scores. |
| Page signals | `apps/extension/src/lib/page-signals.ts` | Extracts bounded DOM-derived signals. |
| Page context | `apps/extension/src/lib/page-context.ts` | Builds normalized page context strings and debug-safe signal snapshots. |
| Debug log | `apps/extension/src/background/debug-log.ts` | Stores a bounded ring buffer of validated debug entries in `chrome.storage.session`. |

## Session Model
- Session state lives in `chrome.storage.local`.
- A running session stores:
  - `goal`
  - `durationMinutes`
  - `startTime`
  - `allowedDomains`
  - `snoozedDomains`
- Session overrides are temporary and reset when the session ends.
- Session state is normalized on read before the extension uses it.

## Classification Flow
1. The background receives a tab update, tab activation, or session sweep event.
2. `classifier.ts` requests ML classification through `offscreen-client.ts`.
3. The offscreen runtime loads or reuses the MiniLM pipeline and returns either:
   - a `ready` result with `classification` and `score`
   - a `fallback` result with `error` and `score: null`
4. If the Stage 1 ML result is borderline, the background requests bounded page signals from the content script and reruns ML with richer page context.
5. If page-signal extraction fails, times out, is sparse, or the page is restricted, the background keeps the Stage 1 decision.
6. Before applying the result, the background checks that the tab has not navigated.
7. The security layer updates the badge and blocks off-task pages when possible.

## Runtime Invariants
- ML does not run in the service worker.
- The offscreen document is the only place that owns model and embedding caches.
- Heuristic fallback remains active when the offscreen runtime cannot produce a usable ML result.
- Restricted pages such as `chrome://` may be classified and badged, but blocking is skipped.
- Already-open pages can be recovered by reinjecting the content script when message delivery has no receiver.
- Page-signal extraction is bounded, sanitized, and not persisted beyond session-scoped debug snapshots.

## Debugging
- Background logs use `[WorkRoom:bg]`.
- Offscreen logs use `[WorkRoom:offscreen]`.
- `GET_DEBUG_LOGS` returns recent validated debug entries from `chrome.storage.session`.
- Important log families include:
  - `classification-complete`
  - `classification-fallback`
  - `signal-extraction-started`
  - `signal-extraction-complete`
  - `signal-extraction-fallback`
  - `signal-extraction-timeout`
  - `classification-skipped`
  - `block-message-recovered`
  - `block-message-skipped`
  - `block-message-failed`
  - `offscreen-created`
  - `offscreen-reused`
  - `offscreen-close-skipped`
  - `offscreen-close-message-failed`
  - `offscreen-request-failed`
  - `offscreen-response-invalid`

## Development
1. Install dependencies:
   - `npm install`
2. Start the extension build:
   - `npm run dev:extension`
3. Load the unpacked extension from:
   - `apps/extension/dist`
4. Run tests:
   - `npm test`
5. Run a strict typecheck:
   - `npx tsc --noEmit -p apps/extension/tsconfig.json`
6. Build production assets:
   - `npm run build:extension`
7. Run the threshold harness:
   - `npm run threshold:calibrate`

## Build Notes
- The main extension build outputs to `apps/extension/dist`.
- Vite builds:
  - `src/popup/popup.html`
  - `src/offscreen/offscreen.html`
  - `src/background/index.ts`
- The content script is built separately as a self-contained IIFE.
- The build copies:
  - `apps/extension/manifest.json`
  - `apps/extension/workicon.png`
  - ONNX Runtime loader and WASM assets into `dist/assets/`
  - MiniLM model assets into `dist/assets/models/minilm/Xenova/all-MiniLM-L6-v2/`
- If `apps/extension/ml/minilm/` is absent, the build downloads the required model files from Hugging Face.

## Test Coverage
- `classifier.test.cjs`
- `security.test.cjs`
- `page-signals.test.cjs`
- `offscreen-client.test.cjs`
- `background-teardown.test.cjs`
- `build-extension.test.cjs`
- `state-normalization.test.cjs`

## Manual QA
- Start a session and confirm already-open tabs are classified immediately.
- Stop a session and verify badges clear, blocked pages recover, and offscreen teardown runs.
- Let a session finish via alarm and verify notification plus `SESSION_COMPLETE` delivery.
- Verify off-task blocking on a normal page with an active content script.
- Verify reinjection recovery on an already-open page with no live receiver.
- Verify restricted pages such as `chrome://extensions` are badged without attempted blocking.
- Exercise a borderline page and confirm second-pass page-signal extraction can refine the result.
- Exercise timeout, sparse-signal, and restricted-page extraction fallbacks and confirm the Stage 1 decision still applies.
- Verify allow-domain and 5/10/15 minute snooze actions unblock immediately and re-enter enforcement when the session override expires.

## Known Limitations
- Some browser-owned pages cannot host injected scripts, so they cannot display the overlay.
- The extension still relies on content-script availability for second-pass page understanding and blocking overlays.
- Heuristic fallback is intentionally simple and title/domain based.
- Session overrides are temporary only; there is no permanent user-managed allowlist.
- The test suite is unit-focused and does not yet provide browser-level end-to-end coverage.
