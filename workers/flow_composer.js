async function flowComposer({ action = 'inspect', prompt = '', before = null, method = null, timeoutMs = 15000 } = {}) {
  window.__storyflowComposer = flowComposer;
  const visible = n => n.isConnected && n.getClientRects().length > 0 && !['hidden', 'collapse'].includes(getComputedStyle(n).visibility);
  const enabled = n => !!n && !n.disabled && !n.matches(':disabled') && n.getAttribute('aria-disabled') !== 'true';
  const value = n => n ? ('value' in n ? n.value : n.textContent || '') : null;
  const label = n => [n.getAttribute('aria-label'), n.getAttribute('title'), n.textContent, n.value].filter(Boolean).join(' ').trim();
  let editors = [];
  for (const selector of ['textarea', '.ProseMirror[contenteditable="true"]', '[contenteditable="true"][role="textbox"]', '[contenteditable="true"]', 'input:not([type]),input[type="text"]', '[role="textbox"]']) {
    editors = [...document.querySelectorAll(selector)].filter(n => visible(n) && !n.disabled && !n.readOnly);
    if (editors.length) break;
  }
  const editor = editors.length === 1 ? editors[0] : null;
  const form = editor?.closest('form');
  const distance = n => {
    let depth = 0;
    for (let ancestor = editor; ancestor; ancestor = ancestor.parentElement, depth++) {
      if (ancestor.contains(n)) return depth;
    }
    return 100;
  };
  const candidates = [...document.querySelectorAll('button,[role="button"],input[type="submit"]')].filter(visible).map(n => {
    const text = label(n);
    const d = distance(n);
    const sameForm = !!form && (n.form === form || form.contains(n));
    const explicit = /generate|start generating|bắt đầu tạo|tạo ảnh|^tạo$|arrow_forward|\bsend\b|^gửi$/i.test(text);
    const excluded = /settings|model|aspect|ratio|upload|attach|nano banana|imagen|veo|cài đặt|tỷ lệ|16:9|9:16|^x\d/i.test(text);
    const submit = n.matches('[type="submit"]');
    const eligible = !excluded && (sameForm || d <= 4) && (explicit || submit || (sameForm && n.tagName === 'BUTTON' && !n.hasAttribute('type')));
    return { node: n, label: text, distance: d, score: (sameForm ? 100 : 0) + (submit ? 60 : 0) + (explicit ? 50 : 0) - d, eligible };
  }).filter(c => c.eligible).sort((a,b) => b.score - a.score);
  const ambiguous = candidates.length > 1 && candidates[0].score === candidates[1].score;
  const button = ambiguous ? null : candidates[0]?.node;
  window.__storyflowMediaIds ||= { ids: new WeakMap(), next: 0 };
  const registry = window.__storyflowMediaIds;
  const id = n => { if (!registry.ids.has(n)) registry.ids.set(n, ++registry.next); return registry.ids.get(n); };
  const loadingNodes = () => [...document.querySelectorAll('[aria-busy="true"],[role="progressbar"],[data-state="loading"],[data-loading="true"],.spinner,[class*="animate-spin"]')].filter(visible);
  const cards = () => [...document.querySelectorAll('[data-testid*="media"],[data-testid*="result"],[data-testid*="placeholder"],[data-generation-id],[data-media-id],[data-state="pending"],[data-state="generating"]')].filter(n => visible(n) && !n.contains(editor) && !n.closest('header,nav'));
  const snapshot = () => {
    const images = [...document.images].filter(n => visible(n) && n.complete && n.naturalWidth >= 512 && n.naturalHeight >= 512 && !n.closest('header,nav') && !/avatar|profile|icon|logo/i.test(n.alt || '')).map(n => ({ id: id(n), src: n.currentSrc || n.src, width: n.naturalWidth, height: n.naturalHeight })).filter(n => n.src);
    const loaders = loadingNodes();
    const media = cards();
    return { ok: !!editor, composerReady: !!editor, generationReady: !!editor && !!button,
      composerType: editor?.tagName, contenteditable: editor?.isContentEditable || false, formFound: !!form,
      promptValue: value(editor), text: value(editor), submitFound: !!button, submitEnabled: enabled(button), submitDisabled: !!button && !enabled(button),
      submitBusy: button?.getAttribute('aria-busy') === 'true' || !!button?.querySelector('[role="progressbar"],.spinner,[class*="animate-spin"]'),
      submitId: button ? id(button) : null, submitLabel: button ? label(button) : null,
      availableButtons: [...document.querySelectorAll('button,[role="button"]')].filter(n => visible(n) && enabled(n)).length,
      candidates: candidates.map(c => ({ label: c.label, distance: c.distance, score: c.score, enabled: enabled(c.node), disabled: !!c.node.disabled, ariaDisabled: c.node.getAttribute('aria-disabled') })),
      images, sources: [...document.images].map(n => n.currentSrc || n.src).filter(Boolean), loading: loaders.length, loadingIds: loaders.map(id), mediaCount: media.length, mediaIds: media.map(id), resultChildren: media.reduce((sum,n) => sum + n.childElementCount, 0),
      alerts: [...document.querySelectorAll('[role="alert"],[role="status"]')].filter(visible).map(n => n.textContent || '').join(' '),
      modelLabels: [...document.querySelectorAll('button,[role="combobox"]')].filter(visible).map(label).filter(t => /nano banana|imagen|veo/i.test(t)),
      mutationCount: window.__storyflowWatch?.count || 0 };
  };
  const compare = baseline => {
    const current = snapshot();
    const oldSources = new Set(baseline.sources || baseline.images?.map(n => n.src) || []);
    const fresh = current.images.filter(n => !oldSources.has(n.src));
    const signals = {
      composerCleared: !!editor && value(editor).trim() === '' && (baseline.promptValue || prompt).trim() !== '',
      buttonChanged: baseline.submitEnabled === true && current.submitFound && (!current.submitEnabled || current.submitBusy),
      loadingAppeared: current.loadingIds.some(n => !(baseline.loadingIds || []).includes(n)) && current.loading > (baseline.loading || 0),
      resultChanged: fresh.length > 0 || current.mediaIds.some(n => !(baseline.mediaIds || []).includes(n)),
      mutationCount: current.mutationCount
    };
    const started = signals.composerCleared || signals.buttonChanged || signals.loadingAppeared || signals.resultChanged;
    return { ...current, fresh, signals, started, generationStarted: started,
      safeToRetry: !started && current.promptValue === baseline.promptValue && current.submitId === baseline.submitId && current.submitEnabled === baseline.submitEnabled && current.submitLabel === baseline.submitLabel && current.loading === baseline.loading && current.mediaCount === baseline.mediaCount && current.mutationCount === 0 };
  };
  if (action === 'snapshot' || action === 'waitGenerationStart') {
    if (action === 'snapshot') return before ? compare(before) : snapshot();
    const deadline = performance.now() + timeoutMs;
    do { const current = compare(before); if (current.started) return current; await new Promise(r => setTimeout(r, 100)); } while (performance.now() < deadline);
    return compare(before);
  }
  if (!editor) return { ...snapshot(), ok: false, error: `Expected one prompt editor, found ${editors.length}`, code: 'FLOW_COMPOSER_NOT_FOUND' };
  if (action === 'probe' || action === 'inspect') return snapshot();
  if (action === 'inject' || action === 'fill') {
    window.__storyflowWatch?.observer.disconnect();
    window.__storyflowWatch = null;
    editor.focus();
    const event = type => new InputEvent(type, { bubbles: true, cancelable: type === 'beforeinput', inputType: 'insertText', data: prompt });
    if (editor instanceof HTMLTextAreaElement || editor instanceof HTMLInputElement) {
      editor.dispatchEvent(event('beforeinput'));
      const proto = editor instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(editor, prompt);
      editor.dispatchEvent(event('input'));
    } else {
      const selection = getSelection(), range = document.createRange();
      range.selectNodeContents(editor); selection.removeAllRanges(); selection.addRange(range);
      const inserted = document.execCommand('insertText', false, prompt);
      if (!inserted || value(editor) !== prompt) {
        if (!editor.dispatchEvent(event('beforeinput'))) return { ...snapshot(), ok: false, error: 'Editor rejected input', code: 'FLOW_PROMPT_INJECT_FAILED' };
        editor.textContent = prompt;
        editor.dispatchEvent(event('input'));
      }
      range.selectNodeContents(editor); range.collapse(false); selection.removeAllRanges(); selection.addRange(range);
    }
    editor.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(r => setTimeout(r, 50));
    return value(editor) === prompt ? snapshot() : { ...snapshot(), ok: false, error: 'Page did not retain the prompt', code: 'FLOW_PROMPT_INJECT_FAILED' };
  }
  if (action === 'observe') {
    window.__storyflowWatch?.observer.disconnect();
    const watch = { count: 0, observer: new MutationObserver(records => { watch.count += records.length; }) };
    watch.observer.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true, attributeFilter: ['aria-busy','disabled','aria-disabled','class','data-state','src'] });
    window.__storyflowWatch = watch;
    return snapshot();
  }
  if (action === 'stop') { window.__storyflowWatch?.observer.disconnect(); return snapshot(); }
  if (value(editor) !== prompt) return { error: 'Prompt was not retained', code: 'FLOW_PROMPT_INJECT_FAILED' };
  if (!button) return { ...snapshot(), error: 'No unambiguous nearby generation control', code: 'FLOW_SUBMIT_BUTTON_NOT_FOUND' };
  if (!enabled(button)) return { ...snapshot(), error: 'Generation control is disabled', code: 'FLOW_SUBMIT_BUTTON_DISABLED' };
  const methods = [];
  if (form && typeof form.requestSubmit === 'function') methods.push('requestSubmit');
  if (typeof button.click === 'function') methods.push('dom-click');
  if (typeof button.dispatchEvent === 'function') methods.push('mouse-event');
  if (editor.getAttribute('data-submit-on-enter') === 'true' || editor.getAttribute('enterkeyhint') === 'send') methods.push('enter');
  const propsKey = Object.keys(button).find(key => key.startsWith('__reactProps$'));
  if (typeof button[propsKey]?.onClick === 'function') methods.push('react-handler');
  const selected = method || methods[0];
  if (!methods.includes(selected)) return { error: 'No supported submit action', code: 'FLOW_SUBMIT_FAILED' };
  if (selected === 'dom-click') {
    document.querySelectorAll('[data-storyflow-submit]').forEach(n => n.removeAttribute('data-storyflow-submit'));
    button.setAttribute('data-storyflow-submit', 'true');
    return { ok: true, method: selected, submitMethod: selected, methods, submitDisabled: false, trustedClick: true };
  }
  if (selected === 'requestSubmit') {
    if (!form.checkValidity()) return { error: 'Composer form failed validation', code: 'FLOW_SUBMIT_FAILED' };
    form.requestSubmit(button.form === form && button.type === 'submit' ? button : undefined);
  } else if (selected === 'dom-click') button.click();
  else if (selected === 'mouse-event') button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  else if (selected === 'enter') {
    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
    editor.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }));
  } else {
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    await button[propsKey].onClick({ nativeEvent: event, target: button, currentTarget: button, type: 'click', preventDefault: () => event.preventDefault(), stopPropagation: () => event.stopPropagation(), isDefaultPrevented: () => event.defaultPrevented, isPropagationStopped: () => event.cancelBubble, persist() {} });
  }
  return { ok: true, method: selected, submitMethod: selected, methods, submitDisabled: false };
}
