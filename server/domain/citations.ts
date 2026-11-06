// Citation validation. A citation asserts only that an exact quote exists in a
// named source document. It proves quote EXISTENCE, never entailment — a valid
// citation does not mean the quote supports any particular conclusion.

export class CitationError extends Error {
  code = "CITATION_INVALID";
  constructor(message: string, code?: string) {
    super(message);
    this.name = "CitationError";
    if (code) this.code = code;
  }
}

export interface SourceDoc {
  id: string;
  title: string;
  text: string;
}

export interface Citation {
  sourceId: string;
  quote: string;
  offset?: number;
}

export interface VerifiedCitation extends Citation {
  /** Character offset of the quote within the source text. */
  offset: number;
}

const MAX_QUOTE_LEN = 2000;

/**
 * Verify a single citation against the available sources.
 * Throws if the source is unknown or the quote is empty/absent.
 */
export function verifyCitation(
  citation: Citation,
  sources: SourceDoc[],
): VerifiedCitation {
  if (!citation || typeof citation.sourceId !== "string") {
    throw new CitationError("Citation is missing a source id.");
  }
  if (typeof citation.quote !== "string" || citation.quote.length === 0) {
    throw new CitationError("Citation quote must be a non-empty string.", "CITATION_EMPTY");
  }
  if (citation.quote.length > MAX_QUOTE_LEN) {
    throw new CitationError("Citation quote is too long.");
  }
  const source = sources.find((s) => s.id === citation.sourceId);
  if (!source) {
    throw new CitationError(
      `Citation references unknown source '${citation.sourceId}'.`,
      "CITATION_UNKNOWN_SOURCE",
    );
  }
  let offset = source.text.indexOf(citation.quote);
  if (citation.offset !== undefined) {
    if (!Number.isInteger(citation.offset) || citation.offset < 0 || source.text.slice(citation.offset, citation.offset + citation.quote.length) !== citation.quote) throw new CitationError('Quote offset does not match the original text.');
    offset = citation.offset;
  } else if (offset >= 0 && source.text.indexOf(citation.quote, offset + 1) >= 0) {
    throw new CitationError('Quote is ambiguous; provide its exact occurrence offset.', 'CITATION_AMBIGUOUS');
  }
  if (offset === -1) {
    throw new CitationError(
      "Citation quote was not found verbatim in the cited source.",
      "CITATION_NOT_FOUND",
    );
  }
  return { sourceId: citation.sourceId, quote: citation.quote, offset };
}

/**
 * Verify a list of citations. Exact duplicates (same source + quote) are
 * collapsed to a single verified entry. Any invalid citation rejects the set.
 */
export function verifyCitations(
  citations: Citation[],
  sources: SourceDoc[],
): VerifiedCitation[] {
  if (!Array.isArray(citations)) {
    throw new CitationError("Citations must be an array.");
  }
  const seen = new Set<string>();
  const out: VerifiedCitation[] = [];
  for (const c of citations) {
    const verified = verifyCitation(c, sources);
    const key = `${verified.sourceId}\u0000${verified.offset}\u0000${verified.quote}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(verified);
  }
  return out;
}
