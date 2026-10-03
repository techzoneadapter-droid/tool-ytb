"""Resume pinned PyTorch wheel in bounded HTTP ranges; verify official SHA256."""
import concurrent.futures
import hashlib
from pathlib import Path
import time
import urllib.request

url = 'https://download.pytorch.org/whl/cu118/torch-2.7.1%2Bcu118-cp310-cp310-win_amd64.whl'
expected = 'af4833e36a8e964681a4dad7775f559cf043bd42c9d0c0b5e0619f9d0e44cb56'
total = 2817209444
block = 8 * 1024 * 1024
directory = Path('data/setup-cache')
directory.mkdir(parents=True, exist_ok=True)
target = directory / 'torch-2.7.1+cu118-cp310-cp310-win_amd64.whl'
def digest(file):
    h = hashlib.sha256()
    with file.open('rb') as f:
        for data in iter(lambda:f.read(block), b''): h.update(data)
    return h.hexdigest()
if target.exists() and digest(target) == expected:
    print('Verified cached PyTorch wheel.', flush=True)
    raise SystemExit(0)
def part(index):
    start = index * block
    end = min(total, start + block) - 1
    file = directory / f'torch.part{index}'
    if file.exists() and file.stat().st_size == end - start + 1: return file
    for attempt in range(4):
        try:
            request = urllib.request.Request(url, headers={'Range':f'bytes={start}-{end}'})
            with urllib.request.urlopen(request, timeout=60) as response:
                if response.status != 206 or response.headers.get('Content-Range') != f'bytes {start}-{end}/{total}':
                    raise ValueError('Unexpected HTTP range response')
                data = response.read()
            if len(data) != end-start+1: raise ValueError('Incomplete range')
            file.write_bytes(data)
            return file
        except Exception:
            if attempt == 3: raise
            time.sleep(2)
count = (total + block - 1) // block
with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
    for done, _ in enumerate(pool.map(part, range(count)), 1):
        if done % 8 == 0: print(f'PyTorch download: {done}/{count} chunks', flush=True)
with target.open('wb') as out:
    for i in range(count): out.write((directory / f'torch.part{i}').read_bytes())
if digest(target) != expected: raise RuntimeError('PyTorch SHA256 mismatch')
print('PyTorch wheel SHA256 verified.', flush=True)
