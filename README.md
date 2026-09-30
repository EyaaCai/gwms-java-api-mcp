# gwms-java-api-mcp

GWMS Java 接口文档（springdoc + knife4j 的 doc.html 页面）的 MCP 服务，让 AI 直接查接口文档，不必再开浏览器翻页面。

> **个人自用项目**：为特定项目的接口文档定制，公开仓库主要用于多机同步与备份，不保证通用性、不提供支持。若要复用到自己的服务，只需在 `.env` 里改掉文档服务地址（见下方「配置」）。

## 能力

- **关键词搜索接口**：同时匹配路径、中文摘要、operationId、标签名，支持多关键词（空格分隔，AND）与分页
- **按 TAPD 需求号查改动接口**：需求号命名的标签（`1082335` / `v1077548` / `f1098971`）下挂着该需求改动的全部接口
- **接口详情**：参数、请求体、响应结构（`$ref` 数据模型自动递归展开并标注模型名）、鉴权要求
- **自动去重**：同一接口常同时挂"功能标签 + TAPD 标签"，所有结果按接口（method + path）去重，标签完整列出，不会重复刷屏

## 数据来源与缓存

| 接口 | 用途 |
| --- | --- |
| `GET /v3/api-docs/swagger-config` | 获取分组列表 |
| `GET /v3/api-docs/所有` | 全量文档（约 1400 个接口 / 2700+ 模型，约 2MB） |
| `GET /v3/api-docs/{Pda端,仓库端,商家端}` | 标注每个接口所属端 |

- 首次查询拉取全量文档并写入 `.cache/`，默认 6 小时内直接读缓存（毫秒级）
- 缓存过期自动重新拉取（一次约 0.5s）；文档服务不可达时回退到旧缓存，并在结果里标注数据时间与失败原因
- 后端改了接口想立刻看到，不用等 TTL：调用 `gwms_refresh_cache` 强制刷新
- 数据源直连 springdoc 元数据接口，无需登录

## 配置

环境相关配置（文档服务地址等）放在项目根目录的 `.env` 里，该文件已被 `.gitignore` 排除，不会提交；模板见 `.env.example`：

```bash
cp .env.example .env
```

```ini
# .env
GWMS_DOC_BASE_URL=http://your-doc-host:port
```

优先级：**MCP 客户端配置里的 `env` > 项目根目录 `.env` > 代码内置默认值**。其中只有 `GWMS_DOC_BASE_URL` 没有内置默认值，未配置时服务启动即报错并提示配置方式。

### 多环境（dev / test）

开发环境和测试环境的文档地址不同时，**每个环境配一个 MCP 实例**：工具名自动带环境前缀（`gwms_dev_search_apis` / `gwms_test_search_apis`），AI 按你提的环境自动选工具，两个环境的缓存也互相隔离（`.cache/<环境名>/`）。

**第一步**：`.env` 里写上两个地址

```ini
# 默认地址（test 实例用）
GWMS_DOC_BASE_URL=http://test-doc-host:port
# 环境专属地址，dev 实例优先用它
GWMS_DOC_BASE_URL_DEV=http://dev-doc-host:port
```

**第二步**：客户端配两条

```json
{
  "mcpServers": {
    "gwms-api-docs-test": {
      "command": "cmd",
      "args": ["/c", "D:\\path\\to\\gwms-java-api-mcp\\bin\\start.cmd"],
      "env": { "GWMS_ENV_NAME": "test" }
    },
    "gwms-api-docs-dev": {
      "command": "cmd",
      "args": ["/c", "D:\\path\\to\\gwms-java-api-mcp\\bin\\start.cmd"],
      "env": { "GWMS_ENV_NAME": "dev" }
    }
  }
}
```

说明：

