"""Build a compact cross-location AlphaEarth index from prepared location grids."""
import argparse
import json
import math
from pathlib import Path
import struct
import zlib

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
LABELS = {'gorny-gigant': 'Gorny Gigant', 'almaty': 'Almaty', 'suaq': 'Suaq',
          'balqash': 'Balqash', 'balqash-lake': 'Lake Balqash'}


def png(path, rgba):
    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data) & 0xffffffff)
    height, width, _ = rgba.shape
    rows = b''.join(b'\0' + row.tobytes() for row in rgba)
    path.write_bytes(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 6, 0, 0, 0))
                     + chunk(b'IDAT', zlib.compress(rows)) + chunk(b'IEND', b''))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--year', type=int, default=2025)
    args = parser.parse_args()
    block = 5
    locations = []
    parts = []
    offset = 0
    dataset = None
    for slug, label in LABELS.items():
        folder = ROOT / 'public/data/locations' / slug / 'embeddings' / str(args.year)
        meta = json.loads((folder / 'metadata.json').read_text())
        if meta['encoding'] != 'aef-int8' or meta['dimensions'] != 64 or meta['year'] != args.year or meta['crs'] != 'EPSG:4326':
            raise RuntimeError('Incompatible source embeddings')
        if dataset and dataset != meta['dataset']:
            raise RuntimeError('Embedding spaces do not match')
        dataset = meta['dataset']
        width, height = meta['width'], meta['height']
        raw = np.fromfile(folder / 'values.bin', dtype=np.int8).reshape(height, width, 64)
        valid = np.all(raw != -128, axis=2)
        values = np.sign(raw.astype(float)) * (raw.astype(float) / 127.5) ** 2
        norms = np.linalg.norm(values, axis=2, keepdims=True)
        values = np.divide(values, norms, out=np.zeros_like(values), where=norms > 0)
        values[~valid] = 0
        rgba = np.zeros((height, width, 4), dtype=np.uint8)
        rgba[:, :, :3] = np.clip((values[:, :, [1, 16, 9]] + .3) / .6 * 255, 0, 255).round().astype(np.uint8)
        rgba[:, :, 3] = valid * 255
        png(folder / 'preview.png', rgba)
        index_w, index_h = math.ceil(width / block), math.ceil(height / block)
        encoded = np.full((index_h, index_w, 64), -128, dtype=np.int8)
        for row in range(index_h):
            for col in range(index_w):
                # Sum decoded unit vectors, then renormalize; never average raw int8 values.
                patch = values[row * block:(row + 1) * block, col * block:(col + 1) * block]
                mean = patch.sum(axis=(0, 1))
                norm = np.linalg.norm(mean)
                if norm < 1e-8:
                    continue
                mean /= norm
                encoded[row, col] = np.clip(np.rint(np.sign(mean) * np.sqrt(np.abs(mean)) * 127.5), -127, 127).astype(np.int8)
        count = index_w * index_h
        locations.append(dict(slug=slug, label=label, bounds=meta['bounds'], sourceWidth=width, sourceHeight=height,
                              width=index_w, height=index_h, offset=offset, count=count))
        parts.append(encoded.reshape(-1, 64))
        offset += count
    output = ROOT / 'public/data/embedding-search' / str(args.year)
    output.mkdir(parents=True, exist_ok=True)
    np.concatenate(parts).tofile(output / 'values.bin')
    manifest = dict(version=1, year=args.year, dataset=dataset, encoding='aef-int8', dimensions=64,
                    blockSize=block, count=offset, valuesFile='values.bin', locations=locations,
                    attribution='The AlphaEarth Foundations Satellite Embedding dataset is produced by Google and Google DeepMind.',
                    license='CC-BY-4.0')
    (output / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print(f'{len(locations)} locations, {offset} patches, {offset * 64 / 1024**2:.2f} MiB')


if __name__ == '__main__':
    main()
