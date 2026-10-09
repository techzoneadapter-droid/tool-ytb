const fs = require('node:fs');
const path = require('node:path');
function inside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}
function validateWorkspace(workspace, installRoot) {
  if (!path.isAbsolute(workspace)) throw Error('Chọn đường dẫn thư mục đầy đủ.');
  if (inside(installRoot, workspace)) throw Error('Chọn thư mục dữ liệu bên ngoài thư mục cài app.');
  fs.mkdirSync(workspace, { recursive: true });
  fs.accessSync(workspace, fs.constants.W_OK);
  return path.resolve(workspace);
}
function resolveWorkspace(userData, installRoot, override) {
  const config = path.join(userData, 'desktop-settings.json');
  let saved;
  if (fs.existsSync(config)) saved = JSON.parse(fs.readFileSync(config, 'utf8')).workspace;
  return validateWorkspace(override || saved || path.join(userData, 'workspace'), installRoot);
}
function saveWorkspace(userData, workspace, installRoot) {
  const chosen = validateWorkspace(workspace, installRoot);
  fs.mkdirSync(userData, { recursive: true });
  const file = path.join(userData, 'desktop-settings.json');
  fs.writeFileSync(file + '.tmp', JSON.stringify({ workspace: chosen }), { mode: 0o600 });
  fs.renameSync(file + '.tmp', file);
  return chosen;
}
module.exports = { inside, validateWorkspace, resolveWorkspace, saveWorkspace };
