import type { RecruitingErrorCode } from "@shared/recruiting";

export class RecruitingError extends Error {
  readonly code: RecruitingErrorCode;

  constructor(code: RecruitingErrorCode, message: string) {
    super(message);
    this.name = "RecruitingError";
    this.code = code;
  }
}
