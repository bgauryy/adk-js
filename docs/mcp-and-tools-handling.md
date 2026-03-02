# MCP and Tools Handling in ADK-JS

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Tool Type Hierarchy](#2-tool-type-hierarchy)
3. [BaseTool — The Foundation](#3-basetool--the-foundation)
4. [FunctionTool — User-Defined Tools](#4-functiontool--user-defined-tools)
5. [MCP Integration](#5-mcp-integration)
6. [MCP Protocol Field Tracing — Where Every Field Lands](#6-mcp-protocol-field-tracing--where-every-field-lands)
7. [How MCP Tools Enter the Agent](#7-how-mcp-tools-enter-the-agent)
8. [Toolsets and Tool Filtering](#8-toolsets-and-tool-filtering)
9. [Specialized Tool Types](#9-specialized-tool-types)
10. [Tool Registration in the Agent Loop](#10-tool-registration-in-the-agent-loop)
11. [Tool Execution Pipeline](#11-tool-execution-pipeline)
12. [Tool Confirmation (HITL)](#12-tool-confirmation-hitl)
13. [Security Plugin and Policy Engine](#13-security-plugin-and-policy-engine)
14. [Instructions and Dynamic Context](#14-instructions-and-dynamic-context)
15. [Schema Conversion (MCP → Gemini)](#15-schema-conversion-mcp--gemini)
16. [Request Processors Pipeline](#16-request-processors-pipeline)
17. [Complete Data Flow](#17-complete-data-flow)

---

## 1. Architecture Overview

The ADK-JS tool system is a layered architecture that abstracts tool
discovery, schema declaration, execution, and lifecycle management across
local functions, MCP servers, built-in model capabilities, and
sub-agent delegation.

```
┌─────────────────────────────────────────────────────┐
│                    Runner                            │
│  (orchestrates session, plugins, agent lifecycle)    │
│  core/src/runner/runner.ts                          │
├─────────────────────────────────────────────────────┤
│                   LlmAgent                           │
│  (owns tools[], runs request/response processors)    │
│  core/src/agents/llm_agent.ts                       │
├──────────┬──────────┬──────────┬────────────────────┤
│ BaseTool │BaseToolset│ToolContext│ Tool Callbacks     │
│          │          │          │ (before/after)       │
├──────────┴──────────┴──────────┴────────────────────┤
│  FunctionTool │ MCPTool │ AgentTool │ GoogleSearch   │
│  LongRunning  │         │           │ (built-in)     │
├───────────────┴─────────┴───────────┴────────────────┤
│              MCP Session Manager                      │
│  (Stdio / StreamableHTTP transport)                  │
│  core/src/tools/mcp/mcp_session_manager.ts           │
└──────────────────────────────────────────────────────┘
```

---

## 2. Tool Type Hierarchy

All tools share a common base class and are identified at runtime via
unique Symbols (structural typing):

```
BaseTool (abstract)
├── FunctionTool              — wraps a user function + Zod/Schema parameters
│   └── LongRunningFunctionTool — marks tool as async/resumable
├── MCPTool                   — wraps an MCP server tool definition
├── AgentTool                 — wraps a sub-agent as a callable tool
└── GoogleSearchTool          — built-in Gemini model tool (server-side)
```

**Reference:** `core/src/tools/base_tool.ts` (lines 62–158)

Type guards use `Symbol.for()` for cross-package identity:

```typescript
const BASE_TOOL_SIGNATURE_SYMBOL = Symbol.for('google.adk.baseTool');
export function isBaseTool(obj: unknown): obj is BaseTool { ... }
```

---

## 3. BaseTool — The Foundation

**Reference:** `core/src/tools/base_tool.ts`

Every tool has three responsibilities:

| Method                       | Purpose                                                                          | Required?                             |
| ---------------------------- | -------------------------------------------------------------------------------- | ------------------------------------- |
| `_getDeclaration()`          | Returns `FunctionDeclaration` (name, description, parameters schema) for the LLM | Optional — skip for built-in tools    |
| `runAsync(request)`          | Executes the tool with args + context, returns result                            | Required for client-side tools        |
| `processLlmRequest(request)` | Injects this tool's declaration into the outgoing LLM request                    | Default impl uses `_getDeclaration()` |

The default `processLlmRequest` implementation:

1. Calls `_getDeclaration()` to get the `FunctionDeclaration`
2. Registers `this` into `llmRequest.toolsDict[this.name]` (used later for execution lookup)
3. Appends the declaration to `llmRequest.config.tools[].functionDeclarations[]`

---

## 4. FunctionTool — User-Defined Tools

**Reference:** `core/src/tools/function_tool.ts`

Wraps a plain function into a tool with schema validation:

```typescript
const myTool = new FunctionTool({
  name: 'get_weather',
  description: 'Get weather for a city',
  parameters: z.object({
    city: z.string(),
  }),
  execute: async (input) => {
    return {temperature: 72, unit: 'F', city: input.city};
  },
});
```

Key behaviors:

- Accepts `z3.ZodObject`, `z4.ZodObject`, or raw `Schema` for parameters
- Zod schemas are converted to Gemini `Schema` via `zodObjectToSchema()`
- Input is validated against the Zod schema at execution time via `.parse()`
- The `name` falls back to the `execute` function's `.name` property if not
  explicitly provided

---

## 5. MCP Integration

MCP (Model Context Protocol) support consists of three components:

### 5.1 MCPSessionManager

**Reference:** `core/src/tools/mcp/mcp_session_manager.ts`

Manages MCP client connections. Supports two transports:

| Transport                        | Config Type                                           | Use Case                        |
| -------------------------------- | ----------------------------------------------------- | ------------------------------- |
| `StdioConnectionParams`          | `{ type, serverParams, timeout? }`                    | Local child process MCP servers |
| `StreamableHTTPConnectionParams` | `{ type, url, header?, timeout?, transportOptions? }` | Remote HTTP+SSE MCP servers     |

Each call to `createSession()` creates a new `Client` and connects it
via the appropriate transport.

### 5.2 MCPToolset

**Reference:** `core/src/tools/mcp/mcp_toolset.ts`

A `BaseToolset` implementation that discovers tools from an MCP server:

1. Creates an MCP session via `MCPSessionManager`
2. Calls `session.listTools()` to get the server's tool catalog
3. Wraps each MCP `Tool` into an `MCPTool` instance
4. Supports a `toolFilter` (string array or predicate function) to
   selectively expose tools

```typescript
const mcpToolset = new MCPToolset({
  type: 'StreamableHTTPConnectionParams',
  url: 'http://localhost:8788/mcp',
});
// Use directly in agent config:
const agent = new LlmAgent({
  tools: [mcpToolset],
  // ...
});
```

### 5.3 MCPTool

**Reference:** `core/src/tools/mcp/mcp_tool.ts`

Wraps a single MCP tool definition (`Tool` from `@modelcontextprotocol/sdk`)
into an ADK `BaseTool`:

- **Schema translation:** `_getDeclaration()` converts the MCP tool's
  `inputSchema` and `outputSchema` to Gemini format via `toGeminiSchema()`
- **Remote execution:** `runAsync()` opens an MCP session, sends a
  `callTool` request with the provided arguments, and returns the
  `CallToolResult`

### MCP Tool Discovery Flow

```
Agent.tools: [MCPToolset]
       │
       ▼
MCPToolset.getTools()
       │
       ▼
MCPSessionManager.createSession()  →  MCP Client connected
       │
       ▼
session.listTools()  →  ListToolsResult { tools: Tool[] }
       │
       ▼
tools.map(t => new MCPTool(t, sessionManager))
       │
       ▼
[MCPTool, MCPTool, ...]  →  returned as BaseTool[]
```

### MCP Tool Execution Flow

```
LLM returns FunctionCall { name: "mcp_tool_name", args: {...} }
       │
       ▼
functions.ts: handleFunctionCallsAsync()
       │  looks up tool in llmRequest.toolsDict
       ▼
MCPTool.runAsync({ args, toolContext })
       │
       ▼
MCPSessionManager.createSession()  →  new MCP Client
       │
       ▼
session.callTool({ name, arguments })  →  CallToolResult
       │
       ▼
Result returned as function response to LLM
```

---

## 6. MCP Protocol Field Tracing — Where Every Field Lands

The MCP SDK `Tool` type (from `@modelcontextprotocol/sdk/types.js`) has
these fields as defined in `ToolSchema`:

> Source: `node_modules/@modelcontextprotocol/sdk/dist/esm/types.d.ts`
> (line 2371)

```typescript
// MCP Tool type (inferred from ToolSchema)
{
  name: string;                        // required
  description?: string;                // optional
  title?: string;                      // optional — human-readable display name
  inputSchema: {                       // required
    type: "object";
    properties?: Record<string, unknown>;
    required?: string[];
    [key: string]: unknown;            // catchall for extra JSON Schema fields
  };
  outputSchema?: {                     // optional
    type: "object";
    properties?: Record<string, unknown>;
    required?: string[];
    [key: string]: unknown;
  };
  annotations?: {                      // optional — behavioral hints
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
  execution?: {                        // optional — task support
    taskSupport?: "optional" | "required" | "forbidden";
  };
  icons?: Array<{                      // optional — tool icons
    src: string;
    mimeType?: string;
    sizes?: string[];
    theme?: "light" | "dark";
  }>;
  _meta?: Record<string, unknown>;     // optional — extension metadata
}
```

### Field-by-field: Where each is consumed in ADK-JS

| MCP Tool Field     | Used? | Where consumed                                 | How                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------ | ----- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`name`**         | YES   | `MCPTool` constructor → `BaseTool.name`        | Stored in `this.name` via `super({name: mcpTool.name, ...})` at `mcp_tool.ts:38`. Used for: (1) `_getDeclaration().name` → sent to LLM as function name, (2) `llmRequest.toolsDict[this.name]` → execution lookup key at `base_tool.ts:126`, (3) `callTool({name: ...})` → MCP server execution at `mcp_tool.ts:58`, (4) `functionResponse.name` → returned to LLM at `functions.ts:257,478` |
| **`description`**  | YES   | `MCPTool` constructor → `BaseTool.description` | Stored via `super({description: mcpTool.description \|\| ''})` at `mcp_tool.ts:38`. Also passed to `_getDeclaration().description` at `mcp_tool.ts:46` → sent to LLM in `FunctionDeclaration` so the model knows what the tool does                                                                                                                                                          |
| **`inputSchema`**  | YES   | `MCPTool._getDeclaration()`                    | Converted via `toGeminiSchema(this.mcpTool.inputSchema)` at `mcp_tool.ts:47` → becomes `FunctionDeclaration.parameters` → sent to LLM so it knows what arguments to generate                                                                                                                                                                                                                 |
| **`outputSchema`** | YES   | `MCPTool._getDeclaration()`                    | Converted via `toGeminiSchema(this.mcpTool.outputSchema)` at `mcp_tool.ts:50` → becomes `FunctionDeclaration.response` → tells LLM the expected return shape (marked with TODO for revisit)                                                                                                                                                                                                  |
| **`title`**        | NO    | Not consumed                                   | Ignored entirely. Neither stored nor forwarded.                                                                                                                                                                                                                                                                                                                                              |
| **`annotations`**  | NO    | Not consumed                                   | `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint` are all ignored. Not used for security policy, HITL decisions, or any behavioral logic.                                                                                                                                                                                                                                 |
| **`execution`**    | NO    | Not consumed                                   | `taskSupport` is ignored.                                                                                                                                                                                                                                                                                                                                                                    |
| **`icons`**        | NO    | Not consumed                                   | Not forwarded to LLM or UI.                                                                                                                                                                                                                                                                                                                                                                  |
| **`_meta`**        | NO    | Not consumed                                   | Extension metadata is discarded.                                                                                                                                                                                                                                                                                                                                                             |

### Schema conversion detail

The `inputSchema` and `outputSchema` pass through `toGeminiSchema()`
(`core/src/utils/gemini_schema_util.ts`):

```
MCP inputSchema (JSON Schema)         Gemini Schema
─────────────────────────────         ─────────────
type: "object"                    →   type: Type.OBJECT
properties.foo.type: "string"     →   properties.foo: { type: Type.STRING }
properties.foo.description: "..." →   properties.foo: { description: "..." }
required: ["foo"]                 →   required: ["foo"]
anyOf: [{type:"string"},{null}]   →   (extracts non-null option)
items: {...}                      →   items: recursiveConvert(...)
```

Fields preserved: `type`, `description`, `properties`, `required`, `items`
Fields lost: `$ref`, `enum`, `default`, `minLength`, `maxLength`,
`minimum`, `maximum`, `pattern`, `format`, `additionalProperties`, and
all other JSON Schema keywords not explicitly handled.

---

## 7. How MCP Tools Enter the Agent

This traces the exact code path from `LlmAgent` config to MCP tools
being available for the LLM to call and for the framework to execute.

### Step 1: Agent Configuration

```typescript
const agent = new LlmAgent({
  tools: [mcpToolset], // MCPToolset is a BaseToolset
  // ...
});
```

At `llm_agent.ts:1380`: `this.tools = config.tools ?? []`
The `tools` array stores `ToolUnion[]` (= `BaseTool | BaseToolset`).

### Step 2: Tool Registration (every LLM call)

In `LlmAgent.runOneStepAsync()` at `llm_agent.ts:1717-1728`:

```typescript
for (const toolUnion of this.tools) {
  const toolContext = new ToolContext({invocationContext});
  const tools = await convertToolUnionToTools(toolUnion, readonlyContext);
  for (const tool of tools) {
    await tool.processLlmRequest({toolContext, llmRequest});
  }
}
```

`convertToolUnionToTools()` at `llm_agent.ts:332-340`:

- If `isBaseTool(toolUnion)` → returns `[toolUnion]` (single tool)
- Else → calls `toolUnion.getTools(context)` (toolset discovery)

**This is where MCP discovery happens — on every LLM call.** The
`MCPToolset.getTools()` at `mcp_toolset.ts:51-64`:

1. `this.mcpSessionManager.createSession()` → new MCP Client
2. `session.listTools()` → `ListToolsResult` from MCP server
3. `listResult.tools.map(t => new MCPTool(t, this.mcpSessionManager))`

Each MCP `Tool` object is wrapped in `MCPTool`, which stores the raw
MCP tool in `this.mcpTool` at `mcp_tool.ts:39`.

### Step 3: Declaration Injection into LLM Request

For each `MCPTool`, `processLlmRequest()` is called (inherited from
`BaseTool` at `base_tool.ts:120-142`):

```
MCPTool.processLlmRequest()
  │
  ├── this._getDeclaration()  →  FunctionDeclaration
  │     │
  │     ├── name: this.mcpTool.name              ← MCP name
  │     ├── description: this.mcpTool.description ← MCP description
  │     ├── parameters: toGeminiSchema(inputSchema) ← MCP inputSchema → Gemini
  │     └── response: toGeminiSchema(outputSchema)  ← MCP outputSchema → Gemini
  │
  ├── llmRequest.toolsDict[this.name] = this   ← registers MCPTool instance
  │     (key = MCP tool name, value = MCPTool object)
  │
  └── llmRequest.config.tools[].functionDeclarations.push(declaration)
        (adds FunctionDeclaration to LLM config)
```

After this step, the LLM request contains:

- **System instruction** with agent identity + user instructions
- **Conversation history** as contents
- **Tool declarations** including all MCP tools as `FunctionDeclaration`
- **toolsDict** mapping tool names → `MCPTool` instances for execution

### Step 4: LLM Sees the Tools

The Gemini `GenerateContentConfig.tools` now contains:

```json
{
  "tools": [{
    "functionDeclarations": [
      {
        "name": "localSearchCode",
        "description": "...",
        "parameters": { "type": "OBJECT", "properties": { ... } },
        "response": { "type": "OBJECT", "properties": { ... } }
      },
      ...
    ]
  }]
}
```

The LLM decides to call a tool based on `name`, `description`, and
`parameters`. It generates a `FunctionCall` with `name` + `args`.

### Step 5: Tool Execution via MCP

When the LLM returns `FunctionCall { name: "localSearchCode", args: {...} }`:

1. `functions.ts:547` — `toolsDict[functionCall.name]` retrieves the
   `MCPTool` instance
2. `functions.ts:395` — `callToolAsync(tool, functionArgs, toolContext)`
3. `MCPTool.runAsync()` at `mcp_tool.ts:54-61`:
   - Opens new MCP session: `this.mcpSessionManager.createSession()`
   - Sends: `session.callTool({name: this.mcpTool.name, arguments: request.args})`
   - Returns: `CallToolResult` from MCP server
4. `functions.ts:472-484` — wraps result as `functionResponse` part in
   an Event
5. Event is yielded and appended to session → fed back to LLM as
   conversation history

### Step 6: Result Returns to LLM

The function response is structured as:

```typescript
{
  functionResponse: {
    id: toolContext.functionCallId,     // matches the function call
    name: tool.name,                    // = MCP tool name
    response: callToolResult,           // raw MCP CallToolResult
  }
}
```

The LLM receives this in the next turn's contents and can either:

- Generate a final text response
- Call another tool (loop continues)

### Visual Summary: MCP Tool Lifecycle

```
┌─── CONFIGURATION TIME ────────────────────────────────┐
│                                                        │
│  new LlmAgent({ tools: [new MCPToolset(params)] })    │
│                           │                            │
│                           ▼                            │
│                  stores as ToolUnion[]                  │
└────────────────────────────────────────────────────────┘
                           │
                    (agent.runAsync called)
                           │
┌─── EVERY LLM CALL (runOneStepAsync) ──────────────────┐
│                                                        │
│  for each ToolUnion in this.tools:                     │
│    │                                                   │
│    ├─ MCPToolset.getTools()                            │
│    │    ├─ MCPSessionManager.createSession()           │
│    │    ├─ session.listTools()  ← MCP PROTOCOL CALL    │
│    │    └─ returns MCPTool[] (wrapping MCP Tool objs)  │
│    │                                                   │
│    └─ for each MCPTool:                                │
│         ├─ _getDeclaration()                           │
│         │   ├─ name ← mcpTool.name                    │
│         │   ├─ description ← mcpTool.description      │
│         │   ├─ parameters ← toGeminiSchema(inputSchema)│
│         │   └─ response ← toGeminiSchema(outputSchema) │
│         │                                              │
│         ├─ toolsDict["name"] = this (MCPTool)          │
│         └─ config.tools[].functionDeclarations.push()  │
│                                                        │
│  ─── LLM CALL ─────────────────────────────────────── │
│  LLM sees: name, description, parameters, response    │
│  LLM returns: FunctionCall { name, args }              │
│                                                        │
│  ─── TOOL EXECUTION ──────────────────────────────── │
│  toolsDict[name] → MCPTool                             │
│  MCPTool.runAsync():                                   │
│    ├─ MCPSessionManager.createSession()                │
│    ├─ session.callTool({name, arguments})              │
│    │       ↕  MCP PROTOCOL CALL                        │
│    └─ returns CallToolResult                           │
│                                                        │
│  ─── RESULT BACK TO LLM ─────────────────────────── │
│  functionResponse { name, response: CallToolResult }   │
│  → appended to session → next LLM turn                 │
│                                                        │
└────────────────────────────────────────────────────────┘
```

### Key Observations

1. **MCP discovery happens every LLM call** — `MCPToolset.getTools()` is
   called inside `runOneStepAsync()` on each iteration of the agent loop.
   A new MCP session is created each time. There is no caching.

2. **Tool descriptions go directly to the LLM** — `mcpTool.description`
   becomes `FunctionDeclaration.description` in the Gemini request.
   This is the primary way the LLM decides which tool to use.

3. **Schema conversion is lossy** — `toGeminiSchema()` only preserves
   `type`, `description`, `properties`, `required`, and `items`.
   Advanced JSON Schema features (`enum`, `default`, `pattern`,
   `minLength`, `maxLength`, `additionalProperties`, etc.) are silently
   dropped.

4. **Annotations are completely ignored** — MCP `annotations` like
   `destructiveHint` and `readOnlyHint` are not used for HITL decisions
   or security policy. The `SecurityPlugin` only uses its own
   `BasePolicyEngine` evaluation, not MCP annotations.

5. **New session per execution** — `MCPTool.runAsync()` creates a fresh
   MCP session for each tool call. There is no session reuse or pooling.

6. **The `toolFilter` on MCPToolset is not applied** — there is a
   `TODO: respect context (e.g. tool filter)` at `mcp_toolset.ts:60`.
   Currently all tools from the MCP server are returned regardless of
   the filter.

---

## 8. Toolsets and Tool Filtering

**Reference:** `core/src/tools/base_toolset.ts`

`BaseToolset` is the abstract base for collections of tools. The
`ToolPredicate` type enables dynamic filtering:

```typescript
type ToolPredicate = (
  tool: BaseTool,
  readonlyContext: ReadonlyContext,
) => boolean;
```

Filtering options:

- **String array:** `['tool_a', 'tool_b']` — filter by tool name
- **Predicate function:** `(tool, ctx) => tool.name.startsWith('safe_')` —
  dynamic context-aware filtering

The `isToolSelected()` method evaluates the filter at tool resolution time.

Toolsets also support `processLlmRequest()` at the set level, allowing bulk
modifications to the LLM request (e.g., `ComputerUseToolset` adds computer
use configuration).

---

## 9. Specialized Tool Types

### 9.1 AgentTool

**Reference:** `core/src/tools/agent_tool.ts`

Wraps an entire agent as a callable tool, enabling agent-as-a-tool patterns:

- Creates an ephemeral `Runner` + `InMemorySessionService` per execution
- Forwards artifacts via `ForwardingArtifactService`
- Respects the sub-agent's `inputSchema` / `outputSchema`
- Supports `skipSummarization` to pass raw output

### 9.2 LongRunningFunctionTool

**Reference:** `core/src/tools/long_running_tool.ts`

Extends `FunctionTool` with `isLongRunning: true`. The framework:

- Skips null responses (tool still pending)
- Appends a system instruction to the tool description warning the LLM
  not to re-invoke it
- Tracks long-running tool IDs in `event.longRunningToolIds`

### 9.3 GoogleSearchTool

**Reference:** `core/src/tools/google_search_tool.ts`

A server-side built-in tool that:

- Has no client-side `runAsync()` (returns immediately)
- Overrides `processLlmRequest()` to inject `googleSearch: {}` or
  `googleSearchRetrieval: {}` into the LLM config depending on model
  version
- A global singleton `GOOGLE_SEARCH` is exported for convenience

---

## 10. Tool Registration in the Agent Loop

**Reference:** `core/src/agents/llm_agent.ts` (lines 1694–1728)

During each step of the agent loop (`runOneStepAsync`), tools are
registered in two phases:

### Phase 1: Request Processors

The ordered processor pipeline runs first (see
[Section 16](#16-request-processors-pipeline)), preparing the LLM request
with model config, instructions, content history, etc.

### Phase 2: Tool Processing

After all request processors, the agent iterates over its `tools[]` array:

```typescript
for (const toolUnion of this.tools) {
  const toolContext = new ToolContext({invocationContext});
  const tools = await convertToolUnionToTools(toolUnion, readonlyContext);
  for (const tool of tools) {
    await tool.processLlmRequest({toolContext, llmRequest});
  }
}
```

`convertToolUnionToTools()` handles the `ToolUnion` type:

- If `BaseTool` → returns `[tool]`
- If `BaseToolset` → calls `toolset.getTools(context)` (this is where
  `MCPToolset` discovers tools from the MCP server)

Each tool's `processLlmRequest()` adds its declaration to the LLM request
and registers itself in `llmRequest.toolsDict` for later execution lookup.

---

## 11. Tool Execution Pipeline

**Reference:** `core/src/agents/functions.ts`

When the LLM returns function calls, the execution pipeline runs:

```
LLM Response with FunctionCall[]
       │
       ▼
populateClientFunctionCallId()     — assign IDs where missing
       │
       ▼
handleFunctionCallsAsync()
       │
       ▼
┌─ For each FunctionCall: ─────────────────────────┐
│                                                    │
│  1. Plugin beforeToolCallback()                   │
│     → if returns response, skip tool execution     │
│                                                    │
│  2. Agent beforeToolCallback[]                    │
│     → callbacks run in order until one returns     │
│                                                    │
│  3. tool.runAsync({ args, toolContext })           │
│     → actual tool execution                        │
│     → on error: plugin onToolErrorCallback()       │
│                                                    │
│  4. Plugin afterToolCallback()                    │
│     → can modify response                          │
│                                                    │
│  5. Agent afterToolCallback[]                     │
│     → callbacks run in order until one returns     │
│                                                    │
│  6. Build function response Event                 │
│                                                    │
└────────────────────────────────────────────────────┘
       │
       ▼
mergeParallelFunctionResponseEvents()
       │  combines all responses into single Event
       ▼
Check for auth requests → generateAuthEvent()
Check for confirmations → generateRequestConfirmationEvent()
Check for agent transfer → run transferred agent
       │
       ▼
yield merged function response Event
```

---

## 12. Tool Confirmation (HITL)

**Reference:** `core/src/tools/tool_confirmation.ts`,
`core/src/tools/tool_context.ts` (lines 113–125),
`core/src/agents/llm_agent.ts` (lines 626–784)

Human-in-the-Loop confirmation allows tools to pause execution for user
approval.

### Requesting Confirmation

Inside a tool or `beforeToolCallback`:

```typescript
toolContext.requestConfirmation({
  hint: 'This will delete all files. Proceed?',
  payload: {fileCount: 42},
});
```

This sets `eventActions.requestedToolConfirmations[functionCallId]`.

### Confirmation Flow

```
Tool requests confirmation
       │
       ▼
generateRequestConfirmationEvent()
  → creates FunctionCall with name "adk_request_confirmation"
  → wraps original FunctionCall + ToolConfirmation in args
  → sets invocationContext.endInvocation = true (suspends loop)
       │
       ▼
Client receives confirmation event
  → presents hint to user
  → user approves/rejects
       │
       ▼
Client sends FunctionResponse with ToolConfirmation { confirmed: true/false }
       │
       ▼
RequestConfirmationLlmRequestProcessor (next run)
  → finds confirmation response in session events
  → matches it to original function call
  → re-executes tool with toolConfirmation in ToolContext
  → tool checks toolContext.toolConfirmation.confirmed
```

### ToolConfirmation Structure

```typescript
class ToolConfirmation {
  hint: string; // display text for user
  confirmed: boolean; // user's decision
  payload?: unknown; // custom JSON-serializable data
}
```

---

## 13. Security Plugin and Policy Engine

**Reference:** `core/src/plugins/security_plugin.ts`

The `SecurityPlugin` intercepts tool calls via the plugin
`beforeToolCallback` and evaluates them against a `BasePolicyEngine`:

```
Tool call arrives
       │
       ▼
SecurityPlugin.beforeToolCallback()
       │
       ▼
First invocation? → policyEngine.evaluate({ tool, toolArgs })
       │
       ├── ALLOW  → tool executes normally
       ├── DENY   → returns error response, tool skipped
       └── CONFIRM → requestConfirmation() + return partial
              │
              ▼
           (HITL flow — see Section 10)
              │
              ▼
           Resumed with ToolConfirmation
              │
              ├── confirmed: true  → tool executes
              └── confirmed: false → returns rejection error
```

The `InMemoryPolicyEngine` is a permissive default (ALLOW all). Custom
engines implement `BasePolicyEngine.evaluate()`.

Policy check state is persisted in session state under
`orcas_tool_call_security_check_states` keyed by function call ID, so
the check runs only once per tool call.

---

## 14. Instructions and Dynamic Context

**Reference:** `core/src/agents/instructions.ts`,
`core/src/agents/llm_agent.ts` (lines 400–451)

### Static Instructions

String templates with `{variable}` placeholders. Session state values
are injected automatically:

```typescript
const agent = new LlmAgent({
  instruction: 'You are helping user {user_name}. Current mode: {app:mode}',
});
```

### Dynamic Instructions (InstructionProvider)

A function that receives `ReadonlyContext` and returns a string:

```typescript
const agent = new LlmAgent({
  instruction: async (context) => {
    const cwd = context.state.get('cwd');
    return `You are in directory: ${cwd}`;
  },
});
```

### State Injection

The `injectSessionState()` function handles template resolution:

- `{var_name}` → session state lookup (throws if missing)
- `{var_name?}` → optional, returns empty string if missing
- `{artifact.filename}` → loads artifact content from artifact service
- Supports state prefixes: `app:`, `user:`, `temp:`

### Instruction Processing Order

The `InstructionsLlmRequestProcessor` appends instructions in this order:

1. **Global instruction** from root agent (if set)
2. **Local instruction** from current agent
3. **Identity instruction** (`"You are an agent. Your internal name is ..."`)

For `InstructionProvider` functions (dynamic), state injection is skipped
(the provider handles its own context). For string templates, state
injection runs automatically.

---

## 15. Schema Conversion (MCP → Gemini)

**Reference:** `core/src/utils/gemini_schema_util.ts`

MCP tools use JSON Schema; Gemini requires its own `Schema` type. The
`toGeminiSchema()` function handles recursive conversion:

| MCP/JSON Schema      | Gemini Type    |
| -------------------- | -------------- |
| `"string"`, `"text"` | `Type.STRING`  |
| `"number"`           | `Type.NUMBER`  |
| `"integer"`          | `Type.INTEGER` |
| `"boolean"`          | `Type.BOOLEAN` |
| `"array"`            | `Type.ARRAY`   |
| `"object"`           | `Type.OBJECT`  |

Special handling:

- **Nullable types** (`anyOf` with null option): extracts the non-null
  alternative
- **Type inference**: objects without explicit `type` but with
  `properties` or `$ref` are inferred as `OBJECT`; with `items` as
  `ARRAY`
- **Nested schemas**: recursively converted, preserving `description`,
  `required`, and `items`

---

## 16. Request Processors Pipeline

**Reference:** `core/src/agents/llm_agent.ts` (lines 1398–1418)

The LLM agent uses an ordered pipeline of request processors that run
before every model call. Order matters:

| #   | Processor                                | Purpose                                                                    |
| --- | ---------------------------------------- | -------------------------------------------------------------------------- |
| 1   | `BasicLlmRequestProcessor`               | Sets model string, config, output schema, live connect config              |
| 2   | `IdentityLlmRequestProcessor`            | Injects agent name + description as system instruction                     |
| 3   | `InstructionsLlmRequestProcessor`        | Resolves global + local instructions with state injection                  |
| 4   | `RequestConfirmationLlmRequestProcessor` | Handles HITL confirmation resumption (re-executes confirmed tools)         |
| 5   | `CompactionRequestProcessor`             | Runs token-threshold compaction on conversation history                    |
| 6   | `ContentRequestProcessor`                | Builds conversation history (`default` = full, `none` = current turn only) |
| 7   | `CodeExecutionRequestProcessor`          | Preprocesses code execution (data files, built-in executor config)         |
| 8   | `AgentTransferLlmRequestProcessor`       | Adds `transfer_to_agent` tool + target agent descriptions (conditional)    |

After processors, tool registration runs (Phase 2 from Section 8).

Response processors are also supported but the default set is empty;
`CodeExecutionResponseProcessor` is added when a code executor is
configured.

---

## 17. Complete Data Flow

End-to-end flow for a single agent turn with MCP tools:

```
User Message
       │
       ▼
Runner.runAsync()
  ├── session.getSession()
  ├── plugin.runOnUserMessageCallback()
  ├── session.appendEvent(userMessage)
  └── agent.runAsync(invocationContext)
              │
              ▼
       LlmAgent.runAsyncImpl()  ←─── while(true) loop
              │
              ▼
       runOneStepAsync()
         │
         ├── [Request Processors 1-8]
         │     └── Instructions, identity, content, etc.
         │
         ├── [Tool Registration]
         │     ├── FunctionTool.processLlmRequest() → adds declaration
         │     ├── MCPToolset.getTools() → discovers MCP tools
         │     │     └── MCPTool.processLlmRequest() → adds declaration
         │     ├── GoogleSearchTool.processLlmRequest() → adds config
         │     └── AgentTool.processLlmRequest() → adds declaration
         │
         ├── [Call LLM]
         │     ├── beforeModelCallback (plugins, then agent)
         │     ├── llm.generateContentAsync()
         │     └── afterModelCallback (plugins, then agent)
         │
         ├── [Response Processors]
         │     └── CodeExecutionResponseProcessor (if configured)
         │
         └── [Postprocess]
               │
               ├── No function calls? → yield final response → break
               │
               ├── pauseOnToolCalls? → yield event, endInvocation → break
               │
               └── Has function calls:
                     │
                     ├── handleFunctionCallsAsync()
                     │     ├── plugin beforeToolCallback
                     │     ├── agent beforeToolCallbacks
                     │     ├── tool.runAsync()  ←── MCPTool calls MCP server
                     │     ├── plugin afterToolCallback
                     │     └── agent afterToolCallbacks
                     │
                     ├── generateAuthEvent() → yield if auth needed
                     │
                     ├── generateRequestConfirmationEvent()
                     │     → yield + endInvocation if confirmation needed
                     │
                     ├── yield function response event
                     │
                     └── transfer_to_agent? → nextAgent.runAsync()
              │
              ▼
       isFinalResponse(lastEvent)?
         ├── yes → break loop
         └── no  → continue loop (next LLM call with tool results)
```

---

## Public API Exports

All tool-related types are exported from `core/src/common.ts` and
re-exported via `core/src/index.ts`:

| Export                                                                         | Source                             |
| ------------------------------------------------------------------------------ | ---------------------------------- |
| `BaseTool`, `isBaseTool`, `BaseToolParams`, `RunAsyncToolRequest`              | `tools/base_tool.ts`               |
| `BaseToolset`, `ToolPredicate`                                                 | `tools/base_toolset.ts`            |
| `FunctionTool`, `isFunctionTool`, `ToolOptions`, `ToolInputParameters`         | `tools/function_tool.ts`           |
| `LongRunningFunctionTool`                                                      | `tools/long_running_tool.ts`       |
| `AgentTool`, `isAgentTool`, `AgentToolConfig`                                  | `tools/agent_tool.ts`              |
| `GoogleSearchTool`, `GOOGLE_SEARCH`                                            | `tools/google_search_tool.ts`      |
| `ToolContext`                                                                  | `tools/tool_context.ts`            |
| `ToolConfirmation`                                                             | `tools/tool_confirmation.ts`       |
| `MCPTool`                                                                      | `tools/mcp/mcp_tool.ts`            |
| `MCPToolset`                                                                   | `tools/mcp/mcp_toolset.ts`         |
| `MCPSessionManager`, `StdioConnectionParams`, `StreamableHTTPConnectionParams` | `tools/mcp/mcp_session_manager.ts` |
| `SecurityPlugin`, `PolicyOutcome`, `BasePolicyEngine`                          | `plugins/security_plugin.ts`       |
| `ToolUnion`, `BeforeToolCallback`, `AfterToolCallback`                         | `agents/llm_agent.ts`              |
