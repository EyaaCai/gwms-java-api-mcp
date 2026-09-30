#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { config, fmtTtl } from './config.js';
import { ensureStore } from './store.js';
import { registerTools } from './tools.js';

async function main(): Promise<void> {
  const major = Number(process.versions.node.split('.')[0]);
  if (!Number.isFinite(major) || major < 18) {
    console.error(
      `[gwms-mcp] 需要 Node.js 18 或更高版本（当前 v${process.versions.node}，缺少全局 fetch）。` +
        '请在 MCP 客户端配置中把 command 指向 node 18+ 的可执行文件路径。',
    );
    process.exit(1);
  }

  const server = new McpServer({
    name: config.envName ? `gwms-java-api-docs-${config.envName}` : 'gwms-java-api-docs',
    version: '1.0.0',
  });

  registerTools(server);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error(
    `[gwms-mcp] 已启动${config.envName ? ` [${config.envName}]` : ''} | 数据源=${config.baseUrl}${config.apiDocsPath} | 缓存=${config.cacheDir} | TTL=${fmtTtl(config.ttlMs)} | node=${process.versions.node}`,
  );

  ensureStore().then(
    (store) => console.error(`[gwms-mcp] 文档预加载完成，接口 ${store.opCount} 个`),
    (err) => console.error(`[gwms-mcp] 文档预加载失败（将在首次查询时重试）: ${err instanceof Error ? err.message : err}`),
  );
}

process.on('uncaughtException', (err) => {
  console.error('[gwms-mcp] 未捕获异常:', err);
});
process.on('unhandledRejection', (err) => {
  console.error('[gwms-mcp] 未处理的 Promise 拒绝:', err);
});

main().catch((err) => {
  console.error('[gwms-mcp] 启动失败:', err);
  process.exit(1);
});
