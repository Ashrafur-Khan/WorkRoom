import {
  classifyWithModel,
  clearModelCaches,
  type MlClassifyRequest,
  type MlClassifyResponse,
  type MlDebugEvent,
} from '../lib/model-manager';

function emitDebugEvent(event: MlDebugEvent): void {
  console.log('[WorkRoom:offscreen]', event.status, event);
  void chrome.runtime.sendMessage({
    payload: event,
    type: 'ML_DEBUG_EVENT',
  });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'ML_CLASSIFY_REQUEST') {
    void (async () => {
      const response = await classifyWithModel(message as MlClassifyRequest, emitDebugEvent);
      sendResponse(response satisfies MlClassifyResponse);
    })();

    return true;
  }

  if (message.type === 'ML_OFFSCREEN_CLOSE') {
    emitDebugEvent({ source: 'offscreen', status: 'offscreen-closed', timestamp: Date.now() });
    clearModelCaches();
  }

  return false;
});

emitDebugEvent({ source: 'offscreen', status: 'offscreen-created', timestamp: Date.now() });
