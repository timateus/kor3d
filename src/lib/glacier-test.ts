import type { TerrainData } from './geotiff-loader';

export const GLACIER_TEST_BASE = `${import.meta.env.BASE_URL}data/glacier-test/`;
export interface VelocityMeta {
  dates: string[];
  cells: { center: [number, number]; corners: [number, number][] }[];
  variables: Record<'speed' | 'speed_uncertainty' | 'data_gap_days', string>;
  spacingM: number;
}
export interface VelocityData extends VelocityMeta {
  speed: Float32Array;
  uncertainty: Float32Array;
  gap: Float32Array;
}
export interface Outline {
  type: 'Feature';
  geometry: { type: 'Polygon' | 'MultiPolygon'; coordinates: number[][][] | number[][][][] };
  properties: { src_date?: string; glac_name?: string; db_area?: number; anlys_id?: number; rgi_id?: string };
}
export interface GlacierManifest {
  elevationChange: { status: string; reason?: string; valuesFile?: string; start?: string; end?: string };
}
export interface GlacierTestData {
  velocity: VelocityData;
  terrain: TerrainData;
  outlines: Outline[];
  inventory: Outline[];
  manifest: GlacierManifest;
  change: Float32Array | null;
}
export async function checkedFetch(url: string, signal?: AbortSignal) {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`Could not load ${url.split('/').pop()} (${response.status})`);
  return response;
}
export async function loadGlacierTest(signal: AbortSignal): Promise<GlacierTestData> {
  const json = async (name: string) => (await checkedFetch(GLACIER_TEST_BASE + name, signal)).json();
  const bin = async (name: string) => new Float32Array(await (await checkedFetch(GLACIER_TEST_BASE + name, signal)).arrayBuffer());
  const [meta, terrainMeta, outlines, inventory, manifest] = await Promise.all([
    json('velocity.json') as Promise<VelocityMeta>, json('terrain.json'), json('outlines.json'),
    (await checkedFetch(`${import.meta.env.BASE_URL}data/locations/tuyuksu-glacier/all_glaciers.json`, signal)).json(),
    json('manifest.json') as Promise<GlacierManifest>,
  ]);
  const [speed, uncertainty, gap, elevations, change] = await Promise.all([
    bin(meta.variables.speed), bin(meta.variables.speed_uncertainty), bin(meta.variables.data_gap_days),
    bin(terrainMeta.valuesFile), manifest.elevationChange.status === 'ready' ? bin(manifest.elevationChange.valuesFile!) : null,
  ]);
  const size = meta.dates.length * meta.cells.length;
  if ([speed, uncertainty, gap].some(v => v.length !== size)) throw new Error('Velocity data dimensions do not match the metadata.');
  if (elevations.length !== terrainMeta.width * terrainMeta.height) throw new Error('Terrain data dimensions do not match the metadata.');
  return { velocity: { ...meta, speed, uncertainty, gap },
    terrain: { ...terrainMeta, elevations, noDataValue: null }, outlines: outlines.features,
    inventory: inventory.features, manifest, change };
}
export function validSpeed(data: VelocityData, frame: number, cell: number, maxGap: number) {
  const i = frame * data.cells.length + cell;
  return Number.isFinite(data.speed[i]) && data.speed[i] >= 0 && Number.isFinite(data.gap[i]) && data.gap[i] <= maxGap;
}
export function frameStats(data: VelocityData, frame: number, maxGap: number) {
  let sum = 0, count = 0;
  data.cells.forEach((_, cell) => {
    if (validSpeed(data, frame, cell, maxGap)) { sum += data.speed[frame * data.cells.length + cell]; count++; }
  });
  return { mean: count ? sum / count * 365.25 : null, count };
}
export function outlineRings(feature: Outline): number[][][] {
  return feature.geometry.type === 'Polygon' ? feature.geometry.coordinates as number[][][]
    : (feature.geometry.coordinates as number[][][][]).flat();
}
export function dateLabel(date: string) {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}
