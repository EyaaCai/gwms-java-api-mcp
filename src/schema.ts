import { config } from './config.js';

function refName(ref: string): string {
  const parts = ref.split('/');
  return parts[parts.length - 1] ?? ref;
}

export function renderSchema(
  schema: any,
  components: Record<string, any>,
  maxDepth: number = config.maxSchemaDepth,
  depth = 0,
  seen: string[] = [],
  expanded?: Set<string>,
): any {
  if (schema == null || typeof schema !== 'object') return schema ?? null;
  if (Array.isArray(schema)) return schema.map((s) => renderSchema(s, components, maxDepth, depth, seen, expanded));

  if (typeof schema.$ref === 'string') {
    const name = refName(schema.$ref);
    const target = components[name];
    if (!target) return { $ref: name, note: '未找到该模型定义' };
    if (seen.includes(name)) return { $ref: name, note: '循环引用，已省略' };
    if (depth >= maxDepth) {
      return { $ref: name, note: `超出最大展开深度(${maxDepth})，可调大 schemaDepth 参数` };
    }
    if (expanded?.has(name)) {
      return { 'x-model': name, note: '同一模型结构已在本响应中展开过，见首次出现处' };
    }
    expanded?.add(name);
    const rendered = renderSchema(target, components, maxDepth, depth + 1, [...seen, name], expanded);
    if (rendered && typeof rendered === 'object' && !Array.isArray(rendered)) {
      return { 'x-model': name, ...rendered };
    }
    return rendered;
  }

  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === '$ref') continue;
    if (k === 'properties' && v && typeof v === 'object') {
      const props: Record<string, any> = {};
      for (const [propName, propSchema] of Object.entries(v)) {
        props[propName] = renderSchema(propSchema, components, maxDepth, depth, seen, expanded);
      }
      out.properties = props;
    } else if ((k === 'items' || k === 'additionalProperties' || k === 'not') && v && typeof v === 'object') {
      out[k] = renderSchema(v, components, maxDepth, depth, seen, expanded);
    } else if ((k === 'allOf' || k === 'oneOf' || k === 'anyOf') && Array.isArray(v)) {
      out[k] = v.map((s) => renderSchema(s, components, maxDepth, depth, seen, expanded));
    } else {
      out[k] = v;
    }
  }
  return out;
}

export function renderContent(
  content: any,
  components: Record<string, any>,
  maxDepth: number = config.maxSchemaDepth,
  expanded?: Set<string>,
): Record<string, any> | null {
  if (!content || typeof content !== 'object') return null;
  const out: Record<string, any> = {};
  for (const [mediaType, media] of Object.entries<any>(content)) {
    out[mediaType] = {
      ...(media?.schema ? { schema: renderSchema(media.schema, components, maxDepth, 0, [], expanded) } : {}),
      ...(media?.example !== undefined ? { example: media.example } : {}),
    };
  }
  return Object.keys(out).length ? out : null;
}

export function renderOperation(
  raw: any,
  components: Record<string, any>,
  maxDepth: number = config.maxSchemaDepth,
) {
  const expanded = new Set<string>();
  const parameters = Array.isArray(raw.parameters)
    ? raw.parameters.map((p: any) => ({
        name: p.name,
        in: p.in,
        required: p.required === true,
        ...(p.description ? { description: p.description } : {}),
        ...(p.schema ? { schema: renderSchema(p.schema, components, maxDepth, 0, [], expanded) } : {}),
      }))
    : [];

  const requestBody = raw.requestBody
    ? {
        required: raw.requestBody.required === true,
        ...(raw.requestBody.description ? { description: raw.requestBody.description } : {}),
        content: renderContent(raw.requestBody.content, components, maxDepth, expanded),
      }
    : null;

  const responses = raw.responses
    ? Object.entries<any>(raw.responses).map(([status, resp]) => ({
        status,
        description: resp?.description ?? '',
        ...(resp?.content ? { content: renderContent(resp.content, components, maxDepth, expanded) } : {}),
      }))
    : [];

  const authSchemes: string[] = [];
  if (Array.isArray(raw.security)) {
    for (const sec of raw.security) {
      for (const k of Object.keys(sec ?? {})) if (!authSchemes.includes(k)) authSchemes.push(k);
    }
  }

  return { parameters, requestBody, responses, authSchemes };
}
