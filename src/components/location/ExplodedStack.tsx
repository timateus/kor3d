import { createContext, useContext, useEffect, useMemo, useRef, type ReactNode } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import * as THREE from 'three';

/**
 * "Exploded" layer stack: every overlay is lifted onto its own floor and
 * flattened, so the location reads like a stack of transparent plates in a
 * wireframe box (terrain at the bottom, places on top). Each slice animates
 * between the normal draped view (t = 0) and the stacked view (t = 1).
 */

interface StackCtx {
  progress: React.MutableRefObject<number>;
  order: string[];
  gap: number;
  flatten: number;
  meshW: number;
  meshH: number;
  active: boolean;
}

const Ctx = createContext<StackCtx | null>(null);

const STACK_LABELS: Record<string, string> = {
  terrain: 'Terrain',
  population: 'Population',
  glacier: 'Glaciers',
  lakes: 'Lakes',
  water: 'Waterways',
  basin: 'Basin',
  canals: 'Canals',
  buildings: 'Buildings',
  roads: 'Roads',
  resources: 'Resources',
  borders: 'Borders',
  inat: 'iNaturalist',
  places: 'Places',
};

const ease = (t: number) => t * t * (3 - 2 * t);

/** Lands slightly past the floor and settles back — reads as weight. */
const easeOutBack = (t: number) => {
  const c1 = 0.7, c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
};

const DROP_HEIGHT = 7;
const DROP_SECONDS = 1.15;
const FLASH_SECONDS = 0.8;
/** Give up waiting for a layer's data after this long and drop whatever's there
 * (also covers DOM-only layers like place labels, which have no geometry). */
const DROP_MAX_WAIT = 1.5;

/** True once a subtree has something drawable (data has arrived). */
function hasContent(root: THREE.Object3D) {
  let found = false;
  root.traverse((o) => {
    if (found) return;
    const g = (o as THREE.Mesh).geometry as THREE.BufferGeometry | undefined;
    if (g?.attributes?.position?.count) found = true;
  });
  return found;
}

export function ExplodedStack({
  active, order, gap, flatten, meshW, meshH, orbitRef, children,
}: {
  active: boolean;
  order: string[];
  gap: number;
  flatten: number;
  meshW: number;
  meshH: number;
  orbitRef: React.MutableRefObject<{ target: THREE.Vector3 } | null>;
  children: ReactNode;
}) {
  const progress = useRef(0);
  const raw = useRef(0);
  const lastMid = useRef(0);
  const { scene, camera } = useThree();
  const bg = useRef<{ base: THREE.Color; dark: THREE.Color } | null>(null);

  useFrame((_, dt) => {
    const target = active ? 1 : 0;
    raw.current += (target - raw.current) * Math.min(1, dt * 3.5);
    if (Math.abs(target - raw.current) < 1e-3) raw.current = target;
    const t = ease(raw.current);
    progress.current = t;

    // Keep the camera framing the middle of the stack as it grows.
    const mid = (t * gap * Math.max(0, order.length - 1)) / 2;
    const delta = mid - lastMid.current;
    if (delta !== 0) {
      lastMid.current = mid;
      const ctrl = orbitRef.current;
      if (ctrl) ctrl.target.y += delta;
      camera.position.y += delta;
    }

    // Fade to a dark backdrop so the plates glow like a hologram.
    if (scene.background instanceof THREE.Color) {
      if (!bg.current) bg.current = { base: scene.background.clone(), dark: new THREE.Color('#07090c') };
      scene.background.copy(bg.current.base).lerp(bg.current.dark, t);
    }
  });

  // Callers build `order` inline each render; key the context on its contents.
  const orderKey = order.join('|');
  const value = useMemo(
    () => ({ progress, order, gap, flatten, meshW, meshH, active }),
    [orderKey, gap, flatten, meshW, meshH, active], // eslint-disable-line react-hooks/exhaustive-deps
  );

  return (
    <Ctx.Provider value={value}>
      {children}
      <StackFrame />
    </Ctx.Provider>
  );
}

/** One floor of the stack. Children keep their own terrain-draped geometry;
 * the group lifts and squashes it. Outside an <ExplodedStack> it's a no-op. */
