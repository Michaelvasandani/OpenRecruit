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

## Hacker News job postings

The canonical Hacker News Source reads public job postings through the unauthenticated [HN Search API](https://hn.algolia.com/api); it needs no credential and is ready by default, but a Scout can use it only after the Source is explicitly selected for that Scout. The agent-facing `HackerNewsJobs` tool has two modes: `who_is_hiring` returns top-level postings from the latest monthly "Ask HN: Who is hiring?" thread, and `job_stories` returns YC startup job posts. Both accept an optional full-text `query`, a `limit` (default 20, hard limit 50), and a `page`. The host owns every outbound URL, records each read as a Source Attempt, and treats postings as untrusted evidence; `record_source_outcome` is the only way a returned posting becomes a durable Signal.

## Job board postings

Six public applicant-tracking boards are canonical Sources: Greenhouse, Lever, SmartRecruiters, Workable, Rippling, and Workday. They need no credential and are ready by default, but a Scout can use a board only after that Source is explicitly selected for it. Discovery stays with the reasoning harness, which searches each selected board with its own web search (`site:job-boards.greenhouse.io "Early Career" "<location>"`). Verification is one agent-facing tool, `JobPostingInspect`: it accepts up to 50 posting URLs in any mix of boards, routes each URL by hostname to a small adapter (`app/src/main/services/recruiting/ats-boards.ts`), reads the posting from that board's public unauthenticated API, and normalizes it. Everything after that is shared (`job-posting-inspect.ts`): the pinned Scout Policy listing window on the host clock, Jev screening, one Source Attempt per board, and opaque evidence references promoted with `RecordSignal`. Greenhouse, Lever, SmartRecruiters, and Workable company boards can also be enumerated for every listed posting inside the window; Rippling and Workday cannot. Workable and Workday state only a publication date, so a posting from the cutoff day counts as inside the window. Search indexes lag the boards, so a removed posting returns a per-input `job_not_found` error rather than failing the call. Adding a board is one adapter plus one seeded Source row.

## Jev posting screening

With a Candidate-supplied TypeSafe key in Settings, every job-posting Source screens what it reads through one shared seam, `PostingScreener` (`app/src/main/services/recruiting/posting-screen.ts`). Jev reads each posting together with the Scout Run's pinned Candidate Profile, Discovery Strategy, and Scout Policy, and answers three questions: the experience the posting really requires, whether it is the kind of job the Scout was asked to find, and whether it is worth keeping for this Candidate. The answers become an `include`, `review`, or `exclude` decision; an excluded posting is still shown to the Scout but the host refuses to promote it to a Signal, and the judgment is stored with every Signal that is kept. A failed judgment asks for review rather than dropping a posting. A new Source gets all of this by handing `PostingScreener` its normalized postings; a new Jev question is added once, in `posting-fit.ts` and `posting-screen.ts`, and reaches Ashby and Hacker News alike.

## Bird-backed X discovery

Bird 0.8.0 is an optional, local executable for the X Source. A Candidate must configure an absolute executable path in Settings, pass the read-only readiness check, and confirm the detected executable and authenticated public X account. The local browser session is a prerequisite for Bird, but OpenRecruit never stores or displays its cookies, cookie locations, child environment, executable output, or raw Bird payload.

The agent-facing boundary is intentionally read-only and logical: `XSearch` uses a default limit of 10 (hard limit 25), `XRead` accepts exactly one numeric public post ID or canonical public URL, and `RecordSignal` is the only way temporary returned evidence becomes a durable Signal. Bird's logged-in retrieval is classified as best-effort public evidence; it does not grant access to private feeds, replies, threads, timelines, likes, bookmarks, media downloads, following, posting, or messaging. OpenRecruit does not fall back to another provider when Bird is unavailable or unsupported.

The portable acceptance gate uses a deterministic Bird-shaped provider and exercises both Codex and Claude through the authenticated localhost MCP seam:

```sh
bun test app/src/main/services/local-api/bird-discovery-journey.test.ts
```

The real-Bird gate is intentionally outside portable CI. To run it on a deliberately provisioned machine, set `OPENRECRUIT_RUN_REAL_BIRD=1`, `OPENRECRUIT_BIRD_PATH`, `OPENRECRUIT_BIRD_POST_ID` (a stable public post), and `OPENRECRUIT_BIRD_QUERY`, then run the same command. Readiness invokes only Bird `--version`, `check`, and `whoami`; the journey invokes only bounded `search` and single-post `read`. If Bird or authenticated browser state is unavailable, the suite reports the unmet prerequisite explicitly.

OpenRecruit is experimental software provided as-is and without warranty. It is not employment, investment, legal, or financial advice.
