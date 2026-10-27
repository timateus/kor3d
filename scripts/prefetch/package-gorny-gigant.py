#!/usr/bin/env python3
"""Validate and package the Arnis-generated Gorny Gigant Java world.

Run with an environment containing nbtlib and Pillow. Generate first with the
command recorded in public/data/minecraft/gorny-gigant/README-RU.md.
"""
from pathlib import Path
from datetime import datetime, timezone
import gzip
import hashlib
import io
import json
import shutil
import struct
import xml.etree.ElementTree as ET
import zipfile
import zlib

import nbtlib
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'public/data/minecraft/gorny-gigant'
CACHE = Path('/tmp/kor3d-arnis')
WORLD = OUT / 'Gorny-Gigant-Almaty'


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def read_chunk(x, z):
    cx, cz = x // 16, z // 16
    path = WORLD / 'region' / f'r.{cx // 32}.{cz // 32}.mca'
    with path.open('rb') as f:
        f.seek(4 * (cx % 32 + cz % 32 * 32))
        entry = int.from_bytes(f.read(4), 'big')
        assert entry, (cx, cz)
        f.seek((entry >> 8) * 4096)
        length = int.from_bytes(f.read(4), 'big')
        assert f.read(1) == b'\x02'
        chunk = nbtlib.File.parse(io.BytesIO(zlib.decompress(f.read(length - 1))))
    assert int(chunk['xPos']) == cx and int(chunk['zPos']) == cz
    assert str(chunk['Status']) == 'minecraft:full'
    return chunk


