(function(){const i=document.createElement("link").relList;if(i&&i.supports&&i.supports("modulepreload"))return;for(const e of document.querySelectorAll('link[rel="modulepreload"]'))a(e);new MutationObserver(e=>{for(const t of e)if(t.type==="childList")for(const s of t.addedNodes)s.tagName==="LINK"&&s.rel==="modulepreload"&&a(s)}).observe(document,{childList:!0,subtree:!0});function l(e){const t={};return e.integrity&&(t.integrity=e.integrity),e.referrerPolicy&&(t.referrerPolicy=e.referrerPolicy),e.crossOrigin==="use-credentials"?t.credentials="include":e.crossOrigin==="anonymous"?t.credentials="omit":t.credentials="same-origin",t}function a(e){if(e.ep)return;e.ep=!0;const t=l(e);fetch(e.href,t)}})();const c=document.getElementById("app");c.innerHTML=`
  <h1 style="font-size: 1.5rem; font-weight: bold; margin-bottom: 1.5rem;">Surf Settings</h1>
  
  <section style="margin-bottom: 2rem;">
    <h2 style="font-size: 1.125rem; font-weight: 600; margin-bottom: 1rem;">Debug Mode</h2>
    <label style="display: flex; align-items: center; gap: 0.5rem;">
      <input type="checkbox" id="debug-mode" style="width: 1rem; height: 1rem;" />
      <span>Enable debug logging</span>
    </label>
  </section>
  
  <section style="margin-bottom: 2rem;">
    <h2 style="font-size: 1.125rem; font-weight: 600; margin-bottom: 1rem;">Static Indicator</h2>
    <label style="display: flex; align-items: center; gap: 0.5rem;">
      <span>Heartbeat interval (seconds):</span>
      <input type="number" id="heartbeat-interval" min="5" max="60" value="10" style="width: 4rem; padding: 0.25rem 0.5rem; border: 1px solid #ccc; border-radius: 0.25rem;" />
    </label>
    <p class="muted" style="font-size: 0.875rem; margin-top: 0.5rem;">
      How often the static indicator checks if Surf is still active (5-60 seconds).
    </p>
  </section>
  
  <section style="margin-bottom: 2rem;">
    <h2 style="font-size: 1.125rem; font-weight: 600; margin-bottom: 1rem;">About</h2>
    <p class="muted">
      Surf v${chrome.runtime.getManifest().version}
    </p>
  </section>
`;const n=document.getElementById("debug-mode");n&&(chrome.storage.local.get("debugMode").then(({debugMode:r})=>{n.checked=!!r}),n.addEventListener("change",()=>{chrome.storage.local.set({debugMode:n.checked})}));const o=document.getElementById("heartbeat-interval");o&&(chrome.storage.local.get("heartbeatInterval").then(({heartbeatInterval:r})=>{o.value=String(r??10)}),o.addEventListener("change",()=>{const r=Math.max(5,Math.min(60,parseInt(o.value,10)||10));o.value=String(r),chrome.storage.local.set({heartbeatInterval:r})}));
//# sourceMappingURL=options.js.map
