async ({ action, prompt }) => {
  const visible = node => node.isConnected && node.getClientRects().length > 0 && getComputedStyle(node).visibility !== 'hidden';
  const editors = [...document.querySelectorAll('.ProseMirror[contenteditable="true"], textarea, input[type="text"], [contenteditable="true"][role="textbox"]')].filter(visible);
  if (editors.length !== 1) return { error: `Expected one prompt editor, found ${editors.length}` };
  const editor = editors[0];
  if (action === 'fill') {
    if (editor.disabled || editor.readOnly) return { error: 'Prompt editor is disabled or read-only' };
    if (editor instanceof HTMLTextAreaElement || editor instanceof HTMLInputElement) {
      const prototype = editor instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, 'value').set.call(editor, prompt);
    } else {
      // Update ProseMirror's document, rather than leaving its state behind the DOM.
      const view = editor.pmViewDesc?.view;
      if (view?.dispatch && view.state?.tr) {
        view.dispatch(view.state.tr.insertText(prompt, 0, view.state.doc.content.size));
      } else {
        editor.textContent = prompt;
      }
    }
    editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: prompt }));
    editor.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 0));
    return { ok: true };
  }
  const value = editor instanceof HTMLTextAreaElement || editor instanceof HTMLInputElement ? editor.value : editor.textContent;
  if (value !== prompt) return { error: 'Prompt was not retained by the page state; submission stopped' };
  const label = node => (node.getAttribute('aria-label') || node.textContent || '').trim();
  const buttons = [...document.querySelectorAll('button,[role="button"]')].filter(node => visible(node) && /^(bắt đầu tạo|tạo ảnh|tạo|generate(?: images?)?|start generating|arrow_forward)$/i.test(label(node)));
  if (buttons.length !== 1) return { error: `Expected one generation submit control, found ${buttons.length}` };
  const button = buttons[0];
  if (button.disabled || button.getAttribute('aria-disabled') === 'true') return { pending: true };
  // Only invoke the handler attached to this confirmed control, never scan global functions.
  const propsKey = Object.keys(button).find(key => key.startsWith('__reactProps$'));
  const handler = propsKey && button[propsKey]?.onClick;
  if (typeof handler === 'function') {
    const nativeEvent = new MouseEvent('click', { bubbles: true, cancelable: true });
    let prevented = false;
    let stopped = false;
    const event = {
      nativeEvent, type: 'click', target: button, currentTarget: button,
      bubbles: true, cancelable: true, timeStamp: nativeEvent.timeStamp,
      get defaultPrevented() { return prevented; },
      preventDefault() { prevented = true; nativeEvent.preventDefault(); },
      stopPropagation() { stopped = true; nativeEvent.stopPropagation(); },
      isDefaultPrevented: () => prevented, isPropagationStopped: () => stopped,
      persist() {},
    };
    await handler(event);
    return { ok: true, method: 'react-handler' };
  }
  if (button.form && button.type === 'submit') {
    button.form.requestSubmit(button);
    return { ok: true, method: 'requestSubmit' };
  }
  // DOM event fallback still runs in page JavaScript, without pointer coordinates.
  button.click();
  return { ok: true, method: 'dom-click' };
}
