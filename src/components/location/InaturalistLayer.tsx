import { useEffect, useMemo, useRef, useState } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import type { GeoBounds, TerrainData } from '@/lib/geotiff-loader';
import { cacheGet, cacheSet } from '@/lib/browser-cache';
import TerrainDecal from './TerrainDecal';

export interface InatObservation {
  id: number;
  lat: number;
  lon: number;
  species: string | null;
  commonName: string | null;
  iconicTaxon: string | null;
  photoUrl: string | null;
  observedOn: string | null;
  user: string | null;
  url: string;
}

interface Props {
  terrain: TerrainData;
  exaggeration: number;
  bounds: GeoBounds;
  queryBounds?: GeoBounds;
  selectedId?: number | null;
  onSelect?: (o: InatObservation | null) => void;
  onObservationsLoaded?: (obs: InatObservation[]) => void;
}

const mem = new Map<string, InatObservation[]>();

async function fetchObservations(b: GeoBounds): Promise<InatObservation[]> {
  const key = `inat|${b.minLat.toFixed(3)},${b.minLon.toFixed(3)},${b.maxLat.toFixed(3)},${b.maxLon.toFixed(3)}`;
  const hit = mem.get(key);
  if (hit) return hit;
  const cached = await cacheGet<InatObservation[]>(key);
  if (cached && Array.isArray(cached)) {
    mem.set(key, cached);
    return cached;
  }

  const out: InatObservation[] = [];
  for (let page = 1; page <= 3; page++) {
    const url = new URL('https://api.inaturalist.org/v1/observations');
    url.searchParams.set('nelat', String(b.maxLat));
    url.searchParams.set('nelng', String(b.maxLon));
    url.searchParams.set('swlat', String(b.minLat));
    url.searchParams.set('swlng', String(b.minLon));
    url.searchParams.set('per_page', '200');
    url.searchParams.set('page', String(page));
    url.searchParams.set('photos', 'true');
    url.searchParams.set('quality_grade', 'research');
    url.searchParams.set('order', 'desc');
    url.searchParams.set('order_by', 'observed_on');
    const res = await fetch(url.toString());
    if (!res.ok) break;
    const json = await res.json();
    for (const r of json.results ?? []) {
      const geo: string | undefined = r.location;
      if (!geo) continue;
      const [latS, lonS] = geo.split(',');
      const lat = parseFloat(latS);
      const lon = parseFloat(lonS);
      if (!isFinite(lat) || !isFinite(lon)) continue;
      const t = r.taxon ?? {};
      const photo = r.photos?.[0]?.url ?? r.observation_photos?.[0]?.photo?.url ?? null;
      out.push({
        id: r.id,
        lat, lon,
        species: t.name ?? null,
        commonName: t.preferred_common_name ?? null,
        iconicTaxon: t.iconic_taxon_name ?? null,
        photoUrl: photo ? photo.replace('/square.', '/medium.') : null,
        observedOn: r.observed_on_details?.date ?? r.observed_on ?? null,
        user: r.user?.login ?? null,
        url: `https://www.inaturalist.org/observations/${r.id}`,
      });
    }
    if ((json.results ?? []).length < 200) break;
  }
  mem.set(key, out);
  cacheSet(key, out);
  return out;
}

const TAXON_TINT: Record<string, [number, number, number]> = {
  Plantae:        [0.86, 0.94, 0.78],
  Fungi:          [0.98, 0.86, 0.68],
  Animalia:       [0.94, 0.90, 0.98],
  Aves:           [0.82, 0.92, 1.00],
  Insecta:        [1.00, 0.92, 0.72],
  Arachnida:      [0.90, 0.82, 1.00],
  Mollusca:       [1.00, 0.88, 0.92],
  Reptilia:       [0.86, 0.98, 0.90],
  Amphibia:       [0.82, 0.96, 0.90],
  Mammalia:       [1.00, 0.88, 0.86],
  Actinopterygii: [0.86, 0.92, 1.00],
};

