import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

const roots = ["app", "modules", "scripts", "workers", "tests"];
const extensions = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".json", ".css", ".md"]);
const markers = [/^<<<<<<< /m, /^=======$/m, /^>>>>>>> /m];

async function walk(dir, out = []) {
  let entries = [];
  try {
    entries = await readdir(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const full = path.join(dir, name);
    const info = await stat(full);
    if (info.isDirectory()) await walk(full, out);
    else if (extensions.has(path.extname(name))) out.push(full);
  }
  return out;
}

const files = [];
for (const root of roots) await walk(path.resolve(root), files);

const bad = [];
for (const file of files) {
  const text = await readFile(file, "utf8");
  if (markers.some((pattern) => pattern.test(text)))
    bad.push(path.relative(process.cwd(), file));
}

if (bad.length) {
  console.error("\nStoryFlow không thể chạy vì còn merge conflict trong code:");
  for (const file of bad) console.error(" - " + file);
  console.error("\nHãy xử lý các marker <<<<<<< / ======= / >>>>>>> trước khi chạy app.\n");
  process.exit(1);
}

console.log("✓ Không còn merge conflict marker trong mã nguồn.");
