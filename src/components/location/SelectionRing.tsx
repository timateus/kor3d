import { useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';

/** Screen-constant, pulsing ring drawn over a selected feature (always on top). */
function ringTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  g.lineWidth = 7;
  g.strokeStyle = '#fff';
  g.shadowColor = '#fff';
  g.shadowBlur = 10;
  g.beginPath();
  g.arc(64, 64, 46, 0, Math.PI * 2);
  g.stroke();
  return new THREE.CanvasTexture(c);
}

const SelectionRing = ({ position, color = '#ffffff', size = 0.07 }: {
  position: [number, number, number] | THREE.Vector3; color?: string; size?: number;
}) => {
  const tex = useMemo(ringTexture, []);
  const ref = useRef<THREE.Sprite>(null);
  useFrame(({ clock }) => {
    if (!ref.current) return;
    const s = size * (1 + 0.12 * Math.sin(clock.getElapsedTime() * 4));
    ref.current.scale.set(s, s, 1);
  });
  return (
    <sprite ref={ref} position={position as any} renderOrder={999} raycast={() => null}>
      <spriteMaterial map={tex} color={color} transparent depthTest={false} depthWrite={false} sizeAttenuation={false} toneMapped={false} />
    </sprite>
  );
};

export default SelectionRing;
