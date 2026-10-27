import { useEffect, useMemo } from 'react';
import { Canvas, type ThreeEvent } from '@react-three/fiber';
import { Line, OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import { outlineRings, validSpeed, type GlacierTestData, type Outline } from '@/lib/glacier-test';

export type GlacierTestLayer = 'velocity' | 'outlines' | 'elevation';
interface Props {
  data: GlacierTestData;
  frame: number;
  maxGap: number;
  layer: GlacierTestLayer;
  outlineDate: string;
  selected: number | null;
  onSelect: (cell: number | null) => void;
  flat: boolean;
}
function speedColor(speed: number) {
  const stops = ['#487d87', '#71b9ac', '#e9d99d', '#c5694f'];
  const t = Math.max(0, Math.min(1, speed / 40)) * 3;
  const i = Math.min(2, Math.floor(t));
  return new THREE.Color(stops[i]).lerp(new THREE.Color(stops[i + 1]), t - i);
}

function World({ data, frame, maxGap, layer, outlineDate, selected, onSelect, flat }: Props) {
  const { terrain } = data;
  const bounds = terrain.bounds!;
  const point = useMemo(() => (lon: number, lat: number, lift = 0): [number, number, number] => {
    const x = (lon - bounds.minLon) / (bounds.maxLon - bounds.minLon) * (terrain.width - 1);
    const y = (bounds.maxLat - lat) / (bounds.maxLat - bounds.minLat) * (terrain.height - 1);
    const col = Math.max(0, Math.min(terrain.width - 1, Math.round(x)));
    const row = Math.max(0, Math.min(terrain.height - 1, Math.round(y)));
    return [(lon - (bounds.minLon + bounds.maxLon) / 2) * 111.32 * Math.cos(43.05 * Math.PI / 180),
      flat ? lift : (terrain.elevations[row * terrain.width + col] - terrain.minElevation) / 1000 * 1.8 + lift,
      ((bounds.minLat + bounds.maxLat) / 2 - lat) * 111.32];
  }, [bounds, terrain, flat]);
  const terrainGeometry = useMemo(() => {
    const vertices: number[] = [], indices: number[] = [], colors: number[] = [];
    for (let j = 0; j < terrain.height; j++) for (let i = 0; i < terrain.width; i++) {
      const lon = bounds.minLon + i / (terrain.width - 1) * (bounds.maxLon - bounds.minLon);
      const lat = bounds.maxLat - j / (terrain.height - 1) * (bounds.maxLat - bounds.minLat);
      vertices.push(...point(lon, lat));
      const h = (terrain.elevations[j * terrain.width + i] - terrain.minElevation) / (terrain.maxElevation - terrain.minElevation);
      const color = new THREE.Color('#a8aaa0').lerp(new THREE.Color('#f1eee2'), h);
      const change = data.change?.[j * terrain.width + i];
      if (layer === 'elevation' && Number.isFinite(change)) {
        const v = change!;
        color.set(v < 0 ? '#d28066' : '#729cb1').lerp(new THREE.Color('#f2eadc'), 1 - Math.min(1, Math.abs(v) / 20));
      }
      colors.push(color.r, color.g, color.b);
    }
    for (let j = 0; j < terrain.height - 1; j++) for (let i = 0; i < terrain.width - 1; i++) {
      const a = j * terrain.width + i;
      indices.push(a, a + terrain.width, a + 1, a + 1, a + terrain.width, a + terrain.width + 1);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geometry.setIndex(indices); geometry.computeVertexNormals();
    return geometry;
  }, [terrain, bounds, point, data.change, layer]);
  useEffect(() => () => terrainGeometry.dispose(), [terrainGeometry]);

  const cells = useMemo(() => {
    const positions: number[] = [], colors: number[] = [], cellIds: number[] = [];
    data.velocity.cells.forEach((cell, index) => {
      if (!validSpeed(data.velocity, frame, index, maxGap)) return;
      const color = speedColor(data.velocity.speed[frame * data.velocity.cells.length + index] * 365.25);
      const corners = cell.corners.map(([lon, lat]) => point(lon, lat, .018));
      for (const k of [0, 2, 1, 0, 3, 2]) { positions.push(...corners[k]); colors.push(color.r, color.g, color.b); }
      cellIds.push(index);
    });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    return { geometry, cellIds };
  }, [data.velocity, frame, maxGap, point]);
  useEffect(() => () => cells.geometry.dispose(), [cells]);
  const selectCell = (event: ThreeEvent<MouseEvent>) => {
    event.stopPropagation();
    if (event.faceIndex != null) onSelect(cells.cellIds[Math.floor(event.faceIndex / 2)]);
  };
  const outlines = layer === 'outlines'
    ? data.outlines.filter(f => f.properties.src_date?.slice(0, 10) === outlineDate)
    : data.inventory.filter(f => f.properties.rgi_id === 'RGI60-13.08624');
  const linePoints = (feature: Outline) => outlineRings(feature).flatMap(ring => {
    const lines: [number, number, number][][] = [];
    let current: [number, number, number][] = [];
    for (let i = 1; i < ring.length; i++) {
      const [ax, ay] = ring[i - 1], [bx, by] = ring[i];
      const dx = bx - ax, dy = by - ay;
      let start = 0, end = 1, visible = true;
      for (const [p, q] of [[-dx, ax - bounds.minLon], [dx, bounds.maxLon - ax], [-dy, ay - bounds.minLat], [dy, bounds.maxLat - ay]]) {
        if (p === 0) { if (q < 0) visible = false; }
        else if (p < 0) start = Math.max(start, q / p);
        else end = Math.min(end, q / p);
      }
      if (!visible || start > end) { if (current.length > 1) lines.push(current); current = []; continue; }
      const lengthM = Math.hypot(dx * 81350, dy * 111320) * (end - start);
      const steps = Math.max(1, Math.ceil(lengthM / 35));
      for (let j = 0; j <= steps; j++) {
        const t = start + (end - start) * j / steps;
        current.push(point(ax + dx * t, ay + dy * t, .027));
      }
      if (end < 1) { if (current.length > 1) lines.push(current); current = []; }
    }
    if (current.length > 1) lines.push(current);
    return lines;
  });
  return <>
    <ambientLight intensity={1.0} />
    <directionalLight position={[-4, 9, -4]} intensity={1.6} />
    <mesh geometry={terrainGeometry}><meshStandardMaterial vertexColors roughness={1} side={THREE.DoubleSide} /></mesh>
    {layer === 'velocity' && <mesh geometry={cells.geometry} onClick={selectCell}>
      <meshBasicMaterial vertexColors side={THREE.DoubleSide} toneMapped={false} />
    </mesh>}
    {outlines.flatMap((f, i) => linePoints(f).map((ring, j) => <Line key={`${i}-${j}`} points={ring} color={layer === 'outlines' ? '#735989' : '#f9ffff'} lineWidth={layer === 'outlines' ? 1.8 : 1.3} />))}
    {layer === 'velocity' && selected !== null && <Line points={[...data.velocity.cells[selected].corners, data.velocity.cells[selected].corners[0]].map(([lon, lat]) => point(lon, lat, .045))} color="#172f35" lineWidth={3} />}
    <OrbitControls key={flat ? 'flat' : '3d'} makeDefault enableRotate={!flat} minDistance={3} maxDistance={16} maxPolarAngle={Math.PI / 2.05} target={[0, flat ? 0 : .6, 0]} />
  </>;
}

export default function GlacierTestScene(props: Props) {
  return <Canvas key={props.flat ? 'flat' : '3d'} camera={{ position: props.flat ? [0, 11, .001] : [4, 8.5, -7], fov: 42, near: .1, far: 80 }} dpr={[1, 2]} onPointerMissed={() => props.onSelect(null)} aria-label="Interactive Tuyuksu glacier terrain. Drag to orbit, scroll to zoom, and click a colored cell to inspect glacier speed.">
    <color attach="background" args={['#e9e7de']} />
    <World {...props} />
  </Canvas>;
}
