chrome.runtime.onMessage.addListener((e,o,t)=>{e.type==="SESSION_COMPLETE"&&n(e.payload.message),e.type==="BLOCK_PAGE"&&d(e.payload.goal)});function n(e){const o=document.createElement("div");o.className="workroom-toast";const t=document.createElement("span");t.textContent=`:) ${e}`,o.appendChild(t),document.body.appendChild(o),setTimeout(()=>{o.classList.add("workroom-toast-exit"),setTimeout(()=>o.remove(),500)},5e3)}function d(e){var t;if(document.getElementById("workroom-overlay-id"))return;const o=document.createElement("div");o.id="workroom-overlay-id",o.className="workroom-overlay",o.innerHTML=`
        <h1>Distraction Detected</h1>
        <p>You committed to focusing on: <strong>${e}</strong></p>
        <button id="workroom-go-back" class="workroom-btn-back">
        Lets get back to work!
        </button>
  `,document.body.appendChild(o),document.body.style.overflow="hidden",(t=document.getElementById("workroom-go-back"))==null||t.addEventListener("click",()=>{history.back()})}
