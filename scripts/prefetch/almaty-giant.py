#!/usr/bin/env python3
"""Build a 1:12 OSM/DEM city miniature with deliberately oversized landmarks.

Dependencies: numpy, scipy, Pillow, requests. Cached source.osm is a merge of
four primary OSM map API responses; see manifest for bounds and provenance.
"""
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
import gzip
import hashlib
import io
import json
import math
import xml.etree.ElementTree as ET
import numpy as np
from scipy.ndimage import map_coordinates, gaussian_filter
from PIL import Image, ImageDraw, ImageFont
import requests

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'public/data/luanti/almaty-giant'
WORLD = OUT / 'Almaty-Giant'
MOD = WORLD / 'worldmods/giant_city'
CACHE = Path('/tmp/kor3d-giant')
WEST, SOUTH, EAST, NORTH = 76.925, 43.205, 76.99, 43.25
METERS = 12
W = round((EAST-WEST)*111320*math.cos(math.radians((SOUTH+NORTH)/2))/METERS)
H = round((NORTH-SOUTH)*111320/METERS)


def xy(lon, lat):
    return ((lon-WEST)/(EAST-WEST)*(W-1), (NORTH-lat)/(NORTH-SOUTH)*(H-1))


def tags(e):
    return {t.attrib['k']: t.attrib['v'] for t in e.findall('tag')}


