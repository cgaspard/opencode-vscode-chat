# Changelog

All notable changes to OpenCode Agent Panel. Generated from `releasenotes/*.yaml`
by `scripts/render-changelog.js` — edit those, not this file.

## v0.11.0

_Released 2026-09-02_

### Highlights
- oMLX is now recognised as its own local runtime, so a model served through it reports its real vision support and context window instead of looking text-only with a guessed window.

### Added
- oMLX joins LM Studio, Ollama and vLLM as a detected local runtime. Because oMLX and vLLM both default to port 8000, detection reads the `/health` body for oMLX's `engine_pool` block rather than trusting the port, and a server found there is now labelled by what actually answered instead of always being offered as "vLLM".
- Models served by oMLX are read from `/v1/models/status`, which carries the metadata its OpenAI-compatible `/v1/models` surface omits — `model_type: vlm` for multimodal models, the configured `max_context_window`, and load state. A model set up by hand as a plain OpenAI-compatible endpoint is also offered this richer listing, so it is not penalised for having been typed in rather than probed.
- Where an oMLX model declares an alias, the alias is what the picker offers — that is the id its chat endpoint accepts, so selecting the on-disk name would have failed the request.

### Changed
- A local endpoint that reports vision now overrides the capability written into our own generated config. That config records an absent value as an explicit `false`, so without this an oMLX-hosted multimodal model stayed marked text-only and had images stripped before the request.
- vLLM and oMLX both advertise the served context as `max_model_len` on `/v1/models`, and that is now read. Previously the picker fell back to the `minContextLength` setting and reported a window unrelated to the server's real limit.

### Fixed
- The bundled OpenCode server moves from 1.18.17 to 1.18.26. Most relevant here - `textVerbosity` is no longer sent to OpenAI-compatible servers that reject it, a turn no longer stops early on a finish reason OpenCode does not recognise, failed subagent calls surface a resumable task id, and more network-error shapes are retried.

## v0.10.3

_Released 2026-08-29_

### Highlights
- Closing a file now actually removes it from the chat's context — no more phantom "Include open file" row, and no more stale selection riding along on your next message.

### Fixed
- The panel kept the last open file and its selection when the active editor went away, so that clicking into the composer wouldn't wipe your context. But closing a tab fires neither an editor nor a selection change, so a closed file stayed pinned forever — it showed in the + menu and was silently attached to every later prompt. Context is now re-checked against the tabs that are actually open.
- A file closed while the panel was hidden is dropped when the panel comes back, and the check runs once more at send time, so a closed file can never be attached to a prompt.

## v0.10.2

_Released 2026-08-20_

### Highlights
- Long tool commands now truncate with an ellipsis; expand the row to see the full command in a box that scrolls on its own.

### Fixed
- Tool rows are buttons, and buttons size to their content instead of their container — so a long bash command still stretched the row past the panel edge and brought the horizontal scrollbar back. Rows now pin to the panel width and the title ellipsizes like it was always meant to.
- Expanding a bash row now shows the complete command above its output, in a scrollable box, so nothing is lost to the ellipsis. Hovering a truncated title also shows the full text as a tooltip.

## v0.10.1

_Released 2026-08-16_

### Highlights
- Wide content no longer drags the whole panel sideways — long lines wrap, and diffs and code scroll inside their own box.

### Fixed
- One wide diff, code block or long path stretched the entire message column, putting a horizontal scrollbar on the panel and carrying every other message off-screen with it. Message parts can shrink again, so wide content scrolls within itself instead.
- Long unbroken tokens — file paths, URLs, base64 — now wrap inside tool rows and the slash-command help rather than widening the row.

## v0.10.0

_Released 2026-08-15_

### Highlights
- The composer is quieter. Nine controls became four — a + for context, a model chip, a permissions chip, and send — with everything else one click away in two combined menus instead of scattered across the row.
- Permission modes now read Auto, Manual and Bypass, and the mode rides the composer chip itself so a Bypass session is never quiet about it.
- Tool calls in the conversation are single quiet lines instead of boxes, each stamped with when it ran, and file edits show a real diff you can open.

### Added
- A combined model menu. Providers and models live in one popover — the provider list with its enable switches sits at the top, models refresh below it, and the context-window presets stay in the menu footer.
- A behavior menu behind the composer chip, holding agent, thinking and permissions as three sections. Agents are chips, thinking is a slider with the level in its label, and the old alt-click "show reasoning" toggle is finally a visible row.
- Collapsed-by-default edit diffs. Edit and write calls show a +N -M chip on their row; click to open the actual diff, colored with your editor's own diff palette.
- Timestamps throughout the conversation. Every tool call carries when it ran, every finished turn carries when it completed, and pauses longer than fifteen minutes get a quiet divider — so a long session reads as history. Reopening an old chat dates every turn from its real completion time.
- A ? button next to + that prints the slash-command list, now a grouped panel (built-in, from OpenCode, skills) instead of a wall of text.
- An add-context menu on the + button, listing everything extra that will be sent — attached images, the open file, and the editor selection that used to be attached invisibly.