def block(chunk, x, y, z):
    section = next(s for s in chunk['sections'] if int(s['Y']) == y // 16)
    states = section['block_states']
    palette = states['palette']
    index = (y % 16) * 256 + (z % 16) * 16 + x % 16
    bits = max(4, (len(palette) - 1).bit_length())
    per = 64 // bits
    entry = 0 if len(palette) == 1 else (
        (int(states['data'][index // per]) & ((1 << 64) - 1))
        >> ((index % per) * bits)
    ) & ((1 << bits) - 1)
    return str(palette[entry]['Name'])


def main():
    original = OUT / 'Gorny-Gigant' / 'Arnis World 1'
    if not WORLD.exists():
        original.rename(WORLD)
        original.parent.rmdir()
    level = nbtlib.load(WORLD / 'level.dat')
    data = level['Data']
    data['LevelName'] = nbtlib.String('Горный Гигант — Алматы')
    level.save()
    assert int(data['DataVersion']) == 4189
    assert int(data['GameType']) == 1 and int(data['allowCommands']) == 1
    x, y, z = (int(data[k]) for k in ('SpawnX', 'SpawnY', 'SpawnZ'))
    chunk = read_chunk(x, z)
    assert block(chunk, x, y, z) == 'minecraft:air'
    assert block(chunk, x, y + 1, z) == 'minecraft:air'
    surface = next(yy for yy in range(y - 1, -65, -1)
                   if block(chunk, x, yy, z) != 'minecraft:air')
    assert 1 <= y - surface <= 5
    chunks = 0
    for path in sorted((WORLD / 'region').glob('*.mca')):
        raw = path.read_bytes()
        for index in range(1024):
            entry = int.from_bytes(raw[index * 4:index * 4 + 4], 'big')
            if not entry:
                continue
            offset, sectors = entry >> 8, entry & 255
            start = offset * 4096
            length = struct.unpack('>I', raw[start:start + 4])[0]
            assert length > 1 and length + 4 <= sectors * 4096
            assert start + length + 4 <= len(raw)
            assert raw[start + 4] == 2
            zlib.decompress(raw[start + 5:start + 4 + length])
            chunks += 1
    # Check coordinates/status at corners and a regular grid, in addition to spawn.
    for xx in (0, 496, 992, 1488, 1993):
        for zz in (0, 496, 992, 1488, 2001):
            read_chunk(xx, zz)
    source = (CACHE / 'gorny-gigant.osm').read_bytes()
    xml = ET.fromstring(source)
    ways = [{t.attrib['k']: t.attrib['v'] for t in w.findall('tag')}
            for w in xml.findall('way')]
    (OUT / 'source.osm.gz').write_bytes(gzip.compress(source, mtime=0))
    Image.open(WORLD / 'arnis_world_map.png').save(OUT / 'preview.png')
    shutil.copyfile(CACHE / 'generation.log', OUT / 'generation.log')
    release = json.loads((CACHE / 'release.json').read_text())
    manifest = {
        'createdUtc': datetime.now(timezone.utc).isoformat(),
        'title': 'Горный Гигант — Алматы',
        'format': 'Minecraft Java Anvil', 'minecraftVersion': '1.21.4',
        'dataVersion': 4189, 'gamemode': 'creative',
        'bboxLonLat': [76.9357, 43.2085, 76.9603, 43.2265],
        'blocksPerMeter': 1, 'sizeBlocks': [1994, 2002],
        'spawn': [x, y, z], 'spawnSurfaceY': surface,
        'sourceFeatureCountsNotGeneratedBuildingCounts': {
            'buildingWays': sum('building' in t for t in ways),
            'highwayWays': sum('highway' in t for t in ways),
            'buildingWaysWithHeightOrLevels': sum('building' in t and
                ('height' in t or 'building:levels' in t) for t in ways),
        },
        'osm': {'url': 'https://api.openstreetmap.org/api/0.6/map?bbox=76.9357,43.2085,76.9603,43.2265',
                'copyright': '© OpenStreetMap contributors', 'license': 'ODbL 1.0',
                'licenseUrl': 'https://www.openstreetmap.org/copyright',
                'sha256Xml': hashlib.sha256(source).hexdigest()},
        'generator': {'name': 'Arnis', 'version': release['tag_name'],
                      'url': 'https://github.com/louis-e/arnis',
                      'binarySha256': sha(CACHE / 'arnis-mac-universal'),
                      'archiveSha256': sha(CACHE / 'arnis-mac-universal.tar.gz')},
        'terrain': {'source': 'Mapterhorn', 'url': 'https://mapterhorn.com/',
                    'elevationRangeMetersFromLog': 170.9,
                    'note': 'Parent tile fallback; generator smooths built-up ground and levels water.'},
        'validation': {'regionFiles': len(list((WORLD / 'region').glob('*.mca'))),
                       'decompressedChunks': chunks, 'sampledNbtChunks': 26,
                       'spawnHasHeadroomAndGround': True, 'testedInMinecraft': False},
        'limitations': ['Rectangular selection around the neighbourhood, not an official boundary.',
                       'Only OSM building footprints; Overture disabled.',
                       'Missing building heights are inferred; interiors and facades are procedural.',
                       'Outside generated rectangle is void; stay within the supplied area.'],
    }
    manifest['worldFilesSha256'] = {
        str(p.relative_to(WORLD)): sha(p)
        for p in sorted(WORLD.rglob('*')) if p.is_file()
    }
    (OUT / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
    archive = OUT / 'gorny-gigant-minecraft-java.zip'
    with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
        zf.write(OUT / 'README-RU.md', 'README-RU.md')
        zf.write(OUT / 'manifest.json', 'manifest.json')
        for p in sorted(WORLD.rglob('*')):
            if p.is_file():
                zf.write(p, str(p.relative_to(OUT)))
    with zipfile.ZipFile(archive) as zf:
        assert zf.testzip() is None
        assert 'Gorny-Gigant-Almaty/level.dat' in zf.namelist()
    print(json.dumps({'archive': str(archive), 'bytes': archive.stat().st_size,
                      'chunksChecked': chunks, 'spawn': [x, y, z]}, indent=2))


if __name__ == '__main__':
    main()
