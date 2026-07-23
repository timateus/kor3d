import { useEffect, useMemo, useState } from 'react';
import * as THREE from 'three';
import { TerrainData } from '@/lib/geotiff-loader';
import { loadBaseStyleTexture, type BaseStyle } from '@/lib/mapbox-tiles';
import { useVisualMode } from '@/lib/visual-mode';
import { useTerrainMode } from '@/hooks/useTerrainMode';

interface Props {
  terrain: TerrainData;
  exaggeration: number;
  token: string;
  onError?: (msg: string) => void;
  baseStyleOverride?: BaseStyle;
  brightness?: number;
  contrast?: number;
  saturation?: number;
  gamma?: number;
  /** Hex color multiplied onto the basemap (e.g. '#ffffff' = none). */
  tint?: string;
  /** 0..1 strength of tint blending. */
  tintStrength?: number;
  /** Render terrain as wireframe overlay only (no satellite). */
  wireframe?: boolean;
}

const MapboxTerrainMesh = ({
  terrain, exaggeration, token, onError, baseStyleOverride,
  brightness = 1, contrast = 1, saturation = 1, gamma = 1,
  tint = '#ffffff', tintStrength = 0, wireframe = false,
}: Props) => {
  const [satellite, setSatellite] = useState<THREE.Texture | null>(null);
  const [mode] = useVisualMode();
  const isMirage = mode === 'mirage' || mode === 'designer';
  const { baseStyle: globalBaseStyle } = useTerrainMode();
  const baseStyle = baseStyleOverride ?? globalBaseStyle;

  useEffect(() => {
    if (!terrain.bounds) return;
    if (baseStyle !== 'osm' && baseStyle !== 'satlas' && !token) return;
    let cancelled = false;
    setSatellite(null);
    loadBaseStyleTexture(terrain.bounds, baseStyle, token)
      .then((t) => { if (!cancelled) setSatellite(t); })
      .catch((e) => { if (!cancelled) onError?.(e.message); });
    return () => { cancelled = true; };
  }, [token, terrain.bounds, onError, baseStyle]);

  const geometry = useMemo(() => {
    const { width: w, height: h, elevations, minElevation, maxElevation, noDataValue } = terrain;
    const elevRange = maxElevation - minElevation || 1;
    const maxHeight = 10 * (exaggeration / 100);
    const positions: number[] = [];
    const uvs: number[] = [];
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        let elev = elevations[j * w + i];
        const nd = isNaN(elev) || (noDataValue !== null && elev === noDataValue) || elev <= -9999;
        if (nd) elev = minElevation;
        const normalized = (elev - minElevation) / elevRange;
        const x = (i / (w - 1) - 0.5) * 10;
        const y = (0.5 - j / (h - 1)) * 10 * (h / w);
        const z = normalized * maxHeight;
        positions.push(x, y, z);
        uvs.push(i / (w - 1), 1 - j / (h - 1));
      }
    }
    const indices: number[] = [];
    for (let j = 0; j < h - 1; j++) {
      for (let i = 0; i < w - 1; i++) {
        const a = j * w + i, b = a + 1, c = a + w, d = c + 1;
        indices.push(a, b, c, b, d, c);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    return geo;
  }, [terrain, exaggeration]);

  const material = useMemo(() => new THREE.ShaderMaterial({
    uniforms: {
      uSatellite: { value: null },
      uMirage: { value: 0 },
      uHasTex: { value: 0 },
      uBrightness: { value: brightness },
      uContrast: { value: contrast },
      uSaturation: { value: saturation },
      uGamma: { value: gamma },
      uTint: { value: new THREE.Color(tint) },
      uTintStrength: { value: tintStrength },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D uSatellite;
      uniform float uMirage;
      uniform float uHasTex;
      uniform float uBrightness;
      uniform float uContrast;
      uniform float uSaturation;
      uniform float uGamma;
      uniform vec3 uTint;
      uniform float uTintStrength;
      varying vec2 vUv;
      void main() {
        vec3 col = uHasTex > 0.5 ? texture2D(uSatellite, vUv).rgb : vec3(0.55, 0.57, 0.6);
        col *= uBrightness;
        col = (col - 0.5) * uContrast + 0.5;
        float gray = dot(col, vec3(0.299, 0.587, 0.114));
        col = mix(vec3(gray), col, uSaturation);
        col = pow(max(col, 0.0), vec3(1.0 / max(uGamma, 0.0001)));
        // Tint: multiply the luminance by the tint color, then blend by strength.
        vec3 tinted = vec3(gray) * uTint * 2.0;
        col = mix(col, col * uTint * 1.5, clamp(uTintStrength, 0.0, 1.0) * 0.6)
            + (tinted - col) * clamp(uTintStrength - 0.6, 0.0, 1.0) * 0.5;
        col = clamp(col, 0.0, 1.0);
        if (uMirage > 0.5) {
          float g = dot(col, vec3(0.299, 0.587, 0.114));
          vec3 desat = mix(col, vec3(g), 0.35);
          col = desat * vec3(1.05, 1.0, 0.92);
        }
        gl_FragColor = vec4(col, 1.0);
      }
    `,
    side: THREE.DoubleSide,
  }), []);

  useEffect(() => { material.uniforms.uMirage.value = isMirage ? 1 : 0; }, [isMirage, material]);
  useEffect(() => { material.uniforms.uBrightness.value = brightness; }, [brightness, material]);
  useEffect(() => { material.uniforms.uContrast.value = contrast; }, [contrast, material]);
  useEffect(() => { material.uniforms.uSaturation.value = saturation; }, [saturation, material]);
  useEffect(() => { material.uniforms.uGamma.value = gamma; }, [gamma, material]);
  useEffect(() => { (material.uniforms.uTint.value as THREE.Color).set(tint); }, [tint, material]);
  useEffect(() => { material.uniforms.uTintStrength.value = tintStrength; }, [tintStrength, material]);
  useEffect(() => {
    material.uniforms.uSatellite.value = satellite;
    material.uniforms.uHasTex.value = satellite ? 1 : 0;
    material.needsUpdate = true;
  }, [satellite, material]);

  // Skirt: opaque vertical sides + base cap, so terrain looks like a solid block
  const skirt = useMemo(() => {
    const { width: w, height: h, elevations, minElevation, maxElevation, noDataValue } = terrain;
    const elevRange = maxElevation - minElevation || 1;
    const maxHeight = 10 * (exaggeration / 100);
    const meshW = 10;
    const meshH = 10 * (h / w);
    const baseZ = -0.4; // pre-rotation z (below terrain min)
    const elevAt = (i: number, j: number) => {
      let e = elevations[j * w + i];
      const nd = isNaN(e) || (noDataValue !== null && e === noDataValue) || e <= -9999;
      if (nd) e = minElevation;
      return ((e - minElevation) / elevRange) * maxHeight;
    };
    const xAt = (i: number) => (i / (w - 1) - 0.5) * meshW;
    const yAt = (j: number) => (0.5 - j / (h - 1)) * meshH;
    const positions: number[] = [];
    const pushQuad = (a: number[], b: number[], c: number[], d: number[]) => {
      positions.push(...a, ...b, ...c, ...a, ...c, ...d);
    };
    // North edge (j=0)
    for (let i = 0; i < w - 1; i++) {
      const x1 = xAt(i), x2 = xAt(i + 1);
      const y = yAt(0);
      const z1 = elevAt(i, 0), z2 = elevAt(i + 1, 0);
      pushQuad([x1, y, baseZ], [x2, y, baseZ], [x2, y, z2], [x1, y, z1]);
    }
    // South edge (j=h-1)
    for (let i = 0; i < w - 1; i++) {
      const x1 = xAt(i), x2 = xAt(i + 1);
      const y = yAt(h - 1);
      const z1 = elevAt(i, h - 1), z2 = elevAt(i + 1, h - 1);
      pushQuad([x1, y, z1], [x2, y, z2], [x2, y, baseZ], [x1, y, baseZ]);
    }
    // West edge (i=0)
    for (let j = 0; j < h - 1; j++) {
      const y1 = yAt(j), y2 = yAt(j + 1);
      const x = xAt(0);
      const z1 = elevAt(0, j), z2 = elevAt(0, j + 1);
      pushQuad([x, y1, z1], [x, y1, baseZ], [x, y2, baseZ], [x, y2, z2]);
    }
    // East edge (i=w-1)
    for (let j = 0; j < h - 1; j++) {
      const y1 = yAt(j), y2 = yAt(j + 1);
      const x = xAt(w - 1);
      const z1 = elevAt(w - 1, j), z2 = elevAt(w - 1, j + 1);
      pushQuad([x, y1, baseZ], [x, y1, z1], [x, y2, z2], [x, y2, baseZ]);
    }
    // Bottom cap (single quad)
    const xMin = xAt(0), xMax = xAt(w - 1);
    const yTop = yAt(0), yBot = yAt(h - 1);
    pushQuad([xMin, yTop, baseZ], [xMin, yBot, baseZ], [xMax, yBot, baseZ], [xMax, yTop, baseZ]);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    g.computeVertexNormals();
    return g;
  }, [terrain, exaggeration]);

  const skirtMaterial = useMemo(() => new THREE.MeshStandardMaterial({
    color: '#f5efe1', roughness: 0.95, metalness: 0, side: THREE.DoubleSide,
  }), []);

  return (
    <group rotation={[-Math.PI / 2, 0, 0]}>
      <mesh geometry={geometry} material={material} userData={{ terrainSurface: true }} />
      <mesh geometry={skirt} material={skirtMaterial} />
      {wireframe && (
        <mesh geometry={geometry}>
          <meshBasicMaterial color="#111827" wireframe transparent opacity={0.55} depthTest={false} />
        </mesh>
      )}
    </group>
  );
};

export default MapboxTerrainMesh;
