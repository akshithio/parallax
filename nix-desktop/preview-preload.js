const { ipcRenderer } = require('electron');

const START_CHANNEL = 'nix-preview-annotation-start';
const CANCEL_CHANNEL = 'nix-preview-annotation-cancel';
const CAPTURED_CHANNEL = 'nix-preview-annotation-captured';
const HOST_MESSAGE = 'nix-preview-annotation';

let activeSession = null;

function makeId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function rectValue(rect) {
  return {
    x: rect.left,
    y: rect.top,
    width: rect.width,
    height: rect.height,
  };
}

function normalizeRect(a, b) {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    width: Math.abs(b.x - a.x),
    height: Math.abs(b.y - a.y),
  };
}

function unionRects(rects, margin = 20) {
  if (!rects.length) return null;
  const left = Math.min(...rects.map((rect) => rect.x));
  const top = Math.min(...rects.map((rect) => rect.y));
  const right = Math.max(...rects.map((rect) => rect.x + rect.width));
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.height));
  const x = clamp(left - margin, 0, window.innerWidth);
  const y = clamp(top - margin, 0, window.innerHeight);
  return {
    x,
    y,
    width: clamp(right + margin, 0, window.innerWidth) - x,
    height: clamp(bottom + margin, 0, window.innerHeight) - y,
  };
}

function cssEscape(value) {
  try {
    return CSS.escape(value);
  } catch {
    return String(value).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
  }
}

function selectorFor(element) {
  if (!(element instanceof Element)) return null;
  if (element.id) return `#${cssEscape(element.id)}`;
  const testId = element.getAttribute('data-testid');
  if (testId) return `[data-testid="${String(testId).replace(/"/g, '\\"')}"]`;
  const parts = [];
  let node = element;
  while (node && node !== document.body && parts.length < 5) {
    let part = node.tagName.toLowerCase();
    const classes = [...node.classList]
      .filter((name) => name && !/[/:[\]]/.test(name))
      .slice(0, 2);
    if (classes.length) part += classes.map((name) => `.${cssEscape(name)}`).join('');
    const parent = node.parentElement;
    if (parent) {
      const siblings = [...parent.children].filter((child) => child.tagName === node.tagName);
      if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
    }
    parts.unshift(part);
    node = parent;
  }
  return parts.join(' > ') || element.tagName.toLowerCase();
}

function componentNameFor(element) {
  const explicit =
    element.getAttribute('data-component') ||
    element.getAttribute('data-component-name') ||
    element.getAttribute('data-svelte-h');
  if (explicit) return explicit;
  try {
    const key = Object.keys(element).find((candidate) => candidate.startsWith('__reactFiber$'));
    let fiber = key ? element[key] : null;
    for (let depth = 0; fiber && depth < 12; depth++, fiber = fiber.return) {
      const type = fiber.type;
      const name = type && (type.displayName || type.name);
      if (name && !/^(div|span|button|input|a)$/i.test(name)) return name;
    }
  } catch {}
  return null;
}

