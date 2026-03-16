import './styles.css';

const OVERLAY_ID = 'workroom-overlay-id';
const GOAL_COPY_ID = 'workroom-goal-copy';
const SNOOZE_OPTIONS = [5, 10, 15] as const;

chrome.runtime.onMessage.addListener((request) => {
  if (request.type === 'SESSION_COMPLETE') {
    removeBlockScreen();
    showNotification(request.payload.message);
  }

  if (request.type === 'BLOCK_PAGE') {
    showBlockScreen(request.payload.goal);
  }

  if (request.type === 'UNBLOCK_PAGE') {
    removeBlockScreen();
  }
});

function showNotification(text: string) {
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

function showBlockScreen(goal: string) {
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
      void snoozeDomain(minutes);
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

function removeBlockScreen() {
  const overlay = document.getElementById(OVERLAY_ID);

  if (!overlay) {
    return;
  }

  document.body.style.overflow = overlay.dataset.previousOverflow ?? '';
  overlay.remove();
}

async function allowDomainForSession(): Promise<void> {
  const response = await chrome.runtime.sendMessage({ type: 'ALLOW_DOMAIN_FOR_SESSION' });

  if (response?.ok) {
    removeBlockScreen();
    return;
  }

  console.error('[WorkRoom:content] Failed to allow domain for session.');
}

async function snoozeDomain(durationMinutes: number): Promise<void> {
  const response = await chrome.runtime.sendMessage({
    payload: { durationMinutes },
    type: 'SNOOZE_DOMAIN',
  });

  if (response?.ok) {
    removeBlockScreen();
    return;
  }

  console.error('[WorkRoom:content] Failed to snooze domain.', { durationMinutes });
}
