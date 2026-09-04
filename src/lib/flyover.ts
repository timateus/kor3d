export interface FlyKeyframe {
  id: string;
  pos: [number, number, number];
  target: [number, number, number];
}

/** Inverse of the heading/tilt calc in CameraProbe — offset from a target for a given distance/heading/tilt. */
export function sphericalOffset(distance: number, headingDeg: number, tiltDeg: number): [number, number, number] {
  const heading = (headingDeg * Math.PI) / 180;
  const tilt = (tiltDeg * Math.PI) / 180;
  const horiz = distance * Math.cos(tilt);
  const dy = distance * Math.sin(tilt);
  const dx = horiz * Math.sin(heading);
  const dz = -horiz * Math.cos(heading);
  return [dx, dy, dz];
}

/** Generates a closed 360° orbit path around `target` at a fixed distance/tilt, starting at the given heading. */
export function orbitKeyframes(
  target: [number, number, number],
  distance: number,
  tiltDeg: number,
  startHeadingDeg: number,
  steps = 8,
): FlyKeyframe[] {
  const out: FlyKeyframe[] = [];
  for (let i = 0; i <= steps; i++) {
    const heading = startHeadingDeg + (360 * i) / steps;
    const [dx, dy, dz] = sphericalOffset(distance, heading, tiltDeg);
    out.push({
      id: `orbit-${i}-${Date.now()}`,
      pos: [target[0] + dx, target[1] + dy, target[2] + dz],
      target,
    });
  }
  return out;
}

export const ASPECTS = {
  landscape: { label: 'Landscape', w: 1920, h: 1080 },
  portrait: { label: 'Stories', w: 1080, h: 1920 },
  square: { label: 'Square', w: 1080, h: 1080 },
} as const;
export type AspectKey = keyof typeof ASPECTS;
