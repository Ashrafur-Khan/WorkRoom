# WorkRoom
WorkRoom is a Manifest V3 Chrome extension for focus sessions. A user enters a goal and timer in the popup, the background monitors tabs during the session, and the content script blocks distracting pages with an in-page overlay that now also supports session-scoped unblock and snooze actions.

## Overview
- Session state is stored locally in `chrome.storage.local`.
- Running sessions now also carry temporary domain exceptions:
  - `allowedDomains` for "This is not a distraction!" overrides
  - `snoozedDomains` for temporary domain-level snoozes keyed to expiration timestamps
- Session completion is driven by a Chrome alarm.
- Classification is local-only and runs through `@huggingface/transformers` with the `Xenova/all-MiniLM-L6-v2` model in an offscreen document.
- Classification now uses a two-stage local pipeline: cheap ML from URL/title context first, followed by conditional page-signal extraction for borderline results.
- The background service worker remains the policy and enforcement layer.
- When ML cannot produce a result, the background falls back to heuristics in `classifier.ts`.
- The packaged model/runtime path is local-only: MiniLM model assets and ONNX Runtime web assets are bundled into the extension and loaded from `chrome-extension://` URLs.
- Build-time model handling is packaging-only: the build either copies vendored MiniLM files from `apps/extension/ml/minilm/` or fetches the required Hugging Face assets, but it does not generate model artifacts.
- Already-open tabs can now be blocked even after extension reload or late activation because the background can reinject the content script and retry delivery when a tab has no receiver.
- Users can override an off-task block for the current session or snooze it for `5`, `10`, or `15` minutes on the current domain.

## Current Stack
- TypeScript
- Vite
- Chrome Extension Manifest V3
- Background service worker
- Vanilla popup and content UI
- `@huggingface/transformers` with `Xenova/all-MiniLM-L6-v2` (ONNX Runtime Web / WASM backend)
- Chrome `offscreen` and `scripting` APIs

## Current Architecture
| Piece | Location | Responsibility |
| --- | --- | --- |
| Manifest | `apps/extension/manifest.json` | Declares permissions, host access, content script injection, background worker, popup, and extension-page CSP for the offscreen ML runtime. |
| Popup | `apps/extension/src/popup/*` | Starts and stops sessions, persists session state, and sends `START_SESSION` / `STOP_SESSION`. |
| Background | `apps/extension/src/background/index.ts` | Main orchestrator for alarms, tab updates, tab activation, runtime messages, debug-log retrieval, and session-scoped domain override updates. |
| Security layer | `apps/extension/src/background/security.ts` | Applies classification results to badges, handles the borderline second-pass flow, honors active domain overrides/snoozes, blocks off-task tabs, and reinjects content scripts into already-open tabs when message delivery has no receiver. |
| Classifier | `apps/extension/src/lib/classifier.ts` | Top-level decision layer. Returns structured classifier decisions, calls offscreen ML, logs fallback, and owns heuristic fallback policy. |
| Offscreen bridge | `apps/extension/src/lib/offscreen-client.ts` | Serializes offscreen create/close operations, creates or reuses the offscreen document, validates ML responses, and sends ML requests from background to offscreen. |
| Offscreen runtime | `apps/extension/src/offscreen/*` | Offscreen document entrypoint that owns ONNX Runtime inference and ML debug events. |
| Model manager | `apps/extension/src/lib/model-manager.ts` | Loads the MiniLM-L6-v2 pipeline via `@huggingface/transformers`, preflights the packaged model and ONNX Runtime assets, disables browser Cache API usage for extension-packaged model files, manages offscreen embedding caches keyed by normalized page context, and produces ML scores. |
| Page signals | `apps/extension/src/lib/page-signals.ts` | Extracts bounded page signals, builds canonical page context, and generates sanitized debug snapshots for second-pass classification. |
| Content script | `apps/extension/src/content/*` | Shows the block overlay and session-complete toast inside the page, and answers `EXTRACT_PAGE_SIGNALS` with bounded DOM-derived signals. |
| Debug log | `apps/extension/src/background/debug-log.ts` | Stores a bounded ring buffer of debug events in `chrome.storage.session`. |

## ML Flow
1. The background sees a relevant tab event.
2. `classifier.ts` requests Stage 1 ML classification through `offscreen-client.ts` using normalized URL/title context.
3. The offscreen document loads or reuses the MiniLM-L6-v2 pipeline (ONNX Runtime Web / WASM) and returns either:
   - a `ready` result with `classification` and numeric `score`, or
   - a `fallback` result with `error` and `score: null`
5. If the Stage 1 ML result is borderline, the background requests bounded page signals from the content script and reruns ML with richer page context.
6. If extraction fails, times out, is too sparse, or the page is restricted, the background falls back to the Stage 1 decision without breaking the flow.
7. Before applying the final result, the background verifies the tab has not navigated and skips stale results.
8. The background applies badge and blocking behavior.
9. Before blocking, the background checks whether the tab's domain is already allowed for the current session or has an active snooze.
10. If the tab is off-task and has no live content-script receiver, the background injects the content CSS/JS into that tab and retries `BLOCK_PAGE` once.
11. If offscreen returns `fallback`, the background runs heuristic fallback from `classifier.ts`.

