/*
 * claude-free-token-meter · content.js
 *
 * Estimación local y aproximada del contexto y del saldo de la ventana
 * gratuita de Claude. Todo el cálculo ocurre en este archivo, dentro del
 * navegador. No hay conexiones de ningún tipo con servidores externos.
 *
 * Secciones:
 *   1. Constantes
 *   2. Utilidades puras
 *   3. Modelo matemático (funciones puras, sin DOM)
 *   4. Escaneo del DOM y Context Sources
 *   5. Almacenamiento y estado global
 *   6. Registro de consumo, cambio de chat y ahorro
 *   7. Interfaz (#cftm-root)
 *   8. Ciclo de vida
 */
(() => {
  'use strict';

  if (window.__cftmLoaded) {
    return;
  }
  window.__cftmLoaded = true;

  /* ====================================================================
   * 1. CONSTANTES
   * ==================================================================== */

  const VERSION = '1.0.0';
  const SELECTORS_VERSION = 1;
  const ROOT_ID = 'cftm-root';
  const KEY_SETTINGS = 'cftm_settings';
  const KEY_STATE = 'cftm_state';
  const LOCK_NAME = 'cftm-state-lock';

  const WINDOW_MS = 18000000;
  const COOLDOWN_MS = 800;
  const DEBOUNCE_MS = 300;
  const MAX_WAIT_MS = 1000;
  const URL_POLL_MS = 2000;
  const TICK_MS = 30000;
  const CONFIRM_FIRST_MS = 700;
  const CONFIRM_SECOND_MS = 1600;
  const TOAST_MS = 3500;
  const DRAG_THRESHOLD_PX = 4;

  const MAX_CALIBRATIONS = 25;
  const MAX_SENDS = 50;
  const MIN_CALIBRATION_CONSUMPTION = 500;
  const DEFAULT_BUDGET = 65000;
  const DEFAULT_PROJECT_TOKENS = 5000;
  const MIN_BUDGET = 1000;
  const MAX_SETTING_VALUE = 10000000;

  const TEXT_DIVISOR = 3.2;
  const CODE_DIVISOR = 2.8;
  const MAX_DOC_TOKENS = 200000;
  const COLLAPSED_ARTIFACT_TOKENS = 1000;

  const NEW_CHAT_MIN_CONTEXT = 3000;
  const DROP_MIN_TOKENS = 2000;
  const DROP_MIN_RATIO = 0.15;
  const DROP_PERSIST_MS = 1500;
  const CHAT_HYDRATION_MS = 2500;

  /* Documentos ---------------------------------------------------------- */

  const CHARS_PER_KB = {
    TXT: 1024, XML: 1024, JSON: 1024, CODIGO: 1024, CSV: 1024,
    DOCX: 250, PDF: 250, XLSX: 250, ZIP: 250
  };
  const DOC_MULTIPLIER = {
    TXT: 1.0, XML: 1.1, JSON: 1.1, CODIGO: 1.15, CSV: 1.2,
    DOCX: 1.25, PDF: 1.3, XLSX: 1.35, ZIP: 1.5
  };
  const DOC_FALLBACK_TOKENS = {
    PDF: 2500, DOCX: 2000, XLSX: 2500, CSV: 2200, JSON: 1800,
    CODIGO: 1800, ZIP: 3500, TXT: 1500, XML: 1800
  };
  const DOC_FALLBACK_UNKNOWN = 1500;

  const EXT_TO_TYPE = {
    pdf: 'PDF', doc: 'DOCX', docx: 'DOCX', xls: 'XLSX', xlsx: 'XLSX', xlsm: 'XLSX',
    csv: 'CSV', tsv: 'CSV',
    txt: 'TXT', md: 'TXT', rtf: 'TXT', log: 'TXT',
    json: 'JSON', jsonl: 'JSON',
    xml: 'XML', html: 'XML', htm: 'XML', svg: 'XML',
    zip: 'ZIP', tar: 'ZIP', gz: 'ZIP', tgz: 'ZIP', rar: 'ZIP', '7z': 'ZIP',
    js: 'CODIGO', jsx: 'CODIGO', ts: 'CODIGO', tsx: 'CODIGO', py: 'CODIGO',
    java: 'CODIGO', cpp: 'CODIGO', cs: 'CODIGO', go: 'CODIGO', rs: 'CODIGO',
    rb: 'CODIGO', php: 'CODIGO', swift: 'CODIGO', kt: 'CODIGO', sql: 'CODIGO',
    sh: 'CODIGO', yml: 'CODIGO', yaml: 'CODIGO', toml: 'CODIGO', ini: 'CODIGO',
    css: 'CODIGO', scss: 'CODIGO', lua: 'CODIGO', vue: 'CODIGO', dart: 'CODIGO'
  };
  const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'heic', 'avif'];
  const TYPE_WORD_TO_TYPE = {
    PDF: 'PDF', DOCX: 'DOCX', DOC: 'DOCX', XLSX: 'XLSX', XLS: 'XLSX', CSV: 'CSV',
    TXT: 'TXT', MD: 'TXT', JSON: 'JSON', XML: 'XML', ZIP: 'ZIP'
  };

  const FILE_EXT_ALTERNATION = Object.keys(EXT_TO_TYPE)
    .concat(IMAGE_EXTS)
    .sort((a, b) => b.length - a.length)
    .join('|');
  const FILE_NAME_RE = new RegExp(
    '([^\\s"\'<>|\\\\/:*?\\u2026]{1,100}\\.(?:' + FILE_EXT_ALTERNATION + '))(?![A-Za-z0-9_])',
    'i'
  );
  const TYPE_WORD_RE = /\b(PDF|DOCX|DOC|XLSX|XLS|CSV|TXT|MD|JSON|XML|ZIP)\b/;

  /* Imágenes ------------------------------------------------------------ */

  const IMAGE_TOKENS = { pequena: 500, mediana: 1000, grande: 2000 };

  /* Confianza ----------------------------------------------------------- */

  const CONFIDENCE_WEIGHT = { alta: 0, media: 0.25, baja: 0.6, muy_baja: 1 };
  const SOURCE_LABELS = {
    mensajes: 'Mensajes',
    documentos: 'Documentos',
    imagenes: 'Imágenes',
    artefactos: 'Artefactos',
    proyecto: 'Proyecto'
  };
  const SOURCE_ORDER = ['mensajes', 'documentos', 'imagenes', 'artefactos', 'proyecto'];
  const CONFIDENCE_LABELS = { alta: 'Alta', media: 'Media', baja: 'Baja', muy_baja: 'Muy baja' };

  /* Selectores (versionados: actualizar aquí si claude.ai cambia) -------- */

  const SEL = {
    userMessage: [
      '[data-testid="user-message"]',
      '.font-user-message',
      '[class*="font-user-message"]'
    ],
    assistantMessage: [
      '[data-testid="assistant-message"]',
      '.font-claude-response',
      '.font-claude-message',
      '[class*="font-claude-response"]',
      '[class*="font-claude-message"]'
    ],
    composer: [
      'div.ProseMirror[contenteditable="true"]',
      'div[contenteditable="true"][role="textbox"]',
      'fieldset div[contenteditable="true"]',
      'div[contenteditable="true"]'
    ],
    artifactPanel: [
      '[data-testid="artifact-content"]',
      '#markdown-artifact',
      '[data-testid="artifact-panel"]',
      '[data-testid*="artifact-panel" i]',
      '[class*="artifact-panel" i]'
    ],
    artifactCard: ['[data-testid*="artifact" i]'],
    docCard: [
      '[data-testid*="file" i]',
      '[data-testid*="attachment" i]',
      '[data-testid*="thumbnail" i]',
      '[data-testid*="document" i]'
    ],
    docLabel: ['[aria-label*="."]', '[title*="."]'],
    thumb: [
      '[data-testid*="file" i]',
      '[data-testid*="attachment" i]',
      '[data-testid*="thumbnail" i]',
      '[data-testid*="image" i]'
    ],
    projectArea: ['[data-testid*="project" i]', '[data-testid*="knowledge" i]']
  };
  const JOIN = (list) => list.join(',');
  const USER_SEL = JOIN(SEL.userMessage);
  const ASSISTANT_SEL = JOIN(SEL.assistantMessage);
  const MESSAGE_SEL = JOIN(SEL.userMessage.concat(SEL.assistantMessage));
  const PANEL_SEL = JOIN(SEL.artifactPanel);
  const DOC_CARD_SEL = JOIN(SEL.docCard);
  const THUMB_SEL = JOIN(SEL.thumb);
  const PROJECT_AREA_SEL = JOIN(SEL.projectArea);
  const EXCLUDED_SEL = '#' + ROOT_ID + ', nav, [role="navigation"]';
  const REMOVE_IN_CLONE =
    'button, svg, style, script, noscript, textarea, input, select, [aria-hidden="true"], [hidden]';

  const STOP_BUTTON_SEL =
    'button[aria-label*="Stop" i], button[aria-label*="Detener" i], button[aria-label*="Parar" i]';

  const ACTION_PATTERNS = {
    send: /^(send( message)?|enviar( mensaje)?)$/i,
    retry: /^(retry|try again|reintentar|volver a intentar)$/i,
    regenerate: /^(regenerate|regenerar)$/i,
    continue: /^(continue|continuar)$/i,
    rewrite: /^(rewrite|reescribir)$/i
  };

  const DEFAULT_SETTINGS = {
    presupuesto: DEFAULT_BUDGET,
    tokensProyectoEstimados: DEFAULT_PROJECT_TOKENS,
    proyectoModo: 'auto',
    tema: 'auto',
    modo: 'compact',
    colapsado: false,
    posicion: null
  };

  /* ====================================================================
   * 2. UTILIDADES PURAS
   * ==================================================================== */

  const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
  const finiteOr = (value, fallback) => (typeof value === 'number' && isFinite(value) ? value : fallback);

  const numberFormat = (() => {
    try {
      return new Intl.NumberFormat('es-ES');
    } catch (err) {
      return { format: (n) => String(n) };
    }
  })();

  function fmtInt(n) {
    return numberFormat.format(Math.round(finiteOr(n, 0)));
  }

  function fmtApprox(n) {
    return '\u2248 ' + fmtInt(n);
  }

  function fmtDuration(ms) {
    const minutes = Math.max(0, Math.floor(ms / 60000));
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    if (hours === 0 && rest === 0) {
      return '<1m';
    }
    return hours + 'h ' + rest + 'm';
  }

  function fmtClock(timestamp) {
    try {
      return new Date(timestamp).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
    } catch (err) {
      return '';
    }
  }

  function parseSizeKB(text) {
    if (!text) {
      return null;
    }
    const match = /(\d{1,3}(?:,\d{3})+|\d+(?:[.,]\d+)?)\s*(bytes?|kb|mb|gb|b)\b/i.exec(text);
    if (!match) {
      return null;
    }
    let raw = match[1];
    if (/^\d{1,3}(,\d{3})+$/.test(raw)) {
      raw = raw.replace(/,/g, '');
    } else {
      raw = raw.replace(',', '.');
    }
    const value = parseFloat(raw);
    if (!isFinite(value) || value <= 0) {
      return null;
    }
    const unit = match[2].toLowerCase();
    if (unit === 'gb') {
      return value * 1048576;
    }
    if (unit === 'mb') {
      return value * 1024;
    }
    if (unit === 'kb') {
      return value;
    }
    return value / 1024;
  }

  function findFileName(text) {
    if (!text) {
      return null;
    }
    const match = FILE_NAME_RE.exec(text);
    return match ? match[1] : null;
  }

  function extensionOf(name) {
    if (!name) {
      return null;
    }
    const index = name.lastIndexOf('.');
    if (index < 0 || index === name.length - 1) {
      return null;
    }
    return name.slice(index + 1).toLowerCase();
  }

  /* Separa los bloques ``` del texto de un borrador. */
  function estimateDraft(text) {
    if (!text) {
      return { chars: 0, tokens: 0, codeTokens: 0 };
    }
    const parts = text.split('```');
    let textChars = 0;
    let codeChars = 0;
    for (let i = 0; i < parts.length; i += 1) {
      if (i % 2 === 1) {
        codeChars += parts[i].length;
      } else {
        textChars += parts[i].replace(/\s+/g, ' ').length;
      }
    }
    const codeTokens = codeChars / CODE_DIVISOR;
    return {
      chars: text.trim().length,
      tokens: Math.round(textChars / TEXT_DIVISOR + codeTokens),
      codeTokens: Math.round(codeTokens)
    };
  }

  function estimateDocTokens(type, sizeKB) {
    if (sizeKB != null && sizeKB > 0) {
      const calcType = CHARS_PER_KB[type] ? type : 'DOCX';
      const base = (sizeKB * CHARS_PER_KB[calcType]) / TEXT_DIVISOR;
      const tokens = Math.round(base * DOC_MULTIPLIER[calcType]);
      return { tokens: Math.min(MAX_DOC_TOKENS, tokens), hasSize: true };
    }
    const fallback = DOC_FALLBACK_TOKENS[type];
    return { tokens: fallback != null ? fallback : DOC_FALLBACK_UNKNOWN, hasSize: false };
  }

  function bucketForImage(longestSide, assumeMedium) {
    if (assumeMedium || !longestSide) {
      return 'mediana';
    }
    if (longestSide <= 512) {
      return 'pequena';
    }
    if (longestSide <= 1280) {
      return 'mediana';
    }
    return 'grande';
  }

  function sameSize(a, b) {
    if (a == null || b == null) {
      return true;
    }
    return Math.abs(a - b) <= Math.max(0.5, 0.05 * Math.max(a, b));
  }

  function isNewChatPath(path) {
    return path === '/' || path === '/new' || path.indexOf('/new/') === 0;
  }

  function isChatPath(path) {
    return /^\/chat\//.test(path);
  }

  /* ====================================================================
   * 3. MODELO MATEMÁTICO (puro)
   * ==================================================================== */

  function normalizeWindow(state, now) {
    if (state.windowStart != null && now >= state.windowStart + WINDOW_MS) {
      state.windowStart = null;
      state.consumo = 0;
      return true;
    }
    return false;
  }

  function effectiveWindow(state, now) {
    if (state.windowStart == null || now >= state.windowStart + WINDOW_MS) {
      return { started: false, startAt: null, endAt: null, remainingMs: null, consumo: 0 };
    }
    const endAt = state.windowStart + WINDOW_MS;
    return {
      started: true,
      startAt: state.windowStart,
      endAt,
      remainingMs: endAt - now,
      consumo: Math.max(0, state.consumo)
    };
  }

  function computeBudget(calibrations, manualBudget) {
    const manual = Math.max(MIN_BUDGET, finiteOr(manualBudget, DEFAULT_BUDGET));
    const n = calibrations.length;
    if (n === 0) {
      return { n: 0, manual, calibrado: null, lambda: 0, efectivo: manual, cv: 0 };
    }
    let sumWeights = 0;
    let sumWeighted = 0;
    for (let i = 0; i < n; i += 1) {
      const value = calibrations[n - 1 - i].consumoEstimado;
      const weight = Math.pow(0.85, i);
      sumWeights += weight;
      sumWeighted += weight * value;
    }
    const calibrado = sumWeighted / sumWeights;
    let sumVariance = 0;
    for (let i = 0; i < n; i += 1) {
      const value = calibrations[n - 1 - i].consumoEstimado;
      const weight = Math.pow(0.85, i);
      sumVariance += weight * (value - calibrado) * (value - calibrado);
    }
    const deviation = Math.sqrt(sumVariance / sumWeights);
    const cv = n >= 2 && calibrado > 0 ? Math.min(1, deviation / calibrado) : 0;
    const lambda = n / (n + 2);
    const efectivo = Math.max(MIN_BUDGET, lambda * calibrado + (1 - lambda) * manual);
    return { n, manual, calibrado, lambda, efectivo, cv };
  }

  function computeBalance(budget, consumo, uncertainFraction) {
    const baseWidth = 0.5 / Math.sqrt(1 + budget.n);
    const width = clamp(baseWidth * (1 + budget.cv) + 0.25 * uncertainFraction, 0.05, 0.85);
    const estimated = Math.max(0, budget.efectivo - consumo);
    const min = Math.max(0, budget.efectivo * (1 - width) - consumo);
    const max = Math.max(0, budget.efectivo * (1 + width) - consumo);
    return { estimado: estimated, min, max, ancho: width };
  }

  function calibrationLevel(n) {
    if (n <= 2) {
      return 'Baja';
    }
    if (n <= 10) {
      return 'Media';
    }
    return 'Alta';
  }

  function computeRemaining(sends, balance, nextCost) {
    const last = sends.slice(-10).map((s) => s.tokens).filter((t) => t > 0);
    const average = last.length > 0 ? last.reduce((a, b) => a + b, 0) / last.length : 0;
    const similar = average > 0 ? Math.floor(balance / average) : null;

    let delta = 0;
    if (last.length >= 2) {
      let sum = 0;
      for (let i = 1; i < last.length; i += 1) {
        sum += last[i] - last[i - 1];
      }
      delta = Math.max(0, sum / (last.length - 1));
    }

    const cost = nextCost > 0 ? nextCost : average;
    let growing = null;
    if (cost > 0) {
      if (delta > 0) {
        const b = cost - delta / 2;
        const discriminant = b * b + 2 * delta * balance;
        growing = Math.max(0, Math.floor((-b + Math.sqrt(discriminant)) / delta + 1e-9));
      } else {
        growing = Math.floor(balance / cost + 1e-9);
      }
    }
    return { promedio: average, similares: similar, conCrecimiento: growing, delta };
  }

  function computeHealth(total, effectiveBudget, userTurns, topShare, heavyCount) {
    const ratio = effectiveBudget > 0 ? total / effectiveBudget : 0;
    const p1 = Math.min(55, 110 * ratio);
    const p2 = Math.min(20, Math.max(0, userTurns - 6));
    const p3 = total >= 3000 && topShare > 0.6 ? Math.min(15, (topShare - 0.6) * 37.5) : 0;
    const p4 = Math.min(10, 5 * heavyCount);
    const score = clamp(Math.round(100 - p1 - p2 - p3 - p4), 0, 100);
    let state = 'critico';
    let tone = 'danger';
    let label = 'Crítico';
    if (score >= 80) {
      state = 'excelente';
      tone = 'good';
      label = 'Excelente';
    } else if (score >= 60) {
      state = 'bueno';
      tone = 'fair';
      label = 'Bueno';
    } else if (score >= 40) {
      state = 'pesado';
      tone = 'warn';
      label = 'Pesado';
    }
    return { score, estado: state, tone, label };
  }

  function computePrecision(n, docs, imageCount, hasProject) {
    const withSize = docs.filter((d) => d.hasSize).length;
    const withoutSize = docs.length - withSize;
    const sizeFraction = docs.length > 0 ? withSize / docs.length : 1;
    const raw =
      30 +
      Math.min(40, 4 * n) +
      20 * sizeFraction -
      Math.min(15, 3 * imageCount) -
      (hasProject ? 12 : 0) -
      Math.min(10, 2 * withoutSize);
    return clamp(Math.round(raw), 5, 95);
  }

  function aggregate(sources) {
    const total = sources.reduce((sum, s) => sum + s.estimatedTokens, 0);
    const parts = sources.map((s) => ({
      source: s.source,
      tokens: s.estimatedTokens,
      confidence: s.confidence,
      pct: total > 0 ? (s.estimatedTokens / total) * 100 : 0
    }));
    let top = null;
    for (const part of parts) {
      if (part.tokens > 0 && (top === null || part.tokens > top.tokens)) {
        top = part;
      }
    }
    return { total, parts, top };
  }

  /* Construye las cinco fuentes con el contrato exacto
     { source, estimatedTokens, confidence }. */
  function buildSources(scan, settings) {
    const docsTokens = scan.docs.reduce((sum, d) => sum + d.tokens, 0);
    let docsConfidence = 'alta';
    if (scan.docs.length > 0) {
      if (scan.docs.every((d) => d.hasSize)) {
        docsConfidence = 'media';
      } else {
        const unsized = scan.docs.filter((d) => !d.hasSize).reduce((sum, d) => sum + d.tokens, 0);
        docsConfidence = docsTokens > 0 && unsized / docsTokens > 0.5 ? 'baja' : 'media';
      }
    }
    const imageTokens = scan.images.reduce((sum, i) => sum + i.tokens, 0);
    const projectIncluded =
      settings.proyectoModo === 'siempre' ||
      (settings.proyectoModo === 'auto' && scan.project.active);

    return {
      projectIncluded,
      list: [
        { source: 'mensajes', estimatedTokens: scan.messages.tokens, confidence: 'alta' },
        { source: 'documentos', estimatedTokens: docsTokens, confidence: docsConfidence },
        { source: 'imagenes', estimatedTokens: imageTokens, confidence: 'muy_baja' },
        {
          source: 'artefactos',
          estimatedTokens: scan.artifacts.tokens,
          confidence: scan.artifacts.collapsedCount > 0 ? 'baja' : 'alta'
        },
        {
          source: 'proyecto',
          estimatedTokens: projectIncluded ? Math.max(0, settings.tokensProyectoEstimados) : 0,
          confidence: 'muy_baja'
        }
      ]
    };
  }

  function computeModel(scan, state, settings, now) {
    const built = buildSources(scan, settings);
    const agg = aggregate(built.list);
    const win = effectiveWindow(state, now);
    const budget = computeBudget(state.calibraciones, settings.presupuesto);

    let uncertain = 0;
    if (agg.total > 0) {
      for (const part of agg.parts) {
        uncertain += part.tokens * CONFIDENCE_WEIGHT[part.confidence];
      }
      uncertain /= agg.total;
    }

    const balance = computeBalance(budget, win.consumo, uncertain);
    const nextCost = agg.total + scan.draftTokens;
    const topShare = agg.top && agg.total > 0 ? agg.top.tokens / agg.total : 0;
    const heavy = scan.docs.filter((d) => d.tokens > 10000).length;
    const health = computeHealth(agg.total, budget.efectivo, scan.messages.userCount, topShare, heavy);
    const precision = computePrecision(budget.n, scan.docs, scan.images.length, built.projectIncluded);
    const remaining = computeRemaining(state.envios, balance.estimado, nextCost);

    const gaugePct = clamp((win.consumo / budget.efectivo) * 100, 0, 100);
    const rangeStart = clamp((win.consumo / (budget.efectivo * (1 + balance.ancho))) * 100, 0, 100);
    const rangeEnd = clamp(
      (win.consumo / Math.max(1, budget.efectivo * (1 - balance.ancho))) * 100,
      rangeStart,
      100
    );

    const messageTokens = agg.parts[0].tokens;
    const docTokens = agg.parts[1].tokens;
    const imageTokens = agg.parts[2].tokens;

    return {
      sources: built.list,
      projectIncluded: built.projectIncluded,
      agg,
      draftTokens: scan.draftTokens,
      nextCost,
      trackTotal: messageTokens + docTokens + imageTokens,
      health,
      window: win,
      budget,
      balance,
      calibration: { n: budget.n, level: calibrationLevel(budget.n) },
      precision,
      remaining,
      ahorro: state.ahorro,
      gauge: {
        pct: gaugePct,
        rangeStart,
        rangeEnd,
        tone: gaugePct >= 85 ? 'danger' : gaugePct >= 60 ? 'warn' : 'ok'
      }
    };
  }

  /* Analizador de ahorro ------------------------------------------------ */

  function impactOf(saving, total) {
    const ratio = saving / Math.max(1, total);
    if (ratio >= 0.25) {
      return 'alto';
    }
    if (ratio >= 0.1) {
      return 'medio';
    }
    return 'bajo';
  }

  function docRule(doc, share, extreme) {
    const t = doc.tokens;
    const name = doc.name || 'archivo sin nombre';
    const lowerName = (doc.name || '').toLowerCase();
    if (extreme) {
      if (doc.tipo === 'PDF' && t >= 8000) {
        return { title: 'PDF muy grande: ' + name, text: 'Extrae solo las páginas necesarias o copia el texto relevante.', factor: 0.8 };
      }
      if (doc.tipo === 'DOCX' && t >= 6000) {
        return { title: 'DOCX grande: ' + name, text: 'Pega solo los apartados relevantes en lugar del documento entero.', factor: 0.7 };
      }
      if (doc.tipo === 'CSV' && t >= 5000) {
        return { title: 'CSV grande: ' + name, text: 'Envía una muestra de filas y una descripción de las columnas.', factor: 0.85 };
      }
      if (doc.tipo === 'JSON' && t >= 5000) {
        return { title: 'JSON extenso: ' + name, text: 'Conserva solo los campos y registros que Claude necesita.', factor: 0.8 };
      }
      if (doc.tipo === 'XLSX' && t >= 6000) {
        return { title: 'Hoja de cálculo grande: ' + name, text: 'Copia solo las hojas y rangos necesarios.', factor: 0.8 };
      }
      if (doc.tipo === 'ZIP' && t >= 6000) {
        return { title: 'Archivo comprimido grande: ' + name, text: 'Descomprime y envía solo los archivos implicados.', factor: 0.8 };
      }
      if (doc.tipo === 'TXT' && t >= 5000 && (doc.ext === 'log' || /log/.test(lowerName))) {
        return { title: 'Log extenso: ' + name, text: 'Filtra las líneas con errores y su contexto inmediato.', factor: 0.85 };
      }
      if (doc.tipo === 'CODIGO' && t >= 6000) {
        return { title: 'Código excesivo: ' + name, text: 'Adjunta solo los archivos o funciones implicados.', factor: 0.6 };
      }
      if (t >= 2000 && share >= 0.1) {
        return { title: 'Documento pesado: ' + name, text: 'Adjunta solo lo necesario o resume el archivo antes de subirlo.', factor: 0.7 };
      }
      return null;
    }
    if (t >= 3000 && share >= 0.2) {
      return { title: 'Reduce ' + name, text: 'Adjunta solo las secciones necesarias o resume el archivo antes de subirlo.', factor: 0.7 };
    }
    return null;
  }

  function analyzeSavings(model, scan, extreme) {
    const total = Math.max(1, model.agg.total);
    const items = [];
    const add = (id, title, text, saving, sumable, forcedImpact) => {
      const value = saving == null ? null : Math.max(0, Math.round(saving));
      items.push({
        id,
        title,
        text,
        ahorro: value,
        sumable: sumable !== false && value != null,
        impacto: forcedImpact || impactOf(value || 0, total)
      });
    };

    scan.docs.forEach((doc, index) => {
      const rule = docRule(doc, doc.tokens / total, extreme);
      if (rule) {
        add('doc-' + index, rule.title, rule.text, doc.tokens * rule.factor, true);
      }
    });

    const msgTokens = model.sources[0].estimatedTokens;
    const longConversation = extreme
      ? msgTokens >= 6000 || scan.messages.userCount >= 10
      : msgTokens >= 8000 || scan.messages.userCount >= 12;
    if (longConversation) {
      add(
        'conversacion',
        'Abre un chat nuevo con un resumen',
        'Pide a Claude un resumen breve y continúa en un chat nuevo: el contexto vuelve casi a cero.',
        msgTokens - 400,
        true
      );
    }

    const codeThreshold = extreme ? 2500 : 3000;
    if (scan.messages.codeTokens >= codeThreshold) {
      add(
        'codigo-mensajes',
        extreme ? 'Código excesivo en la conversación' : 'Evita repetir bloques de código completos',
        'Pega solo la función o el fragmento que cambia en lugar del archivo entero.',
        scan.messages.codeTokens * 0.5,
        !longConversation
      );
    }

    const imageTokens = model.sources[2].estimatedTokens;
    if (imageTokens >= 1000) {
      add(
        'imagenes',
        'Quita o reduce las imágenes',
        'Cada imagen adjunta se vuelve a leer en cada mensaje. Elimina las que ya no necesitas.',
        imageTokens * 0.8,
        true
      );
    }

    const artifactTokens = model.sources[3].estimatedTokens;
    if (artifactTokens >= 3000) {
      add(
        'artefactos',
        'Los artefactos grandes pesan en cada envío',
        'Pide cambios puntuales en lugar de regenerar el artefacto completo.',
        artifactTokens * 0.5,
        true
      );
    }

    const projectTokens = model.sources[4].estimatedTokens;
    if (projectTokens >= 8000 || (projectTokens > 0 && projectTokens / total >= 0.35)) {
      add(
        'proyecto',
        'Revisa el material del Proyecto',
        'Quita del Proyecto los archivos que rara vez usas. Su tamaño real es desconocido.',
        projectTokens * 0.4,
        true
      );
    }

    if (scan.draftTokens >= 2000) {
      add(
        'borrador',
        'Recorta tu borrador',
        'Resume o elimina lo que no sea imprescindible antes de enviar.',
        scan.draftTokens * 0.4,
        true
      );
    }

    if (total >= 5000) {
      add(
        'agrupar',
        'Agrupa varias preguntas en un solo mensaje',
        'Cada mensaje evitado ahorra aproximadamente ' + fmtApprox(total) + ' tokens de relectura.',
        null,
        false,
        total >= 8000 ? 'medio' : 'bajo'
      );
    }

    const rank = { alto: 0, medio: 1, bajo: 2 };
    items.sort((a, b) => rank[a.impacto] - rank[b.impacto] || (b.ahorro || 0) - (a.ahorro || 0));

    const rawTotal = items.reduce((sum, item) => sum + (item.sumable ? item.ahorro : 0), 0);
    return { items, total: Math.round(Math.min(rawTotal, total * 0.9)) };
  }

  /* ====================================================================
   * 4. ESCANEO DEL DOM Y CONTEXT SOURCES
   * ==================================================================== */

  let messageCache = new WeakMap();

  function queryAll(selectors, root) {
    const base = root || document;
    const list = Array.isArray(selectors) ? selectors : [selectors];
    try {
      return Array.from(base.querySelectorAll(list.join(',')));
    } catch (err) {
      const out = [];
      for (const selector of list) {
        try {
          out.push(...base.querySelectorAll(selector));
        } catch (inner) {
          /* selector no válido en este navegador: se ignora */
        }
      }
      return out;
    }
  }

  function isExcluded(el) {
    return !!el.closest(EXCLUDED_SEL);
  }

  /* Conserva solo los nodos más externos (la lista debe estar en orden de
     documento). Los descendientes de un nodo conservado siguen a su ancestro
     de forma contigua, por lo que basta comparar con el último conservado. */
  function outermost(nodes) {
    const kept = [];
    for (const node of nodes) {
      const last = kept.length > 0 ? kept[kept.length - 1] : null;
      if (last && last.contains(node)) {
        continue;
      }
      kept.push(node);
    }
    return kept;
  }

  function stripNodes(root, selector) {
    for (const el of Array.from(root.querySelectorAll(selector))) {
      el.remove();
    }
  }

  function estimateMessageNode(node) {
    const clone = node.cloneNode(true);
    stripNodes(clone, REMOVE_IN_CLONE);
    let codeChars = 0;
    for (const pre of Array.from(clone.querySelectorAll('pre'))) {
      codeChars += (pre.textContent || '').length;
      pre.remove();
    }
    for (const code of Array.from(clone.querySelectorAll('code'))) {
      codeChars += (code.textContent || '').length;
      code.remove();
    }
    const textChars = (clone.textContent || '').replace(/\s+/g, ' ').trim().length;
    const textTokens = textChars / TEXT_DIVISOR;
    const codeTokens = codeChars / CODE_DIVISOR;
    return {
      tokens: Math.round(textTokens + codeTokens),
      codeTokens: Math.round(codeTokens),
      textChars,
      codeChars
    };
  }

  function messageEstimate(node) {
    const length = (node.textContent || '').length;
    const cached = messageCache.get(node);
    if (cached && cached.length === length) {
      return cached;
    }
    const result = estimateMessageNode(node);
    result.length = length;
    messageCache.set(node, result);
    return result;
  }

  function findComposer() {
    const candidates = queryAll(SEL.composer).filter(
      (el) => !isExcluded(el) && !el.closest(MESSAGE_SEL) && el.getClientRects().length > 0
    );
    if (candidates.length === 0) {
      return null;
    }
    let best = candidates[0];
    let bestBottom = -Infinity;
    for (const el of candidates) {
      const bottom = el.getBoundingClientRect().bottom;
      if (bottom >= bestBottom) {
        best = el;
        bestBottom = bottom;
      }
    }
    return best;
  }

  function findComposerRoot(composer) {
    if (!composer) {
      return null;
    }
    const direct = composer.closest('fieldset') || composer.closest('form');
    if (direct) {
      return direct;
    }
    let node = composer;
    for (let i = 0; i < 3 && node.parentElement; i += 1) {
      node = node.parentElement;
    }
    return node;
  }

  function scanMessages() {
    const userNodes = outermost(queryAll(SEL.userMessage)).filter((n) => !isExcluded(n));
    const assistantNodes = outermost(queryAll(SEL.assistantMessage)).filter(
      (n) => !isExcluded(n) && !n.closest(PANEL_SEL) && !n.closest(USER_SEL)
    );
    let tokens = 0;
    let codeTokens = 0;
    for (const node of userNodes) {
      const est = messageEstimate(node);
      tokens += est.tokens;
      codeTokens += est.codeTokens;
    }
    let lastAssistantTokens = 0;
    let lastAssistantLength = 0;
    assistantNodes.forEach((node, index) => {
      const est = messageEstimate(node);
      tokens += est.tokens;
      codeTokens += est.codeTokens;
      if (index === assistantNodes.length - 1) {
        lastAssistantTokens = est.tokens;
        lastAssistantLength = est.length;
      }
    });
    return {
      tokens,
      codeTokens,
      userCount: userNodes.length,
      assistCount: assistantNodes.length,
      lastAssistantTokens,
      lastAssistantLength
    };
  }

  /* Documentos: detección multinivel con deduplicación estricta ---------- */

  function skipForDocs(el) {
    if (isExcluded(el)) {
      return true;
    }
    const tag = el.tagName;
    if (tag === 'INPUT' || tag === 'SCRIPT' || tag === 'STYLE' || tag === 'TEXTAREA') {
      return true;
    }
    return !!(
      el.closest(ASSISTANT_SEL) ||
      el.closest(PANEL_SEL) ||
      el.closest(PROJECT_AREA_SEL) ||
      el.closest('[contenteditable="true"]')
    );
  }

  function describeElement(el) {
    const label = el.getAttribute('aria-label') || '';
    const title = el.getAttribute('title') || '';
    const text = el.children.length <= 12 ? (el.textContent || '').slice(0, 300) : '';
    const levels = [];
    let name = null;

    const fromLabel = findFileName(label);
    const fromTitle = findFileName(title);
    const fromText = findFileName(text);
    if (fromLabel) {
      name = fromLabel;
      levels.push(3);
      if (el.matches('button, [role="button"], a')) {
        levels.push(2);
      }
    }
    if (fromTitle) {
      name = name || fromTitle;
      levels.push(4);
    }
    if (fromText) {
      name = name || fromText;
      levels.push(6);
    }

    let sizeKB = parseSizeKB(text);
    if (sizeKB == null) {
      sizeKB = parseSizeKB(label) || parseSizeKB(title);
    }
    const wordMatch = TYPE_WORD_RE.exec(text) || TYPE_WORD_RE.exec(label);
    if (sizeKB != null || wordMatch) {
      levels.push(5);
    }
    return {
      name,
      sizeKB,
      typeWord: wordMatch ? TYPE_WORD_TO_TYPE[wordMatch[1]] : null,
      levels
    };
  }

  function scanDocuments(composerRoot) {
    const candidates = new Set();
    for (const el of queryAll(SEL.docCard.concat(SEL.docLabel))) {
      candidates.add(el);
    }
    const groups = new Map();
    for (const el of candidates) {
      if (skipForDocs(el)) {
        continue;
      }
      const isCard = el.matches(DOC_CARD_SEL);
      const card = isCard ? el : el.closest(DOC_CARD_SEL) || el;
      const info = describeElement(el);
      if (!info.name && !isCard) {
        continue;
      }
      let group = groups.get(card);
      if (!group) {
        group = {
          name: null,
          sizeKB: null,
          typeWord: null,
          levels: new Set(),
          inComposer: !!(composerRoot && composerRoot.contains(card))
        };
        if (isCard) {
          group.levels.add(1);
        }
        groups.set(card, group);
      }
      if (!group.name && info.name) {
        group.name = info.name;
      }
      if (group.sizeKB == null && info.sizeKB != null) {
        group.sizeKB = info.sizeKB;
      }
      if (!group.typeWord && info.typeWord) {
        group.typeWord = info.typeWord;
      }
      info.levels.forEach((level) => group.levels.add(level));
    }

    const named = new Map();
    const unnamed = [];
    for (const group of groups.values()) {
      const ext = extensionOf(group.name);
      if (ext && IMAGE_EXTS.indexOf(ext) >= 0) {
        continue;
      }
      if (!group.name) {
        if (group.typeWord || group.sizeKB != null) {
          unnamed.push(group);
        }
        continue;
      }
      const key = group.name.toLowerCase();
      const list = named.get(key) || [];
      const match = list.find((other) => sameSize(other.sizeKB, group.sizeKB));
      if (match) {
        if (match.sizeKB == null) {
          match.sizeKB = group.sizeKB;
        }
        if (!match.typeWord) {
          match.typeWord = group.typeWord;
        }
        match.inComposer = match.inComposer && group.inComposer;
        group.levels.forEach((level) => match.levels.add(level));
      } else {
        list.push(group);
        named.set(key, list);
      }
    }

    const entries = [];
    for (const list of named.values()) {
      entries.push(...list);
    }
    entries.push(...unnamed);

    return entries.map((group) => {
      const ext = extensionOf(group.name);
      const type = (ext && EXT_TO_TYPE[ext]) || group.typeWord || null;
      const estimate = estimateDocTokens(type, group.sizeKB);
      return {
        name: group.name,
        ext,
        tipo: type,
        sizeKB: group.sizeKB,
        hasSize: estimate.hasSize,
        tokens: estimate.tokens,
        inComposer: group.inComposer,
        levels: Array.from(group.levels).sort()
      };
    });
  }

  /* Imágenes adjuntas ---------------------------------------------------- */

  function scanImages(composerRoot) {
    const found = [];
    const seen = new Set();
    for (const img of Array.from(document.querySelectorAll('img'))) {
      if (isExcluded(img) || img.closest('header, footer')) {
        continue;
      }
      if (img.closest(ASSISTANT_SEL) || img.closest(PANEL_SEL)) {
        continue;
      }
      const src = img.currentSrc || img.getAttribute('src') || '';
      if (!src) {
        continue;
      }
      const hint = (
        (img.getAttribute('alt') || '') + ' ' +
        (img.className && typeof img.className === 'string' ? img.className : '') + ' ' +
        (img.getAttribute('data-testid') || '')
      ).toLowerCase();
      if (/avatar|logo|icon|emoji|favicon|profile/.test(hint)) {
        continue;
      }
      const inComposer = !!(composerRoot && composerRoot.contains(img));
      const looksAttached =
        !!img.closest(THUMB_SEL) ||
        inComposer ||
        /\/files?\/|\/preview|\/thumbnail|^blob:|^data:image/i.test(src);
      if (!looksAttached) {
        continue;
      }
      const renderedSide = Math.max(img.clientWidth || 0, img.clientHeight || 0);
      const naturalSide = Math.max(img.naturalWidth || 0, img.naturalHeight || 0);
      if (Math.max(renderedSide, naturalSide) < 40) {
        continue;
      }
      const key = src.slice(0, 200);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      const isPreview = /\/preview|\/thumbnail/i.test(src);
      const bucket = bucketForImage(naturalSide || renderedSide, isPreview);
      found.push({ bucket, tokens: IMAGE_TOKENS[bucket], inComposer });
    }
    return found;
  }

  /* Artefactos ------------------------------------------------------------ */

  function artifactTitle(el) {
    const heading = el.querySelector('h1, h2, h3, [data-testid*="title" i]');
    const raw = heading ? heading.textContent : (el.textContent || '').split('\n')[0];
    return (raw || '').replace(/\s+/g, ' ').trim().slice(0, 80).toLowerCase();
  }

  function scanArtifacts() {
    const items = [];
    const panels = outermost(queryAll(SEL.artifactPanel)).filter((n) => !isExcluded(n));
    const openTitles = new Set();
    for (const panel of panels) {
      const estimate = messageEstimate(panel);
      items.push({ tokens: estimate.tokens, visible: true });
      const title = artifactTitle(panel);
      if (title) {
        openTitles.add(title);
      }
    }
    const cards = outermost(queryAll(SEL.artifactCard)).filter(
      (n) => !isExcluded(n) && !n.closest(PANEL_SEL) && !n.matches(PANEL_SEL)
    );
    for (const card of cards) {
      const title = artifactTitle(card);
      if (title && openTitles.has(title)) {
        continue;
      }
      items.push({ tokens: COLLAPSED_ARTIFACT_TOKENS, visible: false });
    }
    return {
      items,
      tokens: items.reduce((sum, item) => sum + item.tokens, 0),
      visibleCount: items.filter((i) => i.visible).length,
      collapsedCount: items.filter((i) => !i.visible).length
    };
  }

  /* Proyecto ---------------------------------------------------------------- */

  function detectProject() {
    const reasons = [];
    if (/^\/projects?\//.test(location.pathname)) {
      reasons.push('url');
    }
    const link = document.querySelector(
      'main a[href*="/project/"], header a[href*="/project/"], [data-testid*="project" i] a[href*="/project/"]'
    );
    if (link && !isExcluded(link)) {
      reasons.push('enlace');
    }
    const marker = document.querySelector('main [data-testid*="project" i], header [data-testid*="project" i]');
    if (marker && !isExcluded(marker)) {
      reasons.push('marcador');
    }
    return { active: reasons.length > 0, reasons };
  }

  /* Escaneo completo ---------------------------------------------------------- */

  function readDraft(composer) {
    if (!composer) {
      return '';
    }
    return (composer.textContent || '').replace(/\u200b/g, '');
  }

  function fullScan() {
    const composer = findComposer();
    const composerRoot = findComposerRoot(composer);
    const messages = scanMessages();
    const docs = scanDocuments(composerRoot);
    const images = scanImages(composerRoot);
    const artifacts = scanArtifacts();
    const project = detectProject();
    const draft = estimateDraft(readDraft(composer));
    return {
      messages,
      docs,
      images,
      artifacts,
      project,
      draft,
      draftTokens: draft.tokens,
      composerPresent: !!composer,
      composerAttachCount:
        docs.filter((d) => d.inComposer).length + images.filter((i) => i.inComposer).length,
      path: location.pathname
    };
  }

  function isGenerating() {
    const buttons = document.querySelectorAll(STOP_BUTTON_SEL);
    for (const button of buttons) {
      if (!isExcluded(button) && button.getClientRects().length > 0) {
        return true;
      }
    }
    return false;
  }

  /* ====================================================================
   * 5. ALMACENAMIENTO Y ESTADO GLOBAL
   * ==================================================================== */

  const S = {
    active: false,
    settings: null,
    state: null,
    scan: null,
    model: null,
    chatKey: null,
    chatSince: 0,
    chatMaxTotal: 0,
    ref: null,
    lowCycles: 0,
    lowSince: 0,
    pendingSaving: 0,
    newChatPending: 0,
    pendingSend: null,
    lastRegisterAt: 0,
    observer: null,
    intervals: [],
    timers: new Set(),
    listeners: [],
    recomputeTimer: null,
    firstPendingAt: null,
    lastScanMs: 0,
    orphaned: false,
    rafId: 0,
    toastTimer: 0,
    analysis: null,
    navigationTarget: null
  };

  let UI = {};

  function storageAvailable() {
    return !!(typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id && chrome.storage && chrome.storage.local);
  }

  function handleStorageError(err) {
    const message = err && err.message ? String(err.message) : String(err);
    if (/context invalidated|receiving end|Extension context/i.test(message)) {
      handleOrphan();
    }
  }

  async function storageGet(keys) {
    if (!storageAvailable()) {
      handleOrphan();
      return {};
    }
    try {
      return await chrome.storage.local.get(keys);
    } catch (err) {
      handleStorageError(err);
      return {};
    }
  }

  async function storageSet(values) {
    if (!storageAvailable()) {
      handleOrphan();
      return false;
    }
    try {
      await chrome.storage.local.set(values);
      return true;
    } catch (err) {
      handleStorageError(err);
      return false;
    }
  }

  function withLock(fn) {
    try {
      if (typeof navigator !== 'undefined' && navigator.locks && typeof navigator.locks.request === 'function') {
        return navigator.locks.request(LOCK_NAME, fn);
      }
    } catch (err) {
      /* sin Web Locks: se ejecuta sin serializar */
    }
    return fn();
  }

  function normalizeSettings(raw) {
    const out = Object.assign({}, DEFAULT_SETTINGS);
    if (!raw || typeof raw !== 'object') {
      return out;
    }
    if (typeof raw.presupuesto === 'number' && isFinite(raw.presupuesto)) {
      out.presupuesto = clamp(Math.round(raw.presupuesto), MIN_BUDGET, MAX_SETTING_VALUE);
    }
    if (typeof raw.tokensProyectoEstimados === 'number' && isFinite(raw.tokensProyectoEstimados)) {
      out.tokensProyectoEstimados = clamp(Math.round(raw.tokensProyectoEstimados), 0, MAX_SETTING_VALUE);
    }
    if (['auto', 'siempre', 'nunca'].indexOf(raw.proyectoModo) >= 0) {
      out.proyectoModo = raw.proyectoModo;
    }
    if (['auto', 'light', 'dark'].indexOf(raw.tema) >= 0) {
      out.tema = raw.tema;
    }
    if (['compact', 'expanded'].indexOf(raw.modo) >= 0) {
      out.modo = raw.modo;
    }
    out.colapsado = raw.colapsado === true;
    if (
      raw.posicion &&
      typeof raw.posicion === 'object' &&
      isFinite(raw.posicion.x) &&
      isFinite(raw.posicion.y)
    ) {
      out.posicion = { x: Math.round(raw.posicion.x), y: Math.round(raw.posicion.y) };
    }
    return out;
  }

  function normalizeState(raw) {
    const out = { windowStart: null, consumo: 0, envios: [], calibraciones: [], ahorro: 0 };
    if (!raw || typeof raw !== 'object') {
      return out;
    }
    if (typeof raw.windowStart === 'number' && isFinite(raw.windowStart)) {
      out.windowStart = raw.windowStart;
    }
    out.consumo = Math.max(0, finiteOr(raw.consumo, 0));
    if (Array.isArray(raw.envios)) {
      out.envios = raw.envios
        .filter((e) => e && isFinite(e.t) && isFinite(e.tokens))
        .map((e) => ({
          t: e.t,
          tokens: Math.max(0, Math.round(e.tokens)),
          tipo: typeof e.tipo === 'string' ? e.tipo.slice(0, 16) : 'envio'
        }))
        .slice(-MAX_SENDS);
    }
    if (Array.isArray(raw.calibraciones)) {
      out.calibraciones = raw.calibraciones
        .filter((c) => c && isFinite(c.timestamp) && isFinite(c.consumoEstimado) && c.consumoEstimado > 0)
        .map((c) => ({ timestamp: c.timestamp, consumoEstimado: Math.round(c.consumoEstimado) }))
        .slice(-MAX_CALIBRATIONS);
    }
    out.ahorro = Math.max(0, finiteOr(raw.ahorro, 0));
    return out;
  }

  /* Lee el estado más reciente, aplica el reinicio automático y el cambio
     pedido, y lo guarda solo si algo cambió. El mutador devuelve true si
     modificó el estado. */
  async function updateState(mutator) {
    return withLock(async () => {
      const res = await storageGet([KEY_STATE]);
      const next = normalizeState(res[KEY_STATE]);
      const now = Date.now();
      let changed = normalizeWindow(next, now);
      if (mutator(next, now) === true) {
        changed = true;
      }
      if (changed) {
        const ok = await storageSet({ [KEY_STATE]: next });
        if (!ok) {
          return false;
        }
        S.state = next;
        deriveAndRender();
        return true;
      }
      S.state = next;
      return false;
    });
  }

  async function updateSettings(patch) {
    Object.assign(S.settings, patch);
    await withLock(async () => {
      const res = await storageGet([KEY_SETTINGS]);
      const current = normalizeSettings(res[KEY_SETTINGS]);
      const next = normalizeSettings(Object.assign({}, current, patch));
      await storageSet({ [KEY_SETTINGS]: next });
    });
  }

  function onStorageChanged(changes, area) {
    if (area !== 'local' || !S.active) {
      return;
    }
    if (changes[KEY_STATE]) {
      S.state = normalizeState(changes[KEY_STATE].newValue);
      deriveAndRender();
    }
    if (changes[KEY_SETTINGS]) {
      const incoming = normalizeSettings(changes[KEY_SETTINGS].newValue);
      incoming.posicion = S.settings.posicion;
      S.settings = incoming;
      applySettingsToUI();
      deriveAndRender();
    }
  }

  function handleOrphan() {
    if (S.orphaned) {
      return;
    }
    S.orphaned = true;
    S.intervals.forEach((id) => clearInterval(id));
    S.intervals = [];
    if (S.observer) {
      S.observer.disconnect();
      S.observer = null;
    }
    if (UI.noteOrphan) {
      UI.noteOrphan.hidden = false;
    }
  }

  function deriveAndRender() {
    if (!S.active || !S.scan || !S.settings || !S.state) {
      return;
    }
    S.model = computeModel(S.scan, S.state, S.settings, Date.now());
    render();
  }

  /* ====================================================================
   * 6. REGISTRO DE CONSUMO, CAMBIO DE CHAT Y AHORRO
   * ==================================================================== */

  function later(fn, ms) {
    const id = setTimeout(() => {
      S.timers.delete(id);
      fn();
    }, ms);
    S.timers.add(id);
    return id;
  }

  function on(target, type, fn, options) {
    target.addEventListener(type, fn, options);
    S.listeners.push([target, type, fn, options]);
  }

  function classifyActionButton(target) {
    if (!target || target.nodeType !== 1) {
      return null;
    }
    const button = target.closest('button, [role="button"], [role="menuitem"], a');
    if (!button || isExcluded(button)) {
      return null;
    }
    const aria = (button.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
    const rawText = (button.textContent || '').replace(/\s+/g, ' ').trim();
    const text = rawText.length <= 30 ? rawText : '';
    const testId = (button.getAttribute('data-testid') || '').toLowerCase();
    const candidates = [aria, text].filter((c) => c.length > 0);

    for (const kind of ['retry', 'regenerate', 'continue', 'rewrite']) {
      if (candidates.some((c) => ACTION_PATTERNS[kind].test(c))) {
        return kind;
      }
    }
    if (candidates.some((c) => ACTION_PATTERNS.send.test(c)) || (/send/.test(testId) && !/stop/.test(testId))) {
      return 'boton';
    }
    return null;
  }

  function onKeydown(event) {
    if (!S.active || event.key !== 'Enter' || event.shiftKey || event.altKey) {
      return;
    }
    if (event.isComposing || event.keyCode === 229) {
      return;
    }
    const composer = findComposer();
    if (!composer || !event.target || !composer.contains(event.target)) {
      return;
    }
    beginAction('enter');
  }

  function onClick(event) {
    if (!S.active) {
      return;
    }
    const kind = classifyActionButton(event.target);
    if (kind) {
      beginAction(kind);
    }
  }

  function beginAction(kind) {
    if (!S.active || S.pendingSend) {
      return;
    }
    const now = Date.now();
    if (now - S.lastRegisterAt < COOLDOWN_MS) {
      return;
    }
    if (isGenerating()) {
      return;
    }
    const scan = fullScan();
    const model = computeModel(scan, S.state, S.settings, now);
    const total = model.agg.total;
    const isSend = kind === 'enter' || kind === 'boton';
    let tokens;

    if (isSend) {
      if (scan.draft.chars === 0 && scan.composerAttachCount === 0) {
        return;
      }
      tokens = total + scan.draftTokens;
    } else if (kind === 'continue') {
      if (scan.messages.assistCount === 0) {
        return;
      }
      tokens = total;
    } else {
      if (scan.messages.assistCount === 0) {
        return;
      }
      tokens = Math.max(0, total - scan.messages.lastAssistantTokens);
    }

    S.pendingSend = {
      kind,
      isSend,
      tokens: Math.max(1, Math.round(tokens)),
      total,
      draftChars: scan.draft.chars,
      attachCount: scan.composerAttachCount,
      userCount: scan.messages.userCount,
      assistLength: scan.messages.lastAssistantLength,
      assistCount: scan.messages.assistCount,
      pendingSaving: S.pendingSaving,
      newChatPending: S.newChatPending
    };
    later(() => confirmAction(1), CONFIRM_FIRST_MS);
  }

  function sentConfirmed(pending) {
    const scan = fullScan();
    if (pending.isSend) {
      const emptied =
        pending.draftChars > 0
          ? scan.draft.chars < pending.draftChars * 0.5
          : scan.composerAttachCount < pending.attachCount;
      return emptied || scan.messages.userCount > pending.userCount || isGenerating();
    }
    return (
      isGenerating() ||
      scan.messages.lastAssistantLength !== pending.assistLength ||
      scan.messages.assistCount !== pending.assistCount
    );
  }

  function confirmAction(attempt) {
    const pending = S.pendingSend;
    if (!pending || !S.active) {
      return;
    }
    if (sentConfirmed(pending)) {
      S.pendingSend = null;
      registerSend(pending);
      return;
    }
    if (attempt < 2) {
      later(() => confirmAction(2), CONFIRM_SECOND_MS - CONFIRM_FIRST_MS);
      return;
    }
    S.pendingSend = null;
  }

  async function registerSend(pending) {
    let credit = pending.pendingSaving;
    if (pending.isSend && pending.newChatPending > 0) {
      credit += Math.max(0, pending.newChatPending - pending.total);
    }
    const stamp = Date.now();
    S.lastRegisterAt = stamp;
    const ok = await updateState((state, now) => {
      if (state.windowStart == null) {
        state.windowStart = now;
      }
      state.consumo += pending.tokens;
      state.envios.push({ t: now, tokens: pending.tokens, tipo: pending.kind });
      state.envios = state.envios.slice(-MAX_SENDS);
      if (credit > 0) {
        state.ahorro += Math.round(credit);
      }
      return true;
    });
    if (ok) {
      S.pendingSaving = Math.max(0, S.pendingSaving - pending.pendingSaving);
      if (pending.newChatPending > 0) {
        S.newChatPending = 0;
      }
      S.ref = null;
      S.lowCycles = 0;
      S.lowSince = 0;
    }
  }

  /* Cambio de chat (SPA): no reinicia la ventana global. */
  function checkChatChange() {
    const path = location.pathname;
    if (path === S.chatKey) {
      return false;
    }
    const previous = S.chatKey;
    S.chatKey = path;
    if (previous != null) {
      if (isNewChatPath(path) && isChatPath(previous) && S.chatMaxTotal >= NEW_CHAT_MIN_CONTEXT) {
        S.newChatPending = S.chatMaxTotal;
      } else if (isChatPath(path) && !S.pendingSend) {
        S.newChatPending = 0;
      }
    }
    S.chatMaxTotal = 0;
    S.ref = null;
    S.lowCycles = 0;
    S.lowSince = 0;
    S.pendingSaving = 0;
    S.chatSince = Date.now();
    messageCache = new WeakMap();
    return true;
  }

  /* Reducciones sostenidas del contexto dentro de un mismo chat. Se mide
     sobre mensajes, documentos e imágenes: los artefactos y el Proyecto
     cambian de estimación al abrir paneles o al editar ajustes, y no son
     reducciones reales. */
  function trackContext(trackTotal, now) {
    if (now - S.chatSince < CHAT_HYDRATION_MS) {
      S.ref = null;
      return;
    }
    if (S.ref == null || trackTotal >= S.ref) {
      S.ref = trackTotal;
      S.lowCycles = 0;
      S.lowSince = 0;
      return;
    }
    const drop = S.ref - trackTotal;
    if (drop >= Math.max(DROP_MIN_TOKENS, DROP_MIN_RATIO * S.ref)) {
      S.lowCycles += 1;
      if (!S.lowSince) {
        S.lowSince = now;
      }
      if (S.lowCycles >= 2 && now - S.lowSince >= DROP_PERSIST_MS) {
        S.pendingSaving += drop;
        S.ref = trackTotal;
        S.lowCycles = 0;
        S.lowSince = 0;
      }
    } else {
      S.lowCycles = 0;
      S.lowSince = 0;
    }
  }

  function recompute() {
    if (!S.active || !S.settings || !S.state) {
      return;
    }
    const started = performance.now();
    const now = Date.now();
    checkChatChange();
    S.scan = fullScan();
    S.model = computeModel(S.scan, S.state, S.settings, now);
    S.chatMaxTotal = Math.max(S.chatMaxTotal, S.model.agg.total);
    trackContext(S.model.trackTotal, now);
    S.lastScanMs = performance.now() - started;
    render();
  }

  function scheduleRecompute() {
    if (!S.active) {
      return;
    }
    const now = performance.now();
    if (S.firstPendingAt == null) {
      S.firstPendingAt = now;
    }
    if (S.recomputeTimer) {
      clearTimeout(S.recomputeTimer);
    }
    const wait = Math.min(DEBOUNCE_MS, Math.max(0, MAX_WAIT_MS - (now - S.firstPendingAt)));
    S.recomputeTimer = setTimeout(() => {
      S.recomputeTimer = null;
      S.firstPendingAt = null;
      recompute();
    }, wait);
  }

  async function calibrate() {
    const current = effectiveWindow(S.state, Date.now());
    if (current.consumo < MIN_CALIBRATION_CONSUMPTION) {
      toast('El consumo estimado es demasiado bajo para calibrar. Es probable que el bloqueo tenga otra causa.');
      return;
    }
    const ok = await updateState((state, now) => {
      const consumo = Math.round(state.consumo);
      if (consumo < MIN_CALIBRATION_CONSUMPTION) {
        return false;
      }
      state.calibraciones.push({ timestamp: now, consumoEstimado: consumo });
      state.calibraciones = state.calibraciones.slice(-MAX_CALIBRATIONS);
      return true;
    });
    toast(ok ? 'Calibración guardada. El rango probable se ajustará.' : 'No se pudo guardar la calibración.');
  }

  async function resetWindow() {
    await updateState((state) => {
      state.windowStart = null;
      state.consumo = 0;
      return true;
    });
    toast('Ventana reiniciada. Arrancará con tu próximo envío.');
  }

  async function tick() {
    if (!S.active) {
      return;
    }
    const state = S.state;
    if (state && state.windowStart != null && Date.now() >= state.windowStart + WINDOW_MS) {
      await updateState(() => false);
    }
    deriveAndRender();
  }

  function poll() {
    if (!S.active) {
      return;
    }
    if (UI.root && !document.getElementById(ROOT_ID) && document.body) {
      document.body.appendChild(UI.root);
    }
    if (location.pathname !== S.chatKey || S.lowCycles > 0) {
      scheduleRecompute();
    }
  }

  /* ====================================================================
   * 7. INTERFAZ
   * ==================================================================== */

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const ICONS = {
    theme: [
      ['circle', { cx: 8, cy: 8, r: 5.5, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.5 }],
      ['path', { d: 'M8 2.5a5.5 5.5 0 0 1 0 11z', fill: 'currentColor' }]
    ],
    expand: [
      ['path', {
        d: 'M9.5 2.5h4v4M6.5 13.5h-4v-4M13.5 2.5L9 7M2.5 13.5L7 9',
        fill: 'none', stroke: 'currentColor', 'stroke-width': 1.5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round'
      }]
    ],
    compress: [
      ['path', {
        d: 'M13.5 6.5h-4v-4M2.5 9.5h4v4M9.5 6.5l4-4M6.5 9.5l-4 4',
        fill: 'none', stroke: 'currentColor', 'stroke-width': 1.5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round'
      }]
    ],
    minimize: [
      ['path', { d: 'M3.5 8h9', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8, 'stroke-linecap': 'round' }]
    ]
  };

  function svgIcon(shapes) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('width', '14');
    svg.setAttribute('height', '14');
    svg.setAttribute('aria-hidden', 'true');
    for (const shape of shapes) {
      const el = document.createElementNS(SVG_NS, shape[0]);
      for (const key of Object.keys(shape[1])) {
        el.setAttribute(key, String(shape[1][key]));
      }
      svg.appendChild(el);
    }
    return svg;
  }

  function h(tag, props, children) {
    const el = document.createElement(tag);
    if (props) {
      for (const key of Object.keys(props)) {
        const value = props[key];
        if (value === undefined || value === null || value === false) {
          continue;
        }
        if (key === 'class') {
          el.className = value;
        } else if (key === 'text') {
          el.textContent = value;
        } else {
          el.setAttribute(key, value === true ? '' : String(value));
        }
      }
    }
    if (children) {
      for (const child of children) {
        if (child === null || child === undefined) {
          continue;
        }
        el.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
      }
    }
    return el;
  }

  function setText(el, text) {
    if (el && el.textContent !== text) {
      el.textContent = text;
    }
  }

  function setTone(el, tone) {
    if (!el) {
      return;
    }
    for (const name of ['good', 'fair', 'warn', 'danger', 'muted']) {
      el.classList.remove('cftm-tone-' + name);
    }
    if (tone) {
      el.classList.add('cftm-tone-' + tone);
    }
  }

  function makeKpi(label) {
    const value = h('div', { class: 'cftm-kpi-value' });
    const sub = h('div', { class: 'cftm-kpi-sub' });
    const el = h('div', { class: 'cftm-kpi' }, [h('div', { class: 'cftm-kpi-label', text: label }), value, sub]);
    return { el, value, sub };
  }

  function makeRow(label) {
    const value = h('span', { class: 'cftm-row-value' });
    const el = h('div', { class: 'cftm-row' }, [h('span', { class: 'cftm-row-label', text: label }), value]);
    return { el, value };
  }

  function makeButton(label, className, handler) {
    const button = h('button', { type: 'button', class: 'cftm-btn ' + className, text: label });
    button.addEventListener('click', handler);
    return button;
  }

  function makeIconButton(label, shapes, handler) {
    const button = h('button', { type: 'button', class: 'cftm-icon-btn', 'aria-label': label, title: label });
    button.appendChild(svgIcon(shapes));
    button.addEventListener('click', handler);
    return button;
  }

  function makeSection(title, children) {
    return h('div', { class: 'cftm-section' }, [h('div', { class: 'cftm-section-title', text: title })].concat(children));
  }

  function toast(message) {
    if (!UI.toast) {
      return;
    }
    UI.toast.textContent = message;
    UI.toast.classList.add('cftm-toast-visible');
    if (S.toastTimer) {
      clearTimeout(S.toastTimer);
      S.timers.delete(S.toastTimer);
    }
    S.toastTimer = later(() => {
      if (UI.toast) {
        UI.toast.classList.remove('cftm-toast-visible');
      }
    }, TOAST_MS);
  }

  function buildUI() {
    const root = h('div', {
      id: ROOT_ID,
      'data-cftm-theme': S.settings.tema,
      'data-cftm-mode': S.settings.modo,
      'data-cftm-collapsed': S.settings.colapsado ? 'true' : 'false'
    });

    /* Cabecera */
    const themeBtn = makeIconButton('Cambiar tema', ICONS.theme, cycleTheme);
    const modeBtn = makeIconButton('Cambiar entre vista compacta y expandida', ICONS.expand, toggleMode);
    const collapseBtn = makeIconButton('Minimizar', ICONS.minimize, () => setCollapsed(true));
    const header = h('div', { class: 'cftm-header' }, [
      h('div', { class: 'cftm-heading' }, [
        h('div', { class: 'cftm-title', text: 'Medidor de contexto' }),
        h('div', { class: 'cftm-subtitle', text: 'Estimación local, no oficial' })
      ]),
      h('div', { class: 'cftm-header-actions' }, [themeBtn, modeBtn, collapseBtn])
    ]);

    /* Indicadores principales */
    const kHealth = makeKpi('Salud del contexto');
    const kBalance = makeKpi('Saldo restante');
    const kCost = makeKpi('Costo si envías ahora');
    const kReset = makeKpi('Reinicio en');
    const kpis = h('div', { class: 'cftm-kpis' }, [kHealth.el, kBalance.el, kCost.el, kReset.el]);

    /* Calibre */
    const gaugeRange = h('div', { class: 'cftm-gauge-range' });
    const gaugeFill = h('div', { class: 'cftm-gauge-fill' });
    const gauge = h('div', { class: 'cftm-gauge' }, [gaugeRange, gaugeFill, h('div', { class: 'cftm-gauge-ticks' })]);
    const gaugeLeft = h('span');
    const gaugeRight = h('span');
    const gaugeWrap = h('div', { class: 'cftm-gauge-wrap' }, [
      gauge,
      h('div', { class: 'cftm-gauge-caption' }, [gaugeLeft, gaugeRight])
    ]);

    /* Vista expandida: contexto */
    const rowTotal = makeRow('Contexto total (estimación)');
    const rowTop = makeRow('Principal consumidor');
    const sourceRows = {};
    const sourceEls = [];
    for (const name of SOURCE_ORDER) {
      const nameEl = h('span', { class: 'cftm-source-name', text: SOURCE_LABELS[name] });
      const badge = h('span', { class: 'cftm-badge cftm-badge-alta', title: 'Confianza de esta fuente' });
      const value = h('span', { class: 'cftm-source-value' });
      const fill = h('div', { class: 'cftm-bar-fill' });
      const el = h('div', { class: 'cftm-source' }, [
        h('div', { class: 'cftm-source-head' }, [nameEl, badge, value]),
        h('div', { class: 'cftm-bar' }, [fill])
      ]);
      sourceRows[name] = { el, name: nameEl, badge, value, fill };
      sourceEls.push(el);
    }
    const detected = h('div', { class: 'cftm-help' });
    const noteImages = h('div', {
      class: 'cftm-note',
      text: 'Las imágenes representan la fuente menos precisa de estimación.',
      hidden: true
    });
    const noteProject = h('div', {
      class: 'cftm-note',
      text: 'Claude no expone públicamente el tamaño real del contexto de los Proyectos. Es un valor que tú configuras.',
      hidden: true
    });
    const noteNoMessages = h('div', {
      class: 'cftm-note',
      text: 'No se detectaron mensajes en este chat. Es posible que la interfaz de claude.ai haya cambiado y los selectores necesiten actualizarse.',
      hidden: true
    });
    const sectionContext = makeSection('Contexto estimado', [rowTotal.el, rowTop.el].concat(sourceEls, [detected, noteImages, noteProject, noteNoMessages]));

    /* Vista expandida: saldo */
    const rowConsumption = makeRow('Consumo de la ventana');
    const rowBalance = makeRow('Saldo restante');
    const rowRange = makeRow('Rango probable');
    const rowConfidence = makeRow('Confianza');
    const rowPrecision = makeRow('Precisión estimada');
    const rowSimilar = makeRow('Mensajes similares restantes');
    const rowGrowing = makeRow('Con el contexto creciendo');
    const sectionBalance = makeSection('Saldo y precisión', [
      rowConsumption.el, rowBalance.el, rowRange.el, rowConfidence.el, rowPrecision.el, rowSimilar.el, rowGrowing.el,
      h('div', { class: 'cftm-help', text: 'Todas las cifras son estimaciones. Claude no expone sus tokens reales ni el límite de tu cuenta.' })
    ]);

    /* Vista expandida: ventana */
    const rowWindowEnd = makeRow('Reinicio en');
    const rowWindowStart = makeRow('Inicio de la ventana');
    const sectionWindow = makeSection('Ventana global de 5 horas', [
      rowWindowEnd.el,
      rowWindowStart.el,
      h('div', { class: 'cftm-actions' }, [makeButton('Reiniciar ventana', 'cftm-btn-ghost', resetWindow)])
    ]);

    /* Vista expandida: ahorro */
    const rowSavings = makeRow('Ahorro histórico');
    const panel = h('div', { class: 'cftm-panel', hidden: true });
    const sectionSavings = makeSection('Ahorro', [
      rowSavings.el,
      h('div', { class: 'cftm-actions' }, [
        makeButton('Analizar ahorro', 'cftm-btn-primary', () => showAnalysis(false)),
        makeButton('Analizar ahorro extremo', '', () => showAnalysis(true))
      ]),
      panel
    ]);

    /* Vista expandida: calibración */
    const sectionCalibration = makeSection('Calibración', [
      h('div', {
        class: 'cftm-help',
        text: 'Si Claude te bloquea por el límite de la ventana, pulsa el botón. Con más calibraciones, el rango probable se estrecha.'
      }),
      h('div', { class: 'cftm-actions' }, [makeButton('Claude me bloqueó aquí', 'cftm-btn-danger', calibrate)])
    ]);

    /* Vista expandida: ajustes */
    const budgetInput = h('input', {
      type: 'number', class: 'cftm-input', min: MIN_BUDGET, max: MAX_SETTING_VALUE, step: 1000,
      'aria-label': 'Presupuesto gratuito en tokens estimados'
    });
    budgetInput.addEventListener('change', () => commitNumber(budgetInput, 'presupuesto', MIN_BUDGET));
    const projectInput = h('input', {
      type: 'number', class: 'cftm-input', min: 0, max: MAX_SETTING_VALUE, step: 500,
      'aria-label': 'Tokens estimados del Proyecto'
    });
    projectInput.addEventListener('change', () => commitNumber(projectInput, 'tokensProyectoEstimados', 0));
    const projectSelect = h('select', { class: 'cftm-select', 'aria-label': 'Contexto del Proyecto' }, [
      h('option', { value: 'auto', text: 'Automático (si hay indicios)' }),
      h('option', { value: 'siempre', text: 'Siempre incluir' }),
      h('option', { value: 'nunca', text: 'Nunca incluir' })
    ]);
    projectSelect.addEventListener('change', () => {
      updateSettings({ proyectoModo: projectSelect.value });
      scheduleRecompute();
    });
    const sectionSettings = makeSection('Ajustes', [
      h('div', { class: 'cftm-field' }, [h('label', { class: 'cftm-label', text: 'Presupuesto gratuito (tokens estimados)' }), budgetInput]),
      h('div', { class: 'cftm-field' }, [h('label', { class: 'cftm-label', text: 'Tokens estimados del Proyecto' }), projectInput]),
      h('div', { class: 'cftm-field' }, [h('label', { class: 'cftm-label', text: 'Contexto del Proyecto' }), projectSelect])
    ]);

    const noteOrphan = h('div', {
      class: 'cftm-note',
      text: 'La extensión se actualizó o se reinició. Recarga esta página para volver a activar el medidor.',
      hidden: true
    });
    const footer = h('div', { class: 'cftm-help' });

    const expanded = h('div', { class: 'cftm-expanded' }, [
      sectionContext, sectionBalance, sectionWindow, sectionSavings, sectionCalibration, sectionSettings, noteOrphan, footer
    ]);

    const toastEl = h('div', { class: 'cftm-toast', role: 'status', 'aria-live': 'polite' });
    const body = h('div', { class: 'cftm-body' }, [kpis, gaugeWrap, expanded]);
    const widget = h('div', { class: 'cftm-widget', role: 'region', 'aria-label': 'Medidor de contexto de Claude (estimación)' }, [
      header, body, toastEl
    ]);

    /* Botón flotante del modo colapsado */
    const fabDot = h('span', { class: 'cftm-fab-dot' });
    const fabText = h('span');
    const fab = h('button', { type: 'button', class: 'cftm-fab', 'aria-label': 'Abrir medidor de contexto' }, [fabDot, fabText]);

    root.appendChild(widget);
    root.appendChild(fab);

    UI = {
      root, widget, header, fab, fabDot, fabText, modeBtn, toast: toastEl, body, panel, footer, noteOrphan,
      kHealth, kBalance, kCost, kReset,
      gauge, gaugeFill, gaugeRange, gaugeLeft, gaugeRight,
      rowTotal, rowTop, sourceRows, detected, noteImages, noteProject, noteNoMessages,
      rowConsumption, rowBalance, rowRange, rowConfidence, rowPrecision, rowSimilar, rowGrowing,
      rowWindowEnd, rowWindowStart, rowSavings,
      budgetInput, projectInput, projectSelect
    };

    document.body.appendChild(root);
    applySettingsToUI();
    setupDrag(header);
    setupDrag(fab);
    fab.addEventListener('click', (event) => {
      if (event.detail === 0) {
        setCollapsed(false);
      }
    });
    applyPosition(S.settings.posicion);
  }

  function commitNumber(input, key, minimum) {
    const value = Math.round(Number(input.value));
    if (!isFinite(value) || value < minimum || value > MAX_SETTING_VALUE) {
      toast('Valor no válido. Debe estar entre ' + fmtInt(minimum) + ' y ' + fmtInt(MAX_SETTING_VALUE) + '.');
      input.value = String(S.settings[key]);
      return;
    }
    const patch = {};
    patch[key] = value;
    updateSettings(patch);
    deriveAndRender();
  }

  function applySettingsToUI() {
    if (!UI.root) {
      return;
    }
    UI.root.setAttribute('data-cftm-theme', S.settings.tema);
    UI.root.setAttribute('data-cftm-mode', S.settings.modo);
    UI.root.setAttribute('data-cftm-collapsed', S.settings.colapsado ? 'true' : 'false');
    const isExpanded = S.settings.modo === 'expanded';
    UI.modeBtn.replaceChildren(svgIcon(isExpanded ? ICONS.compress : ICONS.expand));
    UI.modeBtn.setAttribute('aria-label', isExpanded ? 'Cambiar a vista compacta' : 'Cambiar a vista expandida');
    UI.modeBtn.setAttribute('title', isExpanded ? 'Vista compacta' : 'Vista expandida');
    if (document.activeElement !== UI.budgetInput) {
      UI.budgetInput.value = String(S.settings.presupuesto);
    }
    if (document.activeElement !== UI.projectInput) {
      UI.projectInput.value = String(S.settings.tokensProyectoEstimados);
    }
    UI.projectSelect.value = S.settings.proyectoModo;
  }

  function cycleTheme() {
    const order = ['auto', 'light', 'dark'];
    const names = { auto: 'automático', light: 'claro', dark: 'oscuro' };
    const next = order[(order.indexOf(S.settings.tema) + 1) % order.length];
    updateSettings({ tema: next });
    applySettingsToUI();
    toast('Tema ' + names[next] + '.');
  }

  function toggleMode() {
    const next = S.settings.modo === 'expanded' ? 'compact' : 'expanded';
    updateSettings({ modo: next });
    applySettingsToUI();
    render();
    scheduleClamp();
  }

  function setCollapsed(value) {
    updateSettings({ colapsado: value });
    applySettingsToUI();
    scheduleClamp();
  }

  /* Posición y arrastre ---------------------------------------------------- */

  function placeRoot(x, y) {
    const width = UI.root.offsetWidth;
    const height = UI.root.offsetHeight;
    const maxX = Math.max(8, window.innerWidth - width - 8);
    const maxY = Math.max(8, window.innerHeight - height - 8);
    UI.root.style.left = clamp(x, 8, maxX) + 'px';
    UI.root.style.top = clamp(y, 8, maxY) + 'px';
    UI.root.style.right = 'auto';
    UI.root.style.bottom = 'auto';
  }

  function applyPosition(position) {
    if (position && isFinite(position.x) && isFinite(position.y)) {
      placeRoot(position.x, position.y);
    }
  }

  function scheduleClamp() {
    if (S.rafId) {
      cancelAnimationFrame(S.rafId);
    }
    S.rafId = requestAnimationFrame(() => {
      S.rafId = 0;
      if (UI.root && UI.root.style.left) {
        const rect = UI.root.getBoundingClientRect();
        placeRoot(rect.left, rect.top);
      }
    });
  }

  function setupDrag(handle) {
    let drag = null;
    const finish = (event) => {
      if (!drag || event.pointerId !== drag.id) {
        return;
      }
      const finished = drag;
      drag = null;
      UI.root.classList.remove('cftm-dragging');
      try {
        handle.releasePointerCapture(event.pointerId);
      } catch (err) {
        /* captura ya liberada */
      }
      if (finished.moved) {
        const rect = UI.root.getBoundingClientRect();
        updateSettings({ posicion: { x: Math.round(rect.left), y: Math.round(rect.top) } });
      } else if (handle === UI.fab && event.type === 'pointerup') {
        setCollapsed(false);
      }
    };
    handle.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || (event.target.closest && event.target.closest('.cftm-icon-btn'))) {
        return;
      }
      const rect = UI.root.getBoundingClientRect();
      drag = { id: event.pointerId, startX: event.clientX, startY: event.clientY, left: rect.left, top: rect.top, moved: false };
      try {
        handle.setPointerCapture(event.pointerId);
      } catch (err) {
        /* el navegador no permite capturar este puntero */
      }
    });
    handle.addEventListener('pointermove', (event) => {
      if (!drag || event.pointerId !== drag.id) {
        return;
      }
      const dx = event.clientX - drag.startX;
      const dy = event.clientY - drag.startY;
      if (!drag.moved) {
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) {
          return;
        }
        drag.moved = true;
        UI.root.classList.add('cftm-dragging');
      }
      placeRoot(drag.left + dx, drag.top + dy);
    });
    handle.addEventListener('pointerup', finish);
    handle.addEventListener('pointercancel', finish);
  }

  /* Render ----------------------------------------------------------------- */

  function render() {
    if (!UI.root || !S.model) {
      return;
    }
    const m = S.model;
    const expanded = S.settings.modo === 'expanded';
    const gaugeLabel = 'Consumo estimado ' + fmtApprox(m.window.consumo);

    /* Indicadores principales */
    setText(UI.kHealth.value, m.health.score + '/100');
    setTone(UI.kHealth.value, m.health.tone);
    setText(UI.kHealth.sub, m.health.label);

    setText(UI.kBalance.value, fmtApprox(m.balance.estimado));
    setText(UI.kBalance.sub, 'Rango probable: ' + fmtInt(m.balance.min) + ' a ' + fmtInt(m.balance.max));

    setText(UI.kCost.value, fmtApprox(m.nextCost));
    setText(UI.kCost.sub, 'Contexto ' + fmtApprox(m.agg.total) + ' + borrador ' + fmtApprox(m.draftTokens));

    if (m.window.started) {
      setText(UI.kReset.value, fmtDuration(m.window.remainingMs));
      setText(UI.kReset.sub, 'Ventana global de 5 h');
    } else {
      setText(UI.kReset.value, 'Sin iniciar');
      setText(UI.kReset.sub, 'Arranca con tu próximo envío');
    }

    /* Calibre */
    UI.gauge.classList.remove('cftm-gauge-ok', 'cftm-gauge-warn', 'cftm-gauge-danger');
    UI.gauge.classList.add('cftm-gauge-' + m.gauge.tone);
    UI.gaugeFill.style.setProperty('--cftm-w', m.gauge.pct.toFixed(1) + '%');
    UI.gaugeRange.style.setProperty('--cftm-range-start', m.gauge.rangeStart.toFixed(1) + '%');
    UI.gaugeRange.style.setProperty('--cftm-range-end', m.gauge.rangeEnd.toFixed(1) + '%');
    setText(UI.gaugeLeft, gaugeLabel);
    setText(UI.gaugeRight, 'de ' + fmtApprox(m.budget.efectivo));

    /* Botón flotante */
    setText(UI.fabText, m.health.score + '/100');
    UI.fabDot.classList.remove('cftm-tone-good', 'cftm-tone-fair', 'cftm-tone-warn', 'cftm-tone-danger');
    UI.fabDot.classList.add('cftm-tone-' + m.health.tone);
    UI.fab.setAttribute(
      'aria-label',
      'Abrir medidor de contexto. Salud estimada ' + m.health.score + ' de 100. Saldo estimado ' + fmtInt(m.balance.estimado) + ' tokens.'
    );

    if (!expanded) {
      return;
    }

    /* Contexto */
    setText(UI.rowTotal.value, fmtApprox(m.agg.total));
    if (m.agg.top) {
      setText(UI.rowTop.value, SOURCE_LABELS[m.agg.top.source] + ' (' + Math.round(m.agg.top.pct) + '%)');
    } else {
      setText(UI.rowTop.value, '\u2014');
    }
    for (const part of m.agg.parts) {
      const row = UI.sourceRows[part.source];
      row.badge.className = 'cftm-badge cftm-badge-' + part.confidence;
      setText(row.badge, CONFIDENCE_LABELS[part.confidence]);
      setText(row.value, fmtApprox(part.tokens) + ' (' + Math.round(part.pct) + '%)');
      row.fill.style.setProperty('--cftm-w', clamp(part.pct, 0, 100).toFixed(1) + '%');
      row.el.classList.toggle('cftm-source-top', !!(m.agg.top && m.agg.top.source === part.source));
    }
    const scan = S.scan;
    setText(
      UI.detected,
      'Detectado: ' + scan.messages.userCount + ' mensajes tuyos, ' + scan.messages.assistCount + ' de Claude, ' +
        scan.docs.length + ' archivos, ' + scan.images.length + ' imágenes, ' + scan.artifacts.items.length + ' artefactos.'
    );
    UI.noteImages.hidden = scan.images.length === 0;
    UI.noteProject.hidden = !m.projectIncluded;
    UI.noteNoMessages.hidden = !(isChatPath(location.pathname) && scan.messages.userCount + scan.messages.assistCount === 0);

    /* Saldo y precisión */
    setText(UI.rowConsumption.value, fmtApprox(m.window.consumo));
    setText(UI.rowBalance.value, fmtApprox(m.balance.estimado));
    setText(UI.rowRange.value, 'mín ' + fmtInt(m.balance.min) + ', máx ' + fmtInt(m.balance.max));
    setText(UI.rowConfidence.value, m.calibration.level + ' (' + m.calibration.n + ' calibraciones)');
    setText(UI.rowPrecision.value, m.precision + '%');
    setText(UI.rowSimilar.value, m.remaining.similares == null ? '\u2014' : fmtApprox(m.remaining.similares));
    setText(UI.rowGrowing.value, m.remaining.conCrecimiento == null ? '\u2014' : fmtApprox(m.remaining.conCrecimiento));

    /* Ventana */
    if (m.window.started) {
      setText(UI.rowWindowEnd.value, fmtDuration(m.window.remainingMs));
      setText(UI.rowWindowStart.value, fmtClock(m.window.startAt));
    } else {
      setText(UI.rowWindowEnd.value, 'Sin iniciar');
      setText(UI.rowWindowStart.value, '\u2014');
    }

    /* Ahorro */
    setText(UI.rowSavings.value, fmtApprox(m.ahorro) + ' tokens');

    setText(
      UI.footer,
      'Última actualización: ' + S.lastScanMs.toFixed(1) + ' ms. Versión ' + VERSION + ', selectores v' + SELECTORS_VERSION + '. Todo se calcula en tu navegador.'
    );
  }

  /* Panel de ahorro ------------------------------------------------------------ */

  function showAnalysis(extreme) {
    if (!S.scan || !S.model) {
      toast('Aún no hay datos para analizar.');
      return;
    }
    if (UI.panel.hidden === false && S.analysis === (extreme ? 'extreme' : 'normal')) {
      UI.panel.hidden = true;
      S.analysis = null;
      return;
    }
    S.analysis = extreme ? 'extreme' : 'normal';
    const result = analyzeSavings(S.model, S.scan, extreme);
    UI.panel.replaceChildren();

    const totalLabel = extreme
      ? 'Ahorro potencial máximo: ' + fmtApprox(result.total) + ' tokens por mensaje'
      : 'Ahorro estimado: ' + fmtApprox(result.total);
    UI.panel.appendChild(
      h('div', { class: 'cftm-panel-head' }, [
        h('span', { class: 'cftm-panel-title', text: extreme ? 'Análisis de ahorro extremo' : 'Recomendaciones de ahorro' })
      ])
    );
    UI.panel.appendChild(h('div', { class: 'cftm-panel-total', text: totalLabel }));

    if (result.items.length === 0) {
      UI.panel.appendChild(
        h('div', {
          class: 'cftm-reco-text',
          text: 'Con las estimaciones actuales no se detectan fuentes grandes de consumo. Seguirás ahorrando si abres un chat nuevo al cambiar de tema.'
        })
      );
    }
    for (const item of result.items) {
      const head = h('div', { class: 'cftm-reco-head' }, [
        h('span', { class: 'cftm-impact cftm-impact-' + item.impacto, text: 'Impacto ' + item.impacto }),
        h('span', { class: 'cftm-reco-title', text: item.title })
      ]);
      const children = [head, h('div', { class: 'cftm-reco-text', text: item.text })];
      if (item.ahorro != null) {
        children.push(h('div', { class: 'cftm-reco-saving', text: 'Ahorro estimado: ' + fmtApprox(item.ahorro) }));
      }
      UI.panel.appendChild(h('div', { class: 'cftm-reco' }, children));
    }
    UI.panel.appendChild(
      h('div', { class: 'cftm-note cftm-note-info', text: 'Son estimaciones por mensaje. El ahorro real depende de cómo reduzcas el contexto.' })
    );
    UI.panel.hidden = false;
  }

  /* ====================================================================
   * 8. CICLO DE VIDA
   * ==================================================================== */

  function startObserver() {
    S.observer = new MutationObserver((records) => {
      for (const record of records) {
        const target = record.target;
        const element = target.nodeType === 1 ? target : target.parentElement;
        if (element && element.closest && element.closest('#' + ROOT_ID)) {
          continue;
        }
        scheduleRecompute();
        return;
      }
    });
    S.observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['aria-label', 'title', 'src', 'data-testid']
    });
  }

  function onInput(event) {
    const composer = findComposer();
    if (composer && event.target && composer.contains(event.target)) {
      scheduleRecompute();
    }
  }

  function onResize() {
    if (UI.root && UI.root.style.left) {
      const rect = UI.root.getBoundingClientRect();
      placeRoot(rect.left, rect.top);
    }
  }

  function attachListeners() {
    on(document, 'keydown', onKeydown, true);
    on(document, 'click', onClick, true);
    on(document, 'input', onInput, true);
    on(window, 'popstate', scheduleRecompute);
    on(window, 'resize', onResize);
    on(window, 'beforeunload', onBeforeUnload);
    on(window, 'pagehide', (event) => {
      if (!event.persisted) {
        cleanup();
      }
    });
    if (storageAvailable()) {
      chrome.storage.onChanged.addListener(onStorageChanged);
    }
    try {
      if (window.navigation && typeof window.navigation.addEventListener === 'function') {
        window.navigation.addEventListener('navigatesuccess', scheduleRecompute);
        S.navigationTarget = window.navigation;
      }
    } catch (err) {
      /* API de navegación no disponible: quedan popstate, observer y sondeo */
    }
  }

  function startIntervals() {
    S.intervals.push(setInterval(poll, URL_POLL_MS));
    S.intervals.push(setInterval(tick, TICK_MS));
  }

  function cleanup() {
    S.active = false;
    if (S.observer) {
      S.observer.disconnect();
      S.observer = null;
    }
    S.intervals.forEach((id) => clearInterval(id));
    S.intervals = [];
    S.timers.forEach((id) => clearTimeout(id));
    S.timers.clear();
    if (S.recomputeTimer) {
      clearTimeout(S.recomputeTimer);
      S.recomputeTimer = null;
    }
    S.firstPendingAt = null;
    if (S.rafId) {
      cancelAnimationFrame(S.rafId);
      S.rafId = 0;
    }
    for (const entry of S.listeners) {
      entry[0].removeEventListener(entry[1], entry[2], entry[3]);
    }
    S.listeners = [];
    try {
      if (storageAvailable()) {
        chrome.storage.onChanged.removeListener(onStorageChanged);
      }
    } catch (err) {
      /* contexto de la extensión ya invalidado */
    }
    try {
      if (S.navigationTarget) {
        S.navigationTarget.removeEventListener('navigatesuccess', scheduleRecompute);
        S.navigationTarget = null;
      }
    } catch (err) {
      /* nada que limpiar */
    }
    if (UI.root && UI.root.parentNode) {
      UI.root.parentNode.removeChild(UI.root);
    }
    UI = {};
    S.pendingSend = null;
  }

  /* Si el usuario cancela la salida de la página, el medidor se reactiva. */
  function onBeforeUnload() {
    cleanup();
    setTimeout(() => {
      if (!S.active && !S.orphaned && document.visibilityState !== 'hidden') {
        init();
      }
    }, 1500);
  }

  async function init() {
    if (S.active || S.orphaned) {
      return;
    }
    if (location.hostname !== 'claude.ai' || !document.body) {
      return;
    }
    const stored = await storageGet([KEY_SETTINGS, KEY_STATE]);
    if (S.active) {
      return;
    }
    S.settings = normalizeSettings(stored[KEY_SETTINGS]);
    S.state = normalizeState(stored[KEY_STATE]);
    S.active = true;
    S.chatKey = location.pathname;
    S.chatSince = Date.now();
    S.chatMaxTotal = 0;
    S.ref = null;
    S.lastRegisterAt = 0;

    buildUI();
    attachListeners();
    startObserver();
    startIntervals();
    recompute();
    later(recompute, 800);
    later(recompute, CHAT_HYDRATION_MS);
  }

  // __CFTM_TEST_HOOK__

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
