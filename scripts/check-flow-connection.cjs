const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
process.env.NO_PROXY = [process.env.NO_PROXY, 'localhost', '127.0.0.1', '[::1]'].filter(Boolean).join(',');
(async () => {
  const lines = fs.readFileSync(path.join(process.env.LOCALAPPDATA, 'Google/Chrome/User Data/DevToolsActivePort'), 'utf8').trim().split(/\r?\n/);
  for (const suffix of ['/devtools/browser']) {
    try {
      const browser = await chromium.connectOverCDP(`ws://127.0.0.1:${lines[0]}${suffix}`, { timeout: 60000, noDefaults: true });
      console.log('Connected at', suffix, 'contexts:', browser.contexts().length);
      await browser.close();
      return;
    } catch (error) { console.log(String(error)); }
  }
  process.exitCode = 1;
})();
