const a="59, 178, 191";let i=null,s=null,r=null,o=!1,c=!1,p=!1,u=!1,l=null,f=1e4;chrome.storage.local.get("heartbeatInterval").then(({heartbeatInterval:e})=>{e&&typeof e=="number"&&(f=e*1e3)});chrome.storage.onChanged.addListener((e,t)=>{if(t==="local"&&e.heartbeatInterval){const n=e.heartbeatInterval.newValue;n&&typeof n=="number"&&(f=n*1e3,c&&l&&(clearInterval(l),y()))}});function y(){l=window.setInterval(async()=>{try{(await chrome.runtime.sendMessage({type:"STATIC_INDICATOR_HEARTBEAT"}))?.success||d()}catch{d()}},f)}function x(){if(document.getElementById("pi-agent-styles"))return;const e=document.createElement("style");e.id="pi-agent-styles",e.textContent=`
    @keyframes pi-pulse {
      0% {
        box-shadow: 
          inset 0 0 10px rgba(${a}, 0.5),
          inset 0 0 20px rgba(${a}, 0.3),
          inset 0 0 30px rgba(${a}, 0.1);
      }
      50% {
        box-shadow: 
          inset 0 0 15px rgba(${a}, 0.7),
          inset 0 0 25px rgba(${a}, 0.5),
          inset 0 0 35px rgba(${a}, 0.2);
      }
      100% {
        box-shadow: 
          inset 0 0 10px rgba(${a}, 0.5),
          inset 0 0 20px rgba(${a}, 0.3),
          inset 0 0 30px rgba(${a}, 0.1);
      }
    }
  `,document.head.appendChild(e)}function b(){const e=document.createElement("div");return e.id="pi-agent-glow",e.style.cssText=`
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    pointer-events: none;
    z-index: 2147483646;
    opacity: 0;
    transition: opacity 0.3s ease-in-out;
    animation: pi-pulse 2s ease-in-out infinite;
    box-shadow: 
      inset 0 0 10px rgba(${a}, 0.5),
      inset 0 0 20px rgba(${a}, 0.3),
      inset 0 0 30px rgba(${a}, 0.1);
  `,e}function h(){const e=document.createElement("div");e.id="pi-agent-stop-container",e.style.cssText=`
    position: fixed;
    bottom: 16px;
    left: 50%;
    transform: translateX(-50%);
    display: flex;
    justify-content: center;
    align-items: center;
    pointer-events: none;
    z-index: 2147483647;
  `;const t=document.createElement("button");return t.id="pi-agent-stop-button",t.innerHTML=`
    <svg width="16" height="16" viewBox="0 0 256 256" fill="currentColor" style="margin-right: 12px; vertical-align: middle;">
      <path d="M128,20A108,108,0,1,0,236,128,108.12,108.12,0,0,0,128,20Zm0,192a84,84,0,1,1,84-84A84.09,84.09,0,0,1,128,212Zm40-112v56a12,12,0,0,1-12,12H100a12,12,0,0,1-12-12V100a12,12,0,0,1,12-12h56A12,12,0,0,1,168,100Z"></path>
    </svg>
    <span style="vertical-align: middle;">Stop Surf</span>
  `,t.style.cssText=`
    position: relative;
    transform: translateY(100px);
    padding: 12px 16px;
    background: #FAF9F5;
    color: #141413;
    border: 0.5px solid rgba(31, 30, 29, 0.4);
    border-radius: 12px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    box-shadow: 
      0 40px 80px rgba(${a}, 0.24),
      0 4px 14px rgba(${a}, 0.24);
    transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
    opacity: 0;
    user-select: none;
    pointer-events: auto;
    white-space: nowrap;
    margin: 0 auto;
  `,t.addEventListener("mouseenter",()=>{o&&(t.style.background="#F5F4F0")}),t.addEventListener("mouseleave",()=>{o&&(t.style.background="#FAF9F5")}),t.addEventListener("click",async()=>{await chrome.runtime.sendMessage({type:"STOP_AGENT",fromTabId:"CURRENT_TAB"})}),e.appendChild(t),e}function m(){const e=document.createElement("div");e.id="pi-agent-static-indicator",e.innerHTML=`
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" style="width: 16px; height: 16px; margin-right: 8px; flex-shrink: 0;">
      <circle cx="8" cy="8" r="7" fill="rgb(${a})"/>
      <text x="8" y="11" font-size="9" fill="white" text-anchor="middle" font-weight="bold">π</text>
    </svg>
    <span style="color: #141413; font-size: 14px;">Surf is active in this tab group</span>
    <div style="width: 0.5px; height: 32px; background: rgba(31, 30, 29, 0.15); margin: 0 8px;"></div>
    <button id="pi-static-chat-button" style="display: inline-flex; align-items: center; justify-content: center; padding: 6px; background: transparent; border: none; cursor: pointer; width: 32px; height: 32px; border-radius: 8px; transition: background 0.2s;">
      <svg width="20" height="20" viewBox="0 0 20 20" fill="#141413">
        <path d="M10 2.5C14.1421 2.5 17.5 5.85786 17.5 10C17.5 14.1421 14.1421 17.5 10 17.5H3C2.79779 17.5 2.61549 17.3782 2.53809 17.1914C2.4607 17.0046 2.50349 16.7895 2.64648 16.6465L4.35547 14.9365C3.20124 13.6175 2.5 11.8906 2.5 10C2.5 5.85786 5.85786 2.5 10 2.5Z"/>
      </svg>
    </button>
    <button id="pi-static-close-button" style="display: inline-flex; align-items: center; justify-content: center; padding: 6px; background: transparent; border: none; cursor: pointer; width: 32px; height: 32px; margin-left: 4px; border-radius: 8px; transition: background 0.2s;">
      <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
        <path d="M15.1464 4.14642C15.3417 3.95121 15.6582 3.95118 15.8534 4.14642C16.0486 4.34168 16.0486 4.65822 15.8534 4.85346L10.7069 9.99997L15.8534 15.1465C16.0486 15.3417 16.0486 15.6583 15.8534 15.8535C15.6826 16.0244 15.4186 16.0461 15.2245 15.918L15.1464 15.8535L9.99989 10.707L4.85338 15.8535C4.65813 16.0486 4.34155 16.0486 4.14634 15.8535C3.95115 15.6583 3.95129 15.3418 4.14634 15.1465L9.29286 9.99997L4.14634 4.85346C3.95129 4.65818 3.95115 4.34162 4.14634 4.14642C4.34154 3.95128 4.65812 3.95138 4.85338 4.14642L9.99989 9.29294L15.1464 4.14642Z" fill="#141413"/>
      </svg>
    </button>
  `,e.style.cssText=`
    position: fixed;
    bottom: 16px;
    left: 50%;
    transform: translateX(-50%);
    display: inline-flex;
    align-items: center;
    padding: 6px 6px 6px 16px;
    background: #FAF9F5;
    border: 0.5px solid rgba(31, 30, 29, 0.30);
    border-radius: 14px;
    box-shadow: 0 40px 80px 0 rgba(0, 0, 0, 0.15);
    z-index: 2147483647;
    pointer-events: none;
    white-space: nowrap;
    user-select: none;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  `;const t=e.querySelector("#pi-static-chat-button"),n=e.querySelector("#pi-static-close-button");return t&&(t.style.pointerEvents="auto",t.addEventListener("mouseenter",()=>t.style.background="#F0EEE6"),t.addEventListener("mouseleave",()=>t.style.background="transparent"),t.addEventListener("click",async()=>{await chrome.runtime.sendMessage({type:"OPEN_SIDEPANEL"})})),n&&(n.style.pointerEvents="auto",n.addEventListener("mouseenter",()=>n.style.background="#F0EEE6"),n.addEventListener("mouseleave",()=>n.style.background="transparent"),n.addEventListener("click",async()=>{await chrome.runtime.sendMessage({type:"DISMISS_STATIC_INDICATOR"}),d()})),e}function v(){o||(o=!0,x(),i?i.style.display="":(i=b(),document.body.appendChild(i)),s?s.style.display="":(s=h(),document.body.appendChild(s)),requestAnimationFrame(()=>{if(i&&(i.style.opacity="1"),s){const e=s.querySelector("#pi-agent-stop-button");e&&(e.style.transform="translateY(0)",e.style.opacity="1")}}))}function g(){if(o){if(o=!1,i&&(i.style.opacity="0"),s){const e=s.querySelector("#pi-agent-stop-button");e&&(e.style.transform="translateY(100px)",e.style.opacity="0")}setTimeout(()=>{o||(i?.parentNode&&(i.parentNode.removeChild(i),i=null),s?.parentNode&&(s.parentNode.removeChild(s),s=null))},300)}}function E(){c||(c=!0,r?r.style.display="":(r=m(),document.body.appendChild(r)),l&&clearInterval(l),y())}function d(){c&&(c=!1,l&&(clearInterval(l),l=null),r?.parentNode&&(r.parentNode.removeChild(r),r=null))}chrome.runtime.onMessage.addListener((e,t,n)=>{switch(e.type){case"SHOW_AGENT_INDICATORS":return v(),n({success:!0}),!1;case"HIDE_AGENT_INDICATORS":return g(),n({success:!0}),!1;case"HIDE_FOR_TOOL_USE":return p=o,u=c,i&&(i.style.display="none"),s&&(s.style.display="none"),r&&c&&(r.style.display="none"),n({success:!0}),!1;case"SHOW_AFTER_TOOL_USE":return p&&(i&&(i.style.display=""),s&&(s.style.display="")),u&&r&&(r.style.display=""),p=!1,u=!1,n({success:!0}),!1;case"SHOW_STATIC_INDICATOR":return E(),n({success:!0}),!1;case"HIDE_STATIC_INDICATOR":return d(),n({success:!0}),!1;default:return!1}});window.addEventListener("beforeunload",()=>{g(),d()});
//# sourceMappingURL=visual-indicator.js.map
