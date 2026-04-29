import { classifyWithModel, clearModelCaches } from '../lib/model-manager';
import type {
  DebugLogEntry,
  MlClassifyRequestMessage,
  MlClassifyResponse,
  MlDebugEventMessage,
  MlOffscreenCloseMessage,
  RuntimeMessage,
} from '../types';

function emitDebugEvent(event: DebugLogEntry): void {
  console.log('[WorkRoom:offscreen]', event.status, event);
  void chrome.runtime.sendMessage<MlDebugEventMessage>({
    payload: event,
    type: 'ML_DEBUG_EVENT',
  });
}

function isRuntimeMessage(value: unknown): value is RuntimeMessage {
  return typeof value === 'object' && value !== null && typeof (value as { type?: unknown }).type === 'string';
}

function isMlClassifyRequestMessage(message: RuntimeMessage): message is MlClassifyRequestMessage {
  return message.type === 'ML_CLASSIFY_REQUEST';
}

function isMlOffscreenCloseMessage(message: RuntimeMessage): message is MlOffscreenCloseMessage {
  return message.type === 'ML_OFFSCREEN_CLOSE';
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!isRuntimeMessage(message)) {
    return false;
  }

  if (isMlClassifyRequestMessage(message)) {
    void (async () => {
      const response = await classifyWithModel(message, emitDebugEvent);
      sendResponse(response satisfies MlClassifyResponse);
    })();

    return true;
  }

  if (isMlOffscreenCloseMessage(message)) {
    emitDebugEvent({ source: 'offscreen', status: 'offscreen-closed', timestamp: Date.now() });
    clearModelCaches();
  }

  return false;
});

emitDebugEvent({ source: 'offscreen', status: 'offscreen-created', timestamp: Date.now() });
