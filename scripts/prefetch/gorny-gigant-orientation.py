#!/usr/bin/env python3
"""Build OSM street data and a labelled overview texture for the Luanti world."""
from pathlib import Path
import json
import xml.etree.ElementTree as ET
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[2]
MOD = ROOT / 'public/data/luanti/gorny-gigant/Gorny-Gigant-Almaty/worldmods/gorny_orientation'
MOD.mkdir(parents=True, exist_ok=True)
(MOD / 'textures').mkdir(exist_ok=True)
root = ET.parse('/tmp/kor3d-arnis/gorny-gigant.osm').getroot()
nodes = {n.attrib['id']: (float(n.attrib['lon']), float(n.attrib['lat'])) for n in root.findall('node')}


def world(lon, lat):
    return [round((lon - 76.9357) / .0246 * 1993, 2),
            round(-(43.2265 - lat) / .018 * 2001, 2)]


roads = []
for w in root.findall('way'):
    tags = {t.attrib['k']: t.attrib['v'] for t in w.findall('tag')}
    name = tags.get('name:ru', tags.get('name'))
    if tags.get('highway') and name:
        pts = [world(*nodes[n.attrib['ref']]) for n in w.findall('nd') if n.attrib['ref'] in nodes]
        if len(pts) > 1:
            roads.append({'name': name, 'points': pts})
(MOD / 'roads.json').write_text(json.dumps(roads, ensure_ascii=False))
(MOD / 'mod.conf').write_text('name = gorny_orientation\ndescription = Gorny Gigant OSM street names and orientation map\n')

# Same geographical frame as Arnis, north at the top. Road geometry is OSM;
# the background is the Java export overview, with the same terrain/footprints.
im = Image.open(ROOT / 'public/data/minecraft/gorny-gigant/preview.png').convert('RGB').resize((1024, 1024))
shade = Image.new('RGB', im.size, '#14251e')
im = Image.blend(im, shade, .34)
draw = ImageDraw.Draw(im)
fontpath = '/System/Library/Fonts/Supplemental/Arial Bold.ttf'
font = ImageFont.truetype(fontpath, 21)
small = ImageFont.truetype(fontpath, 16)
title = ImageFont.truetype(fontpath, 30)


def label(text, lon, lat, color='#ffffff'):
    x, z = world(lon, lat)
    px, py = x / 1993 * 1023, -z / 2001 * 1023
    bounds = draw.textbbox((0, 0), text, font=font)
    width, height = bounds[2], bounds[3] - bounds[1]
    px = min(max(width / 2 + 8, px), 1016 - width / 2)
    py = min(max(70, py), 970)
    draw.rounded_rectangle((px-width/2-7, py-5, px+width/2+7, py+height+10), radius=5, fill='#13201c')
    draw.text((px, py), text, font=font, anchor='mt', fill=color)


for road in roads:
    if any(s in road['name'] for s in ('Жамака', 'Манаева', 'Шукшина', 'Аль-Фараби', 'Назарбаева', 'Кажымукана')):
        pts = [(x/1993*1023, -z/2001*1023) for x, z in road['points']]
        draw.line(pts, fill='#f3cd72', width=3)
draw.rectangle((0, 0, 1024, 53), fill='#13201c')
draw.text((20, 10), 'ГОРНЫЙ ГИГАНТ · АЛМАТЫ', font=title, fill='white')
draw.text((982, 68), 'С ↑', font=font, anchor='rt', fill='white')
for text, lon, lat in [
    ('пр. Аль-Фараби',76.9389,43.2252),
    ('ул. Жамакаева',76.9409,43.2221),
    ('ул. Жамакаева',76.9518,43.2140),
    ('ул. Манаева',76.9487,43.2177),
    ('ул. Шукшина',76.9440,43.2207),
    ('пр. Назарбаева',76.9554,43.2230),
    ('ул. Кажымукана',76.9501,43.2223),
    ('Esentai City',76.9411,43.2127),
    ('Горный Гигант',76.9497,43.2162),
]: label(text, lon, lat)
draw.rectangle((0, 990, 1024, 1024), fill='#13201c')
draw.text((12,1000), 'OSM © contributors · схема района · фасады условные',font=small, fill='#e2e8db')
im.save(MOD / 'textures/gorny_overview.png')
dot = Image.new('RGBA', (18, 18))
d = ImageDraw.Draw(dot)
d.ellipse((1, 1, 16, 16), fill='#ff603b', outline='white', width=3)
dot.save(MOD / 'textures/gorny_player.png')
print(f'{len(roads)} named road segments; {MOD}')