- 地址查找顺序：`GWMS_DOC_BASE_URL_<环境名大写>` > `GWMS_DOC_BASE_URL`；所以 test 实例没写 `GWMS_DOC_BASE_URL_TEST` 时会用通用项
- 环境名只用小写字母/数字（如 `dev`、`test`），它会进工具名和缓存目录名
- 不设 `GWMS_ENV_NAME` 时行为与单环境一致（工具名无前缀、缓存目录 `.cache/`）
- 之后直接问"dev 环境的备货单接口有哪些"，AI 就会用 `gwms_dev_search_apis`

## 环境要求

**Node.js >= 18**（需要全局 `fetch`）。

项目已在 `package.json` 里用 Volta pin 了 `node 24.20.0`：

- 装了 Volta 的机器：进入项目目录后 `node` 会自动用 24.20.0（`node -v` 可验证），手跑直接 `node dist/index.js`
- 没装 Volta 的机器：用 MCP 配置直接指定 node 18+ 的路径（见方式二），或把 PATH 里的 node 升级到 18+

如果你的 PATH 里 `node` 是 Volta 的 shim，注意它只在项目目录内才会读到 pin，在其他目录会退回默认版本（可能是旧版）；因此**不要**在 MCP 配置里裸写 `node`，要么用启动脚本（方式一），要么写绝对路径（方式二）。

## 构建

```bash
npm install
npm run build
```

## 接入 MCP 客户端

### 方式一：用项目自带启动脚本（推荐，路径可移植）

`bin/start.cmd` 会先切到项目目录再调用 `node`：

- 装了 Volta 的机器：自动按项目 pin 的 24.20.0 运行，零配置
- 没装 Volta 的机器：自动使用 PATH 中的 node（需 >= 18），版本过低时给出明确报错

```json
{
  "mcpServers": {
    "gwms-api-docs": {
      "command": "cmd",
      "args": ["/c", "D:\\path\\to\\gwms-java-api-mcp\\bin\\start.cmd"]
    }
  }
}
```

> `D:\path\to\gwms-java-api-mcp` 替换为项目实际克隆路径，下同。

### 方式二：直接指定 node 可执行文件（没装 Volta，或 PATH 里 node 太旧）

```json
{
  "mcpServers": {
    "gwms-api-docs": {
      "command": "C:\\Users\\YOUR_USER\\AppData\\Local\\Volta\\tools\\image\\node\\24.20.0\\node.exe",
      "args": ["D:\\path\\to\\gwms-java-api-mcp\\dist\\index.js"]
    }
  }
}
```

> `YOUR_USER` 替换为你的 Windows 用户名；node 路径以 `node -v` 确认的 18+ 版本为准。

客户端支持 `cwd` 时，也可以直接用 Volta shim（shim 需要 cwd 在项目内才会读到 pin）：

```json
{
  "mcpServers": {
    "gwms-api-docs": {
      "command": "C:\\Program Files\\Volta\\node.exe",
      "args": ["dist\\index.js"],
      "cwd": "D:\\path\\to\\gwms-java-api-mcp"
    }
  }
}
```

如需在客户端配置里直接传参（优先级高于项目 `.env`）：

```json
{
  "mcpServers": {
    "gwms-api-docs": {
      "command": "cmd",
      "args": ["/c", "D:\\path\\to\\gwms-java-api-mcp\\bin\\start.cmd"],
      "env": {
        "GWMS_DOC_BASE_URL": "http://your-doc-host:port"
      }
    }
  }
}
```

## 工具

| 工具 | 用途 | 主要参数 |
| --- | --- | --- |
| `gwms_doc_overview` | 文档概览：接口总数、分组统计、标签分类列表（功能 / TAPD / 日期 / 其他） | `kind`、`keyword`、`limit` |
| `gwms_search_apis` | 关键词搜索接口（中文长关键词整串匹配不到时，自动按 2 字片段兜底并提示） | `keyword`（必填）、`group`、`tag`、`method`、`limit`、`offset` |
| `gwms_list_tapd_apis` | 按 TAPD 需求号列出改动接口；不传参数则列出全部需求标签 | `tapd_id`、`limit` |
| `gwms_api_detail` | 接口完整定义，模型递归展开 | `path`（必填）、`method`、`schemaDepth` |
| `gwms_refresh_cache` | 强制刷新缓存 | 无 |

