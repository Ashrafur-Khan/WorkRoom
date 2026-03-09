// apps/extension/src/popup/popup.ts
import './popup.css';
import { ALARM_NAME } from '../lib/constants';

// --- TYPES ---
import { SessionState, Classification } from 'src/types';

// --- STATE MANAGEMENT ---
let state: SessionState = { isRunning: false };


/**
 * Persist state to Chrome's local storage.
 * We immediately render after saving to keep UI in sync.
 */
function saveState(newState: SessionState) {
  state = newState;
  chrome.storage.local.set({ sessionState: newState });
  render();
}

/**
 * Load state from storage.
 * This handles the "Amnesia" problem when the popup re-opens.
 */
async function loadState() {
  const result = await chrome.storage.local.get('sessionState');
  if (result.sessionState) {
    state = result.sessionState;
  }
  render();
}

// --- DOM ELEMENTS & INITIALIZATION ---

// We select elements once at the top level (or inside init)
// to avoid querying the DOM repeatedly.
const elements = {
  views: {
    idle: document.getElementById('view-idle') as HTMLDivElement | null,
    running: document.getElementById('view-running') as HTMLDivElement | null,
  },
  inputs: {
    goal: document.getElementById('goal-input') as HTMLTextAreaElement | null,
    duration: document.getElementById('duration-input') as HTMLInputElement | null,
  },
  buttons: {
    start: document.getElementById('start-btn') as HTMLButtonElement | null,
    stop: document.getElementById('stop-btn') as HTMLButtonElement | null,
  },
  display: {
    goal: document.getElementById('display-goal') as HTMLParagraphElement | null,
    endTime: document.getElementById('display-endtime') as HTMLParagraphElement | null,
  },
};

/**
 * One-time setup for event listeners.
 * This prevents "ghost clicks" where listeners pile up if added during render.
 */
function initialize() {
  // Safety check: if our HTML IDs change, this protects the code from crashing
  if (
    !elements.views.idle ||
    !elements.views.running ||
    !elements.inputs.goal ||
    !elements.inputs.duration ||
    !elements.buttons.start ||
    !elements.buttons.stop
  ) {
    console.error('Critical DOM elements missing');
    return;
  }

  // 1. Input Validation Logic
  const validateInputs = () => {
    const goal = elements.inputs.goal?.value.trim() ?? '';
    const duration = Number(elements.inputs.duration?.value);
    
    const isValid = goal.length > 0 && Number.isFinite(duration) && duration > 0;
    
    if (elements.buttons.start) {
      elements.buttons.start.disabled = !isValid;
    }
  };

  elements.inputs.goal.addEventListener('input', validateInputs);
  elements.inputs.duration.addEventListener('input', validateInputs);

  // 2. Start Button Logic
  elements.buttons.start.addEventListener('click', () => {
    const goal = elements.inputs.goal?.value.trim();
    const duration = Number(elements.inputs.duration?.value);

    if (goal && duration) {
      saveState({
        isRunning: true,
        goal,
        durationMinutes: duration,
        startTime: Date.now(),
      });
      chrome.alarms.create(ALARM_NAME, { delayInMinutes: duration });
      //Tell Background to Scan ALL tabs immediately
      chrome.runtime.sendMessage({ type: 'START_SESSION' });
    }
  });

  // 3. Stop Button Logic
  elements.buttons.stop.addEventListener('click', () => {
    saveState({ isRunning: false });
    chrome.alarms.clear(ALARM_NAME);
  });

  // Load previous data
  loadState();
}

// --- RENDER LOGIC ---

// Add a global interval variable so we can clear it
let timerInterval: number | null = null;

function render() {
  const { views, display } = elements;
  // Guard clause ensures we don't run if DOM isn't ready
  if (!views.idle || !views.running) return;
  // Clear any existing timer to prevent duplicates
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }

  if (!state.isRunning) {
    // SHOW IDLE VIEW
    views.idle.classList.remove('hidden');
    views.running.classList.add('hidden');
  } else {
    // SHOW RUNNING VIEW
    views.idle.classList.add('hidden');
    views.running.classList.remove('hidden');

    // Populate Running View Data
    if (display.goal) display.goal.textContent =   `Goal: ${state.goal}`;

    const updateTimer = () => {
        const now = Date.now();
        if (!('startTime' in state) || !('durationMinutes' in state)) {
            console.error('Session state missing startTime or durationMinutes');
            // stop the session to keep UI consistent
            saveState({ isRunning: false });
            return;
        }

        const endTime = state.startTime + (state.durationMinutes * 60 * 1000);
        const diff = endTime - now;

        if (display.endTime) {
            if (diff <= 0) {
                display.endTime.textContent = "Session Finished";
            } else {
                const minutes = Math.floor(diff / 60000);
                const seconds = Math.floor((diff % 60000) / 1000);
                display.endTime.textContent =
                    `Time Remaining: ${minutes}:${seconds.toString().padStart(2, '0')}`;
            }
        } else {
            //somehow if display.endTime does not exist
            console.log("display.endTime is not available");
        }
    };

    updateTimer();
    timerInterval = window.setInterval(updateTimer, 1000);
  }
}


// Start the engine
document.addEventListener('DOMContentLoaded', initialize);