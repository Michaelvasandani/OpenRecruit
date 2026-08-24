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

OpenRecruit is experimental software provided as-is and without warranty. It is not employment, investment, legal, or financial advice.
