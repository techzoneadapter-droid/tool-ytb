import argparse
from huggingface_hub import snapshot_download

parser = argparse.ArgumentParser()
parser.add_argument('--confirmed', action='store_true')
args = parser.parse_args()
if not args.confirmed:
    raise SystemExit('Explicit confirmation required before downloading model weights.')
snapshot_download('stabilityai/sd-turbo', local_dir='data/models/sd-turbo',
                  allow_patterns=['*.json', '*.txt', '*fp16.safetensors', 'tokenizer/*'])
print('SD-Turbo downloaded. Run the image benchmark before enabling Auto.', flush=True)
