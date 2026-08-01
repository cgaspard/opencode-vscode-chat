# OpenCode Agent

**A real coding agent in VS Code — on whichever models you bring.**

Not autocomplete. This is a full agent panel: it reads and edits your files, runs shell commands, asks permission before it touches anything, works through a todo list, and keeps going until the job is done.

**Bring your own models.** Paste an API key for Anthropic, OpenAI, Google, OpenRouter — or any of the 170+ providers in the [models.dev](https://models.dev) catalog — and/or point it at a local [LM Studio](https://lmstudio.ai), [Ollama](https://ollama.com) or [vLLM](https://docs.vllm.ai) server. Configure as many as you like: they are all live at once, and switching from a local model to Claude is a model choice, not a reconnect.

**It works before you configure anything.** OpenCode's own free *Zen* models are built in, so a fresh install can answer your first question with no key and no account.

Powered by the open-source [**OpenCode**](https://opencode.ai) agent, bundled right in.

<!-- Absolute raw.githubusercontent URLs, not repo-relative paths: the
     Marketplace serves this README from its own domain and will not resolve
     relative images. These live in the repo but are excluded from the .vsix. -->
<img src="https://raw.githubusercontent.com/cgaspard/opencode-vscode-chat/main/media/screenshots/panel.png" alt="The agent working through a task in the side bar, with expandable tool cards for each step" width="420" />

| Every provider in one panel | One picker, grouped by provider |
| --- | --- |
| <img src="https://raw.githubusercontent.com/cgaspard/opencode-vscode-chat/main/media/screenshots/providers.png" alt="Providers panel showing OpenCode Zen, Anthropic, OpenRouter and a local LM Studio server, each with an enable switch, above a single search that adds either an API-key provider or a local server" width="380" /> | <img src="https://raw.githubusercontent.com/cgaspard/opencode-vscode-chat/main/media/screenshots/models.png" alt="Model picker with provider groups collapsed except the current model's, showing context window, price per million tokens and capability badges" width="380" /> |

## The agent

- **Real tools** — reads files, writes edits, runs shell commands, searches your codebase. Every step shows up as a tool card you can expand.
- **You stay in control** — inline permission prompts on every action: *Allow once*, *Allow always*, or *Deny*.
- **Build or plan mode** — `build` edits your code; `plan` is strictly read-only for when you just want a strategy.
- **Live todo list** — the agent's plan renders as a checklist that ticks off in place as it works, with a progress count.
- **See it think** — reasoning models get collapsible *Thinking* blocks. Alt-click the thinking pill to hide them without changing how the model works.
- **Dial the thinking** — set reasoning effort per model from the model menu, the composer pill, or `/effort`. The levels offered are the ones the model actually declares, so you never get a slider that does nothing.
- **Streaming everything** — responses render as markdown with syntax-highlighted code as they arrive.

## Agents — specialists you define

- **Bring your own agent** — drop a `.opencode/agent/<name>.md` in your workspace (YAML frontmatter + a body that becomes its system prompt) and it shows up in the agent picker. Each agent can pin its own model, restrict which tools it may use, and set its own reasoning effort.
- **`mode` decides who reaches it** — `primary` puts it in your picker; `subagent` keeps it out of the picker and lets *the model* delegate to it through the built-in task tool when your request matches its `description`; `all` does both.
- **Delegation saves context, it doesn't spend it** — a subagent runs in its own session with its own context window and returns only its answer, so a long search doesn't fill up the conversation you're having.
- **`/agents`** shows both halves — what you can select, and what the model can delegate to. **`/agents new <name>`** scaffolds a definition and opens it.
- Heads up: new agents are picked up when the OpenCode server restarts, and delegation depends on your local model reliably calling tools — smaller models may just answer directly instead.

## Goals — point it at an objective and walk away

- **`/goal <objective>`** starts an autonomous loop. After each turn, an isolated judge — running on *your* local model — decides whether the goal is actually met. If it isn't, the agent continues with specific feedback about what's still missing.
- **A pinned goal bar** tracks the objective, round count, and elapsed time, with edit / pause / resume / clear controls.
- **It can't run away** — a 25-round cap plus stall detection that pauses the loop and tells you why when progress flatlines.
- **It listens** — change your mind mid-goal and it notices, offering a one-click *Update goal* instead of chasing a stale target.

## Steer it mid-flight

Type while the agent is working and hit Enter — your instructions get injected at its next step, so it adjusts work already in progress instead of you stopping and starting over. The stop button still stops.

## Your models, your keys

- **Add a provider in two clicks** — search the models.dev catalog, paste a key, done. No per-provider setup: the model list, context limits, capabilities and prices all come back from the provider itself.
- **Local servers too** — LM Studio, Ollama, vLLM, or anything else speaking OpenAI-compatible `/v1`. A one-click scan finds servers already running on the usual ports.
- **One picker, every provider** — models grouped by provider, with context window, vision/tool badges, and price per million tokens where there is one. Local models additionally show loaded ● / unloaded ○, publisher, format (MLX/GGUF) and quantization, and can be loaded or ejected right from the menu.
- **Keys stay secret** — stored in VS Code's encrypted Secret Storage, never in a settings file, never sent back to the UI, and never inherited by the tool processes the agent spawns (they are handed to OpenCode through a 0600 file reference, not the environment).
- **Effort that matches the model** — the reasoning levels offered are the ones each model actually declares: Anthropic's low/medium/high/max, OpenAI's medium/high/xhigh, or the honest Auto/Off/On that most local models really support. Models with no reasoning support hide the control entirely.
- **Context handled for you** — on LM Studio, the extension reloads your model with an adequate context window, so a 4096-token default never blows up mid-task.
- **Room to think** — the output budget scales with the context window (up to 32k), so long reasoning doesn't get chopped off mid-answer. If a response does hit the ceiling, you're told.
- **Quiet by default** — a 30-second liveness check shared across panels, paused when hidden, and only ever against your *local* servers: probing a metered API to see if it is alive would bill you to learn what the next real request tells us for free.

## Context, without the busywork

- **Highlight to share** — select code in any file and it's automatically attached to your next message, exact lines and range included. No pill to manage, no setup.
- **`/file`** toggles the open file as context.
- **Paste images** — screenshots and mockups attach as labelled chips with dimensions; click for a full-size lightbox.
- **`/compact`** summarizes the conversation to reclaim context when you're running low, and shows you the summary it produced.
- **A context meter** above the composer so you always know where you stand.

## Sessions that survive

- **Auto-restored** — reopen VS Code and your last conversation is right where you left it, per workspace.
- **Full history** — browse, resume, rename, and delete past sessions. Empty chats never clutter the list.
- **Work in parallel** — *Open in Editor Tab* gives a conversation its own tab, so you can run several at once.

## Extend it — MCP servers and skills

- **MCP tools** — browser automation, databases, issue trackers, docs. Local (stdio) and remote (http/sse) servers both work, and their tools get the same tool cards and permission prompts as built-ins.
- **Nothing to re-enter** — the `.mcp.json` you already wrote for **Claude Code** and the `.vscode/mcp.json` you wrote for **VS Code** are discovered automatically.
- **`/mcp`** shows live status per server: 🟢 connected, 🟡 disabled, 🔴 failed with the reason. A broken server never blocks your chat.
- **`/skills`** lists the skills available to the model with their source (project / global / built-in) and path — your `.opencode/skill` and `.claude/skills` are picked up too.
- **Slash commands** — type `/` for a filterable menu: `/clear`, `/compact`, `/file`, `/mcp`, `/skills`, `/goal`, `/help`, plus your own skills and OpenCode commands, with arguments.

## Fits your window

The panel lives in the Activity Bar (or the secondary side bar), and the composer adapts to narrow layouts — lower-priority controls tuck into a ⋯ menu instead of getting pushed off-screen.

---

## Quick start

1. Install this extension.
2. Click the spark icon in the Activity Bar.
3. Type a task and hit Enter — the built-in free models answer with nothing configured.
4. When you want your own models, open **Providers** and either paste an API key or add a local server.

### Requirements

- **VS Code** 1.104+
- That's it to get started. For your own models, one of:
  - an **API key** for any provider in the [models.dev](https://models.dev) catalog (Anthropic, OpenAI, Google, OpenRouter, Groq, xAI, DeepSeek, Mistral, …), or
  - a **local server** speaking the OpenAI-compatible API — [LM Studio](https://lmstudio.ai) (default `http://127.0.0.1:1234`), [Ollama](https://ollama.com) (`11434`), [vLLM](https://docs.vllm.ai) (`8000`), or anything else
- *(LM Studio only, recommended)* the **`lms` CLI** as a fallback for automatic context-window management

> **[OpenCode](https://opencode.ai) is bundled** — the matching platform binary ships inside the extension, so there's nothing extra to install and it works offline. Power users can point at their own build with `opencodeChat.opencodePath`; an install on your `PATH` or in `~/.opencode/bin` is preferred over the bundled copy if present.
>
> OpenCode is MIT-licensed by [sst/opencode](https://github.com/sst/opencode) and is redistributed here unmodified; its notice ships alongside the binary as `bin/LICENSE.opencode`. This extension is an independent project and is not affiliated with or endorsed by the OpenCode maintainers.

### Beta channel

New features ship to the Marketplace **pre-release** channel first (odd minor
versions, e.g. `0.13.x`; stable releases use even minors). To try betas, open
the extension's Marketplace page in VS Code and click **Switch to Pre-Release
Version** — VS Code updates you along the beta track and you can switch back
any time with **Switch to Release Version**.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `opencodeChat.autoDetectLocalServers` | `true` | Offer local servers found on the well-known ports on first run |
| `opencodeChat.opencodePath` | _(bundled)_ | Override path to an `opencode` binary; empty uses your own install (PATH / `~/.opencode`) or the bundled one |
| `opencodeChat.serverPort` | `0` | Embedded server port (0 = auto) |
| `opencodeChat.defaultModel` | _(first)_ | Default model as `provider/model`, e.g. `anthropic/claude-sonnet-4-6` |
| `opencodeChat.agent` | `build` | `build` or `plan` |
| `opencodeChat.autoEnsureContext` | `true` | *(LM Studio only)* Reload the model with an adequate context window before prompting |
| `opencodeChat.minContextLength` | `32768` | *(LM Studio only)* Context length to (re)load with |
| `opencodeChat.defaultThinkingEffort` | `auto` | Starting reasoning effort for models you haven't set one for; snapped to the levels each model declares |
| `opencodeChat.gpuOffload` | `max` | *(LM Studio only)* GPU offload for `lms load` |
| `opencodeChat.healthCheckSeconds` | `30` | Local-endpoint poll cadence while connected (5–600). Cloud providers are never polled. Disconnected retries stay at 5s; the model list refreshes immediately while the model picker is open |

Providers themselves are **not** settings — they live in the Providers panel, because their API keys belong in Secret Storage rather than a JSON file.
| `opencodeChat.mcpServers` | `{}` | MCP servers to expose to the agent (in addition to auto-discovered ones) |

## MCP servers

The agent can call tools from [MCP (Model Context Protocol)](https://modelcontextprotocol.io) servers — browser automation, databases, issue trackers, docs, and more. OpenCode runs the servers; this extension just gathers them from wherever you've configured them and hands them over.

### Where servers come from

Servers are merged from these sources, in increasing precedence (a later source wins on a name collision):

| # | Source | Format | Top-level key |
| --- | --- | --- | --- |
| 1 | `.mcp.json` at your workspace root | **Claude Code** project format | `mcpServers` |
| 2 | `.vscode/mcp.json` in your workspace | **VS Code** workspace format | `servers` |
| 3 | VS Code's user-level `mcp` setting | **VS Code** user format | `servers` |
| 4 | `opencodeChat.mcpServers` (VS Code settings) | bare map of name → server | _(the map itself)_ |

If you already use MCP with Claude Code or VS Code Copilot, those servers work here with **nothing to re-enter**. Use `opencodeChat.mcpServers` to add a server just for OpenCode Agent, or to override a discovered one.

### Setting up a `.mcp.json` (shareable, per project)

Create `.mcp.json` at your project root — the same file Claude Code uses, so it's safe to commit and share with your team:

```jsonc
{
  "mcpServers": {
    // local (stdio) server — runs a command, talks over stdin/stdout
    "playwright": {
      "command": "npx",
      "args": ["-y", "@playwright/mcp@latest"]
    },
    // local server with a working dir and env var
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."],
      "env": { "LOG_LEVEL": "info" }
    },
    // remote (http/sse) server, with a token pulled from the environment
    "docs": {
      "type": "http",
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer ${MY_TOKEN}" }
    },
    // defined but off — won't be started
    "staging": {
      "command": "npx",
      "args": ["-y", "some-mcp-server"],
      "enabled": false
    }
  }
}
```

A `.vscode/mcp.json` is identical except the top-level key is `servers` instead of `mcpServers` (VS Code's convention) — both are supported.

### What's supported

| Field | Applies to | Notes |
| --- | --- | --- |
| `command` | local (stdio) | Executable name or path (e.g. `npx`, `uvx`, an absolute path). |
| `args` | local (stdio) | Array of arguments passed to `command`. |
| `env` | local (stdio) | Environment variables for the server process. |
| `type` | both | `"http"` / `"sse"` mark a remote server; `"stdio"` / `"local"` a local one. Inferred from the fields when omitted (a `url` ⇒ remote, a `command` ⇒ local). |
| `url` | remote (http/sse) | The server endpoint. |
| `headers` | remote (http/sse) | HTTP headers, e.g. an `Authorization` token. |
| `enabled` | both | Set `false` to keep a server defined but not started. |

- **`${VAR}` references** in `env` values, `headers`, and `url` are resolved from the environment before the server launches — keep secrets in your environment, not in the file.
- **Transports:** local (stdio) and remote (http/sse). Both the Claude Code field shape (`command` + `args`) and the VS Code shape are accepted and normalized for you.

### Checking status — the `/mcp` command

Type **`/mcp`** in the chat to list your configured servers and their live status:

- 🟢 **connected** — running and its tools are available
- 🟡 **disabled** — defined but `"enabled": false`
- 🔴 **failed** — couldn't start/connect; the reason is shown (a bad server never blocks the chat)

Each row shows the transport (local/remote) and the command or URL it was configured with.

### Notes

- **Applying changes.** Edits to `opencodeChat.mcpServers` (or VS Code's `mcp` setting) restart the agent automatically. Edits to the `.mcp.json` / `.vscode/mcp.json` files apply on the next **OpenCode Agent: Restart OpenCode Server** (or a window reload).
- **Mind the context window.** Each MCP server adds its tool schemas to every request. Local models have far less context than cloud ones (OpenCode's own system prompt + built-in tools already use ~11k tokens), so enable only the servers you need and raise `opencodeChat.minContextLength` if tools start crowding out the conversation.
- **`npx`/`uvx` on `PATH`.** Local servers launched with `npx`/`uvx` need Node and those tools on `PATH`. The extension augments `PATH` with common install locations (Homebrew, `~/.local/bin`, nvm/fnm, bun, cargo), but if a server shows as **failed**, check **OpenCode Agent: Show Logs**.

## How it works

```
VS Code webview (chat UI)
        │  postMessage
        ▼
Extension host (bridge)          providers + keys (Secret Storage)
        │  HTTP + SSE  (raw fetch)
        ▼
opencode serve  ──┬── Anthropic / OpenAI / Google / OpenRouter / …
  (headless,      ├── LM Studio · Ollama · vLLM   (OpenAI /v1, local)
   config         └── OpenCode Zen                (built in, no key)
   injected)
```

Every provider you enable is injected into OpenCode at launch via the
`OPENCODE_CONFIG_CONTENT` environment variable — **nothing is written to your
workspace or global config.**

- **Cloud providers** need only their `apiKey`; the model list, limits, prices
  and reasoning variants come from OpenCode's own catalog, which is why 170+
  providers work without a line of per-provider code.
- **Local servers** are declared as `@ai-sdk/openai-compatible` providers with
  their models enumerated from the server itself, since no catalog knows what
  you are running on your own machine.
- **API keys never touch the environment.** `OPENCODE_CONFIG_CONTENT` is process
  environment, and stdio MCP servers inherit it — so each key is written to its
  own `0600` file and referenced with OpenCode's `{file:…}` placeholder, which
  the server resolves at load. Removing a provider deletes its file.

## Develop from source

```bash
npm install
npm run bundle:opencode      # fetch the pinned OpenCode binary into bin/ for your platform
npm run compile              # type-check + bundle (extension + webview)
# then press F5 in VS Code to launch the Extension Development Host
npm run package:vsix:bundled # build a platform .vsix with the binary embedded
```

The OpenCode binary is fetched at build time (pinned by `opencodeVersion` in
`package.json`) and is never committed — `bin/` is git-ignored. Bump that field
to upgrade the bundled OpenCode. F5 also resolves the binary from `bin/`, so run
`bundle:opencode` once before launching the dev host.

## License

MIT
