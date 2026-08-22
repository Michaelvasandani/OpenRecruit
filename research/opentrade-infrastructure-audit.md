# OpenTrade infrastructure and recruiting-seam audit

**Research ticket:** [#2 — Audit OpenTrade's infrastructure and recruiting seams](https://github.com/Michaelvasandani/OpenRecruit/issues/2)  
**Audited snapshot:** `9bbbcdf51983f4a349fbc70158389e64650dd7c0` (`Release v0.2.5`, 2026-08-21)  
**Method:** Static inspection of the committed repository source, tests, manifests, templates, packaging configuration, and Git metadata. No upstream documentation was needed to establish the implementation facts below.

## Executive answer

OpenTrade is not a trading algorithm wrapped in a desktop shell. Its center is a local, persistent agent-runtime platform: an Electron launcher adopts a detached backend host; that host owns agent folders, resumable CLI sessions, PTYs, a SQLite database, a scheduler, per-agent wake queues, authenticated local transports, notifications, and a tRPC control plane. The host keeps running after the GUI closes, while interactive PTYs are deliberately killed and queued work reroutes to headless execution ([host wiring](../app/src/main/host/index.ts#L1-L11), [terminal lifecycle](../app/src/main/services/terminal/index.ts#L32-L43)).

The most domain-neutral seams are already explicit:

- `Harness` isolates Claude-versus-Codex launch, session, wake, environment, and config behavior ([interface](../app/src/main/services/harness/types.ts#L3-L14), [registry](../app/src/main/services/harness/index.ts#L8-L26)).
- `WakeTransport` separates trigger production from interactive/headless delivery, and the coordinator owns a single per-agent FIFO and writer state machine ([transport contract](../app/src/main/services/scheduler/wake/types.ts#L1-L35), [state machine](../app/src/main/services/scheduler/wake/coordinator.ts#L30-L59)).
- `BrokerAdapter` separates the broker-facing service from one concrete Robinhood client, but it abstracts only among trading backends, not among arbitrary recruiting sources ([adapter](../app/src/main/services/broker/adapter.ts#L21-L65)).
- SQLite/Drizzle schema bootstrap and additive migration machinery are independent of trading even though several current tables are not ([database bootstrap](../app/src/main/db/client.ts#L25-L53), [migration contract](../app/src/main/db/migrate.ts#L1-L25)).
- The renderer is a thin client over generic tRPC subscriptions and an authenticated terminal WebSocket; the current right-side information architecture is trading-specific ([app shell](../app/src/renderer/App.tsx#L43-L57), [terminal controller](../app/src/renderer/lib/terminal/session-controller.ts#L11-L20)).

Trading coupling is concentrated rather than uniformly spread: generated harness configuration names Robinhood and order tools; the approval model parses and correlates orders; audit kinds encode the order lifecycle; the broker cache/poller and OAuth provider are Robinhood/account oriented; onboarding requires Robinhood; the Portfolio and Activity panels render brokerage concepts; and the bundled agent instructions define a funded-equities trading mandate ([Claude harness config](../app/src/main/services/harness/claude.ts#L20-L84), [approval types](../app/src/shared/approval.ts#L3-L24), [agent instructions](../templates/agents/CLAUDE.prefix.md#L1-L15)).

This report classifies facts and exposes seams. It intentionally does **not** decide whether any component should be reused, adapted, replaced, or removed.

## Coupling scale

| Classification | Meaning in this report |
|---|---|
| Domain-neutral | The component's state and contract do not require trading concepts. Names and copy may still say OpenTrade. |
| Mixed | A reusable mechanism and a trading policy or schema share the same module or public contract. |
| Trading-coupled | The component's primary data model or behavior is brokerage, market, or order specific. |

## Source-path-backed inventory

### 1. Persistent host, launcher, and service composition — mixed

**Domain-neutral infrastructure.** The Electron process is a launcher/thin client. It discovers or spawns a singleton detached host, reconnects over localhost, recreates windows from notifications or the menu bar, and keeps the host alive when the window closes ([launcher state and window lifecycle](../app/src/main/index.ts#L24-L45), [host adoption](../app/src/main/index.ts#L221-L252)). `HostManifest` is a generic local-process discovery contract containing PID, service ports, bearer token, start time, and build version; lockfile acquisition prevents duplicate hosts ([manifest contract](../app/src/main/host/manifest.ts#L7-L35), [liveness check](../app/src/main/host/manifest.ts#L57-L95)). The headless host composes database, registry, settings, scheduler, terminal, notifications, approvals, audit, broker, and tRPC services and shuts them down in a bounded order ([composition](../app/src/main/host/index.ts#L64-L118), [shutdown](../app/src/main/host/index.ts#L239-L270)).

**Trading coupling.** The host composition directly constructs `RobinhoodAdapter`, `BrokerService`, and order-specific `ApprovalService`; launcher focus changes broker polling cadence, and notification kinds include orders and approvals ([host broker wiring](../app/src/main/host/index.ts#L97-L105), [launcher broker relay](../app/src/main/index.ts#L71-L95), [notification routing](../app/src/main/index.ts#L47-L54)). The seam is the composition root: the process-supervision architecture is neutral, while its concrete service graph is not.

### 2. Agent registry, folders, and memory — mixed

**Domain-neutral infrastructure.** `AgentRegistry` provides stable IDs/slugs, archive semantics, harness choice, persistent last-session IDs and last-active timestamps, runtime execution-state projection, and per-agent folders under the app home ([registry ownership](../app/src/main/services/agents/registry.ts#L62-L77), [identity/create](../app/src/main/services/agents/registry.ts#L131-L175)). Each folder is explicitly the agent's work-product space; the registry adds `.opentrade`, `journal`, an instructions file, and a first-run marker ([scaffold](../app/src/main/services/agents/registry.ts#L178-L229), [session markers](../app/src/main/services/agents/registry.ts#L363-L383)). This file workspace is OpenTrade's durable agent memory: transcripts remain owned by the external harness, while strategy/journal/watch files are ordinary files.

**Trading coupling and missing recruiting model.** The shared instruction prefix carries Robinhood, order-approval, market-data, `STRATEGY.md`, and trading-journal policy ([Claude prefix](../templates/agents/CLAUDE.prefix.md#L3-L15), [environment/data contract](../templates/agents/CLAUDE.prefix.md#L17-L44)). The persisted `Agent` shape has harness/approval/session/execution fields but no Candidate Profile, Discovery Strategy, source, opportunity, evidence, fit evaluation, revisit, or review entity ([agent schema](../app/src/shared/agent.ts#L30-L68)). Agent-folder memory is flexible enough to hold those artifacts, but the application neither types nor indexes them.

**Committed-template gap surfaced by the audit.** `readTemplateSpecialty` expects `templates/agents/<template>/CLAUDE.md` ([reader](../app/src/main/services/agents/registry.ts#L30-L40)), and registry tests expect specialty markers for default, DCA, and momentum templates ([test expectations](../app/src/main/services/agents/registry.test.ts#L85-L121)). At this snapshot those specialty files are not in the committed tree because the repository-wide `CLAUDE.md` ignore rule also matches them ([ignore rule](../.gitignore#L22-L29)); only prefixes, kickoff files, and `.mcp.json` files are committed. A clean checkout therefore seeds an empty specialty unless the user types one, and those composition tests cannot meet their stated fixtures.

### 3. Harnesses and resumable sessions — mixed, with a deep seam

**Domain-neutral infrastructure.** `Harness` centralizes binary probing, instruction filename/prefix, interactive and headless argv, environment layering, config generation, session adoption/verification, and per-harness auth stripping. Its contract explicitly says session-ID storage, wake queue/state machine, spawn markers, approval service, wake format, and base environment remain outside the harness ([contract](../app/src/main/services/harness/types.ts#L3-L14), [launch/config surface](../app/src/main/services/harness/types.ts#L24-L114)). `TerminalService` resolves intent (`auto`, `resume`, `fresh`) into harness calls, coalesces concurrent opens, and prevents an interactive writer from overlapping a headless one ([open guard](../app/src/main/services/terminal/index.ts#L91-L121), [spawn/session resolution](../app/src/main/services/terminal/index.ts#L124-L170)).

Claude uses OpenTrade-minted UUIDs and a channel-enabled PTY for warm delivery; cold wakes are one-shot `--resume ... -p` children ([Claude behavior](../app/src/main/services/harness/claude.ts#L98-L118), [headless argv](../app/src/main/services/harness/claude.ts#L157-L160)). Codex uses a supervised per-agent `codex app-server`, adopts server-minted thread IDs, and drives both warm and cold work as app-server turns ([Codex design](../app/src/main/services/harness/codex.ts#L74-L95), [thread/turn API](../app/src/main/services/harness/codex-app-server.ts#L272-L328)). The Codex manager isolates each agent's config, sessions, auth link, and Unix control socket in a short hashed `CODEX_HOME` ([home derivation](../app/src/main/services/harness/codex-app-server.ts#L27-L46)).

**Trading coupling.** The `Harness` interface itself includes `robinhoodMcpConfigured`, so onboarding policy leaks into the otherwise general seam ([interface](../app/src/main/services/harness/types.ts#L116-L121)). Both implementations generate Robinhood MCP and order-gate configuration. Claude matches four Robinhood order tools and permits Robinhood read tools ([Claude generated settings](../app/src/main/services/harness/claude.ts#L20-L84)); Codex writes per-tool prompt anchors, Robinhood MCP configuration, OpenTrade scheduling MCP configuration, and a network sandbox policy designed to prevent self-approval of orders ([Codex generated config](../app/src/main/services/harness/codex.ts#L302-L356)). Session supervision is neutral; generated tool policy is not.

### 4. PTY and terminal data plane — domain-neutral

`TerminalManager` spawns arbitrary `command`, `args`, `cwd`, `env`, and dimensions through `node-pty`, refuses a duplicate live session, fans output to sinks, and records exit state ([manager contract](../app/src/main/services/terminal/manager.ts#L6-L27), [spawn lifecycle](../app/src/main/services/terminal/manager.ts#L40-L67)). `SessionStore` is an in-memory live-session map with a byte-capped replay ring buffer and atomic sink attachment ([store](../app/src/main/pty-daemon/session-store.ts#L21-L39), [replay/FIFO](../app/src/main/pty-daemon/session-store.ts#L40-L103)). The renderer reuses one xterm viewport and reconnects with replay; it does not keep one off-screen terminal per agent ([controller](../app/src/renderer/lib/terminal/session-controller.ts#L11-L20), [connect sequence](../app/src/renderer/lib/terminal/session-controller.ts#L93-L145)).

The implementation comments often say `claude`, but the runtime types and call sites accept either harness. Trading behavior enters only through the selected agent's generated instructions/config and surrounding UI.

### 5. Durable scheduling and signal monitors — domain-neutral mechanism, trading copy

`Scheduler` persists cron schedules and supervised shell monitors, restores them on host boot, performs one catch-up fire, retires rows instead of deleting them so history remains resolvable, and delegates every fire to a `WakeTransport` without knowing how it will be delivered ([scheduler contract](../app/src/main/services/scheduler/index.ts#L27-L44), [boot/recovery](../app/src/main/services/scheduler/index.ts#L46-L91), [retirement](../app/src/main/services/scheduler/index.ts#L160-L195)). `MonitorRunner` treats each non-empty stdout line as a trigger, rate-limits it, and restarts failed children with bounded exponential backoff ([runner](../app/src/main/services/scheduler/monitor-runner.ts#L3-L15), [supervision](../app/src/main/services/scheduler/monitor-runner.ts#L35-L80)). Cron input is simply an expression, a prompt, and recurrence; monitor input is a command and description ([shared schedule inputs](../app/src/shared/schedule.ts#L53-L65)).

The scheduler code has no symbol, price, portfolio, or order field. Trading appears in examples and in the bundled agent instructions, which tell monitor scripts to poll the quote faucet and tell agents to refresh a quote before acting ([agent scheduling policy](../templates/agents/CLAUDE.prefix.md#L29-L48)). That is policy above the scheduling mechanism.

### 6. Wake delivery, autonomy limits, and crash recovery — mixed

**Domain-neutral infrastructure.** `WakeCoordinator` is a per-agent actor with one FIFO and four writer states: offline, interactive, headless, broken. Interactive channel delivery advances on handoff; Codex push advances on acknowledgement; headless delivery advances on exit so a mid-run crash does not silently lose the queue head ([state and delivery rules](../app/src/main/services/scheduler/wake/coordinator.ts#L30-L59), [push acknowledgement](../app/src/main/services/scheduler/wake/coordinator.ts#L221-L269)). It enforces a live per-run timeout and per-agent unattended-turn budget, reroutes queued work when a PTY goes down, and pauses scheduling when a session becomes broken ([limits](../app/src/main/services/scheduler/wake/coordinator.ts#L278-L343), [transport lifecycle](../app/src/main/services/scheduler/wake/types.ts#L17-L34)). Spawn markers give positive evidence of a host crash during a headless writer, enabling single-writer recovery at next boot ([host reconciliation](../app/src/main/host/index.ts#L90-L96)).

**Mixed coupling.** The generic queue is bound to two concrete delivery mechanisms: Claude channel/CLI and Codex app-server turns. The prompt marker is branded `[OPENTRADE WAKE ...]` and its rationale cites market hours/staleness ([prompt format](../app/src/main/services/scheduler/wake/prompt.ts#L1-L12)). The mechanism maps cleanly to recurring discovery/revisit work, but delivery naming and agent instructions remain trading-specific.

### 7. Agent-facing MCP and localhost control plumbing — mixed

**Domain-neutral infrastructure.** The bundled agent MCP is a dependency-free stdio JSON-RPC server. It advertises tools, validates calls through the host, discovers a localhost endpoint from inherited environment or a persisted manifest, and authenticates every request with a bearer token plus agent identity ([server purpose/security](../app/src/agent-mcp/index.ts#L1-L15), [endpoint discovery](../app/src/agent-mcp/index.ts#L22-L46), [authenticated host call](../app/src/agent-mcp/index.ts#L70-L116)). Its tool set—create/list/delete cron and create/list/stop monitor—is domain-neutral ([tool definitions](../app/src/agent-mcp/index.ts#L133-L253)). Claude warm wakes long-poll `/wake-stream` and arrive as channel notifications; Codex disables that poll because app-server push owns delivery ([MCP initialization](../app/src/agent-mcp/index.ts#L275-L299), [channel poller](../app/src/agent-mcp/index.ts#L338-L372)).

The localhost API binds only to `127.0.0.1`, authenticates with the shared token, validates the agent, and exposes hook, schedule, and wake-stream routes ([server boundary](../app/src/main/services/local-api/index.ts#L32-L60), [route dispatch](../app/src/main/services/local-api/index.ts#L125-L162)).

**Trading coupling.** The same local API also exposes quote/position faucets and order hook endpoints, and its constructor requires broker, approvals, and status services ([dependencies and purpose](../app/src/main/services/local-api/index.ts#L16-L45), [routes](../app/src/main/services/local-api/index.ts#L134-L161)). The MCP binary, headers, environment variables, capability instructions, and process title are branded OpenTrade. The control-plane/auth pattern is neutral; the current route aggregation is mixed.

### 8. Persistence and migrations — mixed

**Domain-neutral infrastructure.** The app creates a permission-restricted home and SQLite database, enables WAL, applies current idempotent DDL, and then applies additive versioned migrations with downgrade refusal ([database setup](../app/src/main/db/client.ts#L10-L23), [open/migrate](../app/src/main/db/client.ts#L25-L53), [migration runner](../app/src/main/db/migrate.ts#L80-L109)). Settings are a typed facade over a generic KV table and broadcast changes to live consumers ([settings service](../app/src/main/services/settings/index.ts#L30-L36), [update/broadcast](../app/src/main/services/settings/index.ts#L88-L110)).

**Table-by-table coupling.** The schema contains:

| Table | Coupling | Evidence |
|---|---|---|
| `agents` | Mixed | Generic identity/session/status fields plus an order `approval_mode` and headless-turn budget ([schema](../app/src/main/db/schema.ts#L3-L24)). |
| `schedules`, `monitors`, `wakes` | Domain-neutral | Agent-scoped prompts, cron expressions, commands, source links, delivery path, and timestamps; no trading fields ([schema](../app/src/main/db/schema.ts#L68-L129)). |
| `recent_notifications` | Domain-neutral | Bounded recent kind/title/body/agent/time ring buffer ([schema](../app/src/main/db/schema.ts#L131-L145)). |
| `settings` | Neutral storage, mixed typed keys | Generic KV table ([schema](../app/src/main/db/schema.ts#L62-L66)); current typed settings include broker cadence, order approvals, autonomy limits, notifications, telemetry, and menu-bar behavior ([settings shape](../app/src/shared/settings.ts#L10-L62)). |
| `approvals` | Trading-coupled | Intercepted order tool input, parsed order, decision, and broker outcome ([schema](../app/src/main/db/schema.ts#L26-L40)). |
| `audit_log` | Neutral storage, trading-coupled taxonomy | Generic append-only kind/payload/time rows ([schema](../app/src/main/db/schema.ts#L42-L53)); allowed kinds are order, approval, broker, and session lifecycle events ([taxonomy](../app/src/shared/approval.ts#L73-L92)). |
| `broker_cache` | Trading-coupled | Portfolio, positions, orders, and quote cache keys ([schema](../app/src/main/db/schema.ts#L55-L60)). |

There is no persisted recruiting-domain schema at this snapshot. The migration machinery can evolve a schema safely; it does not itself answer the required recruiting identity, provenance, deduplication, freshness, evidence, evaluation, or revisit model.

### 9. Run history, audit, and notifications — mixed

**Run history is the cleaner seam.** Every cron/monitor fire produces a `wakes` row linked to its source, including raw prompt, delivery path, and fire time; the scheduler exposes newest-first per-agent history ([write path](../app/src/main/services/scheduler/index.ts#L415-L467), [read path](../app/src/main/services/scheduler/index.ts#L308-L319)). The renderer's Monitor tab intentionally keeps wake history separate from the trade Activity feed ([Monitor panel contract](../app/src/renderer/components/panels/Monitor.tsx#L11-L20)). This is a generic run-event record, but it captures fire/delivery—not completion, result, artifacts, cost, or evaluation outcome.

**Audit is storage-neutral but semantically trading-specific.** `AuditLog` is a simple append-only JSON ledger with optional agent scope ([implementation](../app/src/main/services/audit/index.ts#L8-L46)), yet the closed `AuditKind` enum allows order intent/decision/outcome/fill plus session and broker lifecycle only ([kinds](../app/src/shared/approval.ts#L73-L92)). The Activity UI joins approvals to Robinhood ledger orders and merges external broker orders ([Activity joins](../app/src/renderer/components/panels/Activity.tsx#L27-L56)).

Notification transport is generic title/body/agent metadata, but kinds and producer copy include wake, order, approval, restricted, and update. The launcher gates them with typed settings ([kind shape](../app/src/shared/notify.ts#L1-L25), [display path](../app/src/main/index.ts#L186-L203)).

### 10. Human approval flow — trading-coupled implementation over a reusable interaction pattern

`ApprovalService` has broadly useful mechanics: durable pending records, idempotent duplicate joins, asynchronous waiters, explicit human decisions with notes, timeouts, abandon-on-session-loss, event broadcasting, and audit emission ([service contract](../app/src/main/services/approvals/index.ts#L31-L55), [request/join](../app/src/main/services/approvals/index.ts#L73-L118), [wait/timeout](../app/src/main/services/approvals/index.ts#L176-L201)).

Its current public and stored model is nevertheless order-specific end to end: it parses Robinhood order input, enriches cancellations from the broker ledger, correlates PostToolUse results to order IDs, and returns a Claude `PreToolUse` allow/deny decision ([order parsing/enrichment](../app/src/main/services/approvals/index.ts#L120-L162), [outcome correlation](../app/src/main/services/approvals/index.ts#L245-L283), [hook response](../app/src/main/services/approvals/index.ts#L403-L419)). Claude matches Robinhood place/cancel tools; Codex uses both a per-tool approval anchor and the same hook, with an idempotent join to collapse the two layers ([Claude matcher](../app/src/main/services/harness/claude.ts#L45-L64), [Codex gate routing](../app/src/main/services/harness/codex-gate.ts#L53-L97)). The renderer's approval card expects parsed order summaries, quantities, prices, and estimated cost ([approval shape](../app/src/shared/approval.ts#L3-L24)).

The seam is therefore the *pending-decision lifecycle and event flow*, not the existing approval schema or order-tool interception policy.

### 11. Broker integration — trading-coupled, with a broker-only adapter seam

`BrokerService` owns a read-only app connection, focus/market-hours polling cadence, pull-through cache, complete-plus-recent order ledger, outage telemetry, and order notifications ([service purpose](../app/src/main/services/broker/index.ts#L21-L32), [service state](../app/src/main/services/broker/index.ts#L87-L125), [cache/poll](../app/src/main/services/broker/index.ts#L262-L319)). `BrokerAdapter` permits another broker to implement accounts, portfolio, positions, orders, quotes, order-tool names, and MCP config ([adapter](../app/src/main/services/broker/adapter.ts#L21-L65)); those concepts do not form a general job/source connector contract.

The concrete Robinhood adapter uses the MCP SDK over Streamable HTTP at Robinhood's trading endpoint and implements OAuth dynamic client registration, PKCE, a loopback redirect, and token persistence ([client endpoint](../app/src/main/services/broker/robinhood/client.ts#L1-L26), [consent listener](../app/src/main/services/broker/robinhood/client.ts#L60-L145)). The OAuth mechanics are technically portable, but storage keys, scope, client name, response mapping, and service contracts are Robinhood-specific ([OAuth provider](../app/src/main/services/broker/robinhood/oauth.ts#L45-L55), [metadata/tokens](../app/src/main/services/broker/robinhood/oauth.ts#L94-L130)). Tokens are plaintext JSON protected by `0700`/`0600` filesystem permissions because the detached Node host cannot use Electron `safeStorage` ([security boundary](../app/src/main/services/broker/robinhood/oauth.ts#L5-L9), [home/DB permissions](../app/src/main/db/client.ts#L10-L20)).

### 12. Renderer and human review workspace — mixed

**Domain-neutral shell.** The renderer has an agent sidebar, selected-agent terminal, global scheduled view, settings, onboarding gate, right-side tab container, React Query/tRPC hooks, subscription-driven refresh, and reusable Radix/shadcn primitives ([app layout](../app/src/renderer/App.tsx#L18-L57), [right-panel container](../app/src/renderer/components/layout/RightPanel.tsx#L14-L77)). The Monitor panel's active/history disclosure, badges, detail grids, and run history are structurally reusable ([Monitor panel](../app/src/renderer/components/panels/Monitor.tsx#L17-L69)). The New Agent dialog already supports harness choice and editing the agent's specialty instructions before creation ([dialog model](../app/src/renderer/components/agents/NewAgentDialog.tsx#L77-L104), [editable instructions](../app/src/renderer/components/agents/NewAgentDialog.tsx#L139-L156)).

**Trading coupling.** The right tabs are Portfolio, Activity, and Monitor; the footer is a broker indicator ([tabs](../app/src/renderer/components/layout/RightPanel.tsx#L14-L18), [layout](../app/src/renderer/components/layout/RightPanel.tsx#L62-L75)). New-agent templates are General, DCA, Momentum, and Blank, and approval copy says every order versus full-auto order execution ([template/approval choices](../app/src/renderer/components/agents/NewAgentDialog.tsx#L39-L75)). Onboarding has a Robinhood step that separately connects the app's portfolio client and checks whether Robinhood MCP is registered in each CLI ([wizard purpose](../app/src/renderer/screens/Onboarding.tsx#L15-L27), [MCP check](../app/src/renderer/screens/Onboarding.tsx#L260-L287)). Portfolio, market clock, broker indicator, pending-order cards, and the order-ledger Activity timeline are product-domain components, not just copy skins.

No current panel provides a discovery inbox, opportunity identity/provenance, evidence timeline, fit reasoning, dismissal/promote actions, revisit freshness, or source-auth state.

### 13. Templates and agent operating contract — trading-coupled

Both shared prefixes define the agent as an equities trader connected to a funded Robinhood sub-account, require a user-authored `STRATEGY.md`, describe market-data and order tools, instruct durable cron/monitor use, and explain unattended approval timeout behavior ([Claude prefix](../templates/agents/CLAUDE.prefix.md#L1-L48), [Codex prefix](../templates/agents/AGENTS.prefix.codex.md#L1-L48)). DCA and momentum kickoff prompts collect trading parameters ([DCA kickoff](../templates/agents/dca/kickoff.md#L1), [momentum kickoff](../templates/agents/momentum/kickoff.md#L1)). Claude `.mcp.json` templates hard-code Robinhood's MCP endpoint ([default MCP template](../templates/agents/default/.mcp.json#L1-L8)).

The compositional pattern—shared platform prefix + editable specialty + kickoff—is neutral and is deliberately shared across harnesses ([composition](../app/src/main/services/agents/registry.ts#L43-L59)). The committed prefix text, specialties, kickoff prompts, and MCP entries are not.

### 14. Packaging, release, and platform — mostly domain-neutral mechanics, product-coupled identity

The project is a Bun workspace around Electron/Vite, React, tRPC, SQLite/Drizzle, node-pty, WebSockets, and MCP SDK dependencies ([workspace manifest](../package.json#L1-L21), [app dependencies](../app/package.json#L24-L65)). Electron Builder packages an arm64 macOS DMG and ZIP, unpacks native modules and the per-agent MCP child, copies templates/resources, signs/notarizes, and publishes an update feed to GitHub Releases ([builder resources](../app/electron-builder.yml#L6-L33), [mac targets/publish](../app/electron-builder.yml#L34-L64)). Release CI installs Bun, rebuilds native modules, builds/signs/publishes, and uploads sourcemaps ([workflow](../.github/workflows/release-desktop.yml#L33-L47), [publish step](../.github/workflows/release-desktop.yml#L91-L140)).

Product identity is embedded in app/product names, bundle ID, finance category, updater owner/repository, process titles, default home (`~/.opentrade`), environment/header names, icons, and telemetry names ([app manifest](../app/package.json#L1-L10), [builder identity](../app/electron-builder.yml#L1-L3), [publish target](../app/electron-builder.yml#L60-L64)). The mechanics are not trading-specific; the configured artifact is.

### 15. Tests and verification surface — broad unit coverage, notable gaps

The repository defines `bun test`, `typecheck`, build, lint, and formatting scripts ([root scripts](../package.json#L9-L15)). At the audited snapshot the committed tree contains 32 `*.test.ts` files with 318 `test(`/`it(` declarations. Representative coverage includes:

- schema migration and downgrade behavior ([migration tests](../app/src/main/db/migrate.test.ts#L1-L40));
- agent execution state, turn budgets, scaffolding, and harness divergence ([registry tests](../app/src/main/services/agents/registry.test.ts#L34-L49), [scaffolding tests](../app/src/main/services/agents/registry.test.ts#L85-L125));
- scheduler CRUD/history/retirement and wake queue ordering/limits ([scheduler tests](../app/src/main/services/scheduler/scheduler.test.ts#L82-L120), [wake tests](../app/src/main/services/scheduler/wake/coordinator.test.ts#L73-L140));
- localhost schedule auth/validation ([route tests](../app/src/main/services/local-api/schedules-route.test.ts#L41-L88));
- approval deduplication and mirrored Codex gate decisions ([approval tests](../app/src/main/services/approvals/service.test.ts#L46-L119));
- Codex JSON-RPC/Unix-socket client behavior ([app-server tests](../app/src/main/services/harness/codex-app-server.test.ts#L9-L49), [round-trip test](../app/src/main/services/harness/codex-app-server.test.ts#L64-L73));
- Robinhood connection, OAuth, mapping, polling, notification, and network-error behavior (see the colocated tests under `app/src/main/services/broker/`).

There is no committed renderer end-to-end test, packaged-app smoke test, full host integration test, or recruiting-domain test. The source also describes several behaviors as “spike-verified” or “E2E-caught,” but the ignored `app/spike/` directory is expressly excluded from the committed release tree ([ignore policy](../.gitignore#L13-L17)).

**Execution note.** Static test inventory was completed, but the suite was not executable in the audit environment because the required `bun` binary was not installed (`bun: command not found`). In addition, the committed-template gap above would invalidate the registry specialty expectations in a clean checkout even once Bun is available.

## Seam map

| Boundary | What crosses it today | Coupling observed at the boundary |
|---|---|---|
| Launcher ↔ detached host | Manifest, localhost tRPC/WS, notifications, settings | Neutral local-process protocol; broker focus and trading notification kinds are mixed in. |
| Renderer ↔ host services | Typed tRPC routers/subscriptions | Transport is neutral; router and panel shapes include broker/order concepts. |
| Agent registry ↔ harness | `HarnessId`, session mode/ID, instructions/config, argv/env | Strong harness seam; Robinhood-configured check and order config leak trading policy. |
| Scheduler ↔ wake coordinator | `WakeTransport.enqueue`, `wouldDropWake` | Domain-neutral prompt scheduling and delivery gate. |
| Wake coordinator ↔ execution transport | `HeadlessWakeStrategy`, `InteractivePush` | Queue/state machine is neutral; Claude/Codex implementations and branded prompt are concrete. |
| Agent MCP ↔ localhost API | Token + agent ID, schedule CRUD, long poll | Reusable authenticated local bridge; current API also aggregates broker/order hooks. |
| Approval hook/app-server ↔ approval service | Agent, tool name/input, async decision | Reusable decision rendezvous; current payload, policy, storage, and result are orders. |
| Broker service ↔ adapter | Accounts, portfolio, positions, orders, quotes, MCP config | Decouples broker vendors only; not a source-connector interface. |
| Registry ↔ agent folder | Prefix + specialty + kickoff + generated config + work product | Reusable file-memory/scaffolding pattern; bundled operating contract is trading. |
| Services ↔ SQLite | Drizzle tables + additive migrations | Reusable persistence mechanics; current domain tables omit recruiting identity/evidence/evaluation. |

## Facts that constrain later implementation decisions

1. **“Local-first” is architectural, not just deployment copy.** State, secrets, agent work product, processes, sockets, and schedules live under one local app home; the renderer assumes a host on loopback, and packaging ships native macOS modules.
2. **One resumable conversation per agent is a core invariant.** The registry persists one `lastSessionId`; the wake actor enforces one writer; Codex adds a per-agent engine. Any design needing concurrent investigations inside one Scout must either serialize them through that conversation or introduce a higher-level model.
3. **Wake history is not execution history.** It records a trigger and intended prompt/delivery path, not a completed run, produced evidence, source requests, errors, or result lineage.
4. **Agent folders are unstructured memory.** They preserve arbitrary durable work product but offer no application-level queries, provenance, deduplication, freshness checks, or review status.
5. **Approval mechanics and approval semantics are fused.** The waiting/event lifecycle is reusable, while the persisted schema, parser, hook matcher, return shape, audit taxonomy, notification copy, and UI all encode orders.
6. **The existing “adapter” abstraction is narrower than the recruiting source problem.** It assumes one brokerage account and trading reads/execution; it does not express connector authentication, item identity, pagination/checkpoints, provenance, rate limits, or partial-source failure.
7. **Harness parity is intentionally centralized but not complete by abstraction alone.** Claude and Codex have different session-ID ownership and warm/cold transports; a recruiting adaptation that changes tool policy must update both config writers and their tests.
8. **The clean-checkout template gap is real source state.** Any later template work should account for the global `CLAUDE.md` ignore rule before relying on committed specialty content.
9. **Packaging is currently Apple-Silicon-macOS and OpenTrade-branded.** Builder category, bundle ID, release owner/repo, artifacts, signing/notarization, updater feed, resources, process titles, and app-home names all carry product assumptions.

## Downstream questions surfaced (not new tickets)

- Should a Scout remain one long-lived harness conversation, or should a Scout own multiple durable investigation/run conversations while presenting one product identity?
- What is the canonical recruiting persistence boundary between queryable SQLite records and agent-owned Markdown/files?
- Does “run history” need completion/result/error/artifact lineage, or is trigger history plus evidence records sufficient?
- What generic human-decision vocabulary should replace order-specific `Approval`, and which decisions (promote, dismiss, revisit, source-auth escalation) actually need a blocking rendezvous versus an asynchronous review queue?
- What source-connector contract is required for item identity, deduplication keys, cursors/checkpoints, provenance, freshness, rate limits, authentication state, and recoverable partial failure?
- Which Codex/Claude tool permissions are safe for unattended discovery when network access and local app-server control have different threat models?
- Should onboarding validate only that a connector is configured, or prove that it is authenticated and can fetch a minimally scoped sample?
- How should the product preserve or migrate existing `~/.opentrade` data and external harness transcripts when names, schemas, instructions, and bundle identity change?
- Is the committed template-specialty gap accidental release drift or an intentional dependence on local ignored files?

## Decision gist

OpenTrade's reusable center is the local persistent agent runtime—host supervision, harness/session seam, PTY transport, SQLite migrations, scheduler/wake actor, authenticated local MCP bridge, and generic shell UI—while recruiting work must supply a new domain model and decouple or replace the Robinhood/order-specific policies layered on those mechanisms.
