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
A persistent autonomous agent that follows one specialized discovery strategy for the candidate.
_Avoid_: Search agent, recruiter

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
The permission state that allows OpenRecruit to read a Source, either publicly or through authorization completed by the Candidate.
_Avoid_: credentials, scraping access

**Investigation**:
A reusable record of a scout's question, evidence, conclusions, and check time for a lead or opportunity. A new signal, stale revisit plan, changed Candidate Profile, or unanswered question may justify another investigation.
_Avoid_: Finding, agent memory
