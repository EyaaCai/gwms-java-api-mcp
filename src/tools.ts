import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { config, fmtTtl } from './config.js';
import {
  ensureStore,
  findEndpointsByPath,
  listTags,
  searchEndpoints,
  type EndpointItem,
  type StoreData,
  type TagKind,
} from './store.js';
import { renderOperation } from './schema.js';

const KIND_LABELS: Record<TagKind, string> = {
  feature: '功能标签',
  tapd: 'TAPD 需求标签',
  date: '日期标签',
  other: '其他标签',
};

function fmtTime(ms: number): string {
  return new Date(ms).toLocaleString('zh-CN', { hour12: false });
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function fail(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true };
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function dataSource(store: StoreData): string {
  return `${store.meta.baseUrl}${store.meta.docPath}/${config.mainGroup}`;
}

function staleNotice(store: StoreData): string {
  if (!store.stale) return '';
  return `[注意] 缓存已过期且刷新失败，以下为 ${fmtTime(store.meta.fetchedAt)} 的旧数据。原因: ${store.staleReason ?? '未知'}\n\n`;
}

function groupSummary(store: StoreData): string {
  return config.groupNames.map((n) => `${n} ${store.meta.groupOpCounts[n] ?? 0}`).join(' | ');
}

function formatEndpoint(idx: number, item: EndpointItem): string {
  const lines = [`${idx}. ${item.methods.join('|')} ${item.path} — ${item.summary || '(无摘要)'}`];
  const meta: string[] = [];
  if (item.tags.length) meta.push(`tags: ${item.tags.join(', ')}`);
  meta.push(`分组: ${item.groups.length ? item.groups.join('/') : '未分端'}`);
  if (item.deprecated) meta.push('已废弃');
  lines.push(`   ${meta.join(' | ')}`);
  return lines.join('\n');
}

export function registerTools(server: McpServer): void {
  server.registerTool(
    'gwms_doc_overview',
    {
      title: 'GWMS 接口文档概览',
      description:
        '获取 GWMS Java 接口文档的全景信息：数据源、缓存时间、接口总数、顶层分组（Pda端/仓库端/商家端/所有）统计，以及全部标签分类列表。标签分四类：' +
        'feature=功能模块标签（如"备货单管理"）、tapd=TAPD 需求标签（纯数字或 v/f 前缀，如"1082335"，每次需求改动接口会打上该标签）、' +
        'date=日期标签、other=其他。当需要了解文档结构、查找功能模块或 TAPD 需求号、确认数据新鲜度时使用。',
      inputSchema: {
        kind: z
          .enum(['feature', 'tapd', 'date', 'other', 'all'])
          .optional()
          .describe('标签类别过滤，默认 all'),
        keyword: z.string().optional().describe('按标签名过滤，子串匹配，如 "库存" 或 "108"'),
        limit: z.number().int().min(1).max(500).optional().describe('每类标签最多返回数量，默认 30'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ kind, keyword, limit }) => {
      try {
        const store = await ensureStore();
        const maxPerKind = limit ?? 30;
        const kindFilter = kind && kind !== 'all' ? (kind as TagKind) : undefined;
        const kinds: TagKind[] = kindFilter ? [kindFilter] : ['feature', 'tapd', 'date', 'other'];

        const counts = new Map<TagKind, number>();
        for (const t of store.tagStats) counts.set(t.kind, (counts.get(t.kind) ?? 0) + 1);

        const head = [
          '# GWMS 接口文档概览',
          '',
          `- 数据源: ${dataSource(store)}`,
          `- 缓存时间: ${fmtTime(store.meta.fetchedAt)}（TTL ${fmtTtl(config.ttlMs)}，过期自动刷新）`,
          `- 接口总数: ${store.opCount} 个（路径 ${store.endpoints.length} 条）`,
          `- 顶层分组: ${groupSummary(store)}`,
          `- 标签总数: ${store.tagStats.length}（${(['feature', 'tapd', 'date', 'other'] as TagKind[])
            .map((k) => `${KIND_LABELS[k]} ${counts.get(k) ?? 0}`)
            .join(' / ')}）`,
        ];
        if (store.meta.fetchErrors.length) {
          head.push(
            `- [注意] 部分端分组拉取失败，相关接口的"分组"标注可能缺失: ${store.meta.fetchErrors.join('; ')}`,
          );
        }

        const sections: string[] = [];
        for (const k of kinds) {
          let tags = listTags(store, k, keyword);
          if (k === 'tapd') {
            tags = [...tags].sort(
              (a, b) => Number(b.name.replace(/\D/g, '')) - Number(a.name.replace(/\D/g, '')),
            );
          }
          const shown = tags.slice(0, maxPerKind);
          const title =
            k === 'tapd'
              ? `## ${KIND_LABELS[k]}（显示 ${shown.length} / 共 ${tags.length}，按需求号从新到旧）`
              : `## ${KIND_LABELS[k]}（显示 ${shown.length} / 共 ${tags.length}）`;
          const body = shown.length
            ? shown.map((t) => `- ${t.name} (${t.count})`).join('\n')
            : '- （无匹配）';
          sections.push(`${title}\n${body}`);
        }

        const tips = [
          '',
          '用法提示：',
          '- 用 gwms_search_apis 按关键词搜索接口',
          '- 用 gwms_list_tapd_apis 查看某个 TAPD 需求改动的接口清单',
          '- 用 gwms_api_detail 查看接口的完整出入参定义',
        ];

        return ok([...head, '', ...sections.flatMap((s) => [s, '']), ...tips].join('\n'));
      } catch (err) {
        return fail(`获取文档概览失败: ${errText(err)}`);
      }
    },
  );

  server.registerTool(
    'gwms_search_apis',
    {
      title: '搜索 GWMS 接口',
      description:
        '按关键词搜索 GWMS 接口，关键词会同时匹配接口路径、中文摘要、operationId 和标签名，多个关键词用空格分隔（全部命中才算匹配）。' +
        '结果已按接口去重（同一接口挂多个标签只显示一条，标签全部列出）。返回精简列表，含 method、path、摘要、标签、所属端；' +
        '再用 gwms_api_detail 查完整定义。',
      inputSchema: {
        keyword: z.string().describe('搜索关键词，如 "备货单 分页" 或 "warehouse_stock_order" 或 "库存"'),
        group: z
          .string()
          .optional()
          .describe('限定端分组，可选值: Pda端 / 仓库端 / 商家端；不传则在全部接口中搜索'),
        tag: z.string().optional().describe('限定标签（子串匹配），如 "备货单管理" 或 "1082335"'),
        method: z.enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH']).optional().describe('限定 HTTP 方法'),
        limit: z.number().int().min(1).max(100).optional().describe('返回条数上限，默认 20'),
        offset: z.number().int().min(0).optional().describe('分页偏移，默认 0'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ keyword, group, tag, method, limit, offset }) => {
      try {
        const store = await ensureStore();
        const limitN = limit ?? 20;
        const offsetN = offset ?? 0;
        const keywordText = keyword.trim();
        let groupFilter: string | undefined;
        let groupWarn = '';
        if (group?.trim()) {
          const wanted = group.trim();
          groupFilter = config.groupNames.find((g) => g.toLowerCase() === wanted.toLowerCase());
          if (!groupFilter) {
            groupWarn = `[注意] 未知分组 "${wanted}"，已忽略该过滤条件。可用分组: ${config.groupNames.join(' / ')}\n\n`;
          }
        }

        const { total, items, relaxed } = searchEndpoints(store, {
          keyword: keywordText,
          group: groupFilter,
          tag,
          method,
          limit: limitN,
          offset: offsetN,
        });

        if (total === 0) {
          return ok(
            `${staleNotice(store)}未找到匹配的接口。\n\n` +
              `搜索条件: 关键词="${keywordText}"${groupFilter ? `，分组=${groupFilter}` : ''}${tag ? `，标签=${tag}` : ''}${method ? `，方法=${method}` : ''}\n\n` +
              '建议:\n' +
              '- 换更短的关键词（如 "库存" 而不是 "库存查询接口"）\n' +
              '- 用 gwms_doc_overview 查看所有功能标签和 TAPD 标签名\n' +
              '- 用 gwms_list_tapd_apis 按 TAPD 需求号查询',
          );
        }

        if (items.length === 0) {
          return ok(
            `${staleNotice(store)}关键词「${keywordText}」匹配 ${total} 个接口，但 offset=${offsetN} 已超出范围（有效范围 0-${total - 1}）。`,
          );
        }

        const relaxNote = relaxed
          ? `[注意] 没有与「${keywordText}」整串匹配的接口，已按中文片段放宽匹配，结果可能不完全相关。\n\n`
          : '';
        const label = keywordText ? `搜索「${keywordText}」` : '列出接口';
        const start = offsetN + 1;
        const end = offsetN + items.length;
        const head = `${staleNotice(store)}${groupWarn}${relaxNote}${label}：匹配 ${total} 个接口（文档共 ${store.opCount} 个），显示第 ${start}-${end} 条\n`;
        const list = items.map((item, i) => formatEndpoint(offsetN + i + 1, item)).join('\n\n');
        const more =
          end < total ? `\n\n还有 ${total - end} 条未显示，可用 offset=${end} 继续查看。` : '';
        return ok(`${head}\n${list}${more}`);
      } catch (err) {
        return fail(`搜索失败: ${errText(err)}`);
      }
    },
  );

  server.registerTool(
    'gwms_list_tapd_apis',
    {
      title: '按 TAPD 需求查询改动接口',
      description:
        '查询某个 TAPD 需求（或迭代）改动的接口清单：接口在每次 TAPD 需求中被改动时会打上以需求号命名的标签（如 "1082335"、"v1077548"、"f1098971"），' +
        '本工具列出该标签下的全部接口。不传 tapd_id 时列出所有 TAPD 标签（按需求号从新到旧）。' +
        '结果已去重（接口同时挂在功能标签下不会重复出现），并附带每个接口的功能模块标签。',
      inputSchema: {
        tapd_id: z
          .string()
          .optional()
          .describe('TAPD 需求号，如 "1082335" / "v1077548" / "f1098971"；不传则列出所有 TAPD 标签'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(500)
          .optional()
          .describe('tapd_id 为空时，最多列出多少个 TAPD 标签，默认 50'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ tapd_id, limit }) => {
      try {
        const store = await ensureStore();
        const tapdTags = store.tagStats.filter((t) => t.kind === 'tapd');

        if (!tapd_id) {
          const sorted = [...tapdTags].sort(
            (a, b) => Number(b.name.replace(/\D/g, '')) - Number(a.name.replace(/\D/g, '')),
          );
          const shown = sorted.slice(0, limit ?? 50);
          const lines = shown.map((t) => `- ${t.name} (${t.count} 个接口)`).join('\n');
          return ok(
            `${staleNotice(store)}TAPD 需求标签共 ${sorted.length} 个（显示 ${shown.length} 个，按需求号从新到旧）：\n\n${lines}\n\n` +
              '传入 tapd_id 可查看某个需求改动的接口清单。',
          );
        }

        const id = tapd_id.trim().toLowerCase();
        const tag = tapdTags.find((t) => t.name.toLowerCase() === id) ?? tapdTags.find((t) => t.name.toLowerCase().includes(id));
        if (!tag) {
          const near = tapdTags
            .filter((t) => t.name.toLowerCase().includes(id.slice(0, 4)))
            .slice(0, 10)
            .map((t) => t.name);
          return ok(
            `${staleNotice(store)}未找到 TAPD 标签 "${tapd_id}"。\n` +
              (near.length ? `相近的标签: ${near.join(', ')}\n` : '') +
              '可用 gwms_list_tapd_apis（不传参数）查看全部 TAPD 标签。',
          );
        }

        const { total, items } = searchEndpoints(store, {
          tag: tag.name,
          limit: store.endpoints.length,
          offset: 0,
        });

        const list = items
          .map((item, i) => {
            const otherTags = item.tags.filter((t) => t !== tag.name);
            const lines = [`${i + 1}. ${item.methods.join('|')} ${item.path} — ${item.summary || '(无摘要)'}`];
            const meta: string[] = [];
            if (otherTags.length) meta.push(`其他标签: ${otherTags.join(', ')}`);
            meta.push(`分组: ${item.groups.length ? item.groups.join('/') : '未分端'}`);
            lines.push(`   ${meta.join(' | ')}`);
            return lines.join('\n');
          })
          .join('\n\n');

        return ok(
          `${staleNotice(store)}TAPD ${tag.name} 改动的接口（${total} 个，已按接口去重，同一接口挂在功能标签下不会重复）：\n\n${list}`,
        );
      } catch (err) {
        return fail(`查询 TAPD 接口失败: ${errText(err)}`);
      }
    },
  );

  server.registerTool(
    'gwms_api_detail',
    {
      title: '查看 GWMS 接口详情',
      description:
        '查看单个接口的完整定义：请求参数、请求体（$ref 数据模型已递归展开并标注模型名）、响应结构、鉴权要求、所属标签与分组。' +
        'path 从 gwms_search_apis 或 gwms_list_tapd_apis 的结果中获取（需含前导 / 的完整路径）。' +
        '若同一路径同时支持 GET 和 POST，可用 method 指定，默认返回第一个。',
      inputSchema: {
        path: z.string().describe('接口路径，如 /api/j/customer/warehouse/warehouse_stock_order/addWarehouseStockOrder'),
        method: z
          .enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH'])
          .optional()
          .describe('HTTP 方法；路径同时支持多种方法时用于指定'),
        schemaDepth: z
          .number()
          .int()
          .min(1)
          .max(20)
          .optional()
          .describe('数据模型($ref)最大展开层级，默认 8；输出过大时可调小（如 3）'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ path, method, schemaDepth }) => {
      try {
        const store = await ensureStore();
        const items = findEndpointsByPath(store, path.trim());
        if (!items.length) {
          return fail(
            `未找到接口: ${path}\n\n` +
              '可能原因: 路径不完整或拼写错误（需含前导 /）。\n' +
              '建议用 gwms_search_apis 搜索关键词，或 gwms_list_tapd_apis 按需求号查找，获取准确路径。',
          );
        }

        let item = items[0]!;
        let record = item.records[0]!;
        if (method) {
          const m = method.toUpperCase();
          let found = false;
          for (const it of items) {
            for (const r of it.records) {
              if (r.method === m) {
                item = it;
                record = r;
                found = true;
                break;
              }
            }
            if (found) break;
          }
          if (!found) {
            return fail(
              `接口 ${path} 不支持 ${m} 方法，可用方法: ${items.flatMap((it) => it.methods).join(', ')}`,
            );
          }
        }

        const { parameters, requestBody, responses, authSchemes } = renderOperation(
          record.raw,
          store.components,
          schemaDepth ?? config.maxSchemaDepth,
        );
        const used = new Set(authSchemes);
        const schemes = store.securitySchemes.filter((s) => used.has(s.header));
        const otherMethods = items
          .filter((it) => it !== item)
          .flatMap((it) => it.methods.map((m) => `${m} (${it.summary})`));

        const detail: Record<string, unknown> = {
          path: item.path,
          method: record.method,
          availableMethods: item.methods,
          summary: item.summary,
          operationId: record.operationId,
          tags: item.tags,
          groups: item.groups.length ? item.groups : ['未分端'],
          deprecated: item.deprecated,
        };
        if (otherMethods.length) detail.samePathOtherSummaries = otherMethods;
        detail.auth =
          used.size === 0
            ? '无需登录态（匿名接口）'
            : { security: record.raw.security ?? [], schemes };
        detail.parameters = parameters;
        detail.requestBody = requestBody;
        detail.responses = responses;

        const json = JSON.stringify(detail, null, 1);
        const bigNotice =
          json.length > 40000
            ? `\n\n[提示] 该接口定义较大（${(json.length / 1024).toFixed(0)}KB）。如需更精简的输出，可传 schemaDepth=3 减少数据模型展开层级。`
            : '';
        return ok(`${staleNotice(store)}${json}${bigNotice}`);
      } catch (err) {
        return fail(`获取接口详情失败: ${errText(err)}`);
      }
    },
  );

  server.registerTool(
    'gwms_refresh_cache',
    {
      title: '刷新 GWMS 接口文档缓存',
      description:
        `强制重新拉取接口文档并刷新本地缓存。当后端接口有更新、缓存提示数据陈旧、或用户明确要求刷新时使用。` +
        `正常查询走本地缓存（默认 ${fmtTtl(config.ttlMs)} TTL），一般无需手动刷新。`,
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const start = Date.now();
      try {
        const store = await ensureStore(true);
        if (store.stale) {
          return fail(
            `刷新失败，仍在使用 ${fmtTime(store.meta.fetchedAt)} 的缓存数据。原因: ${store.staleReason ?? '未知'}`,
          );
        }
        const cost = ((Date.now() - start) / 1000).toFixed(1);
        const warn = store.meta.fetchErrors.length
          ? `\n- 部分分组拉取失败: ${store.meta.fetchErrors.join('; ')}`
          : '';
        return ok(
          `缓存已刷新\n- 数据源: ${dataSource(store)}\n- 耗时: ${cost}s\n- 接口总数: ${store.opCount} 个（路径 ${store.endpoints.length} 条）\n- 顶层分组: ${groupSummary(store)}${warn}`,
        );
      } catch (err) {
        return fail(`刷新缓存失败: ${errText(err)}`);
      }
    },
  );
}
