/** Normalize backend search response into a flat item array */
export function normalizeConversationSearchItems(payload: {
  results?: Array<Record<string, unknown>>;
}): Array<Record<string, unknown>>;

/** Filter items by title/snippet matching (case-insensitive) */
export function filterConversationSearchItems(
  data: { items: Array<Record<string, unknown>> },
  query: string,
): Array<Record<string, unknown>>;

/** Merge backend results with local fallback, deduping by id */
export function mergeConversationSearchItems(
  backend: Array<Record<string, unknown>>,
  ...fallbacks: Array<Array<Record<string, unknown>>>
): Array<Record<string, unknown>>;