### Changed
- One accent color, used for two things. The theme accent now paints only the send button and the focused input border; status dots, progress fills, active pills and the spinner went monochrome, so the accent means something again.
- Semantic colors collapsed to one each. Three different yellows became one warning color, two reds became one error color, and green is now reserved for a single meaning — a model ready to serve.
- The model dot has three states — dim for nothing chosen, white for chosen but not serving, green for ready.
- The status line and the Working indicator merged into one activity strip, so a running turn no longer stacks two rows above the input.
- The context meter became a 2px edge on the composer itself. It stays ambient below 70% and announces itself with a label and warning color above it.
- The per-turn stat line trimmed to four fields; the agent name, grand total and thinking share moved to its tooltip. Both it and the context meter now use the same 1024-base formatting, so one token count no longer renders as two different numbers.
- The context readout sits on the composer card's top-right line, above where you type, and is laid out in normal flow so it can never overlap a long message.
- Reasoning blocks restored from a saved conversation open collapsed and labelled with how long the model thought, instead of expanded and still saying "Thinking...".

### Fixed
- The panel could go quiet after changing permissions, the context size, or adding an agent. Those settings restart the local agent server, which comes back on a new port, and the event stream kept retrying the old one — so the panel looked connected with a model loaded but never received another event. It now re-subscribes to the new server as soon as it comes back.
- The permissions picker used to be the first control to vanish into the overflow menu on a narrow panel, hiding the one setting that most deserves to stay visible. There is no overflow menu now, and the mode rides the chip.
- Popover shadows, selection highlights and badge backgrounds used hardcoded fallbacks that ignored the active theme; they now follow theme tokens and behave in light themes.
- Only the last message of a turn had its reasoning collapsed, so earlier blocks in a multi-step turn stayed open forever.
- Three provider tests exercised a tabbed add-provider UI that no longer existed; they now drive the real flow.

### Removed
- The composer overflow menu, along with the providers pill, paperclip, thinking pill, goal button and the two dropdown pickers it used to swallow. Every one of those actions still exists — in the two menus or as a slash command.

## v0.8.0

_Released 2026-08-14_

### Highlights
- Permission levels are now yours to set. A new permissions picker in the composer chooses how often the agent asks for approval — Ask risky only (the default), Ask always, or Bypass all for full autonomy in workspaces you trust.
- Stopping a response now shows one quiet "Stopped" note instead of two harsh red "Aborted" banners.

### Added
- Permissions picker in the composer with three modes. Ask risky only keeps today's behavior (outside-the-workspace access and .env reads prompt); Ask always requires approval for every tool call; Bypass all never asks — every tool call is auto-approved. Backed by the new permissionMode setting (workspace-scoped when a folder is open, so trusting one project with Bypass doesn't leak into others), and the picker turns amber while Bypass is on as a quiet reminder.

### Changed
- Error notes in the conversation are softer. Genuine errors now render as a subtle tint derived from the theme's error color instead of the theme's solid validation fill, which in many themes was a loud salmon banner.
- Mode changes apply from the next message (the local agent server restarts with the new ruleset baked in); a chip in the chat confirms the switch.

### Fixed
- Aborting a response produced two stacked red "Aborted" alerts. OpenCode reports one stop through several channels, and two of its error shapes slipped past the dedup; all abort shapes now collapse into a single muted "Stopped" chip. A stop you asked for is not an error and no longer looks like one.

## v0.6.0

_Released 2026-08-13_

### Highlights
- /compact works again on real conversations. The request that triggers compaction was being cut off after 30 seconds, so any summarization that took longer surfaced an error — even though the compaction itself had succeeded.
- Server slash commands and skills were hitting the same 30-second cutoff mid-run. A command like /init that takes a minute now runs to completion without a spurious error.

### Changed
- /compact no longer reports failure when only the HTTP request failed. OpenCode finishes the summarization regardless of whether the panel is still listening, so a dropped request now checks the session for a new compaction marker and reports success — with the summary — when the work actually landed.

