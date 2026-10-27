import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { paintEmbeddingStroke, type EmbeddingMetadata } from '@/lib/satellite-embeddings';

type Point = { lon: number; lat: number };

/** Live paint uses one small GPU texture; React only receives a selection at stroke end. */
export function useEmbeddingBrush(metadata: EmbeddingMetadata | null, pixels: Uint32Array | null,
  radius: number, onCommit: (pixels: Uint32Array) => void, enabled: boolean) {
  const data = useMemo(() => {
    if (!metadata) return null;
    const mask = new Uint8Array(metadata.width * metadata.height);
    const rgba = new Uint8Array(mask.length * 4);
    const texture = new THREE.DataTexture(rgba, metadata.width, metadata.height, THREE.RGBAFormat);
    texture.flipY = true;
    texture.colorSpace = THREE.NoColorSpace;
    texture.magFilter = THREE.NearestFilter;
    texture.minFilter = THREE.NearestFilter;
    return { mask, rgba, texture };
  }, [metadata]);
  const previous = useRef<Point | null>(null);
  const frame = useRef<number | null>(null);
  const commit = useRef(onCommit);
  commit.current = onCommit;
  const refresh = () => {
    if (!data) return;
    for (let p = 0; p < data.mask.length; p++) {
      const offset = p * 4;
      data.rgba[offset] = 180; data.rgba[offset + 1] = 130; data.rgba[offset + 2] = 255;
      data.rgba[offset + 3] = data.mask[p] ? 190 : 0;
    }
    data.texture.needsUpdate = true;
  };
  const scheduleRefresh = () => {
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(() => { frame.current = null; refresh(); });
  };
  useEffect(() => {
    if (!data) return;
    previous.current = null;
    data.mask.fill(0);
    if (pixels) for (const pixel of pixels) if (pixel < data.mask.length) data.mask[pixel] = 1;
    // Initial and committed masks must also be visible when no stroke is active.
    for (let p = 0; p < data.mask.length; p++) data.rgba.set([180, 130, 255, data.mask[p] ? 190 : 0], p * 4);
    data.texture.needsUpdate = true;
  }, [data, pixels]);
  useEffect(() => () => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    previous.current = null;
    data?.texture.dispose();
  }, [data]);
  const finish = () => {
    if (!data || !previous.current) return;
    previous.current = null;
    const selected: number[] = [];
    for (let p = 0; p < data.mask.length; p++) if (data.mask[p]) selected.push(p);
    commit.current(Uint32Array.from(selected));
  };
  useEffect(() => {
    // Finish outside the mesh/window too, so a released pointer cannot keep painting.
    const end = () => finish();
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
    window.addEventListener('blur', end);
    return () => {
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      window.removeEventListener('blur', end);
    };
    // The current mask is captured; callbacks use a ref to avoid rebinding while drawing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);
  useEffect(() => { if (!enabled) finish(); }, [enabled]); // eslint-disable-line react-hooks/exhaustive-deps
  const paint = (point: Point) => {
    if (!metadata || !data || !previous.current) return;
    paintEmbeddingStroke(data.mask, metadata, previous.current, point, radius);
    previous.current = point;
    scheduleRefresh();
  };
  return {
    texture: data?.texture ?? null,
    start: (point: Point) => {
      if (!enabled || !data || !metadata) return;
      previous.current = point;
      paint(point);
    },
    paint,
    finish,
    isPainting: () => previous.current !== null,
  };
}
