async function flowResult({
  action = "poll",
  requestId,
  projectId,
  chapterId,
} = {}) {
  if (action === "arm") {
    window.__storyflowResult?.stop();
    const ids = new WeakMap();
    let nextId = 0;
    const identity = (node) => {
      if (!ids.has(node)) ids.set(node, ++nextId);
      return ids.get(node);
    };
    const urls = (node) => [
      ...new Set(
        [
          node.src,
          node.currentSrc,
          ...(node.srcset || "")
            .split(",")
            .map((s) => s.trim().split(/\s+/)[0]),
        ].filter(Boolean),
      ),
    ];
    const beforeSnapshot = {
      urls: [...new Set([...document.images].flatMap(urls))],
      nodes: [...document.images].map(identity),
      mediaCount: document.images.length,
      timestamp: Date.now(),
    };
    const baseline = new Set(beforeSnapshot.urls);
    const startedAt = Date.now();
    const seen = new Map();
    const events = [];
    const candidates = [];
    let stopped = false;
    const uiAsset = (node) =>
      /avatar|profile|icon|logo/i.test(
        [node.alt, node.getAttribute("aria-label"), node.className].join(" "),
      ) ||
      !!node.closest('header,nav,[role="navigation"],[data-testid*="avatar"]');
    const resultCard = (node) =>
      node.closest(
        '[data-generation-id],[data-media-id],[data-testid*="result"],[data-testid*="media"],article,figure',
      );
    async function isValidFlowResult(node, source) {
      const src = node.currentSrc || node.src;
      if (stopped || !src || baseline.has(src) || uiAsset(node)) return;
      const key = identity(node) + ":" + src;
      if (!seen.has(key)) seen.set(key, Date.now());
      if (seen.get(key) < startedAt) return;
      // Decoding can complete without another attribute mutation; polling revisits it.
      if (!node.complete) {
        node
          .decode?.()
          .then(() => scan("decode"))
          .catch(() => {});
        return;
      }
      if (node.naturalWidth < 512 || node.naturalHeight < 512) return;
      if (candidates.some((c) => c.src === src)) return;
      candidates.push({
        requestId,
        projectId,
        chapterId,
        id: identity(node),
        src,
        urls: urls(node),
        width: node.naturalWidth,
        height: node.naturalHeight,
        detectedAt: seen.get(key),
        resultCard: !!resultCard(node),
        source,
      });
    }
    const scan = (source) => {
      for (const node of document.images) void isValidFlowResult(node, source);
    };
    const observer = new MutationObserver((records) => {
      events.push({ timestamp: Date.now(), count: records.length });
      if (events.length > 200) events.shift();
      scan("observer");
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["src", "srcset", "class", "aria-busy"],
    });
    const timer = setInterval(() => scan("polling"), 1000);
    window.__storyflowResult = {
      pendingGeneration: {
        requestId,
        projectId,
        chapterId,
        startedAt,
        beforeSnapshot,
      },
      poll: () => {
        scan("polling");
        return {
          beforeSnapshot,
          events,
          candidates: [...candidates].sort(
            (a, b) =>
              Number(b.resultCard) - Number(a.resultCard) ||
              a.detectedAt - b.detectedAt,
          ),
        };
      },
      stop: () => {
        stopped = true;
        observer.disconnect();
        clearInterval(timer);
      },
    };
    return { beforeSnapshot, startedAt, observerReady: true };
  }
  if (action === "stop") {
    const result = window.__storyflowResult?.poll();
    window.__storyflowResult?.stop();
    return result;
  }
  const result = window.__storyflowResult?.poll();
  if (result?.candidates.length) window.__storyflowResult.stop();
  return result || { candidates: [] };
}
