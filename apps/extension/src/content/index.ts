import './styles.css';
import { extractPageSignalsFromDocument } from '../lib/page-signals';
import type {
  AllowDomainForSessionMessage,
  BlockPageMessage,
  ExtractPageSignalsResponse,
  RuntimeMessage,
  SessionCompleteMessage,
  SessionMutationResponse,
  SnoozeDomainMessage,
  UnblockPageMessage,
} from '../types';

const OVERLAY_ID = 'workroom-overlay-id';
const GOAL_COPY_ID = 'workroom-goal-copy';
const SNOOZE_OPTIONS = [5, 10, 15] as const;
const SNOOZE_COOLDOWN_SECONDS = 10;

let cooldownIntervalId: ReturnType<typeof setInterval> | null = null;

function isRuntimeMessage(value: unknown): value is RuntimeMessage {
  return typeof value === 'object' && value !== null && typeof (value as { type?: unknown }).type === 'string';
}

function isSessionMutationResponse(value: unknown): value is SessionMutationResponse {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { ok?: unknown }).ok === 'boolean'
  );
}

function isBlockPageMessage(message: RuntimeMessage): message is BlockPageMessage {
  return message.type === 'BLOCK_PAGE';
}

function isSessionCompleteMessage(message: RuntimeMessage): message is SessionCompleteMessage {
  return message.type === 'SESSION_COMPLETE';
}

function isUnblockPageMessage(message: RuntimeMessage): message is UnblockPageMessage {
  return message.type === 'UNBLOCK_PAGE';
}

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  if (!isRuntimeMessage(request)) {
    return false;
  }

  if (request.type === 'EXTRACT_PAGE_SIGNALS') {
    sendResponse(extractCurrentPageSignals());
    return true;
  }

  if (isSessionCompleteMessage(request)) {
    removeBlockScreen();
    showNotification(request.payload.message);
    return false;
  }

  if (isBlockPageMessage(request)) {
    showBlockScreen(request.payload.goal);
    return false;
  }

  if (isUnblockPageMessage(request)) {
    removeBlockScreen();
  }

  return false;
});

console.info('[WorkRoom:content] Listener ready.', { url: window.location.href });

