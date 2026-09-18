# OpenRecruit

OpenRecruit is a job-search domain for continuously discovering and evaluating possible employment paths for one candidate.

## Language

**Candidate**:
The person whose job search OpenRecruit serves.
_Avoid_: User, job seeker

**Candidate Profile**:
The candidate's CV, GitHub portfolio, and career interests used to judge fit.
_Avoid_: User profile, search settings

**Scout**:
A persistent autonomous role that follows one specialized discovery strategy for the candidate. A Scout keeps its identity even when the model harness or resumable session used to perform its work changes.
_Avoid_: Search agent, recruiter

**Scout Run**:
One bounded execution of a Scout against the Sources explicitly selected for that execution. It ends with an explicit completed, incomplete, failed, or cancelled outcome.
_Avoid_: Agent run, search session

**Discovery Strategy**:
A scout's enduring search thesis, such as finding early-stage startups, founder hiring posts, new-grad roles, or forward-deployed engineering work.
_Avoid_: Search query, agent type

**Lead**:
A candidate-relevant company or source item worth investigating or monitoring because it may develop into an employment path.
_Avoid_: Opportunity, prospect

**Opportunity**:
A candidate-specific employment possibility supported by enough evidence to evaluate or pursue, whether it is an explicit opening or an inferred path with no formal role yet.
_Avoid_: Lead, job listing

**Signal**:
Evidence that creates or updates a lead or opportunity, such as a founder post, job listing, funding announcement, or repository activity.
_Avoid_: Lead, opportunity

**Source**:
An external feed, service, site, or API from which OpenRecruit obtains Signals, whether publicly available or Candidate-authorized.
_Avoid_: connector, scraper

**Source Access**:
The permission state that allows OpenRecruit to read a Source, either publicly or through authorization completed by the Candidate. A Source must be explicitly selected for a Scout before that Scout may read it.
_Avoid_: credentials, scraping access

**X Source**:
A Source of public posts and public account information from X used to discover recruiting Signals. Its retrieval provider does not expand what Scouts are allowed to read.
_Avoid_: Bird Source, Twitter Source

**Public Source Access**:
Source Access limited to evidence publicly visible on the Source. Candidate authorization may enable retrieval but does not grant Scouts access to private account surfaces.
_Avoid_: logged-in access, cookie access

**Source Attempt**:
A bounded record of one effort to read a Source, including its scope, outcome, and safe provenance. A Source Attempt may return no candidate-relevant Signals.
_Avoid_: Signal, search result

**Investigation**:
A reusable record of a scout's question, evidence, conclusions, and check time for a lead or opportunity. A new signal, stale revisit plan, changed Candidate Profile, or unanswered question may justify another investigation.
_Avoid_: Finding, agent memory

**Candidate Decision**:
An append-only record of the Candidate's judgment about a Lead or Opportunity. A later change of mind is another Candidate Decision rather than an edit to prior history.
_Avoid_: Lead status, mutable disposition

**Posting Reference**:
An untrusted URL that may identify a job posting and must be inspected against its Source before its claims are relied on.
_Avoid_: Verified job, search result

**Verified Posting**:
A job posting matched by stable provider identity in a successfully validated Source response. Verification establishes provider facts, not Candidate fit.
_Avoid_: Search result, recommended job

**Publication Time**:
The time a Source says it published a posting. It is distinct from search-engine crawl time, retrieval time, and OpenRecruit's First Seen Time.
_Avoid_: Crawl date, observed date

**First Seen Time**:
The earliest time OpenRecruit successfully verified a posting identity. It is local observation history, not evidence of when the employer published the role.
_Avoid_: Publication Time, posted date

**Relisting**:
An observed transition of the same provider posting identity from explicitly unlisted to explicitly listed. A missing record alone does not establish a Relisting.
_Avoid_: Repost

**Repost**:
A new or renewed posting for substantially the same employment possibility. Repost identity is a semantic conclusion and must not be inferred solely from title similarity or search-engine recency.
_Avoid_: Relisting, refreshed search result

**Experience Requirement**:
An evidence-backed statement in a posting about years of experience, including whether the wording is required, preferred, or ambiguous.
_Avoid_: Seniority guess, experience score
