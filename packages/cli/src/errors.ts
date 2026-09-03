export const EXIT_USAGE = 2;
export const EXIT_CHAIN = 3;
export const EXIT_ASSERTION = 4;

export class CliError extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

export function usage(msg: string): CliError {
  return new CliError(EXIT_USAGE, msg);
}

export function assertion(msg: string): CliError {
  return new CliError(EXIT_ASSERTION, msg);
}

export function chainError(msg: string): CliError {
  return new CliError(EXIT_CHAIN, msg);
}

/** bigint -> string, Uint8Array -> hex. */
function step(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Uint8Array) return Buffer.from(value).toString("hex");
  return value;
}

export function jsonRepr(value: unknown): string {
  return JSON.stringify(value, (_k, v) => step(v), 2);
}

export function renderText(value: unknown, indent = 0): string {
  const pad = "  ".repeat(indent);
  if (value === null || value === undefined) return `${pad}null`;
  if (typeof value !== "object") return `${pad}${String(value)}`;
  if (value instanceof Uint8Array)
    return `${pad}${Buffer.from(value).toString("hex")}`;
  if (Array.isArray(value)) {
    if (value.length === 0) return `${pad}[]`;
    return value.map((v) => renderText(v, indent + 1)).join("\n");
  }
  const lines: string[] = [];
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (v === null || v === undefined) {
      lines.push(`${pad}${key}: null`);
    } else if (typeof v !== "object") {
      lines.push(`${pad}${key}: ${String(v)}`);
    } else {
      lines.push(`${pad}${key}:`);
      lines.push(renderText(v, indent + 1));
    }
  }
  return lines.join("\n");
}

export function print(payload: unknown, json: boolean): void {
  console.log(json ? jsonRepr(payload) : renderText(payload));
}
