import { formatEmbeddingMeters } from '@/lib/satellite-embeddings';
import type { EmbeddingSearch } from '@/hooks/useEmbeddingSearch';
import type { EmbeddingMatch } from '@/lib/embedding-search';

export default function EmbeddingSearchResults({ search, year, canSearch, onOpen }: {
  search: EmbeddingSearch; year: number; canSearch: boolean; onOpen: (match: EmbeddingMatch) => void;
}) {
  return <div className="space-y-2 border-t border-border pt-3">
    <button className="w-full rounded border border-border px-2 py-2 hover:bg-accent disabled:opacity-50" disabled={!canSearch || year !== 2025 || search.status === 'loading'} onClick={search.search}>
      {search.status === 'loading' ? 'Searching other locations…' : 'Find in other locations'}
    </button>
    <p className="text-[10px] text-muted-foreground">{year !== 2025 ? 'Cross-location search is available for 2025.' : 'Search Almaty, Gorny Gigant, Suaq, Balqash city and Lake Balqash. Patches are ~50–55 m in local scenes and ~5 km across the lake. The current scene and overlapping patches are excluded.'}</p>
    {search.error && <p role="alert" className="text-destructive">{search.error}</p>}
    {search.status === 'ready' && <>
      <p role="status">{search.matches.length ? `${search.matches.length} matches · ${search.locations} other locations searched` : 'No patches at this threshold. Lower similarity or choose another example.'}</p>
      {search.matches.map((match, index) => <button key={`${match.slug}-${index}`} className="flex w-full gap-2 rounded border border-border p-2 text-left hover:bg-accent" onClick={() => onOpen(match)} aria-label={`Explore match ${index + 1} in ${match.label}`}>
        <svg role="img" aria-label={`Embedding overview near ${match.lat.toFixed(4)}, ${match.lon.toFixed(4)}`} className="h-16 w-20 shrink-0 rounded bg-black/30" viewBox={`${match.sourceX - 24} ${match.sourceY - 18} 48 36`}>
          <image href={`${import.meta.env.BASE_URL}data/locations/${match.slug}/embeddings/${year}/preview.png`} width={match.sourceWidth} height={match.sourceHeight} />
          <circle cx={match.sourceX} cy={match.sourceY} r={2} fill="none" stroke="white" strokeWidth={0.6} />
        </svg>
        <span className="min-w-0 space-y-1"><span className="block font-semibold">{match.label}</span><span className="block">cos {match.score.toFixed(3)} · {formatEmbeddingMeters(match.patchMeters)} patch</span><span className="block text-[10px] text-muted-foreground">{match.lat.toFixed(4)}, {match.lon.toFixed(4)} · explore →</span></span>
      </button>)}
      {search.matches.length > 0 && <p className="text-[10px] text-muted-foreground">Previews show embedding colours. Similarity does not establish a land-cover class.</p>}
    </>}
  </div>;
}