def main():
    MOD.mkdir(parents=True, exist_ok=True)
    textures = MOD / 'textures'
    textures.mkdir(exist_ok=True)
    root = ET.parse(CACHE / 'source.osm').getroot()
    nodes = {n.attrib['id']: (float(n.attrib['lon']), float(n.attrib['lat'])) for n in root.findall('node')}
    ways = [(w, tags(w), [xy(*nodes[n.attrib['ref']]) for n in w.findall('nd')
                         if n.attrib['ref'] in nodes]) for w in root.findall('way')]
    lon, lat = np.meshgrid(np.linspace(WEST,EAST,W), np.linspace(NORTH,SOUTH,H))
    zoom = 12
    fx = (lon+180)/360*2**zoom
    fy = (1-np.arcsinh(np.tan(np.radians(lat)))/math.pi)/2*2**zoom
    x0,x1,y0,y1 = math.floor(fx.min()),math.floor(fx.max()),math.floor(fy.min()),math.floor(fy.max())
    mosaic = np.empty(((y1-y0+1)*512,(x1-x0+1)*512))
    tiles = [(x,y) for y in range(y0,y1+1) for x in range(x0,x1+1)]
    provenance = []
    def fetch(coords):
        x,y=coords; p=CACHE/f'dem-{zoom}-{x}-{y}.webp';url=f'https://tiles.mapterhorn.com/{zoom}/{x}/{y}.webp'
        if not p.exists():
            r=requests.get(url,timeout=60);r.raise_for_status();p.write_bytes(r.content)
        rgb=np.array(Image.open(p).convert('RGB'),dtype=float)
        dem=rgb[:,:,0]*256+rgb[:,:,1]+rgb[:,:,2]/256-32768
        return x,y,dem,{'url':url,'sha256':hashlib.sha256(p.read_bytes()).hexdigest()}
    with ThreadPoolExecutor(max_workers=4) as pool:
        for x,y,dem,p in pool.map(fetch,tiles):
            mosaic[(y-y0)*512:(y-y0+1)*512,(x-x0)*512:(x-x0+1)*512]=dem;provenance.append(p)
    elevation=map_coordinates(mosaic,[((fy-y0)*512-.5).ravel(),((fx-x0)*512-.5).ravel()],order=1,mode='nearest').reshape(H,W)
    assert np.isfinite(elevation).all() and elevation.min()>400 and elevation.max()<3000
    ground=np.round(gaussian_filter((elevation-elevation.min())/METERS,1)).astype(int)+3
    surface=Image.new('L',(W,H),1);draw=ImageDraw.Draw(surface)
    for w,t,pts in ways:
        if len(pts)>2 and (t.get('leisure') in ('park','garden','pitch') or t.get('landuse') in ('forest','grass','meadow')):
            draw.polygon(pts,fill=2)
        if len(pts)>2 and t.get('natural')=='water':draw.polygon(pts,fill=4)
        if len(pts)>1 and t.get('waterway') in ('river','stream','canal'):draw.line(pts,fill=4,width=2)
    for w,t,pts in ways:
        if len(pts)>1 and t.get('highway') and t['highway'] not in ('steps','footway','path','construction'):
            draw.line(pts,fill=3,width=3 if t['highway'] in ('primary','trunk') else 2 if t['highway'] in ('secondary','tertiary') else 1)
    roof=Image.new('L',(W,H),0);rd=ImageDraw.Draw(roof)
    material=Image.new('L',(W,H),0);md=ImageDraw.Draw(material)
    count=0
    for w,t,pts in ways:
        if len(pts)>2 and t.get('building') and t['building']!='no':
            try: height=float(t.get('height',float(t.get('building:levels','2'))*3))/METERS
            except ValueError:height=1
            height=max(1,min(5,round(height)))
            rd.polygon(pts,fill=height);md.polygon(pts,fill=5+int(w.attrib['id'])%3);count+=1
    surface=np.array(surface);roof=np.array(roof);material=np.array(material)
    roof[surface==3]=0
    landmarks=[
        dict(id='nurly',name='НУРЛЫ ТАУ',lon=76.94629,lat=43.23024,r=29,kind='nurly',source='OSM way 141608484'),
        dict(id='koktobe',name='КОК-ТОБЕ · ТЕЛЕБАШНЯ',lon=76.9763131,lat=43.2287064,r=18,kind='tower',source='OSM node 12220661357'),
        dict(id='nis',name='НИШ · ЖАМАКАЕВА, 145',lon=76.9520467,lat=43.2146756,r=22,kind='school',source='OSM way 445195631, school area 1149563675'),
        dict(id='kenen',name='КЕНЕН АЗЕРБАЕВ',lon=76.9517754,lat=43.2161421,r=9,kind='statue',source='OSM artwork node'),
        dict(id='esentai',name='ESENTAI TOWER',lon=76.929346,lat=43.219234,r=13,kind='esentai',source='OSM way 1458250144'),
        dict(id='hotel',name='ГОСТИНИЦА КАЗАХСТАН',lon=76.9565597,lat=43.2448005,r=15,kind='hotel',source='OSM node 1791377298'),
    ]
    operations=[]
    def box(x1,y1,z1,x2,y2,z2,node):
        operations.append([round(x1),round(y1),round(z1),round(x2),round(y2),round(z2),node])
    def disk(cx,cy,cz,r,node,depth=1):
        for dx in range(-r,r+1):
            dz=math.floor(math.sqrt(max(0,r*r-dx*dx)))
            box(cx+dx,cy,cz-dz,cx+dx,cy+depth-1,cz+dz,node)
    yy,xx=np.indices((H,W))
    for l in landmarks:
        x,row=map(round,xy(l['lon'],l['lat']));z=-row;r=l['r'];mask=(xx-x)**2+(yy-row)**2<=r*r
        base=int(np.median(ground[mask]));ground[mask]=base;roof[mask]=0;surface[mask]=8
        l.update(x=x,z=z,y=base+1)
        b=base+1
        if l['kind']=='nurly':
            box(x-23,b,z-21,x+23,b+1,z+21,8)
            for dx,dz,h in [(-12,-10,29),(12,-10,33),(-12,10,24),(12,10,28)]:
                # Faceted blue glass towers and silver pyramidal crowns.
                for dy in range(h):
                    rad=7
                    disk(x+dx,b+2+dy,z+dz,rad,9 if dy%4 else 10)
                for dy in range(7):disk(x+dx,b+2+h+dy,z+dz,7-dy,10)
            box(x-2,b+2,z-17,x+2,b+3,z+17,4)
        elif l['kind']=='tower':
            disk(x,b,z,14,10,2)
            for dy in range(73):
                rad=3 if dy<42 else 2 if dy<60 else 1
                disk(x,b+2+dy,z,rad,11 if (dy//5)%2 else 10)
            for height,rad in [(34,7),(38,8),(42,6),(50,4)]:disk(x,b+height,z,rad,10,2)
            for angle in range(0,360,3):
                a=math.radians(angle);wx=x-19+round(8*math.cos(a));wy=b+10+round(8*math.sin(a))
                box(wx,wy,z-9,wx,wy,z-9,12)
            box(x-20,b,z-10,x-18,b+10,z-8,10)
        elif l['kind']=='school':
            box(x-20,b,z-14,x+20,b,z+14,10)
            for dx,dz,sx,sz in [(-14,0,5,12),(14,0,5,12),(0,10,10,3)]:
                box(x+dx-sx,b+1,z+dz-sz,x+dx+sx,b+10,z+dz+sz,10)
                box(x+dx-sx,b+4,z+dz-sz,x+dx+sx,b+5,z+dz+sz,9)
                box(x+dx-sx,b+8,z+dz-sz,x+dx+sx,b+8,z+dz+sz,9)
            box(x-7,b+1,z-11,x+7,b+1,z+6,2)
            box(x-8,b+1,z-13,x+8,b+1,z-12,11)
        elif l['kind']=='statue':
            disk(x,b,z,8,8);box(x-3,b+1,z-3,x+3,b+5,z+3,10)
            box(x-2,b+6,z-1,x-1,b+10,z+1,12);box(x+1,b+6,z-1,x+2,b+10,z+1,12)
            box(x-3,b+11,z-2,x+3,b+17,z+2,12);box(x-2,b+18,z-2,x+2,b+21,z+2,12)
            box(x+3,b+10,z-3,x+5,b+13,z-3,12);box(x+4,b+14,z-3,x+4,b+20,z-3,12)
        elif l['kind']=='esentai':
            box(x-10,b,z-8,x+10,b+3,z+8,8)
            box(x-7,b+4,z-5,x+7,b+39,z+5,9)
            for dy in range(5,40,4):box(x-7,b+dy,z-5,x+7,b+dy,z+5,10)
            box(x-8,b+40,z-6,x+8,b+41,z+6,10)
        elif l['kind']=='hotel':
            box(x-12,b,z-6,x+12,b+4,z+6,8)
            box(x-10,b+5,z-3,x+10,b+32,z+3,9)
            for dx in range(-10,11,3):box(x+dx,b+5,z-4,x+dx,b+32,z+4,10)
            box(x-11,b+33,z-4,x+11,b+34,z+4,12)
            for dx in range(-10,11,4):box(x+dx,b+35,z-4,x+dx,b+39,z+4,12)
    palette={
        1:('ground','#9cae78'),2:('park','#4f9968'),3:('road','#444e59'),4:('water','#43a5bc'),
        5:('house_beige','#dcc59f'),6:('house_white','#e8e6db'),7:('roof','#b57e60'),
        8:('plaza','#bec5c1'),9:('blueglass','#3189ad'),10:('white','#edf0e7'),
        11:('red','#d9584d'),12:('gold','#e8bd59'),13:('rock','#7d8a83')}
    for i,(name,color) in palette.items():
        im=Image.new('RGB',(16,16),color);d=ImageDraw.Draw(im)
        if i==9:
            d.line((0,0,15,0),fill='#b9d9dd',width=1);d.line((0,0,0,15),fill='#b9d9dd',width=1)
            d.line((2,12,12,2),fill='#529fc0',width=1)
        elif i in (5,6):d.rectangle((5,5,10,10),fill='#5d8998')
        im.save(textures/f'gg_{name}.png')
    data={'width':W,'height':H,'ground':ground.ravel().tolist(),'surface':surface.ravel().tolist(),
          'roof':roof.ravel().tolist(),'material':material.ravel().tolist(),'landmarks':landmarks,
          'operations':operations,'palette':{str(i):name for i,(name,c) in palette.items()}}
    (MOD/'city.json').write_text(json.dumps(data,ensure_ascii=False,separators=(',',':')))
    (MOD/'mod.conf').write_text('name = giant_city\ndescription = Almaty at 1:12 with oversized geographic landmarks\ndepends = mcl_core\n')
    (WORLD/'world.mt').write_text('backend = sqlite3\nplayer_backend = sqlite3\nauth_backend = sqlite3\nmod_storage_backend = sqlite3\ngameid = mineclonia\nworld_name = Алматы — город для гиганта\ncreative_mode = true\nenable_damage = false\nserver_announce = false\n')
    (WORLD/'map_meta.txt').write_text('mg_name = singlenode\nseed = 0\nwater_level = -20\n[end_of_params]\n')
    (CACHE/'manifest.json').write_text(json.dumps({'bboxLonLat':[WEST,SOUTH,EAST,NORTH],
        'metersPerBlock':METERS,'width':W,'height':H,'osmBuildingWays':count,
        'demTiles':provenance,'landmarks':landmarks,
        'heightRangeMeters':[float(elevation.min()),float(elevation.max())],
        'note':'Geographic miniature. Landmark footprints/heights deliberately exaggerated. Not exact architectural replicas.'},ensure_ascii=False,indent=2))
    # Static overview for the in-game map, derived from the same generated columns.
    rgb=np.empty((H,W,3),dtype=np.uint8)
    for i,(name,c) in palette.items():
        rgb[surface==i]=tuple(bytes.fromhex(c[1:]))
    for i in (5,6,7):rgb[(roof>0)&(material==i)]=tuple(bytes.fromhex(palette[i][1][1:]))
    im=Image.fromarray(rgb).resize((1024,1024),Image.Resampling.NEAREST)
    dr=ImageDraw.Draw(im);font=ImageFont.truetype('/System/Library/Fonts/Supplemental/Arial Bold.ttf',22)
    for l in landmarks:
        px=l['x']/(W-1)*1023;py=-l['z']/(H-1)*1023
        label=l['name'];tw=dr.textbbox((0,0),label,font=font)[2]
        px=max(tw/2+8,min(1016-tw/2,px))
        dr.rounded_rectangle((px-tw/2-6,py-18,px+tw/2+6,py+17),radius=4,fill='#18313a')
        dr.text((px,py),label,font=font,fill='white',anchor='mm')
    im.save(textures/'gg_overview.png');im.save(OUT/'overview.png')
    (OUT/'source.osm.gz').write_bytes(gzip.compress((CACHE/'source.osm').read_bytes(),mtime=0))
    print(f'{W}×{H} blocks; {count} OSM buildings; {len(operations)} landmark drawing operations')


if __name__=='__main__':main()
