import './styles.css';

// Listen for messages from the Background script
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'SESSION_COMPLETE') {
    showNotification(request.payload.message);
  }
  if (request.type === 'BLOCK_PAGE') { 
    showBlockScreen(request.payload.goal);
  }
});

function showNotification(text: string) {
  // 1. Create container
  const container = document.createElement('div');
  container.className = 'workroom-toast';
  
  // 2. Add content
  const message = document.createElement('span');
  message.textContent = `:) ${text}`;
  container.appendChild(message);

  // 3. Inject into DOM
  document.body.appendChild(container);

  // 4. Animate In (handled by CSS)
  // Remove after 5 seconds
  setTimeout(() => {
    container.classList.add('workroom-toast-exit');
    setTimeout(() => container.remove(), 500);
  }, 5000);
}

function showBlockScreen(goal: string) {
    // check if overlay already exists to prevent multiple overlays
    if (document.getElementById('workroom-overlay-id')) return ;
    
    const overlay = document.createElement('div');
    overlay.id = 'workroom-overlay-id';
    overlay.className = 'workroom-overlay';
    overlay.innerHTML = `
        <h1>Distraction Detected</h1>
        <p>You committed to focusing on: <strong>${goal}</strong></p>
        <button id="workroom-go-back" class="workroom-btn-back">
        Lets get back to work!
        </button>
  `;
    document.body.appendChild(overlay);
    //stop scrolling on the same page 
    document.body.style.overflow = 'hidden';
    document.getElementById('workroom-go-back')?.addEventListener('click', () => {
        history.back()
    });
}