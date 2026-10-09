import { useRef, type ReactNode, type RefObject } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';

/**
 * Per-layer "intensity": scales the opacity of every material under a group
 * relative to the opacity it was created with (remembered in userData), so it
 * works for layers whose materials are built asynchronously or rebuilt.
 * Newly-created materials are picked up by a periodic sweep.
 */
const BASE = '__fadeBase';
const BASE_TRANSPARENT = '__fadeBaseTransparent';

/** Above 1, "intensity" also makes unlit line/sprite/point/basic materials glow:
 * brighter colour, additive blending and (for fat lines) a wider stroke. */
function glow(mat: THREE.Material, k: number) {
  const m = mat as any;
  if (!m.color || (m.isMeshStandardMaterial || m.isMeshLambertMaterial || m.isMeshPhongMaterial)) return;
  const u = mat.userData;
  if (!u.__glowBase) {
    u.__glowBase = { color: m.color.clone(), blending: mat.blending, width: m.linewidth };
  }
  const b = u.__glowBase;
  const g = Math.max(0, k - 1) * 1.5;
  // Brighten but keep the hue: never push the strongest channel past 1,
  // otherwise additive blending washes everything out to white.
  const peak = Math.max(b.color.r, b.color.g, b.color.b, 0.001);
  m.color.copy(b.color).multiplyScalar(Math.min(1 + g, 1 / peak));
  if (m.isLineMaterial) m.linewidth = b.width * (1 + g * 0.6);
  const blending = g > 0 ? THREE.AdditiveBlending : b.blending;
  if (mat.blending !== blending) { mat.blending = blending; mat.needsUpdate = true; }
}

function applyTo(root: THREE.Object3D, k: number, filter?: (o: THREE.Object3D) => boolean) {
  root.traverse((o) => {
    if (filter && !filter(o)) return;
    const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
    if (!m) return;
    for (const mat of Array.isArray(m) ? m : [m]) {
      if (mat.userData[BASE] === undefined) {
        if (k === 1) continue;
        mat.userData[BASE] = mat.opacity;
        mat.userData[BASE_TRANSPARENT] = mat.transparent;
      }
      const base = mat.userData[BASE] as number;
      const next = Math.min(1, base * k);
      glow(mat, k);
      const transparent = (mat.userData[BASE_TRANSPARENT] as boolean) || next < 1;
      if (mat.opacity !== next) mat.opacity = next;
      if (mat.transparent !== transparent) { mat.transparent = transparent; mat.needsUpdate = true; }
    }
  });
}

export function useLayerFade(
  ref: RefObject<THREE.Object3D>, intensity: number, filter?: (o: THREE.Object3D) => boolean,
) {
  const last = useRef<{ k: number; frame: number }>({ k: 1, frame: 0 });
  useFrame(() => {
    const root = ref.current;
    if (!root) return;
    const s = last.current;
    s.frame++;
    if (s.k !== intensity || (intensity !== 1 && s.frame % 30 === 0)) {
      s.k = intensity;
      applyTo(root, intensity, filter);
    }
  });
}

export function LayerFade({ intensity, children }: { intensity: number; children: ReactNode }) {
  const ref = useRef<THREE.Group>(null);
  useLayerFade(ref as RefObject<THREE.Object3D>, intensity);
  return <group ref={ref}>{children}</group>;
}
