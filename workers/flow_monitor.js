async args => {
  if (!window.__storyflowComposer) throw new Error("Use FLOW_COMPOSER_SCRIPT snapshot action");
  return window.__storyflowComposer({ ...args, action: "snapshot" });
}
