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

function requireEnv(name: string): string {
  const raw = process.env[name]?.trim();
  if (raw) return raw;
  throw new Error(
    `缺少必填配置 ${name}（接口文档服务地址）。\n` +
      `  方式一：在 ${envFileHint} 中设置，如 ${name}=http://<文档服务地址>\n` +
      `  方式二：在 MCP 客户端配置的 env 中传入 ${name}\n` +
      `  可参考项目根目录的 .env.example`,
  );
}

export const config = {
  baseUrl: requireEnv('GWMS_DOC_BASE_URL').replace(/\/+$/, ''),
  apiDocsPath: process.env.GWMS_API_DOCS_PATH?.trim() || '/v3/api-docs',
  cacheDir: process.env.GWMS_CACHE_DIR?.trim() || path.join(projectRoot, '.cache'),
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
