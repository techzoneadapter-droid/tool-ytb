const { spawnSync } = require('node:child_process');
const path = require('node:path');
const python = process.env.FLOW_PYTHON || path.resolve('.flow-venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const result = spawnSync(python, ['-m', 'unittest', 'discover', '-s', 'tests', '-p', 'test_flow_python.py'], { stdio: 'inherit', windowsHide: true });
if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;
