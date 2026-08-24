/**
 * The CURRENT schema, as idempotent CREATE TABLE IF NOT EXISTS statements. Run on
 * every boot: a fresh DB gets the full latest schema in one shot; an existing DB
 * gets any tables added since it was created (IF NOT EXISTS covers whole-table
 * additions). Changes WITHIN an existing table (new columns, etc.) do NOT take
 * effect through this file — they must also ship as a migration in `migrate.ts`,
 * keyed by `PRAGMA user_version` (production DBs must survive updates). Keep the
 * two in sync: this DDL is what a fresh install gets, the migration is what an
 * existing install gets, and they must converge on the same shape.
 *
 * Dependency-free on purpose (a plain SQL string) so tests can build a real
 * schema without importing the better-sqlite3 client or touching OPENTRADE_HOME.
 */
export const SCHEMA_DDL = `
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      template TEXT NOT NULL DEFAULT 'default',
      harness TEXT NOT NULL DEFAULT 'claude',
      approval_mode TEXT NOT NULL DEFAULT 'approve',
      last_session_id TEXT,
      status TEXT NOT NULL DEFAULT 'idle',
      headless_turns_used INTEGER NOT NULL DEFAULT 0,
      turn_limit_enabled INTEGER NOT NULL DEFAULT 1,
      last_turn_at INTEGER,
      created_at INTEGER NOT NULL,
      archived_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS approvals (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      raw_input TEXT NOT NULL,
      parsed TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      decided_by TEXT,
      note TEXT,
      outcome TEXT,
      requested_at INTEGER NOT NULL,
      decided_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT,
      kind TEXT NOT NULL,
      payload TEXT NOT NULL,
      at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS audit_agent_at ON audit_log (agent_id, at);
    CREATE TABLE IF NOT EXISTS broker_cache (
      key TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      fetched_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS schedules (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      cron_expr TEXT NOT NULL,
      prompt TEXT NOT NULL,
      recurring INTEGER NOT NULL DEFAULT 1,
      enabled INTEGER NOT NULL DEFAULT 1,
      next_fire_at INTEGER,
      last_fired_at INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS schedules_agent ON schedules (agent_id);
    CREATE TABLE IF NOT EXISTS monitors (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      command TEXT NOT NULL,
      description TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      last_fired_at INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS monitors_agent ON monitors (agent_id);
    CREATE TABLE IF NOT EXISTS wakes (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      source_id TEXT,
      prompt TEXT NOT NULL,
      background INTEGER NOT NULL,
      fired_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS wakes_agent_fired ON wakes (agent_id, fired_at);
    CREATE TABLE IF NOT EXISTS recent_notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      agent_id TEXT,
      at INTEGER NOT NULL
    );

    -- Recruiting v6. This is additive beside the inherited OpenTrade tables;
    -- migration v6 imports active legacy agents into scouts after these tables exist.
    CREATE TABLE IF NOT EXISTS profiles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      role_target TEXT NOT NULL DEFAULT '',
      artifact_path TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'draft',
      current_version_id TEXT,
      content_hash TEXT,
      draft_markdown TEXT,
      draft_structured TEXT,
      draft_provenance TEXT,
      revision INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (current_version_id) REFERENCES profile_versions(id)
    );
    CREATE TABLE IF NOT EXISTS profile_versions (
      id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL REFERENCES profiles(id),
      version_no INTEGER NOT NULL,
      markdown_snapshot TEXT NOT NULL,
      structured_snapshot TEXT NOT NULL,
      provenance TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      confirmed_at INTEGER,
      created_at INTEGER NOT NULL,
      UNIQUE (profile_id, version_no),
      UNIQUE (profile_id, content_hash)
    );
    CREATE INDEX IF NOT EXISTS profile_versions_profile ON profile_versions (profile_id, version_no);
    CREATE TABLE IF NOT EXISTS scouts (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      harness TEXT NOT NULL DEFAULT 'claude',
      instruction_path TEXT NOT NULL,
      strategy_path TEXT,
      instruction_hash TEXT,
      strategy_hash TEXT,
      strategy_material TEXT NOT NULL DEFAULT '',
      policy_material TEXT NOT NULL DEFAULT '',
      default_profile_id TEXT REFERENCES profiles(id),
      lifecycle_state TEXT NOT NULL DEFAULT 'active',
      resumable_session_ref TEXT,
      legacy_agent_id TEXT UNIQUE REFERENCES agents(id),
      revision INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      archived_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS scouts_lifecycle ON scouts (lifecycle_state, created_at);
    CREATE TABLE IF NOT EXISTS sources (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      config TEXT NOT NULL DEFAULT '{}',
      readiness TEXT NOT NULL DEFAULT 'not_configured',
      safe_failure TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS source_access (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL REFERENCES sources(id),
      account_ref TEXT NOT NULL DEFAULT '',
      scope_key TEXT NOT NULL,
      access_mode TEXT NOT NULL DEFAULT 'public',
      readiness TEXT NOT NULL DEFAULT 'not_configured',
      safe_failure TEXT,
      last_checked_at INTEGER,
      last_success_at INTEGER,
      next_action TEXT,
      retry_at INTEGER,
      etag TEXT,
      last_modified TEXT,
      cursor TEXT,
      source_identity TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (source_id, account_ref, scope_key)
    );
    CREATE TABLE IF NOT EXISTS scout_sources (
      scout_id TEXT NOT NULL REFERENCES scouts(id),
      source_id TEXT NOT NULL REFERENCES sources(id),
      selected_at INTEGER NOT NULL,
      PRIMARY KEY (scout_id, source_id)
    );
    CREATE TABLE IF NOT EXISTS scout_runs (
      id TEXT PRIMARY KEY,
      scout_id TEXT NOT NULL REFERENCES scouts(id),
      trigger TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      phase TEXT NOT NULL DEFAULT 'preflight',
      budget TEXT NOT NULL DEFAULT '{}',
      profile_version_id TEXT REFERENCES profile_versions(id),
      profile_snapshot TEXT,
      strategy_snapshot TEXT,
      policy_snapshot TEXT,
      override_snapshot TEXT,
      checkpoint TEXT,
      safe_failure TEXT,
      started_at INTEGER,
      completed_at INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS scout_runs_scout_created ON scout_runs (scout_id, created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS scout_runs_one_active
      ON scout_runs (scout_id)
      WHERE status IN ('queued', 'preflight', 'running', 'finalizing');
    CREATE TABLE IF NOT EXISTS scout_run_requests (
      id TEXT PRIMARY KEY,
      scout_id TEXT NOT NULL REFERENCES scouts(id),
      trigger TEXT NOT NULL,
      request_key TEXT NOT NULL,
      source_id TEXT REFERENCES sources(id),
      lead_id TEXT REFERENCES leads(id),
      opportunity_id TEXT REFERENCES opportunities(id),
      investigation_id TEXT REFERENCES investigations(id),
      reason TEXT NOT NULL DEFAULT '',
      budget TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'pending',
      attempt_count INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER,
      run_id TEXT REFERENCES scout_runs(id),
      safe_failure TEXT,
      created_at INTEGER NOT NULL,
      dispatched_at INTEGER,
      completed_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS scout_run_requests_scout_created
      ON scout_run_requests (scout_id, created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS scout_run_requests_pending_key
      ON scout_run_requests (scout_id, request_key)
      WHERE status IN ('pending', 'dispatching');
    CREATE TABLE IF NOT EXISTS scout_run_checkpoints (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES scout_runs(id),
      sequence INTEGER NOT NULL,
      phase TEXT NOT NULL,
      checkpoint TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE (run_id, sequence)
    );
    CREATE TABLE IF NOT EXISTS source_attempts (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES scout_runs(id),
      source_id TEXT NOT NULL REFERENCES sources(id),
      requested_scope TEXT NOT NULL DEFAULT '{}',
      cursor TEXT,
      outcome TEXT NOT NULL DEFAULT 'started',
      item_count INTEGER NOT NULL DEFAULT 0,
      quarantined_count INTEGER NOT NULL DEFAULT 0,
      page_count INTEGER NOT NULL DEFAULT 0,
      retry_at INTEGER,
      safe_failure TEXT,
      started_at INTEGER NOT NULL,
      completed_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS source_attempts_run ON source_attempts (run_id, started_at);
    CREATE TABLE IF NOT EXISTS source_items (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL REFERENCES sources(id),
      identity_key TEXT NOT NULL,
      canonical_url TEXT,
      provider_identity TEXT,
      latest_fingerprint TEXT,
      latest_signal_id TEXT,
      deletion_marker_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (source_id, identity_key)
    );
    CREATE TABLE IF NOT EXISTS signals (
      id TEXT PRIMARY KEY,
      source_item_id TEXT NOT NULL REFERENCES source_items(id),
      source_id TEXT NOT NULL REFERENCES sources(id),
      source_attempt_id TEXT NOT NULL REFERENCES source_attempts(id),
      run_id TEXT NOT NULL REFERENCES scout_runs(id),
      fingerprint TEXT NOT NULL,
      provenance TEXT NOT NULL,
      publication_at INTEGER,
      observed_at INTEGER NOT NULL,
      retrieved_at INTEGER NOT NULL,
      evidence TEXT NOT NULL,
      access_mode TEXT NOT NULL DEFAULT 'public',
      adapter_version TEXT NOT NULL DEFAULT 'rss-atom-v1',
      processor TEXT NOT NULL DEFAULT 'openrecruit-rss-atom',
      retention_until INTEGER,
      superseded_signal_id TEXT,
      created_at INTEGER NOT NULL,
      UNIQUE (source_item_id, fingerprint)
    );
    CREATE TABLE IF NOT EXISTS signal_attributions (
      signal_id TEXT NOT NULL REFERENCES signals(id),
      run_id TEXT NOT NULL REFERENCES scout_runs(id),
      scout_id TEXT NOT NULL REFERENCES scouts(id),
      strategy_key TEXT,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (signal_id, run_id)
    );
    CREATE TABLE IF NOT EXISTS leads (
      id TEXT PRIMARY KEY,
      canonical_key TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      summary TEXT,
      identity_state TEXT NOT NULL DEFAULT 'settled',
      conflict TEXT,
      merged_into TEXT REFERENCES leads(id),
      revision INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS lead_aliases (
      id TEXT PRIMARY KEY,
      lead_id TEXT NOT NULL REFERENCES leads(id),
      kind TEXT NOT NULL,
      value TEXT NOT NULL,
      UNIQUE (kind, value)
    );
    CREATE TABLE IF NOT EXISTS lead_signal_links (
      lead_id TEXT NOT NULL REFERENCES leads(id),
      signal_id TEXT NOT NULL REFERENCES signals(id),
      relation TEXT NOT NULL DEFAULT 'supporting',
      created_at INTEGER NOT NULL,
      PRIMARY KEY (lead_id, signal_id)
    );
    CREATE TABLE IF NOT EXISTS opportunities (
      id TEXT PRIMARY KEY,
      lead_id TEXT NOT NULL REFERENCES leads(id),
      title TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'active',
      revision INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS fit_evaluations (
      id TEXT PRIMARY KEY,
      lead_id TEXT REFERENCES leads(id),
      opportunity_id TEXT REFERENCES opportunities(id),
      profile_version_id TEXT NOT NULL REFERENCES profile_versions(id),
      run_id TEXT NOT NULL REFERENCES scout_runs(id),
      strategy_hash TEXT,
      policy_hash TEXT,
      detail TEXT NOT NULL,
      freshness TEXT NOT NULL,
      stale_reason TEXT,
      stale_at INTEGER,
      created_at INTEGER NOT NULL,
      CHECK ((lead_id IS NOT NULL) <> (opportunity_id IS NOT NULL))
    );
    CREATE TABLE IF NOT EXISTS fit_evaluation_signal_links (
      evaluation_id TEXT NOT NULL REFERENCES fit_evaluations(id),
      signal_id TEXT NOT NULL REFERENCES signals(id),
      PRIMARY KEY (evaluation_id, signal_id)
    );
    CREATE TABLE IF NOT EXISTS investigations (
      id TEXT PRIMARY KEY,
      lead_id TEXT REFERENCES leads(id),
      opportunity_id TEXT REFERENCES opportunities(id),
      question_key TEXT NOT NULL,
      question_snapshot TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      revision INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      CHECK ((lead_id IS NOT NULL) <> (opportunity_id IS NOT NULL))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS investigations_lead_question
      ON investigations (lead_id, question_key) WHERE lead_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS investigations_opportunity_question
      ON investigations (opportunity_id, question_key) WHERE opportunity_id IS NOT NULL;
    CREATE TABLE IF NOT EXISTS investigation_attempts (
      id TEXT PRIMARY KEY,
      investigation_id TEXT NOT NULL REFERENCES investigations(id),
      scout_id TEXT NOT NULL REFERENCES scouts(id),
      run_id TEXT REFERENCES scout_runs(id),
      profile_version_id TEXT REFERENCES profile_versions(id),
      question_snapshot TEXT NOT NULL,
      evidence TEXT NOT NULL DEFAULT '[]',
      conclusion TEXT,
      uncertainty TEXT,
      outcome TEXT NOT NULL,
      rerun_reason TEXT,
      strategy_snapshot TEXT NOT NULL DEFAULT '',
      policy_snapshot TEXT NOT NULL DEFAULT '',
      freshness TEXT NOT NULL DEFAULT 'fresh',
      supersedes_attempt_id TEXT,
      completed_at INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS investigation_attempts_subject ON investigation_attempts (investigation_id, created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS investigation_attempts_one_active
      ON investigation_attempts (investigation_id) WHERE outcome = 'in_progress';
    CREATE TABLE IF NOT EXISTS revisit_plans (
      id TEXT PRIMARY KEY,
      scout_id TEXT NOT NULL REFERENCES scouts(id),
      source_id TEXT REFERENCES sources(id),
      lead_id TEXT REFERENCES leads(id),
      opportunity_id TEXT REFERENCES opportunities(id),
      investigation_id TEXT REFERENCES investigations(id),
      kind TEXT NOT NULL,
      cadence TEXT,
      due_at INTEGER,
      state TEXT NOT NULL DEFAULT 'active',
      policy_snapshot TEXT NOT NULL DEFAULT '{}',
      revision INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      CHECK ((source_id IS NOT NULL) + (lead_id IS NOT NULL) + (opportunity_id IS NOT NULL) + (investigation_id IS NOT NULL) = 1)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS revisit_plans_source_identity
      ON revisit_plans (scout_id, source_id) WHERE source_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS revisit_plans_lead_identity
      ON revisit_plans (scout_id, lead_id) WHERE lead_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS revisit_plans_opportunity_identity
      ON revisit_plans (scout_id, opportunity_id) WHERE opportunity_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS revisit_plans_investigation_identity
      ON revisit_plans (scout_id, investigation_id) WHERE investigation_id IS NOT NULL;
    CREATE TABLE IF NOT EXISTS candidate_decisions (
      id TEXT PRIMARY KEY,
      lead_id TEXT REFERENCES leads(id),
      opportunity_id TEXT REFERENCES opportunities(id),
      kind TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '{}',
      expected_revision INTEGER,
      created_at INTEGER NOT NULL,
      CHECK ((lead_id IS NOT NULL) <> (opportunity_id IS NOT NULL))
    );
    CREATE TABLE IF NOT EXISTS domain_clock (
      id INTEGER PRIMARY KEY,
      revision INTEGER NOT NULL
    );
    INSERT OR IGNORE INTO domain_clock (id, revision) VALUES (1, 0);
    CREATE TABLE IF NOT EXISTS command_receipts (
      id TEXT PRIMARY KEY,
      scope_kind TEXT NOT NULL,
      scope_id TEXT,
      command_kind TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      status TEXT NOT NULL,
      result TEXT,
      error_code TEXT,
      created_at INTEGER NOT NULL,
      completed_at INTEGER,
      UNIQUE (scope_kind, scope_id, command_kind, idempotency_key)
    );
`;
