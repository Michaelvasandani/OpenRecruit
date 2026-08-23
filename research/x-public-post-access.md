# Verify the public X post access path for the POC

**Context pointer:** [OpenRecruit issue 16](https://github.com/Michaelvasandani/OpenRecruit/issues/16)<br>
**Research date:** 2026-08-23<br>
**Scope:** official X API and developer terms, first-party Exa and Jina documentation, and Agent Reach's own repository/docs/source. No secondary sources were used.

## Decision

OpenRecruit should use an OpenRecruit-owned adapter over the official X API v2 for public X post discovery and retrieval. The POC can satisfy its public-post Source contract with:

1. `GET /2/tweets/search/recent` for recurring discovery over the last seven days.
2. `GET /2/tweets` or `GET /2/tweets/:id` for batch or single-post re-fetch and verification.
3. OAuth 2.0 App-Only authentication with an X Bearer Token, kept in local deployment configuration.

Full-archive search is real, but it is pay-per-use/Enterprise-gated and is not needed for a first POC that runs recurring discovery. The adapter must make the seven-day window and any plan limitation explicit rather than treating an unavailable full archive as an empty Source.

Do not use Agent Reach's current X route for OpenRecruit. Agent Reach currently selects third-party `twitter-cli`, OpenCLI, or legacy bird CLI paths that rely on browser/session cookies or equivalent web-session credentials. Its own documentation describes unstable X GraphQL routes, and its source is an installer/doctor/router rather than a normalized Source adapter. That route is outside OpenRecruit's settled access policy and conflicts with X's official developer rules against non-API automation, reverse engineering, unauthorized access, and rate-limit circumvention.

Keep Exa and Jina as separate, optional broader-public-web Sources, consistent with [issue 5](https://github.com/Michaelvasandani/OpenRecruit/issues/5). They are useful for discovering or reading public URLs, including possible X URLs, but neither is an X-native post API. They must not be presented as equivalent to official X search, and their provider-side processing, caching, quotas, and provenance must remain visible in the Source record.

## What OpenRecruit's Source contract requires

There is not yet an implemented `Source` interface in tracked code. For this ticket, the contract is the settled domain/access decision recorded in [issue 6](https://github.com/Michaelvasandani/OpenRecruit/issues/6), [issue 11](https://github.com/Michaelvasandani/OpenRecruit/issues/11), [issue 12](https://github.com/Michaelvasandani/OpenRecruit/issues/12), and [issue 13](https://github.com/Michaelvasandani/OpenRecruit/issues/13). The following is therefore a repository-backed contract interpretation, not a claim about an existing TypeScript type.

Each imported Signal needs, at minimum:

- a Source identifier;
- a canonical resource URL or provider resource ID;
- public versus Candidate-authorized access mode;
- retrieval/observation time and publication time when available;
- provider/connector name and version;
- Scout Run attribution;
- external processor provenance, such as `direct`, `exa`, or `jina`;
- a non-secret account reference when an account is actually involved; and
- a content fingerprint or equivalent deduplication key where retention is allowed.

Each Scout Run must distinguish a clean empty result from authentication failure, rate limiting, blocking, malformed content, or another partial failure. Unattributable content cannot become a Signal. Source-specific rules take precedence over the default local evidence-retention policy.

## Official X API v2

### Verified public discovery and retrieval

X documents two public search endpoints:

- Recent search: `GET /2/tweets/search/recent`, covering Posts from the last seven days and available to all developers.
- Full-archive search: `GET /2/tweets/search/all`, covering the complete archive back to 2006 and available to pay-per-use and Enterprise customers.

The search API supports keyword, phrase, hashtag, mention, `from:`, `to:`, `retweets_of:`, URL, language, media, and other documented operators. Search requests are paginated. The current official search documentation describes recurring listening, research, brand monitoring, and reacting to new Posts as supported use cases. See [Search Posts](https://docs.x.com/x-api/posts/search/introduction) and [Search integration](https://docs.x.com/x-api/posts/search/integrate/overview).

Post lookup is a separate supported capability. X documents single lookup by Post ID at `GET /2/tweets/:id` and multi-Post lookup for up to 100 Posts at `GET /2/tweets`. The lookup documentation says these endpoints retrieve current Post details, verify availability, and expose edit history. See [Post Lookup](https://docs.x.com/x-api/posts/lookup/introduction), [Get Post by ID](https://docs.x.com/x-api/posts/get-post-by-id), and [Get Posts by IDs](https://docs.x.com/x-api/posts/get-posts-by-ids).

### Authentication and access prerequisites

All X API v2 endpoints require authentication. For public Post data, X explicitly documents OAuth 2.0 App-Only authentication using a Bearer Token. User-context OAuth is for user-authorized capabilities such as private metrics; it is not required for the POC's public-post read path. X's getting-access documentation requires an approved developer account, Project, App, and credentials, and asks the developer to describe the intended use case. See [Post lookup authentication](https://docs.x.com/x-api/posts/lookup/integrate), [Search authentication](https://docs.x.com/x-api/posts/search/integrate/overview), and [Getting access](https://docs.x.com/x-api/getting-started/getting-access).

This means OpenRecruit does not need to ask the Candidate for an X password, MFA code, browser cookie, or personal timeline authorization for this Source. The local deployment needs a provider-issued Bearer Token, stored as a secret and never copied into Signals, provenance, logs, transcripts, or analytics.

### Fields and provenance available from X

By default, X returns only `id`, `text`, and `edit_history_tweet_ids`. The adapter should request only the additional public fields needed for evidence and fit reasoning:

| Source-contract need | X API data | Handling |
|---|---|---|
| Stable provider identity | `id` | Primary deduplication identity; keep it as a string. |
| Canonical resource | X Post URL | Store the URL supplied/derived from the documented `x.com/{username}/status/{id}` shape and retain the Post ID as authoritative. X shows this URL shape in its [Post-ID guide](https://docs.x.com/x-api/posts/quote-tweets/quickstart). |
| Evidence | `text`, `entities`, `attachments`, `referenced_tweets` | Store the minimum normalized excerpt needed by the Signal; keep a raw capture only when retention rules allow. |
| Publication time | `created_at` | Map to Signal publication time. |
| Author attribution | `author_id` plus `expansions=author_id` and `user.fields=username,name` | Store the X user ID and handle as provider provenance, not as an unverified off-X identity. |
| Thread/context | `conversation_id`, `in_reply_to_user_id`, `referenced_tweets` | Preserve relationship context without importing a private/home timeline. |
| Public corroboration | `public_metrics`, `context_annotations`, `lang`, `source`, `possibly_sensitive`, `withheld` | Request only what the strategy needs; do not infer sensitive attributes. |
| Edit/deletion awareness | `edit_history_tweet_ids`, current lookup result, `withheld` | Treat a later version as a new observation/history event and re-check before display or refresh. |

The URL construction rule is partly an adapter inference: the API exposes the stable Post ID and the author handle through documented fields, while the official examples show the canonical X URL shape. Store both so a handle rename or unavailable author does not destroy identity. Retrieval time, connector version, Scout Run, access mode, and processor value (`direct`) are OpenRecruit-generated provenance, not X fields.

### Rate limits, quotas, and cost gates

The current [official rate-limit table](https://docs.x.com/x-api/fundamentals/rate-limits) lists these per-app limits for App-Only access:

| Endpoint | Current documented per-app limit | Current documented result/query notes |
|---|---:|---|
| `GET /2/tweets/search/recent` | 450 requests / 15 minutes | 10 default, 100 maximum results; 512-character self-serve query limit |
| `GET /2/tweets/search/all` | 1 request / second and 300 / 15 minutes | 10 default, 500 maximum results; 1,024-character self-serve query limit |
| `GET /2/tweets` | 3,500 / 15 minutes | Multi-Post lookup |
| `GET /2/tweets/:id` | 450 / 15 minutes | Single-Post lookup |

X says limits are endpoint-specific, are also visible in the Developer Console, and are exposed in `x-rate-limit-limit`, `x-rate-limit-remaining`, and `x-rate-limit-reset` response headers. Exceeding a limit produces HTTP 429 until the window resets. The adapter must persist Source readiness as rate limited/degraded, honor reset/`Retry-After` when present, use bounded backoff, and never create another credential or route to evade the limit.

The current [pay-per-use pricing page](https://docs.x.com/x-api/getting-started/pricing) lists Posts Read at `$0.005` per returned Post resource. It says credits are purchased in the Developer Console, costs are tracked at the app level, and prices can change. Pay-per-use plans are currently capped at 3 million Post reads per monthly billing cycle; higher volume requires Enterprise. X also documents a 24-hour UTC resource-deduplication window as a soft guarantee and lets the developer set spending limits that block requests after the cap is reached. The adapter should expose budget exhaustion as a Source failure/readiness state, not as clean emptiness.

Recent search is therefore economically and operationally plausible for a narrow POC: query narrowly, use `max_results` and pagination deliberately, use `since_id`/time windows to avoid replaying old material, and look up only candidate Signals that need verification. Full archive is an optional later capability gated on the account's current plan and budget.

### Retention, deletion, privacy, and display constraints

X's [Developer Policy](https://docs.x.com/developer-terms/policy), [Developer Agreement](https://docs.x.com/developer-terms/agreement), and [compliance-stream documentation](https://docs.x.com/x-api/compliance/streams/introduction) impose constraints that materially affect the Source adapter:

- If X Content is stored offline, it must be kept current with deletion, modification, protected status, suspension, withholding, and other changes. X's policy/agreement specifies removal or modification as soon as possible and, after a written request, within 24 hours. Near-real-time Post/User compliance streams are the official mechanism for keeping stored content synchronized, subject to the access level available to the app.
- Public display must preserve X Content integrity and X attribution requirements. OpenRecruit should link to the canonical X URL and avoid copying more text than needed for local evidence. It must not iframe or mirror the X API.
- API keys and credentials must remain private. The agreement prohibits exceeding or circumventing rate limits, reverse engineering the API, attempting unauthorized access, and redistributing Licensed Material except as permitted by the agreement and approved use case.
- X restricts off-X matching. A public X handle or user ID must not be silently joined to a Candidate, household, device, or other off-X identity outside the policy's consent/expectation boundaries. OpenRecruit should use X posts as employment-path Signals and organization/role evidence, not build a people-tracking or background-check dataset.
- X's restricted-use documentation prohibits surveillance, sensitive-attribute inference, background checks/extreme vetting, and use of X Content/API to train a foundation or frontier model. OpenRecruit may perform bounded, evidence-backed inference for the Candidate's job-search domain, but it must not train a model on imported X Content or derive sensitive attributes.

OpenRecruit's local rule of retaining normalized evidence until Candidate deletion and raw captures for 30 days by default is subordinate to these source rules. For X, the connector needs a deletion/update path that can remove or revise local raw captures, normalized Signal evidence, and conclusions that depend only on deleted content. If compliance access is not available at the selected tier, periodic re-lookup before display plus a documented deletion request path is the minimum POC safeguard; it is not a substitute for complying with the Agreement.

## Agent Reach comparison

### What was verified in Agent Reach's repository

I checked Agent Reach commit [`93ae1d18c37b707dec053c7c4f9d91cd8ef8943d`](https://github.com/Panniantong/Agent-Reach/commit/93ae1d18c37b707dec053c7c4f9d91cd8ef8943d), dated 2026-08-12, plus its current English docs and source.

Agent Reach describes itself as an installer, health checker, configuration tool, and router. Its [core module](https://github.com/Panniantong/Agent-Reach/blob/93ae1d18c37b707dec053c7c4f9d91cd8ef8943d/agent_reach/core.py) and [MCP server](https://github.com/Panniantong/Agent-Reach/blob/93ae1d18c37b707dec053c7c4f9d91cd8ef8943d/agent_reach/integrations/mcp_server.py) say that agents call upstream tools directly and that Agent Reach is not a wrapper or normalized read layer.

Its English README describes Twitter/X as **Read and Search — Cookie**, and says the cookie unlocks search, timeline, tweet reading, and articles. Its [installation guide](https://github.com/Panniantong/Agent-Reach/blob/93ae1d18c37b707dec053c7c4f9d91cd8ef8943d/docs/install.md) tells the user to export a browser Cookie-Editor header, run `agent-reach configure twitter-cookies`, and then pass `TWITTER_AUTH_TOKEN` and `TWITTER_CT0` to the upstream `twitter` command. Its [social reference](https://github.com/Panniantong/Agent-Reach/blob/93ae1d18c37b707dec053c7c4f9d91cd8ef8943d/agent_reach/skill/references/social.md) says:

- `twitter feed`, `twitter tweet`, `twitter user-posts`, and `twitter user` are the stable commands;
- `twitter search` can 404 because Twitter frequently changes GraphQL endpoints;
- OpenCLI is a fallback that reuses a logged-in browser session; and
- a proxy may be needed when X blocks the network.

The [Twitter channel source](https://github.com/Panniantong/Agent-Reach/blob/93ae1d18c37b707dec053c7c4f9d91cd8ef8943d/agent_reach/channels/twitter.py) confirms that the channel checks `twitter-cli`, OpenCLI, and legacy bird CLI. It does not call `api.x.com`, does not create a Bearer-token client, and does not retrieve or normalize Posts itself. It deliberately avoids running `twitter status` because the upstream command may fall back to browser-cookie access. The channel's `active_backend` is a health-check result, not a Source cursor/provenance/failure contract.

The upstream tool named by Agent Reach is also explicit about its mechanism: [twitter-cli's own GraphQL source](https://github.com/public-clis/twitter-cli/blob/main/twitter_cli/graphql.py) builds requests to `https://x.com/i/api/graphql/...`, scans X web bundles/query IDs, and maintains hard-coded query-ID fallbacks. Its [README](https://github.com/public-clis/twitter-cli) documents browser-cookie extraction, full-cookie forwarding, TLS fingerprint impersonation, transaction-ID generation, request jitter, and proxy support. This is not the official X API v2.

### Classification

| Question | Finding | Evidence level |
|---|---|---|
| Official X API route? | No. Agent Reach selects third-party CLIs/browser tooling; its X source has no `api.x.com` integration or Bearer-token path. | Verified from Agent Reach source; the conclusion that it is not an official API route follows directly from the selected backends and endpoints. |
| Browser-cookie/session-based? | Yes. Cookie-Editor exports, `TWITTER_AUTH_TOKEN`/`TWITTER_CT0`, full browser-cookie extraction, and OpenCLI's logged-in Chrome session are documented. | Verified. |
| Reverse-engineered/unofficial web route? | Yes for the selected `twitter-cli` path: the upstream source builds private-looking `x.com/i/api/graphql` calls, scans web bundles, and rotates query IDs; Agent Reach itself calls those routes unstable. | Verified mechanism from upstream source; “reverse-engineered” is the appropriate classification/inference from that mechanism, not a claim that Agent Reach's Python code implements the GraphQL client. |
| Stable structured results? | Upstream CLIs offer JSON/YAML, but Agent Reach does not normalize schema, cursors, provider IDs, publication/retrieval timestamps, deletion state, or retry/readiness outcomes into OpenRecruit's Source contract. | First part verified in Agent Reach docs; adapter mismatch is an inference from comparing those docs/source with the settled OpenRecruit contract. |
| Policy-compatible for this POC? | No. It requires exactly the browser-cookie/session or unofficial-route behavior that OpenRecruit issue 11 excludes and X's official policy/terms restrict. | Verified policy conflict; final POC exclusion is an OpenRecruit decision. |

Agent Reach remains useful as reference material for dependency discovery and health-check UX. It must not be the X Source implementation unless the route is replaced by a direct official X API adapter and OpenRecruit owns the normalization, provenance, rate-limit, retention, and failure boundary.

## Approved public-web alternatives

“Approved” here means approved in OpenRecruit's [issue 5 source portfolio](https://github.com/Michaelvasandani/OpenRecruit/issues/5), not approved or endorsed by X.

### Exa

Exa's first-party [Search API](https://exa.ai/docs/reference/search) is an authenticated `POST https://api.exa.ai/search` that searches the web and can return extracted contents. It supports `includeDomains`, so an OpenRecruit adapter could constrain a query to `x.com` or `twitter.com`. A result schema can include `id`, `url`, `title`, `publishedDate`, `author`, text/highlights, and a request ID. Exa's [Contents API](https://exa.ai/docs/reference/contents-retrieval) can retrieve a known public URL, and its status array distinguishes source-unavailable/403, not-found, timeout, and other crawl failures. Exa's [freshness documentation](https://exa.ai/docs/reference/livecrawling-contents) says results may be cached; `maxAgeHours: 0` forces livecrawl, while normal settings can fall back to cached content after a livecrawl failure.

This makes Exa a plausible broader-web discovery Source and a useful fallback for locating public X URLs, but not a substitute for X search semantics or X's Post ID/edit/compliance model. Exa does not promise complete X coverage, exact `from:`/`since_id` semantics, or current availability of every public Post. That limitation is an inference from Exa's generic web-search/content contract, not a claim that Exa cannot ever return an X page.

The current [Exa pricing page](https://exa.ai/pricing?tab=api) lists Search at `$7/1,000` requests (up to 10 results), Contents at `$1/1,000` pages, a free signup credit/monthly credit offer, and plan-dependent QPS (the page currently lists 5 QPS for free and 10 QPS for developer). Enterprise offers custom QPS and zero-data-retention arrangements. Exa's [security docs](https://exa.ai/docs/reference/security) say zero data retention requires an Enterprise discussion, while its [privacy policy](https://exa.ai/privacy-policy) says query fields are open text but users should not submit personal information as Query Data. OpenRecruit must therefore send only generic, Candidate-PII-redacted queries and public URLs, and must record `processor=exa` rather than implying direct X retrieval.

### Jina Reader/Search

Jina's first-party [Reader documentation](https://jina.ai/reader/) describes `https://r.jina.ai/` as a server-side URL-to-LLM-text reader and `https://s.jina.ai/?q=...` as web search returning the top five results with URLs and content. Jina says Reader processes only publicly accessible URLs, respects website access controls, cannot access content behind a login, and caches the same URL for five minutes. It also documents endpoint limits: the current table lists unauthenticated Reader at 20 RPM, Reader with a free key at 500 RPM, Search without a key as blocked, and Search with a free key at 100 RPM. API-key usage is token-metered; new keys receive free tokens and paid tiers increase limits.

As a retrieval-only alternative, Jina can satisfy a weaker generic Source contract when OpenRecruit already knows the public URL: the canonical URL and fetch time are available locally, and the returned Markdown can be processed transiently. It does not provide X's stable Post object, author ID, Post publication timestamp, edit history, public metrics, `next_token`, or deletion/compliance stream. Therefore it cannot satisfy the official-X discovery contract on its own.

I also performed a read-only smoke test on 2026-08-23 against the public X URL used in X's own documentation, `https://x.com/XDevelopers/status/1409931481552543749`, through `https://r.jina.ai/`. The response was HTTP 403 `AbuseAlleviationError` stating that anonymous access to `x.com` was temporarily blocked by Jina. This is a time-stamped observation of the current path from this environment, not a universal availability guarantee; it is enough to require an explicit degraded/blocked state rather than relying on Jina as the POC's canonical X feed.

Jina's [legal-information page](https://jina.ai/legal/) notes that, after its acquisition by Elastic, current data processing is governed by Elastic's data-processing terms and older Jina terms may no longer reflect current practice. No product page reviewed here provides a source-specific retention/deletion SLA equivalent to X's compliance rules. Treat Jina as an off-device processor, keep Candidate/private content out of requests, and make vendor-term confirmation a prerequisite for any durable use.

## Contract fit and recommended adapter boundary

| Access path | Discovery | Known-URL retrieval | Stable X provenance | Auth boundary | Source-contract result |
|---|---|---|---|---|---|
| Direct official X API | Yes: recent; full archive when plan allows | Yes: single/batch lookup | Yes: Post ID, text, author, timestamps, fields, edit history; adapter adds URL/retrieval/run metadata | App-only Bearer Token for public data | **Meets the POC X Source contract** |
| Exa Search + Contents | Generic web discovery; can include X domains | Yes, for provider-accepted public URLs | Provider URL/ID/title/optional date/author; no X-native guarantee | Exa API key; query/URL leaves machine | **Meets a generic public-web contract; not an X-native contract** |
| Jina Search + Reader | Generic web search; top-five result behavior | Yes, for publicly accessible URLs, subject to provider access | URL and fetched Markdown; no X-native Post object | Optional Reader key; Search key required; content leaves machine | **Retrieval-only auxiliary Source; not sufficient for X discovery** |
| Agent Reach current X path | Search/read commands depend on upstream tool/session | Yes, when session route works | CLI output is not OpenRecruit-normalized and may depend on private session state | Browser cookies, session credentials, or private web routes | **Exclude** |

The direct X adapter should expose an explicit seam along these lines (the exact TypeScript shape is deferred to issue 8 and is not changed here):

- `check()` — validates that the local Bearer Token is configured without logging it and reports `not_configured`, `ready`, `rate_limited`, `blocked`, or `degraded`.
- `search(query, window, cursor)` — calls recent search, records the exact query/window/returned count, stores `meta.next_token`, and never converts 401/403/429/5xx into empty results.
- `lookup(ids)` — batches up to the documented limit, re-fetches current content, and records missing/withheld/deleted results as source outcomes.
- `normalize(post)` — emits one attributable immutable observation with `source=x`, `access_mode=public`, `external_processor=direct`, provider ID, canonical URL, publication time, retrieval time, connector version, content fingerprint, and Scout Run attribution.
- `refresh/delete-compliance()` — updates or removes local evidence when X content changes or is withdrawn, with a 24-hour request/removal target and an audit event that contains no secret.

For the POC, use narrow recent-search queries and a cadence comfortably below seven days, then use `since_id` and Post lookup to avoid duplicate billing and preserve append-only Signal history. If a strategy needs historical search, surface the full-archive plan gate and budget explicitly. Do not silently fall back to Agent Reach, cookies, browser sessions, X home timeline, DMs, posting, or a web scraper.

## Explicit exclusions

| Excluded capability/path | Decision and reason |
|---|---|
| Browser-cookie/session import | Excluded. This includes Cookie-Editor exports, `auth_token`/`ct0`, automatic browser-cookie extraction, and reusing a logged-in Chrome session. It violates OpenRecruit issue 11's access policy for this Source and is not the official Bearer-token path. |
| Reverse-engineered routes | Excluded. This includes private-looking `x.com/i/api/graphql` routes, query-ID scraping/rotation, TLS/browser fingerprint impersonation, proxy evasion, or any similar undocumented route. X's agreement prohibits reverse engineering and unauthorized access; Agent Reach's own X route relies on this class of mechanism. |
| Private/protected/home timelines | Excluded. The POC reads public search results only. X documents that the home timeline requires User Context; no protected account or personal timeline should be imported, and a protected/blocked result must never be bypassed or served to an unauthorized person. |
| Direct Messages | Excluded. OpenRecruit Scouts have no X DM permission. X treats DMs as non-public and requires additional privacy safeguards; no DM endpoint, event, or content belongs in this Source. |
| Posting, replying, liking, following, or other writes | Excluded. The X API and Agent Reach upstream tools have write capabilities, but OpenRecruit's Source is read-only and external communication remains human-controlled. Do not request user-context write scopes. |
| CAPTCHA, robots, paywall, block, or access-control bypass | Excluded. A blocked or unauthorized response is a durable Source failure/readiness state. There is no alternate credential, browser automation, proxy evasion, or undocumented endpoint fallback. |

## Final recommendation

Proceed with a direct official X API v2 public-read adapter for the POC, starting with recent search plus Post lookup. Gate onboarding on an approved X developer account/App and a local Bearer Token; gate operation on spend limits, the current per-app rate limits, and a written X use-case description. Treat X content as mutable external evidence, preserve minimal provenance, and implement deletion/update handling before durable import.

Do not adopt Agent Reach's current X route. Keep Agent Reach only as reference/bootstrap material. Exa may remain an auxiliary broader-web discovery Source, and Jina may remain a best-effort public-URL reader, but neither should be used to claim complete or authoritative X post discovery. The recommendation satisfies the settled OpenRecruit Source contract while honoring the explicit exclusions in issue 16.

## Primary sources

### X

- [Search Posts](https://docs.x.com/x-api/posts/search/introduction)
- [Search integration and authentication](https://docs.x.com/x-api/posts/search/integrate/overview)
- [Post Lookup](https://docs.x.com/x-api/posts/lookup/introduction)
- [Get Post by ID](https://docs.x.com/x-api/posts/get-post-by-id)
- [Fields and expansions](https://docs.x.com/x-api/fundamentals/fields)
- [Rate limits](https://docs.x.com/x-api/fundamentals/rate-limits)
- [Pay-per-use pricing](https://docs.x.com/x-api/getting-started/pricing)
- [Getting access](https://docs.x.com/x-api/getting-started/getting-access)
- [Developer Policy](https://docs.x.com/developer-terms/policy)
- [Developer Agreement](https://docs.x.com/developer-terms/agreement)
- [Restricted use cases](https://docs.x.com/developer-terms/restricted-use-cases)
- [Compliance event streams](https://docs.x.com/x-api/compliance/streams/introduction)

### Exa and Jina

- [Exa Search API](https://exa.ai/docs/reference/search)
- [Exa Contents Retrieval](https://exa.ai/docs/reference/contents-retrieval)
- [Exa Content Freshness](https://exa.ai/docs/reference/livecrawling-contents)
- [Exa pricing](https://exa.ai/pricing?tab=api)
- [Exa security](https://exa.ai/docs/reference/security)
- [Exa privacy policy](https://exa.ai/privacy-policy)
- [Jina Reader](https://jina.ai/reader/)
- [Jina legal information](https://jina.ai/legal/)

### Agent Reach and its X backend

- [Agent Reach repository at checked commit](https://github.com/Panniantong/Agent-Reach/tree/93ae1d18c37b707dec053c7c4f9d91cd8ef8943d)
- [Agent Reach English README](https://github.com/Panniantong/Agent-Reach/blob/93ae1d18c37b707dec053c7c4f9d91cd8ef8943d/docs/README_en.md)
- [Agent Reach installation guide](https://github.com/Panniantong/Agent-Reach/blob/93ae1d18c37b707dec053c7c4f9d91cd8ef8943d/docs/install.md)
- [Agent Reach social reference](https://github.com/Panniantong/Agent-Reach/blob/93ae1d18c37b707dec053c7c4f9d91cd8ef8943d/agent_reach/skill/references/social.md)
- [Agent Reach Twitter channel source](https://github.com/Panniantong/Agent-Reach/blob/93ae1d18c37b707dec053c7c4f9d91cd8ef8943d/agent_reach/channels/twitter.py)
- [Agent Reach core source](https://github.com/Panniantong/Agent-Reach/blob/93ae1d18c37b707dec053c7c4f9d91cd8ef8943d/agent_reach/core.py)
- [twitter-cli GraphQL source](https://github.com/public-clis/twitter-cli/blob/main/twitter_cli/graphql.py)
- [twitter-cli README](https://github.com/public-clis/twitter-cli)
