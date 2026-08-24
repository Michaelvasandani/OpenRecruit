import type { RecruitingErrorCode } from "@shared/recruiting";

export type RecruitingFailureCategory =
  | "missing_configuration"
  | "invalid_authentication"
  | "rate_limited"
  | "invalid_input"
  | "disabled_source_access"
  | "exhausted_transient_failure"
  | "provider_failure"
  | "missing_source_access"
  | "invalid_url"
  | "not_ready";

export class RecruitingError extends Error {
  readonly code: RecruitingErrorCode;
  readonly category: RecruitingFailureCategory | null;

  constructor(
    code: RecruitingErrorCode,
    message: string,
    category: RecruitingFailureCategory | null = null,
  ) {
    super(message);
    this.name = "RecruitingError";
    this.code = code;
    this.category = category;
  }
}
