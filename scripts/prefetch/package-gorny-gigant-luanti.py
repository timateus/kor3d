#!/usr/bin/env python3
"""Check and archive the pristine Arnis Luanti export (not the player's copy)."""
from pathlib import Path
from datetime import datetime, timezone
import hashlib
import json
import shutil
import sqlite3
import zipfile

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'public/data/luanti/gorny-gigant'
WORLD = OUT / 'Gorny-Gigant-Almaty'
CACHE = Path('/tmp/kor3d-arnis')


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


with sqlite3.connect(f'file:{WORLD / "map.sqlite"}?mode=ro', uri=True) as db:
    assert db.execute('pragma integrity_check').fetchone()[0] == 'ok'
    count = db.execute('select count(*) from blocks').fetchone()[0]
    assert count == 118685
assert 'gameid = mineclonia' in (WORLD / 'world.mt').read_text()
assert 'singlenode' in (WORLD / 'map_meta.txt').read_text()
log = (CACHE / 'luanti-client.log').read_text()
assert 'joins game. List of players: tim' in log
shutil.copyfile(CACHE / 'luanti-generation.log', OUT / 'generation.log')
shutil.copyfile(ROOT / 'public/data/minecraft/gorny-gigant/source.osm.gz', OUT / 'source.osm.gz')
manifest = {
    'createdUtc': datetime.now(timezone.utc).isoformat(),
    'title': 'Горный Гигант — Алматы',
    'engine': 'Luanti 5.17.0', 'game': 'Mineclonia',
    'minecloniaContentDbRelease': json.loads((CACHE / 'mineclonia-package.json').read_text())['release'],
    'generator': 'Arnis 3.3.0', 'format': 'Luanti SQLite mapblocks',
    'bboxLonLat': [76.9357, 43.2085, 76.9603, 43.2265],
    'blocksPerMeter': 1, 'sizeBlocks': [1994, 2002],
    'spawn': [997, -2, -996], 'gamemode': 'creative',
    'orientation': {'nearestNamedStreet': True, 'heading': True,
                    'overviewMapWithPlayerMarker': True, 'mapCommand': '/gg',
                    'roadData': 'OpenStreetMap',
                    'overviewBackground': 'Java export in same geographic frame; Luanti details differ'},
    'validation': {'sqliteIntegrity': 'ok', 'mapblocks': count,
                   'localServerStarted': True, 'clientJoined': True,
                   'allBuildingsVisuallyChecked': False},
    'sources': {'osm': 'https://www.openstreetmap.org/copyright',
                'terrain': 'https://mapterhorn.com/',
                'landCover': 'https://esa-worldcover.org/',
                'luanti': 'https://github.com/luanti-org/luanti/releases/tag/5.17.0',
                'mineclonia': 'https://content.luanti.org/packages/ryvnf/mineclonia/'},
    'limitations': ['Experimental Arnis Luanti export; some details differ from Java.',
                   'Estimated heights where OSM has none; procedural interiors.',
                   'Rectangle around neighbourhood, not an administrative boundary.'],
    'worldFilesSha256': {str(p.relative_to(WORLD)): sha(p)
                         for p in sorted(WORLD.rglob('*')) if p.is_file()},
    'downloadsSha256': {p.name: sha(p) for p in
                        (CACHE / 'luanti.zip', CACHE / 'mineclonia.zip')},
}
(OUT / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
archive = OUT / 'gorny-gigant-luanti.zip'
with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
    for name in ('README-RU.md', 'manifest.json', 'source.osm.gz', 'generation.log'):
        zf.write(OUT / name, name)
    for p in sorted(WORLD.rglob('*')):
        if p.is_file():
            zf.write(p, str(p.relative_to(OUT)))
with zipfile.ZipFile(archive) as zf:
    assert zf.testzip() is None
    assert 'Gorny-Gigant-Almaty/map.sqlite' in zf.namelist()
print(json.dumps({'archive': str(archive), 'bytes': archive.stat().st_size,
                  'mapblocks': count}, indent=2))