## Runtime Notes
- ML does not run in the service worker.
- The offscreen document exists because ONNX Runtime Web requires a DOM-capable extension page.
- `@huggingface/transformers` is configured for local-only loading: remote model fetches are disabled, local model loading is enabled, and the model path points at the packaged extension assets.
- Before pipeline initialization, the offscreen runtime verifies that `assets/models/minilm/Xenova/all-MiniLM-L6-v2/config.json` is fetchable. This is a lightweight packaged-model sentinel used to fail fast with a precise asset-path error if the model bundle is missing or unreadable.
- Before pipeline initialization, the offscreen runtime also verifies that the packaged ONNX Runtime loader and WASM files are fetchable, so missing ORT assets fail with a precise extension-path error instead of a generic backend-init failure.
- Browser Cache API usage is disabled for packaged `chrome-extension://` model assets to avoid unsupported cache writes from the transformers runtime.
- The runtime currently relies on the library-default WASM dtype selection. Since no explicit `dtype` is configured, Transformers.js will choose its default WASM dtype for the model.
- The extension enables WASM for extension pages via:
  - `"content_security_policy": { "extension_pages": "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'" }`
- Classification is privacy-preserving: no browsing data is sent to a remote service.
- The extension requests `host_permissions: ["<all_urls>"]` and `scripting` permission so it can classify pages by URL/title, request bounded page signals when needed, and recover page blocking for already-open tabs when no content-script receiver is available.
- Programmatic reinjection is only attempted for script-injectable URLs such as `http:`, `https:`, and `file:`. Restricted browser pages like `chrome://` remain non-blockable.
- Session overrides and snoozes are domain-scoped and reset when the session ends.
- Expired snoozes are pruned during background enforcement and the affected tabs return to normal classification behavior.
- Extracted page content is not persisted long-term. Debug retention is session-only and stores a sanitized signal snapshot.

## Debugging and Observability
- Background logs use `[WorkRoom:bg]`.
- Offscreen logs use `[WorkRoom:offscreen]`.
- `GET_DEBUG_LOGS` returns recent debug entries from `chrome.storage.session`.
- `classification-complete` logs include `modelState`, backend, and when available also `classification` or `error`.
- `classification-complete` and `classification-fallback` include timing metadata for classification work.
- `model-loading` / `model-ready` events reflect pipeline initialization. Backend is always `wasm`, and `model-ready` includes load timing metadata.
- Offscreen lifecycle logs now distinguish:
  - `offscreen-created` when the document is created for the current request flow
  - `offscreen-reused` when an existing offscreen runtime is reused
  - `offscreen-close-skipped` when teardown is requested but no offscreen document exists
  - `offscreen-close-message-failed` when the teardown ping fails but document closure continues
  - `offscreen-request-failed` when the runtime message transport fails before a response is received
  - `offscreen-response-invalid` when the offscreen runtime returns no response or a malformed payload
- If model preflight fails before pipeline creation, the fallback error now includes the exact asset path, such as `assets/models/minilm/Xenova/all-MiniLM-L6-v2/config.json`, instead of only reporting `Failed to fetch`.
- If ONNX Runtime asset preflight fails before pipeline creation, the fallback error includes the exact missing runtime path, such as `assets/ort-wasm-simd-threaded.jsep.mjs`.
- Signal extraction logs include:
  - `signal-extraction-started`
  - `signal-extraction-complete`
  - `signal-extraction-fallback`
  - `signal-extraction-timeout`
- `classification-skipped` records stale-tab and tab-unavailable protection paths.
- Background delivery logs distinguish normal block delivery from:
  - `block-message-recovered` after reinjecting the content script, and
  - `block-message-skipped` / `block-message-failed` when delivery cannot be recovered.
- Session exception logs include:
  - `user-marked-allowed-domain` when a user marks the current domain as not distracting for the session
  - `domain-snoozed` when a user snoozes the current domain
  - `snooze-expired` when a stored snooze is removed after expiring
  - `override-applied` when background enforcement treats a domain as allowed because of an active override or snooze
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
6. Run threshold calibration harness (downloads a local cache copy on first run):
   - `npm run threshold:calibrate`

## Stage 2 Manual QA Checklist
- Start a session and confirm already-open tabs are classified immediately.
- Stop a session and verify badges clear, blocked pages recover, and the offscreen runtime tears down cleanly.
- Let a session finish via alarm and verify teardown plus the completion notification/toast flow.
- Reload the extension during an active session and confirm classification recovers on the next relevant tab event.
- Verify off-task blocking on a normal page with a live content script receiver.
- Verify off-task blocking on an already-open page that requires content-script reinjection.
- Verify restricted URLs such as `chrome://extensions` are badged safely without attempted injection.
- Exercise a borderline page and confirm second-pass page-signal extraction can refine the decision.
- Exercise a page where second-pass extraction is unavailable, sparse, or times out and confirm the Stage 1 result still applies cleanly.
- Verify "This is not a distraction" applies immediately to the current domain for the rest of the session.
- Verify 5/10/15 minute snoozes unblock immediately, expire correctly, and return the tab to normal enforcement afterward.

