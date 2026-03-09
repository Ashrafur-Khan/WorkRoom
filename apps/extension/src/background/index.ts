// src/background/index.ts
import { classifyUrl } from '../lib/classifier';
import { getSessionStatus, createIdleState } from '../lib/session-utilities';
import { ALARM_NAME } from '../lib/constants';
import type { SessionState } from '../types';

// The Alarm Listener (Handles the "Time's Up" event)
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ALARM_NAME) {
    console.log('[WorkRoom] Alarm fired! Ending session.');
    
    // Fetch state to get the goal name for the notification
    const result = await chrome.storage.local.get('sessionState');
    const state = result.sessionState as SessionState | undefined;

    // Safely extract goal only when present on the active session shape
    const goal = state && 'goal' in state ? state.goal : undefined;

    // Reset State
    await chrome.storage.local.set({ sessionState: createIdleState() });

    // Clear Badges
    chrome.action.setBadgeText({ text: "" });

    // Notify User
    chrome.notifications.create({
      type: 'basic',
      iconUrl: chrome.runtime.getURL('workicon.png'),
      title: 'Session Complete',
      message: goal ? `Great job! You focused on: ${goal}` : 'Session finished!',
      priority: 2
    },
    (notificationId) => {
        // ERROR HANDLING: This will tell us if Chrome rejected the notification
        if (chrome.runtime.lastError) {
        console.error('[WorkRoom] Notification failed:', chrome.runtime.lastError);
        } else {
        console.log('[WorkRoom] Notification sent. ID:', notificationId);
        }
    });
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    
    if (tabs.length > 0 && tabs[0].id) {
      // We use a try-catch because we can't inject into chrome:// pages
      try {
        await chrome.tabs.sendMessage(tabs[0].id, {
          type: 'SESSION_COMPLETE',
          payload: { 
            message: goal ? `Great job! You finished: ${goal}` : 'Session Done!' 
          }
        });
      } catch (err) {
        console.log('Could not send in-page notification (probably a restricted page)');
      }
    }
    }
});

// URL change
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  // We only care if the URL or Title changed, and if the page is fully loaded
  if (changeInfo.status === 'complete' && tab.url && tab.title) {
    await runSecurityCheck(tabId, tab.url, tab.title);
  }
});

// Tab switching. This catches the user switching to a restricted tab before extension was active
chrome.tabs.onActivated.addListener(async (activeInfo) => {
    const tab = await chrome.tabs.get(activeInfo.tabId); 
    if (tab.url && tab.title) { 
        await runSecurityCheck(tab.id!, tab.url, tab.title)
    }
})

// Message listener for START_SESSION that sweeps all tabs 
chrome.runtime.onMessage.addListener((message) => {
    if (message.type == 'START_SESSION') { 
        sweepAllTabs()
    }
})

//checks a single tab against a current session 
async function runSecurityCheck(tabId: number, url: string, title: string) { 
    const result = await chrome.storage.local.get('sessionState');
    const state = result.sessionState as SessionState | undefined;

    //if no session/session paused 
    if (!state || !state.isRunning) {
        return;
    }
    // classify the url 
    const resultType = classifyUrl(url, title, state.goal)
    // Set badges 
    if (resultType == 'off-task') { 
        console.log('!!! THIS PAGE SHOULD BE BLOCKED !!!');

        chrome.action.setBadgeText({ text: "BAD", tabId });
        chrome.action.setBadgeBackgroundColor({ color: "#FF0000", tabId });
    
        try { 
            await chrome.tabs.sendMessage(tabId, { 
                type: 'BLOCK_PAGE', 
                payload: { goal: state.goal }
            })
        } catch(e) {
            console.error("What the helly:", e); 
        }

    } else if (resultType == 'on-task') { 
        chrome.action.setBadgeText({ text: "GOOD", tabId });
        chrome.action.setBadgeBackgroundColor({ color: "#00FF00", tabId });
    } else { 
        chrome.action.setBadgeText({ text: "", tabId });
    }
}

async function sweepAllTabs() {
    const tabs = await chrome.tabs.query({}); //get every tab
    for (const tab of tabs) { 
        if (tab.id && tab.url && tab.title) {
            runSecurityCheck(tab.id, tab.url, tab.title)
        }
    }
}

