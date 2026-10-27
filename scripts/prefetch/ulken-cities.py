#!/usr/bin/env python3
"""Build a Cities: Skylines 1 import kit for Ulken, Kazakhstan.

Python dependencies: numpy scipy Pillow pyproj shapely requests rasterio.
Real land elevations and OSM shoreline; explicitly synthetic game bathymetry.
Does not generate a .crp save, place a real NPP site, or modify a game install.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import hashlib
import io
import json
import math
from pathlib import Path
import zipfile
import xml.etree.ElementTree as ET

import numpy as np
from PIL import Image, ImageDraw, ImageFont
from pyproj import Transformer
import requests
from scipy.ndimage import distance_transform_edt, map_coordinates
from shapely import contains_xy, prepare
from shapely.geometry import LineString, Polygon, box, mapping, shape
from shapely.ops import polygonize, transform, unary_union
import rasterio
from rasterio.transform import from_origin

ROOT = Path(__file__).resolve().parents[2]
SIDE = 17280
SIZE = 1081
STEP = SIDE / (SIZE - 1)
SEA = 40.0
CENTER = (73.984322, 45.208988)  # OSM village node 2587147171; longitude, latitude.
OSM_FILE = ROOT / 'public/data/locations/balqash-lake/water_large.json'
OUT = ROOT / 'public/data/cities-skylines/ulken'
CRS = 'EPSG:32643'
TILE_Z = 12


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def fetch(url, path, query=None):
    if path.exists():
        return path.read_bytes()
    if query is None:
        response = requests.get(url, timeout=(15, 60))
    else:
        response = requests.post(url, data={'data': query}, timeout=(15, 75))
    response.raise_for_status()
    data = response.content
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return data


def fetch_osm(query, cache, bounds, osm_api_only=False):
    path = cache / 'osm-local.json'
    endpoint_file = cache / 'osm-endpoint.txt'
    if path.exists():
        return path.read_bytes(), endpoint_file.read_text().strip() if endpoint_file.exists() else 'cached Overpass response'
    errors = []
    endpoints = [] if osm_api_only else ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter', 'https://overpass.private.coffee/api/interpreter']
    for endpoint in endpoints:
        try:
            response = requests.get(endpoint, params={'data': query}, headers={'User-Agent': 'KOR3D geographic data preparation', 'Accept': 'application/json'}, timeout=(15, 75))
            response.raise_for_status()
            payload = response.json()
            if not isinstance(payload.get('elements'), list) or 'remark' in payload:
                raise ValueError('Overpass returned an incomplete response')
            path.write_bytes(response.content)
            endpoint_file.write_text(endpoint)
            print(f"OSM: {len(payload['elements'])} features from {endpoint}", flush=True)
            return response.content, endpoint
        except (requests.RequestException, ValueError) as error:
            errors.append(f'{endpoint}: {type(error).__name__}' + (f' HTTP {error.response.status_code}' if isinstance(error, requests.HTTPError) and error.response is not None else ''))
            print(errors[-1], flush=True)
    # For a one-off, small bounding box, the primary OSM read-only map API is
    # a fallback when public Overpass servers are unavailable.
    endpoint = 'https://api.openstreetmap.org/api/0.6/map'
    bbox = f"{bounds['minLon']},{bounds['minLat']},{bounds['maxLon']},{bounds['maxLat']}"
    response = requests.get(endpoint, params={'bbox': bbox}, headers={'User-Agent': 'KOR3D geographic data preparation'}, timeout=(15, 75))
    response.raise_for_status()
    root = ET.fromstring(response.content)
    nodes = {node.attrib['id']: node for node in root.findall('node')}
    elements = []
    tags_of = lambda element: {tag.attrib['k']: tag.attrib['v'] for tag in element.findall('tag')}
    for node in nodes.values():
        tags = tags_of(node)
        if 'place' in tags:
            elements.append(dict(type='node', id=int(node.attrib['id']), lat=float(node.attrib['lat']), lon=float(node.attrib['lon']), tags=tags))
    for way in root.findall('way'):
        tags = tags_of(way)
        if not ('highway' in tags or 'building' in tags or tags.get('railway') == 'rail' or tags.get('natural') == 'water'):
            continue
        refs = [nd.attrib['ref'] for nd in way.findall('nd')]
        if not all(ref in nodes for ref in refs):
            raise ValueError('OSM map API returned an incomplete way')
        geometry = [dict(lon=float(nodes[ref].attrib['lon']), lat=float(nodes[ref].attrib['lat'])) for ref in refs]
        elements.append(dict(type='way', id=int(way.attrib['id']), tags=tags, geometry=geometry))
    data = json.dumps(dict(elements=elements, sourceEndpoint=endpoint, retrievalTime=response.headers.get('Date')), separators=(',', ':')).encode()
    path.write_bytes(data)
    endpoint_file.write_text(endpoint)
    (cache / 'osm-map-api.xml').write_bytes(response.content)
    print(f'OSM map API: {len(elements)} local features', flush=True)
    return data, endpoint



def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--cache', type=Path, default=Path('/tmp/kor3d-ulken-cities'))
    parser.add_argument('--osm-api-only', action='store_true', help='Use the primary OSM map API directly when Overpass is unavailable')
    args = parser.parse_args()
    args.cache.mkdir(parents=True, exist_ok=True)
    OUT.mkdir(parents=True, exist_ok=True)
    forward = Transformer.from_crs(4326, CRS, always_xy=True)
    inverse = Transformer.from_crs(CRS, 4326, always_xy=True)
    cx, cy = forward.transform(*CENTER)
    xmin, xmax, ymin, ymax = cx - SIDE / 2, cx + SIDE / 2, cy - SIDE / 2, cy + SIDE / 2
    xx, yy = np.meshgrid(np.linspace(xmin, xmax, SIZE), np.linspace(ymax, ymin, SIZE))
    lon, lat = inverse.transform(xx, yy)
    bounds = dict(minLon=float(lon.min()), minLat=float(lat.min()), maxLon=float(lon.max()), maxLat=float(lat.max()))
    domain = box(xmin, ymin, xmax, ymax)
    geographic_domain = transform(inverse.transform, domain)
    fx = (lon + 180) / 360 * 2 ** TILE_Z
    fy = (1 - np.arcsinh(np.tan(np.radians(lat))) / math.pi) / 2 * 2 ** TILE_Z
    tx0, tx1 = math.floor(fx.min()), math.floor(fx.max())
    ty0, ty1 = math.floor(fy.min()), math.floor(fy.max())
    tiles = [(x, y) for y in range(ty0, ty1 + 1) for x in range(tx0, tx1 + 1)]
    b = bounds
    bbox = f"{b['minLat']},{b['minLon']},{b['maxLat']},{b['maxLon']}"
    query = f'''[out:json][timeout:60];(
      way["highway"]({bbox});way["railway"="rail"]({bbox});
      way["building"]({bbox});way["natural"="water"]({bbox});
      node["place"]({bbox}););out geom;'''
    osm_endpoint = 'https://overpass-api.de/api/interpreter'

    def tile_job(coords):
        x, y = coords
        url = f'https://tiles.mapterhorn.com/{TILE_Z}/{x}/{y}.webp'
        path = args.cache / f'dem-{TILE_Z}-{x}-{y}.webp'
        data = fetch(url, path)
        rgb = np.asarray(Image.open(io.BytesIO(data)).convert('RGB'), dtype=np.float64)
        if rgb.shape != (512, 512, 3):
            raise ValueError(f'Unexpected DEM tile size: {url}')
        values = rgb[:, :, 0] * 256 + rgb[:, :, 1] + rgb[:, :, 2] / 256 - 32768
        print(f'DEM {x}/{y}', flush=True)
        return x, y, values, dict(url=url, sha256=hashlib.sha256(data).hexdigest())

    print(f'Fetching {len(tiles)} terrain tiles and local OSM reference features…', flush=True)
    with ThreadPoolExecutor(max_workers=5) as pool:
        osm_future = pool.submit(fetch_osm, query, args.cache, bounds, args.osm_api_only)
        tile_results = list(pool.map(tile_job, tiles))
        osm_bytes, osm_endpoint = osm_future.result()
        local = json.loads(osm_bytes)
    mosaic = np.empty(((ty1 - ty0 + 1) * 512, (tx1 - tx0 + 1) * 512), dtype=np.float64)
    for x, y, values, _ in tile_results:
        mosaic[(y - ty0) * 512:(y - ty0 + 1) * 512, (x - tx0) * 512:(x - tx0 + 1) * 512] = values
    # Decode heights before bilinear sampling (interpolating RGB would be incorrect).
    elevation = map_coordinates(mosaic, [((fy - ty0) * 512 - .5).ravel(), ((fx - tx0) * 512 - .5).ravel()], order=1, mode='nearest').reshape(SIZE, SIZE)
    if not np.isfinite(elevation).all() or elevation.min() < -500 or elevation.max() > 9000:
        raise ValueError('Missing or invalid DEM elevations.')

    water_data = json.loads(OSM_FILE.read_text())
    lake = next(e for e in water_data['elements'] if e['type'] == 'relation' and e['id'] == 19025268)
    def lake_polygons(role):
        lines = [LineString([(g['lon'], g['lat']) for g in m['geometry']])
                 for m in lake['members'] if m.get('role') == role and len(m.get('geometry', [])) >= 2]
        return unary_union(list(polygonize(unary_union(lines))))
    # Reconstruct complete multipolygon rings; never close individual shoreline segments.
    lake_geometry = lake_polygons('outer').difference(lake_polygons('inner'))
    local_lake = transform(forward.transform, lake_geometry.intersection(geographic_domain)).intersection(domain)
    water = local_lake
    other_water = []
    features = []
    for element in local['elements']:
        tags = element.get('tags', {})
        points = element.get('geometry')
        if element['type'] == 'way' and points and len(points) >= 2:
            coords = [(g['lon'], g['lat']) for g in points]
            kind = 'road' if 'highway' in tags else 'rail' if tags.get('railway') == 'rail' else 'building' if 'building' in tags else 'water'
            polygon = kind in ['water', 'building'] and coords[0] == coords[-1] and len(coords) >= 4
            geometry = Polygon(coords) if polygon else LineString(coords)
            if not geometry.is_valid:
                geometry = geometry.buffer(0) if polygon else geometry
            projected = transform(forward.transform, geometry).intersection(domain)
            if projected.is_empty:
                continue
            if kind == 'water' and polygon:
                other_water.append(projected)
            elif kind in ['road', 'rail', 'building']:
                features.append(dict(type='Feature', geometry=mapping(transform(inverse.transform, projected)),
                                     properties=dict(osmId=element['id'], kind=kind, name=tags.get('name', ''), highway=tags.get('highway'))))
    water = unary_union([water, *other_water])
    prepare(water)
    mask = contains_xy(water, xx, yy)
    if not .05 < mask.mean() < .9:
        raise ValueError(f'Unexpected water coverage: {mask.mean()}')
    prepare(local_lake)
    lake_mask = contains_xy(local_lake, xx, yy)
    reference_water = float(np.median(elevation[lake_mask]))
    offset = reference_water - SEA
    unmodified_game = elevation - offset
    game = unmodified_game.copy()
    # DEM water pixels describe a water surface, not the bed. This generated
    # bathymetry is ONLY for gameplay: 2–20 m deep, based on distance from shore.
    depth = np.minimum(20, 2 + distance_transform_edt(mask) * STEP * .03)
    game[mask] = SEA - depth[mask]
    # Prevent noisy DEM/coastline disagreement from flooding the OSM land mask.
    corrected = (~mask) & (game < SEA + 1)
    game[corrected] = SEA + 1
    if game.min() < 0 or game.max() > 1024:
        raise ValueError('Heightmap would clip the CS1 0–1024 m height range.')
    encoded = np.rint(game / 1024 * 65535).astype(np.uint16)
    output = OUT / 'ulken-cs1-heightmap.png'
    Image.fromarray(encoded).save(output)
    Image.fromarray((mask * 255).astype(np.uint8)).save(OUT / 'water-mask.png')
    transform_grid = from_origin(xmin - STEP / 2, ymax + STEP / 2, STEP, STEP)
    with rasterio.open(OUT / 'source-elevation.tif', 'w', driver='GTiff', width=SIZE, height=SIZE, count=1,
                       dtype='float32', crs=CRS, transform=transform_grid, compress='deflate') as dst:
        dst.write(elevation.astype('float32'), 1)
        dst.update_tags(AREA_OR_POINT='Point', source='Mapterhorn DEM; water is surface elevation, not bathymetry')
    shore_fc = dict(type='FeatureCollection', features=[dict(type='Feature', properties=dict(name='OSM water footprint'), geometry=mapping(transform(inverse.transform, water)))])
    (OUT / 'water.geojson').write_text(json.dumps(shore_fc, ensure_ascii=False, separators=(',', ':')))
    (OUT / 'reference-features.geojson').write_text(json.dumps(dict(type='FeatureCollection', features=features), ensure_ascii=False, separators=(',', ':')))
    make_preview(game, mask, features, forward, xmin, ymax)
    manifest = dict(
        prepared=datetime.now(timezone.utc).isoformat(), target='Cities: Skylines 1 desktop', status='heightmap import kit; not a .crp map save',
        center=dict(longitude=CENTER[0], latitude=CENTER[1], source='OSM village node 2587147171'),
        crs=CRS, geographicBounds=bounds, projectedBounds=dict(xmin=xmin, xmax=xmax, ymin=ymin, ymax=ymax),
        raster=dict(width=SIZE, height=SIZE, encoding='16-bit grayscale PNG', axis='north at top, east at right',
                    intervalM=STEP, nodeToNodeExtentM=SIDE, horizontalScale=1, verticalScale=1,
                    decodedHeight='pixel / 65535 * 1024 metres'),
        water=dict(gameLevelM=SEA, demReferenceSurfaceM=reference_water,
                   elevationOffsetM=offset, depth='synthetic 2–20 m game bathymetry; NOT a measured lake bed',
                   landCellsRaisedForShoreline=int(corrected.sum()), shorelineLandFloorM=SEA + 1,
                   landCorrectionMaxM=float((game - unmodified_game)[corrected].max()) if corrected.any() else 0,
                   coverageFraction=float(mask.mean())),
        elevations=dict(rawMinM=float(elevation.min()), rawMaxM=float(elevation.max()), gameMinM=float(game.min()), gameMaxM=float(game.max())),
        sources=[dict(name='Mapterhorn DEM', attribution='Elevation: Mapterhorn', url='https://mapterhorn.com/attribution/', tiles=[t[3] for t in tile_results]),
                 dict(name='OSM Balkhash multipolygon', id=19025268, url='https://www.openstreetmap.org/relation/19025268',
                      cachedInputSha256=digest(OSM_FILE), cachedInputAcquisitionDate='unknown; existing project snapshot'),
                 dict(name='OSM local reference features', endpoint=osm_endpoint, sha256=digest(args.cache / 'osm-local.json'),
                      query=query if 'overpass' in osm_endpoint else {'bbox': f"{b['minLon']},{b['minLat']},{b['maxLon']},{b['maxLat']}"},
                      osmTimestamp=local.get('osm3s', {}).get('timestamp_osm_base'), retrievalTime=local.get('retrievalTime'), license='ODbL 1.0')],
        npp=dict(realSitePolygonIncluded=False, realPlantLayoutIncluded=False,
                 note='No confirmed project boundary is included. Place any in-game power plant as a fictional gameplay choice.',
                 officialContext='https://www.gov.kz/org/atom-energiyasy/press/news/details/1307784'),
        validation=dict(inGameTested=False, reason='Cities: Skylines is not installed in the default Steam library.',
                        pngBitDepth=16, pngColorType=0, expectedSeaLevelM=SEA),
        artifacts={p.name: dict(bytes=p.stat().st_size, sha256=digest(p)) for p in sorted(OUT.iterdir()) if p.is_file() and p.name not in ['manifest.json', 'ulken-cs1-kit.zip']})
    (OUT / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
    with zipfile.ZipFile(OUT / 'ulken-cs1-kit.zip', 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as bundle:
        for artifact in sorted(OUT.iterdir()):
            if artifact.is_file() and artifact.suffix != '.zip':
                bundle.write(artifact, artifact.name)
    print(json.dumps(dict(center=CENTER, tiles=len(tiles), waterFraction=float(mask.mean()), demWaterM=reference_water,
                          rawRange=[float(elevation.min()), float(elevation.max())], gameRange=[float(game.min()), float(game.max())],
                          correctedLandCells=int(corrected.sum()), features=len(features)), indent=2), flush=True)


def make_preview(game, mask, features, project, xmin, ymax):
    # Cartographic reference, not an in-game screenshot; roads/buildings are guides only.
    dx, dz = np.gradient(game, STEP)
    shade = np.clip(.78 - .6 * dx + .5 * dz, .4, 1.1)
    t = np.clip((game - SEA) / 90, 0, 1)
    low = np.array([203, 196, 151]); high = np.array([151, 143, 110])
    rgb = (low[None, None, :] * (1 - t[:, :, None]) + high[None, None, :] * t[:, :, None]) * shade[:, :, None]
    rgb[mask] = [95, 149, 165]
    image = Image.fromarray(np.clip(rgb, 0, 255).astype(np.uint8))
    draw = ImageDraw.Draw(image)
    for feature in features:
        geometry = shape(feature['geometry'])
        kind = feature['properties']['kind']
        if kind == 'building':
            geoms = [geometry] if geometry.geom_type == 'Polygon' else list(getattr(geometry, 'geoms', []))
            for g in geoms:
                if g.geom_type == 'Polygon':
                    pixels = [pixel(p, project, xmin, ymax) for p in g.exterior.coords]
                    draw.polygon(pixels, fill='#655c48')
            continue
        parts = [geometry] if geometry.geom_type == 'LineString' else list(getattr(geometry, 'geoms', []))
        for g in parts:
            if g.geom_type != 'LineString':
                continue
            pixels = [pixel(p, project, xmin, ymax) for p in g.coords]
            if kind == 'rail':
                draw.line(pixels, fill='#343e3b', width=2)
            else:
                major = feature['properties'].get('highway') in ['motorway', 'trunk', 'primary', 'secondary']
                draw.line(pixels, fill='#eee3bc' if major else '#e4d9b4', width=4 if major else 1)
    # 9×9 source extent; central 5×5 is the base game's selectable area, central tile is start.
    for i in range(1, 9):
        p = round(i * (SIZE - 1) / 9)
        for j in range(0, SIZE, 13):
            draw.line((p, j, p, min(SIZE - 1, j + 5)), fill='#8b9386')
            draw.line((j, p, min(SIZE - 1, j + 5), p), fill='#8b9386')
    a, b = [round(i * (SIZE - 1) / 9) for i in [4, 5]]
    draw.rectangle((a, a, b, b), outline='#f4b84c', width=4)
    draw.ellipse((SIZE / 2 - 5, SIZE / 2 - 5, SIZE / 2 + 5, SIZE / 2 + 5), fill='#f4b84c', outline='#2d3c37', width=2)
    font_path = '/System/Library/Fonts/Supplemental/Arial.ttf'
    font = lambda size: ImageFont.truetype(font_path, size) if Path(font_path).exists() else ImageFont.load_default(size=size)
    canvas = Image.new('RGB', (1200, 1345), '#f2f0e6')
    canvas.paste(image, (60, 145))
    d = ImageDraw.Draw(canvas)
    d.text((60, 35), 'ҮЛКЕН / БАЛХАШ', font=font(34), fill='#24443f')
    d.text((60, 89), 'Cities: Skylines 1 · карта импорта · 17,28 × 17,28 км · север сверху', font=font(17), fill='#5e6c60')
    px, py = SIZE / 2 + 60, SIZE / 2 + 145
    d.rectangle((px + 12, py + 8, px + 105, py + 39), fill='#f2f0e6')
    d.text((px + 20, py + 13), 'Улкен', font=font(18), fill='#24443f')
    d.text((900, 190), 'БАЛХАШ', font=font(25), fill='#eef2e7')
    d.line((95, 1180, 95 + 2000 / STEP, 1180), fill='#263e37', width=5)
    d.text((95, 1148), '2 км', font=font(16), fill='#263e37')
    d.text((60, 1245), 'Жёлтая рамка — стартовая клетка. Дороги и здания — ориентиры OSM, не игровые объекты.', font=font(16), fill='#4c6159')
    d.text((60, 1275), 'Дно озера условное для игры. Точная площадка и проект АЭС не нанесены.', font=font(16), fill='#4c6159')
    d.text((60, 1310), 'Elevation: Mapterhorn · © OpenStreetMap contributors · подготовлено KÖR3D', font=font(13), fill='#68786c')
    canvas.save(OUT / 'ulken-preview.png')


def pixel(point, project, xmin, ymax):
    x, y = project.transform(*point)
    return ((x - xmin) / STEP, (ymax - y) / STEP)


if __name__ == '__main__':
    main()
