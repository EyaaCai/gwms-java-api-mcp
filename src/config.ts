import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

// 真实环境变量优先，其次项目根目录的 .env（可用 GWMS_ENV_FILE 指向别处）
function applyEnvFile(): string | null {
  const file = process.env.GWMS_ENV_FILE?.trim() || path.join(projectRoot, '.env');
  if (!fs.existsSync(file)) return null;
  if (typeof process.loadEnvFile === 'function') {
    process.loadEnvFile(file);
  } else {
    for (const [key, value] of Object.entries(parseEnvFile(fs.readFileSync(file, 'utf8')))) {
      if (process.env[key] === undefined) process.env[key] = value;
    }
  }
  return file;
}

const envFile = applyEnvFile();
const envFileHint = envFile ?? path.join(projectRoot, '.env');

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// 环境名（如 dev / test）：设置后工具名会带前缀、缓存目录按环境隔离
const envName = (process.env.GWMS_ENV_NAME?.trim() || '').toLowerCase().replace(/[^a-z0-9_-]/g, '');

// 环境专属变量优先（GWMS_DOC_BASE_URL_DEV），其次通用变量（GWMS_DOC_BASE_URL）
function resolveBaseUrl(): string {
  if (envName) {
    const scoped = process.env[`GWMS_DOC_BASE_URL_${envName.toUpperCase()}`]?.trim();
    if (scoped) return scoped.replace(/\/+$/, '');
  }
  const generic = process.env.GWMS_DOC_BASE_URL?.trim();
  if (generic) return generic.replace(/\/+$/, '');
  const scopedVars = Object.keys(process.env).filter((k) => /^GWMS_DOC_BASE_URL_.+$/.test(k));
  throw new Error(
    `缺少文档服务地址配置，请设置以下任一项：\n` +
      `  - GWMS_DOC_BASE_URL（通用）\n` +
      (envName ? `  - GWMS_DOC_BASE_URL_${envName.toUpperCase()}（${envName} 环境专用，优先于通用项）\n` : '') +
      (scopedVars.length
        ? `检测到环境专属地址变量 ${scopedVars.join(' / ')}，请在 MCP 客户端配置里用 GWMS_ENV_NAME 指定使用哪个环境（如 GWMS_ENV_NAME=dev）\n`
        : '') +
      `可在 ${envFileHint} 中配置，或在 MCP 客户端配置的 env 中传入（参考 .env.example）。`,
  );
}

export const config = {
  envName,
  baseUrl: resolveBaseUrl(),
  apiDocsPath: process.env.GWMS_API_DOCS_PATH?.trim() || '/v3/api-docs',
  cacheDir:
    process.env.GWMS_CACHE_DIR?.trim() ||
    (envName ? path.join(projectRoot, '.cache', envName) : path.join(projectRoot, '.cache')),
  ttlMs: envInt('GWMS_CACHE_TTL_MS', 6 * 60 * 60 * 1000),
  requestTimeoutMs: envInt('GWMS_REQUEST_TIMEOUT_MS', 60 * 1000),
  mainGroup: '所有',
  groupNames: ['Pda端', '仓库端', '商家端', '所有'],
  maxSchemaDepth: envInt('GWMS_MAX_SCHEMA_DEPTH', 8),
  envFile,
};

export type Config = typeof config;

export function fmtTtl(ms: number): string {
  if (ms < 60000) return `${Math.round(ms / 1000)} 秒`;
  if (ms < 3600000) return `${Math.round(ms / 60000)} 分钟`;
  const hours = ms / 3600000;
  return `${Number.isInteger(hours) ? hours : hours.toFixed(1)} 小时`;
}
