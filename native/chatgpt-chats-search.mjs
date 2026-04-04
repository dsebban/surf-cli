function toEpochMs(value) {
  if (value == null || value === '') return 0;
  if (typeof value === 'number') {
    return Number.isFinite(value) ? (value > 1e12 ? value : value * 1000) : 0;
  }
  const parsed = Date.parse(String(value));
  return Number.isNaN(parsed) ? 0 : parsed;
}

export function normalizeSearchText(value) {
  return String(value || '').normalize('NFKC').toLowerCase().trim();
}

export function mapConversationSearchItem(item = {}) {
  const updateTime = item.update_time ?? item.updateTime ?? item.create_time ?? item.createTime ?? null;
  const createTime = item.create_time ?? item.createTime ?? updateTime ?? null;
  return {
    ...item,
    id: item.id || item.conversation_id || item.conversationId || null,
    conversation_id: item.conversation_id || item.id || item.conversationId || null,
    title: item.title || '(untitled)',
    create_time: createTime,
    update_time: updateTime,
    current_node_id: item.current_node_id || item.currentNodeId || null,
    snippet: item.snippet || item.payload?.snippet || null,
    is_archived: item.is_archived ?? false,
  };
}

export function normalizeConversationSearchItems(raw) {
  const source = Array.isArray(raw)
    ? raw
    : Array.isArray(raw?.items)
      ? raw.items
      : Array.isArray(raw?.results)
        ? raw.results
        : [];

  return source
    .filter(Boolean)
    .map((item) => mapConversationSearchItem(item))
    .filter((item) => item.id || item.conversation_id);
}

export function mergeConversationSearchItems(...groups) {
  const merged = new Map();
  for (const group of groups) {
    for (const item of group || []) {
      const mapped = mapConversationSearchItem(item);
      if (!mapped.id) continue;
      const prev = merged.get(mapped.id);
      if (!prev) {
        merged.set(mapped.id, mapped);
        continue;
      }
      const prevMs = toEpochMs(prev.update_time || prev.create_time);
      const nextMs = toEpochMs(mapped.update_time || mapped.create_time);
      const freshest = nextMs >= prevMs ? mapped : prev;
      const other = freshest === mapped ? prev : mapped;
      merged.set(mapped.id, {
        ...other,
        ...freshest,
        snippet: freshest.snippet || other.snippet || null,
        title: freshest.title || other.title || '(untitled)',
        create_time: freshest.create_time || other.create_time || null,
        update_time: freshest.update_time || other.update_time || null,
      });
    }
  }
  return Array.from(merged.values()).sort((a, b) => toEpochMs(b.update_time) - toEpochMs(a.update_time));
}

export function matchesConversationSearchQuery(item, query) {
  const needle = normalizeSearchText(query);
  if (!needle) return false;
  const haystacks = [item?.title, item?.snippet, item?.id].map(normalizeSearchText).filter(Boolean);
  return haystacks.some((value) => value.includes(needle));
}

export function filterConversationSearchItems(raw, query) {
  return normalizeConversationSearchItems(raw).filter((item) => matchesConversationSearchQuery(item, query));
}