### Fixed
- /compact failed with a timeout error on any conversation large or slow enough to need more than 30 seconds to summarize. Measured against a local 27B, even a two-turn session took 49 seconds, so this affected essentially every real compaction. The conversation was compacted anyway, but the panel showed an error and no summary chip.
- Server-provided slash commands and skills aborted after 30 seconds while still running. Measured at 47 seconds for /init on a local 20B.

## v0.5.0

_Released 2026-08-12_

### Highlights
- Bundled OpenCode upgraded 1.18.11 → 1.18.17, six upstream releases of fixes verified end-to-end with zero changes to existing behavior.

### Changed
- The bundled OpenCode server is now 1.18.17. Message history is ordered by true chronology, repeated /compact keeps earlier tool-call history in summaries and produces clearer summaries on smaller models, MCP connections recover better after errors and expired sessions, transient model-server errors are retried with a cap (~5 attempts) instead of hanging the turn forever, and unknown config keys no longer risk breaking server startup.
- Every consumed endpoint and event was verified live on the new server — streaming, thinking blocks (both reasoning field styles models use), reasoning-effort variants on the wire, /compact plus post-compaction turns, session history, and permission prompts all behave exactly as before.

## v0.4.0

_Released 2026-08-05_

### Highlights
- Stable release of what landed in the 0.3.0 pre-release. Same code, now on the stable channel.
- Command-line tools the agent runs can see your real environment again. Most visibly, `gh` is authenticated - it was reporting "not logged into any GitHub hosts" on machines where `gh auth status` works fine in a terminal.
- The cause was this extension, not OpenCode. To keep its managed OpenCode server from sharing state with your own OpenCode install, the extension pins XDG_CONFIG_HOME and friends to a private directory - and every command the agent ran inherited them.
- That silently broke any tool that follows the XDG spec. `gh` reads $XDG_CONFIG_HOME/gh/hosts.yml to learn which hosts exist before it consults the keychain, so with the pin in place it concluded there were none. `helm` lost its repo list and chart cache the same way.
- Fixed without giving up the isolation - OpenCode still keeps its own state in the private directory. Only the commands the agent spawns get your real values back.

### Added
- A small OpenCode plugin ships with the extension and restores the host's XDG_DATA_HOME, XDG_CONFIG_HOME, XDG_CACHE_HOME and XDG_STATE_HOME for shell commands the agent runs.
- stdio MCP servers get the same treatment through their per-server environment map, since the plugin hook does not reach them.

### Changed
- A variable that was unset on your machine is now genuinely unset for the agent's commands rather than being set to an empty string, which is not the same thing to a tool that joins the value onto a path.
- An MCP server's own environment still wins over these values, so deliberately pointing one at a different config directory keeps working.

### Fixed
- `gh` reported not being logged in, so the agent could not file issues, open pull requests, or read anything through the GitHub CLI even on a fully authenticated machine.
- `helm` resolved HELM_CONFIG_HOME, HELM_CACHE_HOME and HELM_DATA_HOME into the extension's private directory, so repo lists and chart caches came back empty.
- Any other XDG-respecting CLI the agent invoked had the same problem, including tools invoked indirectly from a script.
- Packaging no longer picks up local agent config or generated code-graph output when the .vsix is built on a developer machine rather than in CI.

## v0.3.0

_Released 2026-08-05_

### Highlights
- Command-line tools the agent runs can see your real environment again. Most visibly, `gh` is authenticated - it was reporting "not logged into any GitHub hosts" on machines where `gh auth status` works fine in a terminal.
- The cause was this extension, not OpenCode. To keep its managed OpenCode server from sharing state with your own OpenCode install, the extension pins XDG_CONFIG_HOME and friends to a private directory - and every command the agent ran inherited them.
- That silently broke any tool that follows the XDG spec. `gh` reads $XDG_CONFIG_HOME/gh/hosts.yml to learn which hosts exist before it consults the keychain, so with the pin in place it concluded there were none. `helm` lost its repo list and chart cache the same way.
- Fixed without giving up the isolation - OpenCode still keeps its own state in the private directory. Only the commands the agent spawns get your real values back.

### Added
- A small OpenCode plugin ships with the extension and restores the host's XDG_DATA_HOME, XDG_CONFIG_HOME, XDG_CACHE_HOME and XDG_STATE_HOME for shell commands the agent runs.
- stdio MCP servers get the same treatment through their per-server environment map, since the plugin hook does not reach them.

### Changed
- A variable that was unset on your machine is now genuinely unset for the agent's commands rather than being set to an empty string, which is not the same thing to a tool that joins the value onto a path.
- An MCP server's own environment still wins over these values, so deliberately pointing one at a different config directory keeps working.