典型用法：

1. `gwms_search_apis` 搜"备货单 分页" → 拿到 `path`
2. `gwms_api_detail` 传入 `path` → 拿到完整出入参
3. 联调某次需求：`gwms_list_tapd_apis` 传 `1122873` → 该需求改动的接口清单

## 环境变量

配置来源：客户端 `env` 优先于项目 `.env`。仅 `GWMS_DOC_BASE_URL` 必填。

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `GWMS_DOC_BASE_URL` | 无（必填） | 文档服务根地址，不带结尾斜杠 |
| `GWMS_DOC_BASE_URL_<ENV>` | 无 | 环境专属地址（环境名大写，如 `GWMS_DOC_BASE_URL_DEV`），优先于通用项 |
| `GWMS_ENV_NAME` | 空 | 实例的环境名（如 `dev`/`test`），设置后工具名带前缀、缓存目录隔离到 `.cache/<环境名>/` |
| `GWMS_API_DOCS_PATH` | `/v3/api-docs` | springdoc 元数据路径 |
| `GWMS_CACHE_DIR` | `<项目目录>/.cache` | 缓存目录 |
| `GWMS_CACHE_TTL_MS` | `21600000`（6 小时） | 缓存有效期，按文档更新频率调整 |
| `GWMS_REQUEST_TIMEOUT_MS` | `60000` | 单个 HTTP 请求超时 |
| `GWMS_MAX_SCHEMA_DEPTH` | `8` | 详情默认模型展开层级 |
| `GWMS_ENV_FILE` | `<项目目录>/.env` | 指定其他 .env 文件位置 |

## 数据约定

- **标签语义**：接口每次被 TAPD 需求改动时会打上需求号标签，同时保留功能模块标签（如 `备货单管理` + `1082335` 下是同一批接口）。需求号标签有纯数字、`v` 前缀、`f` 前缀三种形式。
- **端分组**：`Pda端`、`仓库端`、`商家端` 互不相交，是"所有"的子集；少数接口不属于任何端（显示"未分端"）。
- **多方法路径**：5 个路径同时暴露 GET/POST（同一接口的两种方法），列表中合并为 `GET|POST`，详情可用 `method` 指定。
- **详情体积**：中位数约 2KB；超大接口（>40KB）会附带提示，可用 `schemaDepth=3` 降低展开层级。同一模型在同一响应内只完整展开一次，重复出现处标注"见首次出现处"。

## 排查

| 现象 | 处理 |
| --- | --- |
| 启动报"需要 Node.js 18 或更高版本" | MCP 配置里的 `command` 指向了旧版 node，改成上面 Node 24 的路径 |
| 启动报"fetch is not defined" | 同上，node 版本过低 |
| 启动报"缺少必填配置 GWMS_DOC_BASE_URL" | 在项目根目录创建 `.env` 并填入文档服务地址（参考 `.env.example`），或在客户端配置的 `env` 里传入 |
| 结果带"[注意] 缓存已过期且刷新失败" | 文档服务不可达，当前用的是本地缓存；网络恢复后自动刷新，或调用 `gwms_refresh_cache` |
| 文档服务宕机会不会一直卡住 | 不会。只有首次会等待连接超时（默认 60s），之后 60 秒内直接返回本地缓存不再重试 |
| 后端改了接口但查不到 | 调用 `gwms_refresh_cache` 强制刷新；否则等 TTL 过期（默认 6 小时）后自动重拉 |
| 想直接看服务日志 | MCP 服务日志走 stderr（stdout 被协议占用），在客户端日志里查看 `[gwms-mcp]` 前缀的输出 |