export function StackSlice({ id, children }: { id: string; children: ReactNode }) {
  const ctx = useContext(Ctx);
  const ref = useRef<THREE.Group>(null);
  const plate = useRef<THREE.MeshBasicMaterial>(null);
  const edge = useRef<THREE.LineBasicMaterial>(null);
  const content = useRef<THREE.Group>(null);
  // Layers that are switched off stay mounted (several just take enabled=false);
  // they get no floor, plate or label.
  const index = ctx ? ctx.order.indexOf(id) : -1;
  const floor = Math.max(0, index);
  const shownNow = index >= 0;

  // Floors glide when a layer is inserted/removed below this one.
  const floorAnim = useRef(floor);
  // Switching a layer on drops it from the sky: wait for its data, then fall.
  const drop = useRef<{ waited: number; elapsed: number | null } | null>(null);
  const sinceLanding = useRef(Infinity);
  const wasShown = useRef(shownNow);
  useEffect(() => {
    if (shownNow && !wasShown.current) drop.current = { waited: 0, elapsed: null };
    if (!shownNow) drop.current = null;
    wasShown.current = shownNow;
  }, [shownNow]);

  useFrame((_, dt) => {
    if (!ctx || !ref.current) return;
    const t = ctx.progress.current;
    floorAnim.current += (floor - floorAnim.current) * Math.min(1, dt * 6);

    let offset = 0;
    let falling = false;
    const d = drop.current;
    if (d) {
      if (d.elapsed === null) {
        d.waited += dt;
        if ((content.current && hasContent(content.current)) || d.waited > DROP_MAX_WAIT) d.elapsed = 0;
      }
      if (d.elapsed === null) {
        if (content.current) content.current.visible = false;
      } else {
        if (content.current) content.current.visible = true;
        d.elapsed += dt;
        const p = Math.min(1, d.elapsed / DROP_SECONDS);
        offset = (DROP_HEIGHT + ctx.gap * t) * (1 - easeOutBack(p));
        falling = true;
        if (p >= 1) { drop.current = null; sinceLanding.current = 0; }
      }
    } else if (content.current && !content.current.visible) {
      content.current.visible = true;
    }
    sinceLanding.current += dt;
    const flash = falling ? 0.9 : Math.max(0, 1 - sinceLanding.current / FLASH_SECONDS) * 0.9;

    ref.current.position.y = floorAnim.current * ctx.gap * t + offset;
    ref.current.scale.y = 1 + (Math.max(0.02, ctx.flatten) - 1) * t;
    if (plate.current) plate.current.opacity = Math.max(0.05 * t, flash * 0.08);
    if (edge.current) edge.current.opacity = Math.max(0.55 * t, flash);
  });

  const outline = useMemo(() => {
    if (!ctx) return null;
    const w = ctx.meshW / 2, h = ctx.meshH / 2;
    return new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-w, 0, -h), new THREE.Vector3(w, 0, -h),
      new THREE.Vector3(w, 0, h), new THREE.Vector3(-w, 0, h),
    ]);
  }, [ctx?.meshW, ctx?.meshH]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!ctx) return <>{children}</>;
  const shown = index >= 0;

  return (
    <group ref={ref}>
      <group ref={content}>{children}</group>
      {shown && outline && (
        <lineLoop geometry={outline} renderOrder={-1}>
          <lineBasicMaterial ref={edge} color="#ffffff" transparent opacity={0} depthWrite={false} />
        </lineLoop>
      )}
      {shown && id !== 'terrain' && (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.01, 0]} raycast={() => null} renderOrder={-2}>
          <planeGeometry args={[ctx.meshW, ctx.meshH]} />
          <meshBasicMaterial ref={plate} color="#bfe3ff" transparent opacity={0} depthWrite={false} side={THREE.DoubleSide} />
        </mesh>
      )}
      {shown && ctx.active && (
        <Html position={[ctx.meshW / 2 + 0.25, 0, ctx.meshH / 2]} zIndexRange={[5, 0]} style={{ pointerEvents: 'none' }}>
          <div
            className="tech-font whitespace-nowrap rounded-sm px-1.5 py-0.5 text-[10px] uppercase tracking-[0.2em]"
            style={{ color: '#e8f4ff', background: 'rgba(7,9,12,0.55)', textShadow: '0 0 6px rgba(140,200,255,0.6)' }}
          >
            <span style={{ opacity: 0.5 }}>{String(index + 1).padStart(2, '0')} </span>
            {STACK_LABELS[id] ?? id}
          </div>
        </Html>
      )}
    </group>
  );
}

/** Wireframe box enclosing the stack, with a faint vertical grid. */
function StackFrame() {
  const ctx = useContext(Ctx)!;
  const box = useRef<THREE.LineSegments>(null);
  const grid = useRef<THREE.LineSegments>(null);
  const mats = useRef<THREE.LineBasicMaterial[]>([]);

  const boxGeom = useMemo(() => new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0)), []);
  const gridGeom = useMemo(() => {
    // Vertical guides on each wall, unit height; scaled per frame.
    const pts: THREE.Vector3[] = [];
    const n = 6;
    for (let i = 1; i < n; i++) {
      const f = i / n - 0.5;
      pts.push(new THREE.Vector3(f, 0, -0.5), new THREE.Vector3(f, 1, -0.5));
      pts.push(new THREE.Vector3(f, 0, 0.5), new THREE.Vector3(f, 1, 0.5));
      pts.push(new THREE.Vector3(-0.5, 0, f), new THREE.Vector3(-0.5, 1, f));
      pts.push(new THREE.Vector3(0.5, 0, f), new THREE.Vector3(0.5, 1, f));
    }
    return new THREE.BufferGeometry().setFromPoints(pts);
  }, []);

  useEffect(() => () => { boxGeom.dispose(); gridGeom.dispose(); }, [boxGeom, gridGeom]);

  useFrame(() => {
    const t = ctx.progress.current;
    const visible = t > 0.001;
    const height = Math.max(0.5, Math.max(0, ctx.order.length - 1) * ctx.gap * t + ctx.gap * 0.6);
    for (const o of [box.current, grid.current]) {
      if (!o) continue;
      o.visible = visible;
      o.scale.set(ctx.meshW + 0.4, height, ctx.meshH + 0.4);
      o.position.y = -0.15;
    }
    const [a, b] = mats.current;
    if (a) a.opacity = 0.7 * t;
    if (b) b.opacity = 0.12 * t;
  });

  return (
    <>
      <lineSegments ref={box} geometry={boxGeom} raycast={() => null}>
        <lineBasicMaterial ref={(m) => { if (m) mats.current[0] = m; }} color="#ffffff" transparent opacity={0} depthWrite={false} />
      </lineSegments>
      <lineSegments ref={grid} geometry={gridGeom} raycast={() => null}>
        <lineBasicMaterial ref={(m) => { if (m) mats.current[1] = m; }} color="#ffffff" transparent opacity={0} depthWrite={false} />
      </lineSegments>
    </>
  );
}
