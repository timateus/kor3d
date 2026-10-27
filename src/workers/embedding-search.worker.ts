import { normalizeEmbeddings } from '../lib/satellite-embeddings';
import { searchEmbeddingIndex, unitReference, validateSearchManifest } from '../lib/embedding-search';

self.onmessage = (event: MessageEvent) => {
  const { manifest, buffer, reference, slug, bounds, threshold } = event.data;
  try {
    validateSearchManifest(manifest, event.data.year);
    if (buffer.byteLength !== manifest.count * 64) throw new Error('Search data has an unexpected size');
    const vector = unitReference(reference);
    if (!vector) throw new Error('Select a valid example first');
    const matches = searchEmbeddingIndex(manifest, normalizeEmbeddings(new Int8Array(buffer)), vector, slug, bounds, threshold);
    self.postMessage({ matches, locations: manifest.locations.filter((location: { slug: string }) => location.slug !== slug).length });
  } catch (cause) {
    self.postMessage({ error: cause instanceof Error ? cause.message : String(cause) });
  }
};
