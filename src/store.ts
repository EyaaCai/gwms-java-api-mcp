import { config } from './config.js';
import { fetchAllGroups } from './fetch.js';
import { readCache, writeCache, isFresh, type CacheMeta } from './cache.js';

export type TagKind = 'feature' | 'tapd' | 'date' | 'other';

export interface OpRecord {
  method: string;
  path: string;
  summary: string;
  operationId: string;
  tags: string[];
  groups: string[];
  deprecated: boolean;
  raw: any;
}

export interface EndpointItem {
  path: string;
  methods: string[];
  summary: string;
  operationId: string;
  tags: string[];
  groups: string[];
  deprecated: boolean;
  records: OpRecord[];
}

export interface TagStat {
  name: string;
  count: number;
  kind: TagKind;
}

export interface StoreData {
  endpoints: EndpointItem[];
  byPath: Map<string, EndpointItem[]>;
  tagStats: TagStat[];
  tagKind: Map<string, TagKind>;
  securitySchemes: Array<{ header: string; description: string }>;
  components: Record<string, any>;
  opCount: number;
  meta: CacheMeta;
  stale: boolean;
  staleReason?: string;
}

const HTTP_METHODS = new Set(['get', 'post', 'put', 'delete', 'patch', 'head', 'options', 'trace']);
const FETCH_BACKOFF_MS = 60_000;

export function classifyTag(name: string): TagKind {
  if (/^\d{4,}$/.test(name) || /^[vf]\d{4,}$/i.test(name)) return 'tapd';
  if (/^\d{4}-\d{2}-\d{2}/.test(name)) return 'date';
  if (/[\u4e00-\u9fa5]/.test(name)) return 'feature';
  return 'other';
}

function parseOps(doc: any, groupsMap: Record<string, string[]>): OpRecord[] {
  const ops: OpRecord[] = [];
  const paths = (doc && doc.paths) || {};
  for (const [p, pathItem] of Object.entries<any>(paths)) {
    if (!pathItem || typeof pathItem !== 'object') continue;
    const pathLevelParams = Array.isArray(pathItem.parameters) ? pathItem.parameters : [];
    for (const [m, op] of Object.entries<any>(pathItem)) {
      if (!HTTP_METHODS.has(m.toLowerCase()) || !op || typeof op !== 'object') continue;
      const method = m.toUpperCase();
      const raw =
        pathLevelParams.length > 0
          ? {
              ...op,
              parameters: [...pathLevelParams, ...(Array.isArray(op.parameters) ? op.parameters : [])],
            }
          : op;
      ops.push({
        method,
        path: p,
        summary: op.summary || op.description || '',
        operationId: op.operationId || '',
        tags: (Array.isArray(op.tags) ? op.tags : []).filter((t: unknown) => typeof t === 'string' && t),
        groups: groupsMap[`${method} ${p}`] ?? [],
        deprecated: op.deprecated === true,
        raw,
      });
    }
  }
  return ops;
}

function buildGroupsMap(groups: Map<string, unknown>): Record<string, string[]> {
  const map: Record<string, string[]> = {};
  for (const name of config.groupNames) {
    if (name === config.mainGroup) continue;
    const doc = groups.get(name) as any;
    const paths = (doc && doc.paths) || {};
    for (const [p, pathItem] of Object.entries<any>(paths)) {
      if (!pathItem || typeof pathItem !== 'object') continue;
      for (const m of Object.keys(pathItem)) {
        if (!HTTP_METHODS.has(m.toLowerCase())) continue;
        const key = `${m.toUpperCase()} ${p}`;
        (map[key] ??= []).push(name);
      }
    }
  }
  for (const key of Object.keys(map)) map[key]!.sort();
  return map;
}

function buildEndpoints(ops: OpRecord[]): EndpointItem[] {
  const map = new Map<string, EndpointItem>();
  for (const op of ops) {
    const key = `${op.path}\u0000${op.summary}`;
    let item = map.get(key);
    if (!item) {
      item = {
        path: op.path,
        methods: [],
        summary: op.summary,
        operationId: op.operationId,
        tags: [],
        groups: [],
        deprecated: op.deprecated,
        records: [],
      };
      map.set(key, item);
    }
    item.methods.push(op.method);
    item.records.push(op);
    for (const t of op.tags) if (!item.tags.includes(t)) item.tags.push(t);
    for (const g of op.groups) if (!item.groups.includes(g)) item.groups.push(g);
    item.deprecated = item.deprecated && op.deprecated;
  }
  for (const item of map.values()) item.methods.sort();
  return [...map.values()];
}