### Fixed
- `gh` reported not being logged in, so the agent could not file issues, open pull requests, or read anything through the GitHub CLI even on a fully authenticated machine.
- `helm` resolved HELM_CONFIG_HOME, HELM_CACHE_HOME and HELM_DATA_HOME into the extension's private directory, so repo lists and chart caches came back empty.
- Any other XDG-respecting CLI the agent invoked had the same problem, including tools invoked indirectly from a script.

## v0.2.1

_Released 2026-08-01_

### Highlights
- The provider on/off switch now responds the moment you click it, instead of appearing stuck while the agent restarts.
- OpenCode Zen can take a paid API key. Previously it could only ever run on its free tier.

### Added
- A paid OpenCode Zen key can be entered from the Providers panel. The row shows whether Zen is running on the free tier or your paid account, and removing the key drops back to free.

### Fixed
- Toggling a provider used to leave the switch in its old position until the agent finished restarting — seconds later — so it read as a control that did nothing. It now flips immediately, shows that work is in progress, and corrects itself if the change does not apply. A second click while one is still applying is ignored rather than queueing another restart.
- A stored Zen key survives disabling and re-enabling the provider. It was previously discarded from the panel's view while still being used, so the key was live but invisible.

## v0.2.0

_Released 2026-08-01_

### Highlights
- First release. A full coding agent in VS Code, running on whichever models you bring — cloud API keys, local servers, or both at once.
- Works before you configure anything: OpenCode's free Zen models are built in, so a fresh install answers your first question with no key and no account.
- Add a provider in two clicks — search the models.dev catalog, paste a key. 170+ providers work with no per-provider setup, because model lists, context limits, capabilities and prices all come from the provider itself.
- Local servers are first class — LM Studio, Ollama, vLLM or any OpenAI-compatible endpoint, with a one-click scan of the usual ports.

### Added
- Providers panel — configured providers with live status, searchable catalog, masked key entry, per-provider enable/disable, and edit/remove.
- Model picker grouped by provider, showing context window, vision/tool badges, and price per million tokens where a model is priced.
- LM Studio extras where they apply — loaded/unloaded state, publisher, format and quantization, load/eject from the menu, and automatic context-window management.
- Reasoning effort derived from what each model actually declares — Anthropic low/medium/high/max, OpenAI medium/high/xhigh, Auto/Off/On for most local models, hidden entirely for models that cannot reason.
- Agent panel carried over from the LM Studio edition it forks — tool cards with permission prompts, build/plan modes, live todo lists, user-defined agents and delegation, autonomous goals with an LLM judge, session history and restore, MCP servers discovered from Claude Code and VS Code configs, skills, and slash commands.
- Model picker groups collapse by provider, all but the one holding your current model — a flat list over a 300-model provider is unusable, and you can still see which model you are on.
- Known local runtimes are one click from the provider search — LM Studio, Ollama and vLLM prefill their default address, plus a Custom server row for anything else.

### Changed
- Bundled OpenCode 1.18.11, which brings three MCP fixes (stuck SSE reconnect loops, reconnecting after expired SDK sessions, legacy client compatibility), reasoning-field parsing for providers using custom field names, and correct per-SDK prompt-cache keys.
- Adding a provider is one search over both kinds. What you click decides the form — a keyed provider asks for a key, a local server asks for an address — instead of two tabs you had to choose between first.
- Models are identified as provider/model, so the same model id under two providers is never ambiguous.
- Every enabled provider is live at once — switching from a local model to Claude is a model choice, not a server switch, and keeps your session.
- The offline banner now means nothing at all can serve a model. A single local server going down while another provider works is reported on that provider's row, and on the banner only when it is the one serving your selected model.
- Cloud providers are never polled for liveness — probing a metered API would bill you to learn what the next real request reports for free.

### Fixed
- The context-window control no longer appears for models whose window is not ours to set. Choosing one on a cloud model silently rewrote the local setting and metered the usage bar against a window five times too small.
- A local server added by typing its address now has its runtime detected, so an LM Studio box elsewhere on your network keeps load/eject, context management and its identity badges instead of degrading to a plain OpenAI-compatible endpoint.
- Local servers no longer appear under "add an API key". Four models.dev entries are really local runtimes, so searching for LM Studio offered a key prompt for something that has none.
- The providers panel no longer clips its own contents. Both add-forms rendered on top of each other, which pushed the local form off the bottom and squeezed the provider list — and its enable/disable switches — out of view.

### Removed
- The single hardcoded LM Studio server, and its opencodeChat.lmStudioBaseUrl setting, replaced by the provider registry.
