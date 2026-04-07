<script lang="ts">
  import { onMount, onDestroy } from 'svelte';

  const WS_URL = (typeof window !== 'undefined')
    ? (location.protocol === 'https:' ? 'wss' : 'ws') + '://' + location.host + '/ws'
    : '';

  // Estado
  let ws: WebSocket | null = null;
  let connected = false;
  let generating = false;
  let currentResult: any = null;
  let regenHandler: ((msg: any) => void) | null = null;

  // Inputs
  let threadId = 'session-1';
  let urlRef = '';
  let prompt = 'vender esto en Colombia';

  // Historial y stats
  let stats = { generaciones: 0, cacheHits: 0 };
  let sessionHistory: any[] = [];

  // Ángulos con historial de versiones
  let angles = {
    agresivo: [] as string[][],
    emocional: [] as string[][],
    logico: [] as string[][]
  };
  let currentVersion = { agresivo: 0, emocional: 0, logico: 0 };

  // UI
  let logLines: { text: string; cls: string }[] = [];
  let showResults = false;
  let sidebarOpen = false;
  let toastMsg = '';
  let toastVisible = false;
  let exportDisabled = true;

  // Regen state
  let regenLoading = { agresivo: false, emocional: false, logico: false };

  onMount(() => {
    stats = JSON.parse(localStorage.getItem('3pod-stats') || '{"generaciones":0,"cacheHits":0}');
    sessionHistory = JSON.parse(localStorage.getItem('3pod-history') || '[]');
    connect();
  });

  onDestroy(() => ws?.close());

  function connect() {
    ws = new WebSocket(WS_URL);
    ws.onopen = () => { connected = true; };
    ws.onclose = () => { connected = false; setTimeout(connect, 3000); };
    ws.onerror = () => { connected = false; };
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (regenHandler) { regenHandler(msg); return; }
      if (msg.event === 'status') addLog(msg.data.mensaje, msg.data.nodo ? 'active' : '');
      if (msg.event === 'resultado') { renderResultado(msg.data, true); generating = false; addLog('Generacion completada.', 'done'); }
      if (msg.event === 'fin') generating = false;
      if (msg.event === 'error') { addLog('Error: ' + msg.data.mensaje, 'error'); generating = false; }
    };
  }

  function generar() {
    if (!ws || ws.readyState !== WebSocket.OPEN) { showToast('Sin conexion WebSocket'); return; }
    logLines = [];
    showResults = false;
    generating = true;
    addLog('Iniciando motor 3Pod...');
    const payload: any = { action: 'generar', thread_id: threadId, prompt };
    if (urlRef) payload.url_referencia = urlRef;
    ws.send(JSON.stringify(payload));
  }

  function detener() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ action: 'detener' }));
    generating = false;
    addLog('Proceso detenido.', 'error');
  }

  function regenerar(tipo: string) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    regenLoading = { ...regenLoading, [tipo]: true };
    addLog('Regenerando angulos ' + tipo + '...', 'active');
    const payload: any = { action: 'generar', thread_id: 'regen-' + tipo + '-' + Date.now(), prompt: prompt + ' enfoque ' + tipo };
    if (urlRef) payload.url_referencia = urlRef;
    ws.send(JSON.stringify(payload));
    regenHandler = (msg) => {
      if (msg.event === 'resultado' && msg.data.angulos) {
        angles[tipo as keyof typeof angles] = [...angles[tipo as keyof typeof angles], [...msg.data.angulos[tipo]]];
        currentVersion[tipo as keyof typeof currentVersion] = angles[tipo as keyof typeof angles].length - 1;
        regenLoading = { ...regenLoading, [tipo]: false };
        addLog('Angulos ' + tipo + ' regenerados.', 'done');
        regenHandler = null;
      }
    };
  }

  function detenerRegen(tipo: string) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ action: 'detener' }));
    regenLoading = { ...regenLoading, [tipo]: false };
    regenHandler = null;
    addLog('Regeneracion de ' + tipo + ' detenida.', 'error');
  }

  function navVersion(tipo: string, dir: number) {
    const key = tipo as keyof typeof currentVersion;
    const newIdx = currentVersion[key] + dir;
    if (newIdx < 0 || newIdx >= angles[key as keyof typeof angles].length) return;
    currentVersion[key] = newIdx;
    currentVersion = { ...currentVersion };
  }

  function renderResultado(data: any, animate: boolean) {
    currentResult = { ...data, ts: Date.now() };
    const tipos = ['agresivo', 'emocional', 'logico'] as const;
    tipos.forEach(tipo => {
      const frases = data.angulos?.[tipo] || [];
      angles[tipo] = [[...frases]];
      currentVersion[tipo] = 0;
    });
    angles = { ...angles };
    currentVersion = { ...currentVersion };
    stats.generaciones++;
    if (data.from_cache) stats.cacheHits++;
    localStorage.setItem('3pod-stats', JSON.stringify(stats));
    stats = { ...stats };
    sessionHistory = [...sessionHistory, currentResult].slice(-20);
    localStorage.setItem('3pod-history', JSON.stringify(sessionHistory));
    showResults = true;
    exportDisabled = false;
  }

  function loadFromHistory(idx: number) {
    const item = sessionHistory[idx];
    if (!item) return;
    currentResult = item;
    const tipos = ['agresivo', 'emocional', 'logico'] as const;
    tipos.forEach(tipo => {
      angles[tipo] = [[...(item.angulos?.[tipo] || [])]];
      currentVersion[tipo] = 0;
    });
    angles = { ...angles };
    currentVersion = { ...currentVersion };
    showResults = true;
    exportDisabled = false;
    showToast('Historial cargado: ' + item.producto);
  }

  function deleteHistoryItem(idx: number) {
    sessionHistory = sessionHistory.filter((_, i) => i !== idx);
    localStorage.setItem('3pod-history', JSON.stringify(sessionHistory));
    showToast('Eliminado del historial');
  }

  function clearHistory() {
    if (!confirm('¿Limpiar historial y resetear estadísticas?')) return;
    sessionHistory = [];
    stats = { generaciones: 0, cacheHits: 0 };
    localStorage.setItem('3pod-history', JSON.stringify(sessionHistory));
    localStorage.setItem('3pod-stats', JSON.stringify(stats));
    showToast('Historial limpiado');
  }

  function exportarResultado() {
    if (!currentResult) return;
    const blob = new Blob([JSON.stringify(currentResult, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = '3pod-' + (currentResult.producto || 'resultado').replace(/\s+/g, '-').toLowerCase() + '.json';
    a.click();
    showToast('JSON exportado');
  }

  function exportAll() {
    const blob = new Blob([JSON.stringify(sessionHistory, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = '3pod-historial-' + Date.now() + '.json';
    a.click();
    showToast('Historial exportado');
  }

  function copiar(texto: string) {
    navigator.clipboard.writeText(texto).then(() => showToast('Copiado'));
  }

  function addLog(text: string, cls = '') {
    logLines = [...logLines, { text, cls }];
  }

  function showToast(msg: string) {
    toastMsg = msg;
    toastVisible = true;
    setTimeout(() => toastVisible = false, 2000);
  }

  const logIcons: Record<string, string> = { active: '▶', done: '✓', error: '✕', '': '·' };
  const tipos = ['agresivo', 'emocional', 'logico'] as const;
</script>

<div class="layout">
  <!-- SIDEBAR -->
  <aside class="sidebar" class:open={sidebarOpen}>
    <div class="sidebar-header">
      <div class="sidebar-logo">3POD <span>// MOTOR DE LANDINGS</span></div>
    </div>
    <div class="sidebar-stats">
      <div class="stat-item">
        <div class="stat-value">{stats.generaciones}</div>
        <div class="stat-label">GENERACIONES</div>
      </div>
      <div class="stat-item">
        <div class="stat-value">{stats.cacheHits}</div>
        <div class="stat-label">CACHE HITS</div>
      </div>
    </div>
    <div class="sidebar-section-title">// historial</div>
    <div class="history-list">
      {#if sessionHistory.length === 0}
        <div class="history-empty">Sin generaciones aún</div>
      {:else}
        {#each sessionHistory.slice().reverse() as item, i}
          <div class="history-item" class:active={i === 0}>
            <div class="history-item-product" on:click={() => loadFromHistory(sessionHistory.length - 1 - i)} role="button" tabindex="0">{item.producto}</div>
            <div class="history-item-meta">
              <span>${item.precio_calculado}</span>
              {#if item.from_cache}
                <span class="cache-badge">CACHE</span>
              {:else}
                <span class="fresh-badge">FRESH</span>
              {/if}
              <span class="meta-time">{new Date(item.ts).toLocaleTimeString()}</span>
              <span class="delete-btn" on:click={() => deleteHistoryItem(sessionHistory.length - 1 - i)} role="button" tabindex="0">✕</span>
            </div>
          </div>
        {/each}
      {/if}
    </div>
    <div class="sidebar-actions">
      <button class="btn-sidebar" on:click={clearHistory}>LIMPIAR</button>
      <button class="btn-sidebar" on:click={exportAll}>EXPORTAR TODO</button>
    </div>
  </aside>

  {#if sidebarOpen}
    <div class="overlay" on:click={() => sidebarOpen = false} role="button" tabindex="0"></div>
  {/if}

  <!-- MAIN -->
  <main class="main">
    <div class="container">
      <header class="header">
        <div class="header-left">
          <button class="menu-btn" on:click={() => sidebarOpen = !sidebarOpen}>☰</button>
          <div class="logo">MOTOR <span>3POD</span></div>
        </div>
        <div class="status-dot">
          <div class="dot" class:connected class:error={!connected}></div>
          <span>{connected ? 'CONECTADO' : 'DESCONECTADO'}</span>
        </div>
      </header>

      <!-- INPUT -->
      <div class="input-panel">
        <div class="panel-title">// configuración de entrada</div>
        <div class="fields">
          <div class="field">
            <label>THREAD_ID</label>
            <input type="text" bind:value={threadId}>
          </div>
          <div class="field">
            <label>URL_REFERENCIA</label>
            <input type="text" bind:value={urlRef} placeholder="https://...">
          </div>
          <div class="field">
            <label>PROMPT</label>
            <input type="text" bind:value={prompt}>
          </div>
        </div>
        <div class="actions">
          <button class="btn btn-primary" class:loading={generating} disabled={generating} on:click={generar}>
            <div class="spinner"></div>
            <span class="btn-text">GENERAR</span>
          </button>
          <button class="btn btn-danger" disabled={!generating} on:click={detener}>DETENER</button>
          <button class="btn btn-export" disabled={exportDisabled} on:click={exportarResultado}>↓ EXPORTAR JSON</button>
        </div>
      </div>

      <!-- LOG -->
      {#if logLines.length > 0}
        <div class="log">
          {#each logLines as line}
            <div class="log-line {line.cls}">
              <span class="log-icon">{logIcons[line.cls] || '·'}</span>
              {line.text}
            </div>
          {/each}
        </div>
      {/if}

      <!-- RESULTS -->
      {#if showResults && currentResult}
        <div class="results">
          <div class="product-header">
            <div class="product-info">
              <div class="product-name">{currentResult.producto}</div>
              <div class="product-badges">
                {#if currentResult.from_cache}
                  <span class="badge badge-cache">⚡ DESDE CACHE</span>
                {:else}
                  <span class="badge badge-fresh">🔍 SCRAPING FRESCO</span>
                {/if}
              </div>
            </div>
            <div class="precio-badge">
              <span class="precio-label">PRECIO VENTA</span>
              <div class="precio-value">${currentResult.precio_calculado}</div>
            </div>
          </div>

          <!-- ÁNGULOS -->
          <div class="angles-grid">
            {#each tipos as tipo}
              <div class="angle-column {tipo}">
                <div class="angle-header">
                  <span class="angle-title">{tipo.toUpperCase()}</span>
                  {#if regenLoading[tipo]}
                    <button class="btn-stop-regen" on:click={() => detenerRegen(tipo)}>✕</button>
                  {:else}
                    <button class="btn-regenerar" on:click={() => regenerar(tipo)}>↻</button>
                  {/if}
                </div>
                <div class="angle-cards">
                  {#each angles[tipo][currentVersion[tipo]] || [] as frase}
                    <div class="angle-card" on:click={() => copiar(frase)} role="button" tabindex="0">
                      <span>{frase}</span>
                      <span class="copy-hint">COPIAR</span>
                    </div>
                  {/each}
                </div>
                <div class="version-nav">
                  <span class="version-label">v{currentVersion[tipo] + 1} / {angles[tipo].length}</span>
                  <button class="btn-version" disabled={currentVersion[tipo] <= 0} on:click={() => navVersion(tipo, -1)}>◀</button>
                  <button class="btn-version" disabled={currentVersion[tipo] >= angles[tipo].length - 1} on:click={() => navVersion(tipo, 1)}>▶</button>
                </div>
              </div>
            {/each}
          </div>

          <!-- BOTTOM -->
          <div class="bottom-grid">
            <div class="info-panel">
              <div class="info-panel-title">// beneficios</div>
              {#each currentResult.beneficios || [] as b}
                <div class="benefit-item">
                  <div class="benefit-dot"></div>
                  <span>{b}</span>
                </div>
              {/each}
            </div>
            <div class="info-panel">
              <div class="info-panel-title">// imágenes del producto</div>
              <div class="images-grid">
                {#if (currentResult.imagenes || []).filter(Boolean).length === 0}
                  <div class="no-images">Sin imágenes disponibles</div>
                {:else}
                  {#each (currentResult.imagenes || []).filter(Boolean) as src}
                    <div class="img-card">
                      <img {src} alt="producto" on:error={(e) => (e.currentTarget as HTMLElement).parentElement!.style.display='none'}>
                    </div>
                  {/each}
                {/if}
              </div>
            </div>
          </div>
        </div>
      {/if}
    </div>
  </main>
</div>

{#if toastVisible}
  <div class="toast show">{toastMsg}</div>
{/if}

<style>
  :global(:root) {
    --bg: #07080d; --bg2: #0d0f17; --bg3: #12151f; --bg4: #0a0c14;
    --border: rgba(255,255,255,0.06);
    --accent: #00e5ff; --accent3: #b8ff57;
    --text: #e8eaf0; --muted: #4a5068; --muted2: #2a2d3e;
    --agresivo: #ff3d6b; --emocional: #c084fc; --logico: #00e5ff;
  }
  :global(*) { margin: 0; padding: 0; box-sizing: border-box; }
  :global(body) { background: var(--bg); color: var(--text); font-family: 'DM Sans', sans-serif; min-height: 100vh; }
  :global(body::before) { content: ''; position: fixed; inset: 0; background-image: linear-gradient(rgba(0,229,255,0.025) 1px, transparent 1px), linear-gradient(90deg, rgba(0,229,255,0.025) 1px, transparent 1px); background-size: 48px 48px; pointer-events: none; z-index: 0; }

  .layout { display: flex; min-height: 100vh; }
  .sidebar { width: 280px; background: var(--bg4); border-right: 1px solid var(--border); flex-shrink: 0; display: flex; flex-direction: column; position: fixed; top: 0; left: 0; height: 100vh; z-index: 10; overflow: hidden; transition: transform 0.3s; }
  .main { flex: 1; margin-left: 280px; position: relative; z-index: 1; }
  @media (max-width: 900px) { .sidebar { transform: translateX(-100%); } .sidebar.open { transform: translateX(0); } .main { margin-left: 0; } }

  .sidebar-header { padding: 20px; border-bottom: 1px solid var(--border); }
  .sidebar-logo { font-family: 'Bebas Neue', sans-serif; font-size: 1.4rem; color: var(--accent); letter-spacing: 0.1em; }
  .sidebar-logo span { color: var(--muted); font-size: 0.7rem; font-family: 'JetBrains Mono', monospace; display: block; letter-spacing: 0.15em; }
  .sidebar-stats { padding: 16px 20px; border-bottom: 1px solid var(--border); display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  .stat-item { background: var(--bg2); border-radius: 8px; padding: 10px; }
  .stat-value { font-family: 'Bebas Neue', sans-serif; font-size: 1.4rem; color: var(--accent3); }
  .stat-label { font-family: 'JetBrains Mono', monospace; font-size: 0.58rem; color: var(--muted); margin-top: 2px; }
  .sidebar-section-title { font-family: 'JetBrains Mono', monospace; font-size: 0.62rem; color: var(--muted); letter-spacing: 0.15em; text-transform: uppercase; padding: 14px 20px 8px; }
  .history-list { flex: 1; overflow-y: auto; padding: 0 12px 12px; }
  .history-list::-webkit-scrollbar { width: 3px; }
  .history-list::-webkit-scrollbar-thumb { background: var(--muted2); border-radius: 2px; }
  .history-item { background: var(--bg2); border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; margin-bottom: 8px; cursor: pointer; transition: all 0.2s; }
  .history-item:hover { border-color: rgba(0,229,255,0.2); }
  .history-item.active { border-color: var(--accent); background: rgba(0,229,255,0.05); }
  .history-item-product { font-size: 0.82rem; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-bottom: 4px; }
  .history-item-meta { display: flex; align-items: center; gap: 6px; font-family: 'JetBrains Mono', monospace; font-size: 0.6rem; color: var(--muted); }
  .cache-badge { background: rgba(184,255,87,0.1); color: var(--accent3); border: 1px solid rgba(184,255,87,0.2); border-radius: 4px; padding: 1px 5px; font-size: 0.55rem; }
  .fresh-badge { color: var(--accent); font-size: 0.55rem; }
  .meta-time { margin-left: auto; }
  .delete-btn { color: var(--agresivo); padding-left: 6px; cursor: pointer; }
  .history-empty { font-family: 'JetBrains Mono', monospace; font-size: 0.7rem; color: var(--muted); text-align: center; padding: 20px; }
  .sidebar-actions { padding: 12px; border-top: 1px solid var(--border); display: flex; gap: 8px; }
  .btn-sidebar { flex: 1; font-family: 'JetBrains Mono', monospace; font-size: 0.65rem; padding: 8px; border-radius: 6px; border: 1px solid var(--border); background: transparent; color: var(--muted); cursor: pointer; transition: all 0.2s; }
  .btn-sidebar:hover { border-color: rgba(255,255,255,0.15); color: var(--text); }
  .overlay { display: block; position: fixed; inset: 0; background: rgba(0,0,0,0.6); z-index: 9; }

  .container { max-width: 1000px; margin: 0 auto; padding: 32px 24px; }
  .header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 32px; padding-bottom: 20px; border-bottom: 1px solid var(--border); }
  .header-left { display: flex; align-items: center; gap: 16px; }
  .menu-btn { display: none; background: transparent; border: 1px solid var(--border); border-radius: 6px; color: var(--muted); padding: 6px 10px; cursor: pointer; font-size: 1rem; }
  @media (max-width: 900px) { .menu-btn { display: block; } }
  .logo { font-family: 'Bebas Neue', sans-serif; font-size: 2rem; letter-spacing: 0.1em; color: var(--accent); text-shadow: 0 0 24px rgba(0,229,255,0.3); }
  .logo span { color: var(--text); }
  .status-dot { display: flex; align-items: center; gap: 8px; font-family: 'JetBrains Mono', monospace; font-size: 0.72rem; color: var(--muted); }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--muted); transition: all 0.3s; }
  .dot.connected { background: var(--accent3); box-shadow: 0 0 8px var(--accent3); animation: pulse 2s infinite; }
  .dot.error { background: var(--agresivo); box-shadow: 0 0 8px var(--agresivo); }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }

  .input-panel { background: var(--bg2); border: 1px solid var(--border); border-radius: 12px; padding: 24px; margin-bottom: 24px; }
  .panel-title { font-family: 'JetBrains Mono', monospace; font-size: 0.65rem; color: var(--muted); letter-spacing: 0.15em; text-transform: uppercase; margin-bottom: 16px; }
  .fields { display: grid; grid-template-columns: 1fr 2fr 1fr; gap: 12px; margin-bottom: 16px; }
  @media (max-width: 700px) { .fields { grid-template-columns: 1fr; } }
  .field label { display: block; font-family: 'JetBrains Mono', monospace; font-size: 0.62rem; color: var(--muted); letter-spacing: 0.1em; margin-bottom: 6px; }
  .field input { width: 100%; background: var(--bg3); border: 1px solid var(--border); border-radius: 8px; padding: 9px 12px; color: var(--text); font-family: 'JetBrains Mono', monospace; font-size: 0.78rem; outline: none; transition: border-color 0.2s; }
  .field input:focus { border-color: var(--accent); }
  .actions { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
  .btn { font-family: 'Bebas Neue', sans-serif; font-size: 0.95rem; letter-spacing: 0.1em; padding: 10px 24px; border-radius: 8px; border: none; cursor: pointer; transition: all 0.2s; display: flex; align-items: center; gap: 8px; white-space: nowrap; }
  .btn-primary { background: var(--accent); color: var(--bg); }
  .btn-primary:hover:not(:disabled) { background: #33eaff; transform: translateY(-1px); }
  .btn-primary:disabled { background: var(--muted); cursor: not-allowed; }
  .btn-danger { background: transparent; color: var(--agresivo); border: 1px solid var(--agresivo); }
  .btn-danger:disabled { opacity: 0.3; cursor: not-allowed; }
  .btn-export { background: transparent; color: var(--accent3); border: 1px solid rgba(184,255,87,0.3); font-size: 0.75rem; padding: 10px 16px; }
  .btn-export:disabled { opacity: 0.3; cursor: not-allowed; }

  .log { background: var(--bg2); border: 1px solid var(--border); border-radius: 12px; padding: 16px 20px; margin-bottom: 24px; }
  .log-line { font-family: 'JetBrains Mono', monospace; font-size: 0.72rem; color: var(--muted); padding: 3px 0; display: flex; align-items: center; gap: 10px; }
  .log-line.active { color: var(--accent); }
  .log-line.done { color: var(--accent3); }
  .log-line.error { color: var(--agresivo); }
  .log-icon { width: 12px; flex-shrink: 0; }

  .results { animation: fadeIn 0.4s ease; }
  @keyframes fadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
  .product-header { display: flex; align-items: flex-start; justify-content: space-between; margin-bottom: 28px; gap: 16px; flex-wrap: wrap; }
  .product-info { flex: 1; }
  .product-name { font-family: 'Bebas Neue', sans-serif; font-size: 2.4rem; line-height: 1; color: var(--text); letter-spacing: 0.05em; margin-bottom: 8px; }
  .product-badges { display: flex; gap: 8px; }
  .badge { font-family: 'JetBrains Mono', monospace; font-size: 0.62rem; padding: 3px 8px; border-radius: 4px; }
  .badge-cache { background: rgba(184,255,87,0.1); color: var(--accent3); border: 1px solid rgba(184,255,87,0.25); }
  .badge-fresh { background: rgba(0,229,255,0.08); color: var(--accent); border: 1px solid rgba(0,229,255,0.2); }
  .precio-badge { background: var(--bg2); border: 1px solid var(--accent3); border-radius: 10px; padding: 12px 18px; text-align: center; }
  .precio-label { font-family: 'JetBrains Mono', monospace; font-size: 0.6rem; color: var(--muted); display: block; margin-bottom: 2px; }
  .precio-value { font-family: 'Bebas Neue', sans-serif; font-size: 1.9rem; color: var(--accent3); }

  .angles-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; margin-bottom: 24px; }
  @media (max-width: 800px) { .angles-grid { grid-template-columns: 1fr; } }
  .angle-column { background: var(--bg2); border: 1px solid var(--border); border-radius: 12px; overflow: hidden; }
  .angle-column.agresivo { border-top: 2px solid var(--agresivo); }
  .angle-column.emocional { border-top: 2px solid var(--emocional); }
  .angle-column.logico { border-top: 2px solid var(--logico); }
  .angle-header { padding: 12px 16px; display: flex; align-items: center; gap: 8px; border-bottom: 1px solid var(--border); }
  .angle-title { font-family: 'Bebas Neue', sans-serif; font-size: 1rem; letter-spacing: 0.12em; flex: 1; }
  .angle-column.agresivo .angle-title { color: var(--agresivo); }
  .angle-column.emocional .angle-title { color: var(--emocional); }
  .angle-column.logico .angle-title { color: var(--logico); }
  .btn-regenerar, .btn-stop-regen { font-family: 'JetBrains Mono', monospace; font-size: 0.6rem; padding: 4px 8px; border-radius: 5px; cursor: pointer; transition: all 0.2s; background: transparent; letter-spacing: 0.05em; }
  .angle-column.agresivo .btn-regenerar { color: var(--agresivo); border: 1px solid rgba(255,61,107,0.3); }
  .angle-column.emocional .btn-regenerar { color: var(--emocional); border: 1px solid rgba(192,132,252,0.3); }
  .angle-column.logico .btn-regenerar { color: var(--logico); border: 1px solid rgba(0,229,255,0.3); }
  .btn-stop-regen { color: var(--agresivo); border: 1px solid rgba(255,61,107,0.4); }
  .angle-cards { padding: 12px; display: flex; flex-direction: column; gap: 8px; min-height: 120px; }
  .angle-card { background: var(--bg3); border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; font-size: 0.82rem; line-height: 1.55; cursor: pointer; transition: all 0.2s; position: relative; }
  .angle-card:hover { border-color: rgba(255,255,255,0.12); transform: translateY(-1px); }
  .copy-hint { position: absolute; top: 7px; right: 9px; font-family: 'JetBrains Mono', monospace; font-size: 0.55rem; color: var(--muted); opacity: 0; transition: opacity 0.2s; }
  .angle-card:hover .copy-hint { opacity: 1; }
  .version-nav { display: flex; align-items: center; gap: 6px; padding: 8px 12px; border-top: 1px solid var(--border); }
  .version-label { font-family: 'JetBrains Mono', monospace; font-size: 0.6rem; color: var(--muted); flex: 1; }
  .btn-version { background: transparent; border: 1px solid var(--border); border-radius: 4px; color: var(--muted); font-family: 'JetBrains Mono', monospace; font-size: 0.65rem; padding: 2px 7px; cursor: pointer; }
  .btn-version:disabled { opacity: 0.2; cursor: not-allowed; }

  .bottom-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  @media (max-width: 700px) { .bottom-grid { grid-template-columns: 1fr; } }
  .info-panel { background: var(--bg2); border: 1px solid var(--border); border-radius: 12px; padding: 18px; }
  .info-panel-title { font-family: 'JetBrains Mono', monospace; font-size: 0.62rem; color: var(--muted); letter-spacing: 0.12em; text-transform: uppercase; margin-bottom: 12px; }
  .benefit-item { display: flex; align-items: flex-start; gap: 10px; padding: 7px 0; border-bottom: 1px solid var(--border); font-size: 0.82rem; line-height: 1.5; }
  .benefit-item:last-child { border-bottom: none; }
  .benefit-dot { width: 5px; height: 5px; border-radius: 50%; background: var(--accent3); flex-shrink: 0; margin-top: 8px; }
  .images-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
  .img-card { aspect-ratio: 1; border-radius: 8px; overflow: hidden; background: var(--bg3); border: 1px solid var(--border); }
  .img-card img { width: 100%; height: 100%; object-fit: cover; transition: transform 0.3s; }
  .img-card:hover img { transform: scale(1.06); }
  .no-images { grid-column: 1 / -1; font-family: 'JetBrains Mono', monospace; font-size: 0.7rem; color: var(--muted); text-align: center; padding: 20px 0; }

  .toast { position: fixed; bottom: 20px; right: 20px; background: var(--bg3); border: 1px solid var(--accent3); border-radius: 8px; padding: 10px 16px; font-family: 'JetBrains Mono', monospace; font-size: 0.72rem; color: var(--accent3); z-index: 200; opacity: 0; transform: translateY(8px); transition: all 0.3s; }
  .toast.show { opacity: 1; transform: translateY(0); }

  .spinner { width: 13px; height: 13px; border: 2px solid rgba(0,0,0,0.3); border-top-color: var(--bg); border-radius: 50%; animation: spin 0.6s linear infinite; display: none; }
  .btn-primary.loading .spinner { display: block; }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>