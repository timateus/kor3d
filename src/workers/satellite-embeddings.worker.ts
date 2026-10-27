import { localEmbeddingDifference, colourLocalDifference, candidateShoreline } from '../lib/embedding-analysis';
import type { EmbeddingMetadata } from '../lib/satellite-embeddings';
import { normalizeEmbeddings, similarityScores, areaReference, embeddingChanges, embeddingOverview, type EmbeddingChangeStats } from '../lib/satellite-embeddings';

import { unitReference } from '../lib/embedding-search';

let metadata: EmbeddingMetadata | null = null;
let localCache: { key: string; values: Float32Array } | null = null;
let otherScores: Float32Array | null = null;
let vectors: Float32Array | null = null;
let comparison: Float32Array | null = null;
let changes: Float32Array | null = null;
let cachedSelection: number | null = null;
let cachedReference: Float32Array | null = null;
let sampleCount = 0;
let overview: Uint8ClampedArray | null = null;
let comparisonOverview: Uint8ClampedArray | null = null;
let scores: Float32Array | null = null;
self.onmessage = (event: MessageEvent) => {
  const { id, type, pixel, threshold, pixels, selectionId, view, externalReference, changeThreshold = 0.1 } = event.data;
  try {
    if (type === 'init') {
      metadata = event.data.metadata ?? null;
      localCache = null;
      otherScores = null;
      vectors = normalizeEmbeddings(new Int8Array(event.data.buffer));
      cachedSelection = null;
      cachedReference = null;
      scores = null;
      overview = null;
      comparison = null;
      comparisonOverview = null;
      changes = null;
      self.postMessage({ id, ready: true });
      return;
    }
    if (!vectors) throw new Error('Embeddings are not loaded');
    if (type === 'comparison-init') {
      comparison = normalizeEmbeddings(new Int8Array(event.data.buffer));
      changes = embeddingChanges(vectors, comparison);
      comparisonOverview = null;
      otherScores = null;
      self.postMessage({ id, ready: true });
      return;
    }
    if (type === 'compare') {
      if (!comparison || !changes) throw new Error('The comparison year is not loaded');
      const stats: EmbeddingChangeStats = { validPixels: 0, aboveThreshold: 0, meanChange: 0 };
      let rgba = new Uint8ClampedArray(changes.length * 4);
      for (let p = 0; p < changes.length; p++) {
        const change = changes[p];
        if (!Number.isFinite(change)) continue;
        stats.validPixels++;
        stats.meanChange += change;
        if (change < changeThreshold) continue;
        stats.aboveThreshold++;
        if (view === 'change') {
          const t = Math.max(0, Math.min(1, (change - changeThreshold) / 0.5));
          rgba.set([Math.round(255 - 40 * t), Math.round(210 - 175 * t), Math.round(90 + 20 * t), Math.round(100 + 155 * t)], p * 4);
        }
      }
      if (!stats.validPixels) throw new Error('No pixels have valid embeddings in both years');
      stats.meanChange /= stats.validPixels;
      let secondRgba: Uint8ClampedArray | undefined;
      if (view !== 'change') {
        overview ??= embeddingOverview(vectors);
        comparisonOverview ??= embeddingOverview(comparison);
        rgba = (view === 'comparison' ? comparisonOverview : overview).slice();
        if (view === 'swipe') secondRgba = comparisonOverview.slice();
      }
      const transfer: ArrayBuffer[] = [rgba.buffer as ArrayBuffer];
      if (secondRgba) transfer.push(secondRgba.buffer as ArrayBuffer);
      self.postMessage({ id, rgba, secondRgba, stats }, { transfer });
      return;
    }
    if (type === 'anomaly' || type === 'transition') {
      if (!metadata) throw new Error('Grid metadata is missing');
      const radius = event.data.radius ?? 1;
      const key = `${type}|${radius}`;
      if (localCache?.key !== key) localCache = { key, values: localEmbeddingDifference(vectors, metadata.width, metadata.height, radius, type) };
      const { rgba, stats } = colourLocalDifference(localCache.values, event.data.localThreshold ?? .05);
      self.postMessage({ id, rgba, localStats: stats }, { transfer: [rgba.buffer] });
      return;
    }
    if (type !== 'similarity' && type !== 'shoreline') {
      overview ??= embeddingOverview(vectors);
      const rgba = overview.slice();
      self.postMessage({ id, rgba }, { transfer: [rgba.buffer] });
      return;
    }
    const rgba = new Uint8ClampedArray(vectors.length / 64 * 4);
    const key = selectionId ?? pixel;
    if (cachedSelection !== key) {
      const area = pixels ? areaReference(vectors, pixels) : null;
      const pointReference = Number.isInteger(pixel) && pixel >= 0 && pixel * 64 + 64 <= vectors.length ? vectors.subarray(pixel * 64, pixel * 64 + 64) : null;
      cachedReference = externalReference ? unitReference(externalReference) : pixels ? area?.vector ?? null : pointReference ? unitReference(pointReference) : null;
      scores = cachedReference ? similarityScores(vectors, cachedReference) : null;
      otherScores = null;
      sampleCount = externalReference ? 0 : pixels ? (area?.count ?? 0) : (scores ? 1 : 0);
      cachedSelection = key;
    }
    if (!scores) throw new Error('No valid embedding in this selection. Choose another area or point.');
    if (type === 'shoreline') {
      if (!metadata) throw new Error('Grid metadata is missing');
      if (comparison && cachedReference && event.data.compareShoreline) otherScores ??= similarityScores(comparison, cachedReference);
      const result = candidateShoreline(scores, event.data.compareShoreline ? otherScores : null, metadata, threshold);
      self.postMessage({ id, rgba: result.rgba, shorelineStats: result.stats, edges: result.edges, sampleCount, reference: cachedReference },
        { transfer: [result.rgba.buffer, result.edges.buffer] });
      return;
    }
    for (let p = 0; p < scores.length; p++) {
      const score = scores[p];
      if (!Number.isFinite(score) || score < threshold) continue;
      const t = Math.max(0, Math.min(1, (score - threshold) / Math.max(0.001, 1 - threshold)));
      rgba.set([Math.round(45 + 210 * t), Math.round(160 + 70 * t), Math.round(180 - 135 * t), Math.round(90 + 165 * t)], p * 4);
    }
    self.postMessage({ id, rgba, sampleCount, reference: cachedReference }, { transfer: [rgba.buffer] });
  } catch (error) {
    self.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
};