## Build Notes
- Dist artifacts are generated into `apps/extension/dist`.
- The build script copies:
  - `apps/extension/manifest.json`
  - `apps/extension/workicon.png`
  - ONNX Runtime web loader and WASM files from `onnxruntime-web` into `dist/assets/`
  - MiniLM-L6-v2 model files (config, tokenizer, quantized ONNX model) into `dist/assets/models/minilm/Xenova/all-MiniLM-L6-v2/`
  - `config.json` acts as the runtime preflight sentinel used by the offscreen loader before pipeline initialization
  - The build validates that the required ORT runtime module and WASM files are present in `dist/assets/` before succeeding
  - If `apps/extension/ml/minilm/` exists, the build copies those packaged model files; otherwise it fetches the required files from Hugging Face at build time

## Current Behavior
- Starting a session triggers an immediate sweep across all open tabs.
- Both manual stop and alarm-driven completion reset session state, clear badges, and tear down the offscreen runtime so model caches do not leak across sessions.
- `on-task` tabs get a green badge.
- `off-task` tabs get a red badge and a `BLOCK_PAGE` message to the content script.
- Borderline ML results can trigger a second pass using bounded DOM-derived page signals before the final decision is applied.
- If an already-open off-task tab has no content-script receiver, the background injects the content script and CSS into that tab and retries the block once.
- If a page cannot host injected scripts, the extension can still classify and badge it, but blocking is skipped cleanly and logged as a restricted URL path.
- Blocked pages now show three recovery paths:
  - go back immediately
  - mark the current domain as "not a distraction" for the rest of the session
  - snooze the current domain for `5`, `10`, or `15` minutes (snooze activation is delayed by a 10-second cooldown; if the user navigates away or clicks "Take me back" before the countdown ends, the snooze is cancelled)
- Domains covered by an active override or snooze are treated as allowed and get a green badge during that period.
- `ambiguous` tabs clear the badge.
- The content script shows a full-page overlay for blocked pages, removes the overlay when the user allows or snoozes the domain, and shows a toast when the session ends.
- Heuristic fallback still exists and is intentionally simple: domain allow/block lists plus title keyword matching against the user goal.
- If second-pass page-signal extraction fails because of timeout, sparse signals, restricted URLs, missing receivers, reinjection failure, or tab loss, the extension falls back to the Stage 1 decision without breaking the flow.
- If a tab navigates while classification is in flight, or the tab disappears before enforcement, the background discards the stale result instead of applying it to the wrong page.

## Known Limitations
- Some browser-owned or restricted pages cannot be script-injected, so they can be classified and badged but not overlaid.
- SPA-heavy sites can still produce timing edge cases around navigation and message delivery, though the background now retries by reinjecting the content script when possible.
- Session overrides and snoozes are temporary only; there is no permanent user-managed allowlist yet.
- Heuristic fallback is intentionally simple and title/domain based.
- The extension still relies on content-script availability for richer second-pass page understanding and for page overlays on off-task tabs.
- ML classification thresholds were calibrated against a labeled evaluation set of 43 (goal, title+URL) pairs. The calibration harness and labeled pairs live in `apps/extension/scripts/threshold-harness.mjs` and `apps/extension/src/__tests__/threshold-pairs.ts`. Tricky off-task pairs with keyword overlap (e.g. "r/biology" vs a biology study goal) can still leak through Stage 1; this is a known limitation of title-only context that Stage 2 DOM signals can address.
- The extension has unit coverage for classifier, security, page-signal extraction, build/runtime asset validation, and offscreen-client lifecycle/error handling, but it does not yet have browser-level end-to-end coverage.
- The README may lag behind active development; the codebase is the source of truth.

## Important Files
- `apps/extension/src/lib/classifier.ts`
- `apps/extension/src/lib/model-manager.ts`
- `apps/extension/src/lib/offscreen-client.ts`
- `apps/extension/src/lib/session-utilities.ts`
- `apps/extension/src/background/index.ts`
- `apps/extension/src/background/security.ts`
- `apps/extension/src/offscreen/offscreen.ts`

## Project Status
The extension is beyond the original heuristic-only prototype. It now has:
- an offscreen ML pipeline using `@huggingface/transformers` (MiniLM-L6-v2 / ONNX Runtime Web),
- background-owned heuristic fallback policy,
- reinjection-based recovery for blocking already-open off-task tabs,
- session-scoped domain override and snooze controls in the block overlay,
- bounded debug-log storage for background and offscreen events, and
- unit coverage for classifier, security/blocking, page-signal extraction, build/runtime asset validation, and offscreen-client lifecycle/error flows, and
- empirically calibrated ML thresholds with a labeled evaluation set and scoring harness.

There is still a lot I have to do. The extension is still a bit slow, and the main remaining work before broad public release is product hardening rather than core capability: privacy/disclosure materials, broader manual QA across sites, and end-to-end validation of real browser flows.
