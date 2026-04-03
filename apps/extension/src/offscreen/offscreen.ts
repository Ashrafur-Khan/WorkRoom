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
    // The offscreen document owns model lifetime so the background can keep a
    // stable request/response contract without loading ML code itself.
    void (async () => {
      const response = await classifyWithModel(message as MlClassifyRequest, emitDebugEvent);
      sendResponse(response satisfies MlClassifyResponse);
    })();

    return true;
  }

  if (message.type === 'ML_OFFSCREEN_CLOSE') {
    // Session stop and completion both tear down the offscreen document, so this
    // is the runtime hook that drops cached embeddings between sessions.
    emitDebugEvent({ source: 'offscreen', status: 'offscreen-closed', timestamp: Date.now() });
    clearModelCaches();
  }

  return false;
});

emitDebugEvent({ source: 'offscreen', status: 'offscreen-created', timestamp: Date.now() });
