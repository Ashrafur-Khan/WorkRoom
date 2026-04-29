import './popup.css';
import { ALARM_NAME } from '../lib/constants';
import { createRunningState, readSessionState, writeSessionState } from '../lib/session-utilities';
import type { SessionState, StartSessionMessage, StopSessionMessage } from '../types';

type PopupElements = {
  buttons: {
    start: HTMLButtonElement;
    stop: HTMLButtonElement;
  };
  display: {
    endTime: HTMLParagraphElement;
    goal: HTMLParagraphElement;
  };
  inputs: {
    duration: HTMLInputElement;
    goal: HTMLTextAreaElement;
  };
  views: {
    idle: HTMLDivElement;
    running: HTMLDivElement;
  };
};

let state: SessionState = { isRunning: false };
let timerInterval: number | null = null;

function getRequiredElement<T extends typeof HTMLElement>(
  id: string,
  expectedType: T,
): InstanceType<T> {
  const element = document.getElementById(id);

  if (!(element instanceof expectedType)) {
    throw new Error(`Missing required element: ${id}`);
  }

  return element as InstanceType<T>;
}

function getPopupElements(): PopupElements {
  return {
    buttons: {
      start: getRequiredElement('start-btn', HTMLButtonElement),
      stop: getRequiredElement('stop-btn', HTMLButtonElement),
    },
    display: {
      endTime: getRequiredElement('display-endtime', HTMLParagraphElement),
      goal: getRequiredElement('display-goal', HTMLParagraphElement),
    },
    inputs: {
      duration: getRequiredElement('duration-input', HTMLInputElement),
      goal: getRequiredElement('goal-input', HTMLTextAreaElement),
    },
    views: {
      idle: getRequiredElement('view-idle', HTMLDivElement),
      running: getRequiredElement('view-running', HTMLDivElement),
    },
  };
}

async function saveState(newState: SessionState): Promise<void> {
  state = newState;
  await writeSessionState(newState);
}

async function loadState(): Promise<void> {
  state = await readSessionState();
}

function render(elements: PopupElements): void {
  if (timerInterval !== null) {
    clearInterval(timerInterval);
    timerInterval = null;
  }

  if (!state.isRunning) {
    elements.views.idle.classList.remove('hidden');
    elements.views.running.classList.add('hidden');
    return;
  }

  elements.views.idle.classList.add('hidden');
  elements.views.running.classList.remove('hidden');
  elements.display.goal.textContent = `Goal: ${state.goal}`;

  const updateTimer = () => {
    if (!state.isRunning) {
      return;
    }

    const endTime = state.startTime + state.durationMinutes * 60 * 1000;
    const diff = endTime - Date.now();

    if (diff <= 0) {
      elements.display.endTime.textContent = 'Session Finished';
      return;
    }

    const minutes = Math.floor(diff / 60000);
    const seconds = Math.floor((diff % 60000) / 1000);
    elements.display.endTime.textContent = `Time Remaining: ${minutes}:${seconds.toString().padStart(2, '0')}`;
  };

  updateTimer();
  timerInterval = window.setInterval(updateTimer, 1000);
}

function validateInputs(elements: PopupElements): void {
  const goal = elements.inputs.goal.value.trim();
  const duration = Number(elements.inputs.duration.value);
  const isValid = goal.length > 0 && Number.isFinite(duration) && duration > 0;

  elements.buttons.start.disabled = !isValid;
}

async function initialize(): Promise<void> {
  let elements: PopupElements;

  try {
    elements = getPopupElements();
  } catch (error) {
    console.error('[WorkRoom:popup] Critical DOM elements missing.', error);
    return;
  }

  const rerender = () => render(elements);

  elements.inputs.goal.addEventListener('input', () => {
    validateInputs(elements);
  });
  elements.inputs.duration.addEventListener('input', () => {
    validateInputs(elements);
  });

  elements.buttons.start.addEventListener('click', () => {
    void (async () => {
      const goal = elements.inputs.goal.value.trim();
      const duration = Number(elements.inputs.duration.value);

      if (!goal || !Number.isFinite(duration) || duration <= 0) {
        validateInputs(elements);
        return;
      }

      await saveState(createRunningState(goal, duration));
      chrome.alarms.create(ALARM_NAME, { delayInMinutes: duration });
      await chrome.runtime.sendMessage<StartSessionMessage>({ type: 'START_SESSION' });
      rerender();
    })();
  });

  elements.buttons.stop.addEventListener('click', () => {
    void (async () => {
      await saveState({ isRunning: false });
      await chrome.alarms.clear(ALARM_NAME);
      await chrome.runtime.sendMessage<StopSessionMessage>({ type: 'STOP_SESSION' });
      rerender();
    })();
  });

  await loadState();
  validateInputs(elements);
  rerender();
}

document.addEventListener('DOMContentLoaded', () => {
  void initialize();
});
