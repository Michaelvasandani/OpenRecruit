# OpenRecruit

OpenRecruit is a source-built macOS POC for private, local employment-path discovery. It helps one Candidate import and confirm a versioned Candidate Profile, configure Scouts against explicitly selected public Sources, run bounded and checkpointed discovery, and review evidence-backed Leads, Opportunities, Fit Evaluations, Revisit Plans, and Candidate Decisions.

The detached local host, Electron shell, SQLite migrations, Claude/Codex harnesses, PTY transport, authenticated local APIs, WebSockets, scheduler, wake coordinator, supervision, notifications, and terminal diagnostics remain useful runtime mechanics. The active product path is recruiting-neutral: no broker connection, OAuth, order or market surface, trading prompt, broker MCP, public updater, external messaging, job application submission, or hosted account is included.

## Local development

Install dependencies, then run the Electron app from `app/`:

```sh
cd app
bun install
bun run dev
```

The source-built POC intentionally has no public release feed or auto-update behavior. Build artifacts are local and should be inspected before sharing.

Candidate data is stored locally under the OpenRecruit data directory. Existing legacy database tables and rows are retained additively for recovery and are not converted into recruiting records.

## Privacy and scope

OpenRecruit does not store provider credentials, cookies, unnecessary personal data, or provider transcripts in recruiting records. Source access is explicit and bounded. The POC never submits applications or sends external messages.

## Bird-backed X discovery

Bird 0.8.0 is an optional, local executable for the X Source. A Candidate must configure an absolute executable path in Settings, pass the read-only readiness check, and confirm the detected executable and authenticated public X account. The local browser session is a prerequisite for Bird, but OpenRecruit never stores or displays its cookies, cookie locations, child environment, executable output, or raw Bird payload.

The agent-facing boundary is intentionally read-only and logical: `XSearch` uses a default limit of 10 (hard limit 25), `XRead` accepts exactly one numeric public post ID or canonical public URL, and `RecordSignal` is the only way temporary returned evidence becomes a durable Signal. Bird's logged-in retrieval is classified as best-effort public evidence; it does not grant access to private feeds, replies, threads, timelines, likes, bookmarks, media downloads, following, posting, or messaging. OpenRecruit does not fall back to another provider when Bird is unavailable or unsupported.

The portable acceptance gate uses a deterministic Bird-shaped provider and exercises both Codex and Claude through the authenticated localhost MCP seam:

```sh
bun test app/src/main/services/local-api/bird-discovery-journey.test.ts
```

The real-Bird gate is intentionally outside portable CI. To run it on a deliberately provisioned machine, set `OPENRECRUIT_RUN_REAL_BIRD=1`, `OPENRECRUIT_BIRD_PATH`, `OPENRECRUIT_BIRD_POST_ID` (a stable public post), and `OPENRECRUIT_BIRD_QUERY`, then run the same command. Readiness invokes only Bird `--version`, `check`, and `whoami`; the journey invokes only bounded `search` and single-post `read`. If Bird or authenticated browser state is unavailable, the suite reports the unmet prerequisite explicitly.

OpenRecruit is experimental software provided as-is and without warranty. It is not employment, investment, legal, or financial advice.
