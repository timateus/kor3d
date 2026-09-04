import { useEffect, useMemo, useState } from 'react';
import * as THREE from 'three';
import { DecalGeometry } from 'three/examples/jsm/geometries/DecalGeometry.js';
import { useThree } from '@react-three/fiber';

interface Props {
  /** Image to project onto the terrain surface. */
  imageUrl: string;
  /** World-space point on (or very near) the terrain surface to center the decal on. */
  position: THREE.Vector3;
  /** Deterministic seed for the decal's rotation so repeat renders don't jitter. */
  seed?: number;
  /** Roughly how wide the decal patch is, in scene units (terrain spans ~10 units). */
  baseSize?: number;
  opacity?: number;
}

/** Generates a soft radial-gradient alpha mask so decals fade at the edges instead of
 * showing a hard photo rectangle glued to the terrain. */
function makeFeatherMask(): THREE.Texture {
  const s = 256;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  g.addColorStop(0.0, 'rgba(255,255,255,1)');
  g.addColorStop(0.65, 'rgba(255,255,255,1)');
  g.addColorStop(1.0, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
  const t = new THREE.CanvasTexture(c);
  t.needsUpdate = true;
  return t;
}

let _featherMask: THREE.Texture | null = null;
function featherMask(): THREE.Texture {
  if (!_featherMask) _featherMask = makeFeatherMask();
  return _featherMask;
}

/** Finds the terrain surface mesh (tagged by MapboxTerrainMesh via userData.terrainSurface)
 * to project the decal's geometry against. */
function findTerrainMesh(root: THREE.Object3D): THREE.Mesh | null {
  let found: THREE.Mesh | null = null;
  root.traverse((o) => {
    if (!found && (o as THREE.Mesh).isMesh && o.userData?.terrainSurface) found = o as THREE.Mesh;
  });
  return found;
}

/** Projects `imageUrl` onto the terrain mesh at `position`, conforming to the local
 * slope/relief instead of floating above it as a flat card. */
const TerrainDecal = ({ imageUrl, position, seed = 0, baseSize = 0.6, opacity = 0.92 }: Props) => {
  const { scene } = useThree();
  const [texture, setTexture] = useState<THREE.Texture | null>(null);

  useEffect(() => {
    let cancelled = false;
    const loader = new THREE.TextureLoader();
    loader.load(imageUrl, (tex) => {
      if (cancelled) { tex.dispose(); return; }
      tex.colorSpace = THREE.SRGBColorSpace;
      setTexture(tex);
    }, undefined, (err) => { console.warn('[TerrainDecal] texture load failed', imageUrl, err); });
    return () => {
      cancelled = true;
      setTexture((t) => { t?.dispose(); return null; });
    };
  }, [imageUrl]);

  const geometry = useMemo(() => {
    if (!texture) return null;
    const mesh = findTerrainMesh(scene);
    if (!mesh) return null;
    mesh.updateMatrixWorld();

    const dummy = new THREE.Object3D();
    dummy.position.copy(position);
    dummy.lookAt(position.clone().add(new THREE.Vector3(0, -1, 0)));
    dummy.rotateZ(((seed * 137.5) % 360) * (Math.PI / 180));
    dummy.updateMatrixWorld();

    const img = texture.image as { width: number; height: number };
    const aspect = img?.width && img?.height ? img.width / img.height : 1;
    const sizeX = baseSize * Math.sqrt(aspect);
    const sizeY = baseSize / Math.sqrt(aspect);
    const size = new THREE.Vector3(sizeX, sizeY, baseSize * 1.4);

    try {
      const g = new DecalGeometry(mesh, dummy.position, dummy.rotation, size);
      // Decal vertices sit exactly on the terrain surface (that's the whole point of
      // conforming to it), which z-fights with the terrain mesh itself. polygonOffset
      // alone isn't reliable at this scene's depth range, so also nudge each vertex a
      // hair off the surface along its normal.
      const posAttr = g.attributes.position;
      const normAttr = g.attributes.normal;
      const EPS = 0.004;
      for (let i = 0; i < posAttr.count; i++) {
        posAttr.setXYZ(
          i,
          posAttr.getX(i) + normAttr.getX(i) * EPS,
          posAttr.getY(i) + normAttr.getY(i) * EPS,
          posAttr.getZ(i) + normAttr.getZ(i) * EPS,
        );
      }
      posAttr.needsUpdate = true;
      return g;
    } catch (e) {
      console.warn('[TerrainDecal] failed', e);
      return null;
    }
  }, [texture, scene, position, seed, baseSize]);

  useEffect(() => () => geometry?.dispose(), [geometry]);

  if (!geometry || !texture) return null;

  return (
    <mesh geometry={geometry} raycast={() => null}>
      <meshStandardMaterial
        map={texture}
        alphaMap={featherMask()}
        transparent
        depthWrite={false}
        polygonOffset
        polygonOffsetFactor={-4}
        polygonOffsetUnits={-4}
        roughness={0.9}
        metalness={0}
        opacity={opacity}
      />
    </mesh>
  );
};

export default TerrainDecal;