function captureElement(element) {
  try {
    const computed = getComputedStyle(element);
    const styleNames = [
      'display',
      'position',
      'width',
      'height',
      'padding',
      'margin',
      'gap',
      'font-family',
      'font-size',
      'font-weight',
      'line-height',
      'color',
      'background-color',
      'border',
      'border-radius',
      'opacity',
    ];
    const styles = styleNames
      .map((name) => `${name}: ${computed.getPropertyValue(name)}`)
      .join('; ');
    return {
      pageUrl: location.href,
      pageTitle: document.title?.trim() || null,
      tagName: element.tagName.toLowerCase(),
      selector: selectorFor(element),
      text: (element.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 280),
      htmlPreview: element.outerHTML.replace(/\s+/g, ' ').slice(0, 1200),
      styles,
      componentName: componentNameFor(element),
      pickedAt: new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

function startAnnotation(theme = {}) {
  activeSession?.teardown(false);

  const primary = theme.primary || '#2563eb';
  const foreground = theme.foreground || '#18181b';
  const background = theme.background || '#ffffff';
  const border = theme.border || 'rgba(24,24,27,.14)';
  const muted = theme.mutedForeground || '#71717a';
  const radius = theme.radius || '10px';
  const font = theme.fontSans || '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  const mono = theme.fontMono || 'ui-monospace, SFMono-Regular, Menlo, monospace';

  const host = document.createElement('div');
  host.setAttribute('data-nix-preview-overlay', '');
  host.style.cssText =
    'position:fixed;inset:0;z-index:2147483647;pointer-events:none;color-scheme:light;';
  const shadow = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = `
    :host{--p:${primary};--fg:${foreground};--bg:${background};--bd:${border};--muted:${muted};--radius:${radius};font-family:${font};color:var(--fg)}
    *{box-sizing:border-box}
    button,input,textarea,select{font:inherit}
    button{border:0}
    .toolbar,.editor{pointer-events:auto;background:color-mix(in srgb,var(--bg) 94%,transparent);border:1px solid var(--bd);box-shadow:0 18px 48px rgba(0,0,0,.22);backdrop-filter:blur(18px)}
    .toolbar{position:fixed;top:12px;left:50%;transform:translateX(-50%);display:flex;align-items:center;gap:3px;padding:4px;border-radius:calc(var(--radius) + 2px)}
    .tool,.action{height:30px;padding:0 10px;border-radius:var(--radius);background:transparent;color:var(--muted);font-size:12px;font-weight:600;cursor:pointer}
    .tool:hover,.action:hover{background:rgba(127,127,127,.12);color:var(--fg)}
    .tool.active{background:color-mix(in srgb,var(--p) 12%,transparent);color:var(--p)}
    .action.primary{background:var(--p);color:white}
    .action:disabled{opacity:.45;cursor:not-allowed}
    .divider{width:1px;height:18px;background:var(--bd);margin:0 2px}
    .editor{position:fixed;right:12px;bottom:12px;width:min(340px,calc(100vw - 24px));max-height:calc(100vh - 70px);overflow:auto;border-radius:calc(var(--radius) + 4px);padding:12px;display:grid;gap:10px}
    .editor h2{font-size:13px;margin:0;font-weight:700}
    .summary{font-size:11px;color:var(--muted)}
    textarea{width:100%;min-height:68px;resize:vertical;border:1px solid var(--bd);border-radius:var(--radius);background:var(--bg);color:var(--fg);padding:8px;font-size:12px;outline:none}
    textarea:focus,input:focus,select:focus{border-color:var(--p);outline:2px solid color-mix(in srgb,var(--p) 16%,transparent)}
    .styles{display:none;gap:6px;padding-top:9px;border-top:1px solid var(--bd)}
    .styles.visible{display:grid}
    label{display:grid;grid-template-columns:92px minmax(0,1fr);align-items:center;gap:8px;font-size:11px;color:var(--muted)}
    input,select{width:100%;height:28px;border:1px solid var(--bd);border-radius:calc(var(--radius) - 2px);background:var(--bg);color:var(--fg);padding:0 7px;font-family:${mono};font-size:11px;outline:none}
    .editor-actions{display:flex;justify-content:flex-end;gap:5px}
    .hover,.box,.region{position:fixed;pointer-events:none;border:2px solid var(--p);border-radius:3px}
    .hover{border-style:dashed;background:color-mix(in srgb,var(--p) 5%,transparent)}
    .box{background:color-mix(in srgb,var(--p) 7%,transparent)}
    .box span{position:absolute;left:-2px;top:-20px;max-width:240px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;background:var(--p);color:white;border-radius:3px 3px 3px 0;padding:2px 5px;font-family:${mono};font-size:10px}
    .region{background:color-mix(in srgb,var(--p) 7%,transparent);border-style:dashed}
    .marquee{position:fixed;pointer-events:none;border:1px dashed var(--p);background:color-mix(in srgb,var(--p) 8%,transparent);display:none}
    svg{position:fixed;inset:0;width:100vw;height:100vh;pointer-events:none;overflow:visible}
  `;
  shadow.appendChild(style);

  const layer = document.createElement('div');
  const hover = document.createElement('div');
  hover.className = 'hover';
  hover.style.display = 'none';
  const marquee = document.createElement('div');
  marquee.className = 'marquee';
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  layer.append(hover, marquee, svg);

  const toolbar = document.createElement('div');
  toolbar.className = 'toolbar';
  const tools = [
    ['select', 'Select', 'Select elements (V)'],
    ['region', 'Region', 'Mark a region (R)'],
    ['draw', 'Draw', 'Draw freehand (D)'],
    ['erase', 'Erase', 'Remove a target (E)'],
  ];
  const toolButtons = new Map();
  let tool = 'select';
  for (const [id, label, title] of tools) {
    const button = document.createElement('button');
    button.className = 'tool';
    button.type = 'button';
    button.textContent = label;
    button.title = title;
    button.addEventListener('click', () => {
      tool = id;
      refreshTools();
    });
    toolbar.appendChild(button);
    toolButtons.set(id, button);
  }
  const divider = document.createElement('span');
  divider.className = 'divider';
  const cancelTop = document.createElement('button');
  cancelTop.className = 'action';
  cancelTop.type = 'button';
  cancelTop.textContent = 'Cancel';
  toolbar.append(divider, cancelTop);

  const editor = document.createElement('section');
  editor.className = 'editor';
  const heading = document.createElement('h2');
  heading.textContent = 'Preview annotation';
  const summary = document.createElement('div');
  summary.className = 'summary';
  const comment = document.createElement('textarea');
  comment.placeholder = 'Describe what should change…';
  const stylesPanel = document.createElement('div');
  stylesPanel.className = 'styles';
  const editorActions = document.createElement('div');
  editorActions.className = 'editor-actions';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'action';
  cancel.textContent = 'Cancel';
  const save = document.createElement('button');
  save.type = 'button';
  save.className = 'action primary';
  save.textContent = 'Attach';
  editorActions.append(cancel, save);
  editor.append(heading, summary, comment, stylesPanel, editorActions);

  shadow.append(layer, toolbar, editor);
  document.documentElement.appendChild(host);

  const selected = new Map();
  const regions = [];
  const strokes = [];
  const baselineStyles = new Map();
  const styleChanges = new Map();
  let dragStart = null;
  let activeStroke = null;
  let finished = false;
  let pendingCapture = false;

  function refreshTools() {
    for (const [id, button] of toolButtons) button.classList.toggle('active', id === tool);
    document.documentElement.style.cursor =
      tool === 'erase' ? 'not-allowed' : tool === 'draw' ? 'crosshair' : 'default';
    hover.style.display = 'none';
  }

  function position(node, rect) {
    node.style.left = `${rect.x}px`;
    node.style.top = `${rect.y}px`;
    node.style.width = `${rect.width}px`;
    node.style.height = `${rect.height}px`;
    node.style.display = rect.width > 0 && rect.height > 0 ? 'block' : 'none';
  }

  function selectedBox(target) {
    const box = document.createElement('div');
    box.className = 'box';
    box.setAttribute('data-target-id', target.id);
    const label = document.createElement('span');
    label.textContent = selectorFor(target.element) || target.element.tagName.toLowerCase();
    box.appendChild(label);
    layer.appendChild(box);
    return box;
  }

  function addSelected(element) {
    if (!(element instanceof Element) || selected.has(element)) return;
    const target = { id: makeId('element'), element, box: null };
    target.box = selectedBox(target);
    selected.set(element, target);
    repaint();
    updateEditor();
  }

  function removeSelected(element) {
    const target = selected.get(element);
    if (!target) return;
    target.box.remove();
    selected.delete(element);
    updateEditor();
  }

  function pickFromPoint(x, y) {
    const element = document.elementFromPoint(x, y);
    if (!element || element === document.documentElement || element === document.body) return element;
    if (element === host || element.closest?.('[data-nix-preview-overlay]')) return null;
    return element;
  }

  function repaint() {
    for (const target of selected.values()) {
      position(target.box, rectValue(target.element.getBoundingClientRect()));
    }
  }

  function updateEditor() {
    const targetCount = selected.size + regions.length + strokes.length;
    summary.textContent = targetCount
      ? `${selected.size} element${selected.size === 1 ? '' : 's'}, ${regions.length} region${regions.length === 1 ? '' : 's'}, ${strokes.length} drawing${strokes.length === 1 ? '' : 's'}`
      : 'Select an element, mark a region, or draw on the page.';
    save.disabled = targetCount === 0 || pendingCapture;
    stylesPanel.classList.toggle('visible', selected.size > 0);
    syncStyleFields();
  }

  const styleFields = new Map();
  const fieldDefinitions = [
    ['font-size', 'Font size'],
    ['font-weight', 'Font weight'],
    ['color', 'Text color'],
    ['background-color', 'Background'],
    ['border-color', 'Border color'],
    ['border-width', 'Border width'],
    ['border-radius', 'Radius'],
    ['width', 'Width'],
    ['height', 'Height'],
    ['padding', 'Padding'],
    ['margin', 'Margin'],
    ['gap', 'Gap'],
    ['opacity', 'Opacity'],
  ];
  for (const [property, labelText] of fieldDefinitions) {
    const label = document.createElement('label');
    const name = document.createElement('span');
    name.textContent = labelText;
    const input = document.createElement('input');
    input.type = 'text';
    input.addEventListener('change', () => setStyle(property, input.value.trim()));
    label.append(name, input);
    stylesPanel.appendChild(label);
    styleFields.set(property, input);
  }

  function setStyle(property, value) {
    for (const target of selected.values()) {
      const element = target.element;
      if (!(element instanceof HTMLElement || element instanceof SVGElement)) continue;
      let baselines = baselineStyles.get(element);
      if (!baselines) {
        baselines = new Map();
        baselineStyles.set(element, baselines);
      }
      if (!baselines.has(property)) baselines.set(property, element.style.getPropertyValue(property));
      const previousValue = getComputedStyle(element).getPropertyValue(property).trim();
      if (value) element.style.setProperty(property, value);
      else element.style.removeProperty(property);
      styleChanges.set(`${target.id}:${property}`, {
        targetId: target.id,
        selector: selectorFor(element),
        property,
        previousValue,
        value,
      });
    }
    repaint();
    syncStyleFields();
  }

  function syncStyleFields() {
    const first = selected.values().next().value;
    if (!first) {
      for (const input of styleFields.values()) input.value = '';
      return;
    }
    const computed = getComputedStyle(first.element);
    for (const [property, input] of styleFields) {
      input.value = computed.getPropertyValue(property).trim();
    }
  }

  function eraseAt(x, y) {
    const element = pickFromPoint(x, y);
    if (element && selected.has(element)) {
      removeSelected(element);
      return;
    }
    for (const target of selected.values()) {
      const rect = target.element.getBoundingClientRect();
      if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
        removeSelected(target.element);
        return;
      }
    }
    const regionIndex = regions.findIndex(
      (target) =>
        x >= target.rect.x &&
        x <= target.rect.x + target.rect.width &&
        y >= target.rect.y &&
        y <= target.rect.y + target.rect.height,
    );
    if (regionIndex >= 0) {
      const [target] = regions.splice(regionIndex, 1);
      layer.querySelector(`[data-region-id="${target.id}"]`)?.remove();
      updateEditor();
      return;
    }
    const strokeIndex = strokes.findIndex(
      (target) =>
        x >= target.bounds.x &&
        x <= target.bounds.x + target.bounds.width &&
        y >= target.bounds.y &&
        y <= target.bounds.y + target.bounds.height,
    );
    if (strokeIndex >= 0) {
      const [target] = strokes.splice(strokeIndex, 1);
      svg.querySelector(`[data-stroke-id="${target.id}"]`)?.remove();
      updateEditor();
    }
  }

  function isOverlayTarget(event) {
    const path = event.composedPath?.() || [];
    return path.includes(host);
  }

  function onPointerMove(event) {
    if (isOverlayTarget(event)) {
      hover.style.display = 'none';
      return;
    }
    if (tool === 'select' && !dragStart) {
      const element = pickFromPoint(event.clientX, event.clientY);
      if (element) position(hover, rectValue(element.getBoundingClientRect()));
      else hover.style.display = 'none';
    } else {
      hover.style.display = 'none';
    }
    if (tool === 'region' && dragStart) {
      position(marquee, normalizeRect(dragStart, { x: event.clientX, y: event.clientY }));
    }
    if (tool === 'draw' && activeStroke) {
      activeStroke.points.push({ x: event.clientX, y: event.clientY });
      activeStroke.path.setAttribute(
        'd',
        activeStroke.points
          .map((point, index) => `${index ? 'L' : 'M'} ${point.x} ${point.y}`)
          .join(' '),
      );
    }
  }

  function onPointerDown(event) {
    if (event.button !== 0 || isOverlayTarget(event)) return;
    event.preventDefault();
    event.stopPropagation();
    if (tool === 'select') {
      const element = pickFromPoint(event.clientX, event.clientY);
      if (!element) return;
      if (selected.has(element)) removeSelected(element);
      else {
        if (!event.shiftKey) {
          for (const target of [...selected.values()]) removeSelected(target.element);
        }
        addSelected(element);
      }
      return;
    }
    if (tool === 'erase') {
      eraseAt(event.clientX, event.clientY);
      return;
    }
    dragStart = { x: event.clientX, y: event.clientY };
    if (tool === 'draw') {
      const target = {
        id: makeId('stroke'),
        color: primary,
        width: 4,
        points: [dragStart],
        bounds: { x: dragStart.x, y: dragStart.y, width: 1, height: 1 },
      };
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('data-stroke-id', target.id);
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke', target.color);
      path.setAttribute('stroke-width', String(target.width));
      path.setAttribute('stroke-linecap', 'round');
      path.setAttribute('stroke-linejoin', 'round');
      svg.appendChild(path);
      activeStroke = { ...target, path };
    }
  }

  function onPointerUp(event) {
    if (!dragStart) return;
    event.preventDefault();
    event.stopPropagation();
    if (tool === 'region') {
      const rect = normalizeRect(dragStart, { x: event.clientX, y: event.clientY });
      marquee.style.display = 'none';
      if (rect.width >= 5 && rect.height >= 5) {
        const target = { id: makeId('region'), rect };
        regions.push(target);
        const box = document.createElement('div');
        box.className = 'region';
        box.setAttribute('data-region-id', target.id);
        position(box, rect);
        layer.appendChild(box);
      }
    } else if (tool === 'draw' && activeStroke) {
      const points = activeStroke.points;
      if (points.length > 1) {
        activeStroke.bounds = unionRects(
          points.map((point) => ({ x: point.x, y: point.y, width: 1, height: 1 })),
          activeStroke.width,
        );
        const { path, ...target } = activeStroke;
        strokes.push(target);
      } else {
        activeStroke.path.remove();
      }
      activeStroke = null;
    }
    dragStart = null;
    updateEditor();
  }

  function onClick(event) {
    if (isOverlayTarget(event)) return;
    event.preventDefault();
    event.stopPropagation();
  }

  function restoreStyles() {
    for (const [element, baselines] of baselineStyles) {
      for (const [property, value] of baselines) {
        if (value) element.style.setProperty(property, value);
        else element.style.removeProperty(property);
      }
    }
  }

  function teardown(notifyHost) {
    if (finished) return;
    finished = true;
    restoreStyles();
    document.documentElement.style.cursor = '';
    window.removeEventListener('pointermove', onPointerMove, true);
    window.removeEventListener('pointerdown', onPointerDown, true);
    window.removeEventListener('pointerup', onPointerUp, true);
    window.removeEventListener('click', onClick, true);
    window.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('scroll', repaint, true);
    window.removeEventListener('resize', repaint);
    host.remove();
    activeSession = null;
    if (notifyHost) ipcRenderer.sendToHost(HOST_MESSAGE, { type: 'cancelled' });
  }

  function onKeyDown(event) {
    if (isOverlayTarget(event) && event.key !== 'Escape') return;
    if (event.key === 'Escape') {
      event.preventDefault();
      teardown(true);
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      submit();
      return;
    }
    const key = event.key.toLowerCase();
    if (key === 'v') tool = 'select';
    else if (key === 'r') tool = 'region';
    else if (key === 'd') tool = 'draw';
    else if (key === 'e') tool = 'erase';
    else return;
    refreshTools();
  }

  function submit() {
    if (pendingCapture || (!selected.size && !regions.length && !strokes.length)) return;
    pendingCapture = true;
    save.disabled = true;
    save.textContent = 'Capturing…';
    const elements = [...selected.values()].flatMap((target) => {
      const element = captureElement(target.element);
      return element
        ? [{ id: target.id, element, rect: rectValue(target.element.getBoundingClientRect()) }]
        : [];
    });
    const screenshotRect = unionRects([
      ...elements.map((target) => target.rect),
      ...regions.map((target) => target.rect),
      ...strokes.map((target) => target.bounds),
    ]);
    toolbar.style.display = 'none';
    editor.style.display = 'none';
    hover.style.display = 'none';
    ipcRenderer.sendToHost(HOST_MESSAGE, {
      type: 'captured',
      annotation: {
        id: makeId('annotation'),
        pageUrl: location.href,
        pageTitle: document.title?.trim() || null,
        comment: comment.value.trim(),
        elements,
        regions: [...regions],
        strokes: [...strokes],
        styleChanges: [...styleChanges.values()],
        screenshot: null,
        createdAt: new Date().toISOString(),
      },
      screenshotRect,
    });
  }

  cancel.addEventListener('click', () => teardown(true));
  cancelTop.addEventListener('click', () => teardown(true));
  save.addEventListener('click', submit);
  comment.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      submit();
    }
  });
  window.addEventListener('pointermove', onPointerMove, { capture: true, passive: false });
  window.addEventListener('pointerdown', onPointerDown, { capture: true, passive: false });
  window.addEventListener('pointerup', onPointerUp, { capture: true, passive: false });
  window.addEventListener('click', onClick, { capture: true, passive: false });
  window.addEventListener('keydown', onKeyDown, { capture: true });
  window.addEventListener('scroll', repaint, { capture: true, passive: true });
  window.addEventListener('resize', repaint, { passive: true });

  refreshTools();
  updateEditor();
  activeSession = { teardown };
}

ipcRenderer.on(START_CHANNEL, (_event, theme) => startAnnotation(theme || {}));
ipcRenderer.on(CANCEL_CHANNEL, () => activeSession?.teardown(false));
ipcRenderer.on(CAPTURED_CHANNEL, () => activeSession?.teardown(false));