function buildTagStats(ops: OpRecord[]): TagStat[] {
  const counts = new Map<string, number>();
  for (const op of ops) {
    for (const t of op.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count, kind: classifyTag(name) }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

function buildMeta(main: any, groups: Map<string, unknown>, fetchErrors: string[]): CacheMeta {
  const groupOpCounts: Record<string, number> = {};
  for (const [name, doc] of groups) {
    let n = 0;
    const paths = (doc as any)?.paths || {};
    for (const pathItem of Object.values<any>(paths)) {
      for (const m of Object.keys(pathItem ?? {})) if (HTTP_METHODS.has(m.toLowerCase())) n++;
    }
    groupOpCounts[name] = n;
  }
  let opCount = 0;
  for (const pathItem of Object.values<any>(main?.paths || {})) {
    for (const m of Object.keys(pathItem ?? {})) if (HTTP_METHODS.has(m.toLowerCase())) opCount++;
  }
  return {
    fetchedAt: Date.now(),
    baseUrl: config.baseUrl,
    docPath: config.apiDocsPath,
    opCount,
    groupOpCounts,
    fetchErrors,
  };
}

function buildStore(
  main: any,
  groupsMap: Record<string, string[]>,
  meta: CacheMeta,
  stale: boolean,
): StoreData {
  const ops = parseOps(main, groupsMap);
  const endpoints = buildEndpoints(ops);
  const tagStats = buildTagStats(ops);
  const byPath = new Map<string, EndpointItem[]>();
  for (const item of endpoints) {
    let list = byPath.get(item.path);
    if (!list) {
      list = [];
      byPath.set(item.path, list);
    }
    list.push(item);
  }
  const schemes = (main && main.components && main.components.securitySchemes) || {};
  const securitySchemes = Object.entries<any>(schemes).map(([key, s]) => ({
    header: s?.name ?? key,
    description: s?.description ?? '',
  }));
  return {
    endpoints,
    byPath,
    tagStats,
    tagKind: new Map(tagStats.map((t) => [t.name, t.kind])),
    securitySchemes,
    components: (main && main.components && main.components.schemas) || {},
    opCount: ops.length,
    meta,
    stale,
  };
}

let current: StoreData | null = null;
let inflight: Promise<StoreData> | null = null;
let lastFailureAt = 0;

async function fetchAndBuild(): Promise<StoreData> {
  const started = Date.now();
  const { main, groups, errors } = await fetchAllGroups();
  const groupsMap = buildGroupsMap(groups);
  const meta = buildMeta(main, groups, errors);
  writeCache(main, groupsMap, meta);
  const store = buildStore(main, groupsMap, meta, false);
  console.error(
    `[gwms-mcp] 文档已刷新: 接口 ${store.opCount} 个，耗时 ${Date.now() - started}ms${errors.length ? `，部分分组失败: ${errors.join('; ')}` : ''}`,
  );
  return store;
}

function fallbackToCache(reason: string): StoreData {
  const cached = readCache();
  if (!cached) throw new Error(`接口文档拉取失败且无本地缓存: ${reason}`);
  if (cached.meta.baseUrl !== config.baseUrl || cached.meta.docPath !== config.apiDocsPath) {
    throw new Error(
      `接口文档拉取失败，且本地缓存属于其他环境（缓存地址 ${cached.meta.baseUrl}，当前配置 ${config.baseUrl}）: ${reason}`,
    );
  }
  const store = buildStore(cached.main, cached.groupsMap, cached.meta, true);
  store.staleReason = reason;
  return store;
}

export async function ensureStore(force = false): Promise<StoreData> {
  if (!force && current && isFresh(current.meta)) return current;

  if (!force) {
    const cached = readCache();
    if (cached && isFresh(cached.meta)) {
      current = buildStore(cached.main, cached.groupsMap, cached.meta, false);
      return current;
    }
    if (inflight) return inflight;
    if (lastFailureAt > 0 && Date.now() - lastFailureAt < FETCH_BACKOFF_MS) {
      const waitSec = Math.ceil((FETCH_BACKOFF_MS - (Date.now() - lastFailureAt)) / 1000);
      if (!current) current = fallbackToCache(`上次拉取失败，${waitSec} 秒内不再重试`);
      return current;
    }
  }

  inflight = (async () => {
    try {
      const store = await fetchAndBuild();
      lastFailureAt = 0;
      current = store;
      return store;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      lastFailureAt = Date.now();
      const store = fallbackToCache(reason);
      current = store;
      console.error(`[gwms-mcp] 拉取失败，回退到本地缓存(${new Date(store.meta.fetchedAt).toLocaleString()}): ${reason}`);
      return store;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

export interface SearchOptions {
  keyword?: string;
  group?: string;
  tag?: string;
  method?: string;
  limit: number;
  offset: number;
}

export interface SearchResult {
  total: number;
  items: EndpointItem[];
  relaxed: boolean;
}

function scoreTerm(item: EndpointItem, term: string): number {
  const p = item.path.toLowerCase();
  const opId = item.operationId.toLowerCase();
  let s = 0;
  if (p.includes(term)) s = Math.max(s, p.endsWith(`/${term}`) ? 120 : 90);
  if (opId.includes(term)) s = Math.max(s, 80);
  if (item.summary.toLowerCase().includes(term)) s = Math.max(s, 60);
  if (item.tags.some((t) => t.toLowerCase().includes(term))) s = Math.max(s, 40);
  return s;
}

function scoreAll(item: EndpointItem, terms: string[]): number {
  let total = 0;
  for (const term of terms) {
    const s = scoreTerm(item, term);
    if (s === 0) return 0;
    total += s;
  }
  return total;
}

function scoreAny(item: EndpointItem, terms: string[]): number {
  let best = 0;
  for (const term of terms) {
    const s = scoreTerm(item, term);
    if (s > best) best = s;
  }
  return best;
}

// 中文长词（"查询库存"）很难整串命中，拆成 2-gram 片段做兜底匹配
function relaxTerms(terms: string[]): { terms: string[]; changed: boolean } {
  const out = new Set<string>();
  let changed = false;
  for (const t of terms) {
    if (/^[\u4e00-\u9fa5]{3,}$/.test(t)) {
      changed = true;
      for (let i = 0; i + 2 <= t.length; i++) out.add(t.slice(i, i + 2));
    } else {
      out.add(t);
    }
  }
  return { terms: [...out], changed };
}

export function searchEndpoints(store: StoreData, opts: SearchOptions): SearchResult {
  const terms = (opts.keyword ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  const group = opts.group?.trim().toLowerCase();
  const tag = opts.tag?.trim().toLowerCase();
  const method = opts.method?.trim().toUpperCase();
  const ignoreGroup = !group || group === config.mainGroup.toLowerCase();

  const collect = (scoreFn: (item: EndpointItem) => number): Array<{ item: EndpointItem; score: number }> => {
    const matched: Array<{ item: EndpointItem; score: number }> = [];
    for (const item of store.endpoints) {
      if (!ignoreGroup && !item.groups.some((g) => g.toLowerCase() === group)) continue;
      if (tag && !item.tags.some((t) => t.toLowerCase().includes(tag))) continue;
      if (method && !item.methods.includes(method)) continue;
      const score = terms.length ? scoreFn(item) : 0;
      if (terms.length && score === 0) continue;
      matched.push({ item, score });
    }
    matched.sort(
      (a, b) => b.score - a.score || a.item.path.localeCompare(b.item.path) || a.item.summary.localeCompare(b.item.summary),
    );
    return matched;
  };

  let matched = collect((item) => scoreAll(item, terms));
  let relaxed = false;
  if (!matched.length && terms.length) {
    const relaxedTerms = relaxTerms(terms);
    if (relaxedTerms.changed) {
      matched = collect((item) => scoreAny(item, relaxedTerms.terms));
      relaxed = matched.length > 0;
    }
  }

  const total = matched.length;
  const items = matched.slice(opts.offset, opts.offset + opts.limit).map((m) => m.item);
  return { total, items, relaxed };
}

export function findEndpointsByPath(store: StoreData, path: string): EndpointItem[] {
  const trimmed = path.trim().replace(/\/+$/, '');
  const exact = store.byPath.get(trimmed);
  if (exact) return exact;
  const lower = trimmed.toLowerCase();
  return store.endpoints.filter((e) => e.path.toLowerCase() === lower);
}

export function listTags(store: StoreData, kind?: TagKind, keyword?: string): TagStat[] {
  const kw = keyword?.trim().toLowerCase();
  return store.tagStats.filter(
    (t) => (!kind || t.kind === kind) && (!kw || t.name.toLowerCase().includes(kw)),
  );
}
