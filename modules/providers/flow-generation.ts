export function generationScript(
  prompt: string,
  aspect: "16:9" | "9:16",
  timeout = 420000,
) {
  return `async () => {
    const prompt = ${JSON.stringify(prompt)};
    const aspect = ${JSON.stringify(aspect)};
    const timeoutMs = ${Math.max(30000, timeout)};

    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const largeImages = () =>
      Array.from(document.images)
        .filter((img) =>
          img.complete &&
          img.naturalWidth >= 256 &&
          img.naturalHeight >= 256 &&
          img.naturalWidth * img.naturalHeight >= 262144 &&
          (img.currentSrc || img.src)
        )
        .map((img) => img.currentSrc || img.src);

    const before = new Set(largeImages());

    const selectors = [
      '.ProseMirror[contenteditable="true"]',
      'textarea[placeholder*="Bạn muốn tạo"]',
      'textarea[placeholder*="What do you want"]',
      '[contenteditable="true"][role="textbox"]',
      'textarea',
      '[contenteditable="true"]'
    ];

    let box = null;
    for (const selector of selectors) {
      const nodes = Array.from(document.querySelectorAll(selector));
      box = nodes.reverse().find((node) => {
        const rect = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden';
      });
      if (box) break;
    }
    if (!box) throw new Error("Không tìm thấy ô nhập prompt trên Flow.");

    box.focus();
    const existing = box instanceof HTMLTextAreaElement || box instanceof HTMLInputElement ? box.value : box.textContent;
    if (existing !== prompt) {
    if (box instanceof HTMLTextAreaElement || box instanceof HTMLInputElement) {
      const proto = box instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      setter?.call(box, prompt);
      box.dispatchEvent(new Event('input', { bubbles: true }));
      box.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      box.textContent = prompt;
      box.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        inputType: 'insertText',
        data: prompt
      }));
    }
    }

    const aspectNodes = Array.from(document.querySelectorAll('button,[role="button"],[role="menuitem"],[role="option"]'));
    const aspectNode = aspectNodes.find((node) => node.textContent?.trim() === aspect);
    if (aspectNode instanceof HTMLElement) aspectNode.click();

    await sleep(300);

    const buttons = Array.from(document.querySelectorAll('button,[role="button"]'));
    const generate = buttons.reverse().find((node) => {
      if (!(node instanceof HTMLElement)) return false;
      const label = (node.getAttribute('aria-label') || node.textContent || '').trim().toLowerCase();
      const disabled =
        node instanceof HTMLButtonElement ? node.disabled : node.getAttribute('aria-disabled') === 'true';
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && !disabled && ['tạo','tạo ảnh','bắt đầu tạo','generate','start generating','generate image','generate images','gửi','send','arrow_forward'].includes(label);
    });

    if (generate instanceof HTMLElement) generate.click();
    else throw new Error('Không tìm thấy nút tạo ảnh đang bật trên Flow. Kiểm tra chế độ Images và model trong dự án.');

    const deadline = Date.now() + timeoutMs;
    let src = '';
    while (Date.now() < deadline) {
      const body = Array.from(document.querySelectorAll('[role="alert"]')).map(node => node.textContent || '').join(' ').toLowerCase();
      const warning = [
        'hết tín dụng',
        'insufficient credits',
        'too many requests',
        'rate limit',
        'try again later',
        'thử lại sau'
      ].find((item) => body.includes(item));
      if (warning) throw new Error('Google Flow đang báo giới hạn/tín dụng: ' + warning);

      const fresh = largeImages().filter((item) => !before.has(item));
      if (fresh.length) {
        src = fresh[fresh.length - 1];
        break;
      }
      await sleep(1500);
    }
    if (!src) throw new Error('Flow chưa trả ảnh trong thời gian chờ.');

    let response;
    try { response = await fetch(src); }
    catch {
      // The worker can download HTTPS assets using the same account cookies,
      // even when the image host does not permit cross-origin browser fetch.
      return { storyflow: true, src };
    }
    if (!response.ok) throw new Error('Không tải được ảnh Flow: HTTP ' + response.status);
    const blob = await response.blob();
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error);
      reader.onload = () => resolve(String(reader.result));
      reader.readAsDataURL(blob);
    });

    return {
      storyflow: true,
      mime: blob.type || 'image/png',
      dataUrl,
      src
    };
  }`;
}
