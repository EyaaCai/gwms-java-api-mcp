import { config } from './config.js';

export interface FetchedDocs {
  main: unknown;
  groups: Map<string, unknown>;
  errors: string[];
}

export async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(config.requestTimeoutMs),
    headers: { accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText}`);
  }
  return res.json();
}

export function groupUrl(name: string): string {
  return `${config.baseUrl}${config.apiDocsPath}/${encodeURIComponent(name)}`;
}

export async function fetchAllGroups(): Promise<FetchedDocs> {
  const settled = await Promise.allSettled(
    config.groupNames.map(async (name) => {
      const doc = await fetchJson(groupUrl(name));
      return [name, doc] as const;
    }),
  );

  const groups = new Map<string, unknown>();
  const errors: string[] = [];
  settled.forEach((result, i) => {
    const name = config.groupNames[i]!;
    if (result.status === 'fulfilled') {
      groups.set(result.value[0], result.value[1]);
    } else {
      const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
      errors.push(`${name}: ${reason}`);
    }
  });

  const main = groups.get(config.mainGroup);
  if (main === undefined) {
    throw new Error(`主分组「${config.mainGroup}」拉取失败 -> ${errors.join('; ') || '未知错误'}`);
  }
  return { main, groups, errors };
}
