import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import type { FlyKeyframe } from '@/lib/flyover';

interface Props {
  keyframes: FlyKeyframe[];
  playing: boolean;
  duration: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  orbitRef: React.MutableRefObject<any>;
  onDone: () => void;
}

// Cap how much progress a single frame can contribute. Without this, a
// throttled/delayed frame (tab backgrounded, slow GC pause, etc.) computes a
// huge delta and the flight jumps straight to completion in one tick.
const MAX_FRAME_DELTA = 0.5;

/** Drives the camera along a Catmull-Rom path through `keyframes` over `duration` seconds,
 * taking over from OrbitControls while playing and handing control back when done. */
const FlyoverController = ({ keyframes, playing, duration, orbitRef, onDone }: Props) => {
  const { camera } = useThree();
  const elapsedRef = useRef(0);
  const doneRef = useRef(false);
  const wasEnabledRef = useRef(true);

  const posCurve = useMemo(() => (
    keyframes.length >= 2 ? new THREE.CatmullRomCurve3(keyframes.map((k) => new THREE.Vector3(...k.pos))) : null
  ), [keyframes]);
  const targetCurve = useMemo(() => (
    keyframes.length >= 2 ? new THREE.CatmullRomCurve3(keyframes.map((k) => new THREE.Vector3(...k.target))) : null
  ), [keyframes]);

  useEffect(() => {
    if (playing) {
      elapsedRef.current = 0;
      doneRef.current = false;
      if (orbitRef.current) {
        wasEnabledRef.current = orbitRef.current.enabled;
        orbitRef.current.enabled = false;
      }
    } else if (orbitRef.current) {
      orbitRef.current.enabled = wasEnabledRef.current;
    }
  }, [playing, orbitRef]);

  useFrame((_, delta) => {
    if (!playing || !posCurve || !targetCurve) return;
    elapsedRef.current += Math.min(delta, MAX_FRAME_DELTA);
    const t = Math.min(1, elapsedRef.current / duration);
    camera.position.copy(posCurve.getPointAt(t));
    const tgt = targetCurve.getPointAt(t);
    if (orbitRef.current) {
      orbitRef.current.target.copy(tgt);
      orbitRef.current.update();
    } else {
      camera.lookAt(tgt);
    }
    if (t >= 1 && !doneRef.current) {
      doneRef.current = true;
      onDone();
    }
  });

  return null;
};

export default FlyoverController;