function extractCurrentPageSignals(): ExtractPageSignalsResponse {
  try {
    return {
      ok: true,
      signals: extractPageSignalsFromDocument(document, window.location.href),
    };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

function showNotification(text: string): void {
  const container = document.createElement('div');
  container.className = 'workroom-toast';

  const message = document.createElement('span');
  message.textContent = `:) ${text}`;
  container.appendChild(message);

  document.body.appendChild(container);

  setTimeout(() => {
    container.classList.add('workroom-toast-exit');
    setTimeout(() => container.remove(), 500);
  }, 5000);
}

function showBlockScreen(goal: string): void {
  const existingOverlay = document.getElementById(OVERLAY_ID);

  if (existingOverlay) {
    const goalCopy = document.getElementById(GOAL_COPY_ID);

    if (goalCopy) {
      goalCopy.textContent = goal;
    }

    return;
  }

  const overlay = document.createElement('div');
  overlay.id = OVERLAY_ID;
  overlay.className = 'workroom-overlay';

  const title = document.createElement('h1');
  title.textContent = 'Distraction Detected';
  overlay.appendChild(title);

  const description = document.createElement('p');
  description.innerHTML = 'You committed to focusing on: <strong id="workroom-goal-copy"></strong>';
  overlay.appendChild(description);

  const actions = document.createElement('div');
  actions.className = 'workroom-actions';

  const goBackButton = document.createElement('button');
  goBackButton.className = 'workroom-btn-back';
  goBackButton.textContent = "Let's get back to work!";
  goBackButton.addEventListener('click', () => {
    history.back();
  });
  actions.appendChild(goBackButton);

  const allowButton = document.createElement('button');
  allowButton.className = 'workroom-btn-secondary';
  allowButton.textContent = 'This is not a distraction!';
  allowButton.addEventListener('click', () => {
    void allowDomainForSession();
  });
  actions.appendChild(allowButton);

  const snoozeContainer = document.createElement('div');
  snoozeContainer.className = 'workroom-snooze-container';

  const snoozeLabel = document.createElement('p');
  snoozeLabel.className = 'workroom-snooze-label';
  snoozeLabel.textContent = 'Snooze for';
  snoozeContainer.appendChild(snoozeLabel);

  const snoozeActions = document.createElement('div');
  snoozeActions.className = 'workroom-snooze-actions';

  SNOOZE_OPTIONS.forEach((minutes) => {
    const button = document.createElement('button');
    button.className = 'workroom-btn-snooze';
    button.textContent = `${minutes} min`;
    button.addEventListener('click', () => {
      showCooldownScreen(minutes);
    });
    snoozeActions.appendChild(button);
  });

  snoozeContainer.appendChild(snoozeActions);
  actions.appendChild(snoozeContainer);
  overlay.appendChild(actions);
  document.body.appendChild(overlay);

  const goalCopy = document.getElementById(GOAL_COPY_ID);

  if (goalCopy) {
    goalCopy.textContent = goal;
  }

  overlay.dataset.previousOverflow = document.body.style.overflow;
  document.body.style.overflow = 'hidden';
}

function removeBlockScreen(): void {
  if (cooldownIntervalId !== null) {
    clearInterval(cooldownIntervalId);
    cooldownIntervalId = null;
  }

  const overlay = document.getElementById(OVERLAY_ID);

  if (!overlay) {
    return;
  }

  document.body.style.overflow = overlay.dataset.previousOverflow ?? '';
  overlay.remove();
}

function cancelCooldown(): void {
  if (cooldownIntervalId !== null) {
    clearInterval(cooldownIntervalId);
    cooldownIntervalId = null;
  }

  history.back();
}

function showCooldownScreen(durationMinutes: number): void {
  const overlay = document.getElementById(OVERLAY_ID);

  if (!overlay) {
    return;
  }

  overlay.innerHTML = '';

  const title = document.createElement('h1');
  title.textContent = 'Snooze Pending...';
  overlay.appendChild(title);

  const warning = document.createElement('p');
  warning.textContent = "If you leave now, the snooze won't take effect!";
  overlay.appendChild(warning);

  const timerWrapper = document.createElement('div');
  timerWrapper.className = 'workroom-cooldown-timer';

  const digits = document.createElement('span');
  digits.className = 'workroom-cooldown-digits';
  digits.textContent = String(SNOOZE_COOLDOWN_SECONDS);
  timerWrapper.appendChild(digits);
  overlay.appendChild(timerWrapper);

  const cancelButton = document.createElement('button');
  cancelButton.className = 'workroom-btn-back';
  cancelButton.textContent = 'Take me back';
  cancelButton.addEventListener('click', cancelCooldown);
  overlay.appendChild(cancelButton);

  let secondsLeft = SNOOZE_COOLDOWN_SECONDS;
  cooldownIntervalId = setInterval(() => {
    secondsLeft -= 1;
    digits.textContent = String(secondsLeft);

    if (secondsLeft <= 0) {
      const intervalId = cooldownIntervalId;

      if (intervalId !== null) {
        clearInterval(intervalId);
        cooldownIntervalId = null;
      }

      void snoozeDomain(durationMinutes);
    }
  }, 1000);
}

async function allowDomainForSession(): Promise<void> {
  const response = await chrome.runtime.sendMessage<AllowDomainForSessionMessage, unknown>({
    type: 'ALLOW_DOMAIN_FOR_SESSION',
  });

  if (isSessionMutationResponse(response) && response.ok) {
    removeBlockScreen();
    return;
  }

  console.error('[WorkRoom:content] Failed to allow domain for session.');
}

async function snoozeDomain(durationMinutes: number): Promise<void> {
  const response = await chrome.runtime.sendMessage<SnoozeDomainMessage, unknown>({
    payload: { durationMinutes },
    type: 'SNOOZE_DOMAIN',
  });

  if (isSessionMutationResponse(response) && response.ok) {
    removeBlockScreen();
    return;
  }

  console.error('[WorkRoom:content] Failed to snooze domain.', { durationMinutes });
}