function makeDotTexture(): THREE.Texture {
  const s = 64;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  g.addColorStop(0.0, 'rgba(255,255,255,1)');
  g.addColorStop(0.25, 'rgba(255,255,255,0.55)');
  g.addColorStop(0.6, 'rgba(255,255,255,0.10)');
  g.addColorStop(1.0, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
  const t = new THREE.CanvasTexture(c);
  t.needsUpdate = true;
  return t;
}

// disable raycast on visual-only meshes
const noRaycast: any = () => null;

const InaturalistLayer = ({
  terrain, exaggeration, bounds, queryBounds,
  selectedId, onSelect, onObservationsLoaded,
}: Props) => {
  const [obs, setObs] = useState<InatObservation[] | null>(null);
  const q = queryBounds ?? bounds;

  const dotTex = useMemo(() => makeDotTexture(), []);

  useEffect(() => {
    let cancelled = false;
    setObs(null);
    fetchObservations(q)
      .then((o) => { if (!cancelled) { setObs(o); onObservationsLoaded?.(o); } })
      .catch(() => { if (!cancelled) { setObs([]); onObservationsLoaded?.([]); } });
    return () => { cancelled = true; };
  }, [q.minLat, q.minLon, q.maxLat, q.maxLon]);

  const anchored = useMemo(() => {
    if (!obs) return [] as Array<{ o: InatObservation; pos: THREE.Vector3; tint: THREE.Color }>;
    const meshW = 10;
    const meshH = 10 * (terrain.height / terrain.width);
    const elevRange = terrain.maxElevation - terrain.minElevation || 1;
    const maxH = 10 * (exaggeration / 100);
    const out: Array<{ o: InatObservation; pos: THREE.Vector3; tint: THREE.Color }> = [];
    for (const o of obs) {
      const nx = (o.lon - bounds.minLon) / (bounds.maxLon - bounds.minLon);
      const ny = (o.lat - bounds.minLat) / (bounds.maxLat - bounds.minLat);
      const x = (nx - 0.5) * meshW;
      const z = -((ny - 0.5) * meshH);
      let y = 0.02;
      if (nx >= 0 && nx <= 1 && ny >= 0 && ny <= 1) {
        const cx = Math.floor(nx * (terrain.width - 1));
        const cy = Math.floor((1 - ny) * (terrain.height - 1));
        let e = terrain.elevations[cy * terrain.width + cx];
        if (!isFinite(e)) e = terrain.minElevation;
        y = ((e - terrain.minElevation) / elevRange) * maxH;
      }
      const rgb = TAXON_TINT[o.iconicTaxon ?? ''] ?? [0.95, 0.95, 0.98];
      out.push({ o, pos: new THREE.Vector3(x, y, z), tint: new THREE.Color(rgb[0], rgb[1], rgb[2]) });
    }
    return out;
  }, [obs, terrain, exaggeration, bounds.minLat, bounds.minLon, bounds.maxLat, bounds.maxLon]);

  const pointsGeom = useMemo(() => {
    const g = new THREE.BufferGeometry();
    const positions = new Float32Array(anchored.length * 3);
    const colors = new Float32Array(anchored.length * 3);
    anchored.forEach((a, i) => {
      positions[i * 3 + 0] = a.pos.x;
      positions[i * 3 + 1] = a.pos.y + 0.015;
      positions[i * 3 + 2] = a.pos.z;
      colors[i * 3 + 0] = a.tint.r;
      colors[i * 3 + 1] = a.tint.g;
      colors[i * 3 + 2] = a.tint.b;
    });
    g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    return g;
  }, [anchored]);

  const scratchGeom = useMemo(() => {
    if (anchored.length === 0) return null;
    const positions: number[] = [];
    const colors: number[] = [];
    for (const a of anchored) {
      const angle = (a.o.id * 37) % 360 * (Math.PI / 180);
      const len = 0.028 + ((a.o.id % 7) * 0.004);
      const dx = Math.cos(angle) * len;
      const dz = Math.sin(angle) * len;
      positions.push(a.pos.x - dx, a.pos.y + 0.01, a.pos.z - dz);
      positions.push(a.pos.x + dx, a.pos.y + 0.01, a.pos.z + dz);
      colors.push(a.tint.r, a.tint.g, a.tint.b, a.tint.r, a.tint.g, a.tint.b);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    return g;
  }, [anchored]);

  // Precise hit-boxes: instanced tiny spheres (radius = HIT_R) — tight click area.
  const HIT_R = 0.045;
  const instRef = useRef<THREE.InstancedMesh>(null);
  const tmpMat = useMemo(() => new THREE.Matrix4(), []);
  useEffect(() => {
    const mesh = instRef.current;
    if (!mesh) return;
    anchored.forEach((a, i) => {
      tmpMat.makeTranslation(a.pos.x, a.pos.y + 0.02, a.pos.z);
      mesh.setMatrixAt(i, tmpMat);
    });
    mesh.count = anchored.length;
    mesh.instanceMatrix.needsUpdate = true;
  }, [anchored, tmpMat]);

  // Selected highlight — blue glowing point
  const highlight = useMemo(() => {
    if (selectedId == null) return null;
    return anchored.find((a) => a.o.id === selectedId) ?? null;
  }, [selectedId, anchored]);

  const glowRef = useRef<THREE.Points>(null);
  useFrame(({ clock }) => {
    if (!glowRef.current) return;
    const t = clock.getElapsedTime();
    const mat = glowRef.current.material as THREE.PointsMaterial;
    mat.opacity = 0.75 + Math.sin(t * 3) * 0.2;
  });

  // Shrink the dots a little as the camera zooms in, so close-up they don't
  // balloon into oversized blobs (sizeAttenuation alone keeps growing them).
  const haloRef = useRef<THREE.Points>(null);
  const coreRef = useRef<THREE.Points>(null);
  const BASE_HALO_SIZE = 0.28;
  const BASE_CORE_SIZE = 0.07;
  useFrame(({ camera }) => {
    const dist = camera.position.length();
    const factor = THREE.MathUtils.clamp(dist / 15, 0.8, 1);
    if (haloRef.current) (haloRef.current.material as THREE.PointsMaterial).size = BASE_HALO_SIZE * factor;
    if (coreRef.current) (coreRef.current.material as THREE.PointsMaterial).size = BASE_CORE_SIZE * factor;
  });

  const highlightGeom = useMemo(() => {
    if (!highlight) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute(
      'position',
      new THREE.Float32BufferAttribute(
        [highlight.pos.x, highlight.pos.y + 0.02, highlight.pos.z],
        3,
      ),
    );
    return g;
  }, [highlight]);

  if (anchored.length === 0) return null;

  return (
    <group>
      {scratchGeom && (
        <lineSegments geometry={scratchGeom} raycast={noRaycast}>
          <lineBasicMaterial
            vertexColors transparent opacity={0.35} depthWrite={false}
            blending={THREE.AdditiveBlending} toneMapped={false}
          />
        </lineSegments>
      )}
      <points ref={haloRef} geometry={pointsGeom} raycast={noRaycast}>
        <pointsMaterial
          size={0.28} map={dotTex} vertexColors transparent depthWrite={false}
          opacity={0.55} sizeAttenuation blending={THREE.AdditiveBlending}
          alphaTest={0.01} toneMapped={false}
        />
      </points>
      <points ref={coreRef} geometry={pointsGeom} raycast={noRaycast}>
        <pointsMaterial
          size={0.07} map={dotTex} vertexColors transparent depthWrite={false}
          opacity={0.95} sizeAttenuation blending={THREE.AdditiveBlending}
          alphaTest={0.01} toneMapped={false}
        />
      </points>

      {/* Invisible instanced hit-spheres for precise clicks */}
      <instancedMesh
        ref={instRef}
        args={[undefined as any, undefined as any, Math.max(1, anchored.length)]}
        onPointerDown={(e) => {
          if (typeof e.instanceId !== 'number') return;
          const a = anchored[e.instanceId];
          if (!a) return;
          e.stopPropagation();
          onSelect?.(a.o);
        }}
        onPointerOver={() => { document.body.style.cursor = 'pointer'; }}
        onPointerOut={() => { document.body.style.cursor = ''; }}
      >
        <sphereGeometry args={[HIT_R, 8, 6]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </instancedMesh>

      {/* Selected point: blue glow (halo + core) */}
      {highlightGeom && (
        <>
          <points geometry={highlightGeom} raycast={noRaycast}>
            <pointsMaterial
              size={0.9} map={dotTex} color="#3ba7ff" transparent depthWrite={false}
              opacity={0.7} sizeAttenuation blending={THREE.AdditiveBlending}
              alphaTest={0.01} toneMapped={false}
            />
          </points>
          <points ref={glowRef} geometry={highlightGeom} raycast={noRaycast}>
            <pointsMaterial
              size={0.35} map={dotTex} color="#7fd0ff" transparent depthWrite={false}
              opacity={0.9} sizeAttenuation blending={THREE.AdditiveBlending}
              alphaTest={0.01} toneMapped={false}
            />
          </points>
          <points geometry={highlightGeom} raycast={noRaycast}>
            <pointsMaterial
              size={0.12} map={dotTex} color="#eaf6ff" transparent depthWrite={false}
              opacity={1} sizeAttenuation blending={THREE.AdditiveBlending}
              alphaTest={0.01} toneMapped={false}
            />
          </points>
        </>
      )}

      {/* Projects the selected observation's photo directly onto the terrain surface,
          conforming to local relief instead of floating as a flat card. */}
      {highlight?.o.photoUrl && (
        <TerrainDecal
          key={highlight.o.id}
          imageUrl={highlight.o.photoUrl}
          position={highlight.pos}
          seed={highlight.o.id}
        />
      )}
    </group>
  );
};


export default InaturalistLayer;
