import { BadRequestException, Body, Controller, Logger, Post } from "@nestjs/common";

import { PrismaService } from "../prisma/prisma.service";

const MAX_LEN = 2_000;

interface ErrorReportBody {
  code?: unknown;
  message?: unknown;
  signature?: unknown;
  wallet?: unknown;
  page?: unknown;
}

interface ParsedErrorReport {
  code: string;
  message: string;
  signature: string | null;
  wallet: string | null;
  page: string | null;
}

/** A non-empty string, truncated; anything else (missing, wrong type, empty) is null. */
const optionalString = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value.slice(0, MAX_LEN) : null;

function parseErrorReport(body: unknown): ParsedErrorReport {
  const raw = (body ?? {}) as ErrorReportBody;
  if (typeof raw.code !== "string" || raw.code.length === 0) {
    throw new BadRequestException("Send a JSON body with a `code` string.");
  }
  if (typeof raw.message !== "string" || raw.message.length === 0) {
    throw new BadRequestException("Send a JSON body with a `message` string.");
  }
  return {
    code: raw.code.slice(0, 200),
    message: raw.message.slice(0, MAX_LEN),
    signature: optionalString(raw.signature),
    wallet: optionalString(raw.wallet),
    page: optionalString(raw.page),
  };
}

/**
 * beta-launch-fixes ticket 16: stores decoded send failures and
 * error-boundary catches the web posts, so a broken money path reaches the
 * maintainers instead of only the depositor's console (`errorReport.ts`,
 * `ErrorBoundary.tsx`, `playerErrors.ts`'s `decodeSendFailure`). Write-only:
 * no route reads this back; an operator queries Postgres directly.
 */
@Controller("error-reports")
export class ErrorReportController {
  private readonly logger = new Logger(ErrorReportController.name);

  constructor(private readonly prisma: PrismaService) {}

  @Post()
  async create(@Body() body: unknown): Promise<{ ok: true }> {
    const report = parseErrorReport(body);
    this.logger.warn(`error report ${report.code}: ${report.message}`);
    await this.prisma.errorReport.create({ data: report });
    return { ok: true };
  }
}
