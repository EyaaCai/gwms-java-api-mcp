import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

export interface CacheMeta {
  fetchedAt: number;
  baseUrl: string;
  docPath: string;
  opCount: number;
  groupOpCounts: Record<string, number>;
  fetchErrors: string[];
}

export interface CachedDocs {
  main: any;
  groupsMap: Record<string, string[]>;
  meta: CacheMeta;
}

const MAIN_FILE = 'api-docs.json';
const GROUPS_FILE = 'groups-map.json';
const META_FILE = 'meta.json';

function writeJsonAtomic(file: string, data: unknown): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
  fs.renameSync(tmp, file);
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

export function writeCache(main: unknown, groupsMap: Record<string, string[]>, meta: CacheMeta): void {
  fs.mkdirSync(config.cacheDir, { recursive: true });
  writeJsonAtomic(path.join(config.cacheDir, MAIN_FILE), main);
  writeJsonAtomic(path.join(config.cacheDir, GROUPS_FILE), groupsMap);
  writeJsonAtomic(path.join(config.cacheDir, META_FILE), meta);
}

export function readCache(): CachedDocs | null {
  const main = readJson<any>(path.join(config.cacheDir, MAIN_FILE));
  const meta = readJson<CacheMeta>(path.join(config.cacheDir, META_FILE));
  if (!main || !meta) return null;
  const groupsMap = readJson<Record<string, string[]>>(path.join(config.cacheDir, GROUPS_FILE)) ?? {};
  return { main, groupsMap, meta };
}

export function isFresh(meta: CacheMeta, now = Date.now()): boolean {
  return (
    now - meta.fetchedAt < config.ttlMs &&
    meta.baseUrl === config.baseUrl &&
    meta.docPath === config.apiDocsPath
  );
}
