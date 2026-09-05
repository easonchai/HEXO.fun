import {
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { map, type Observable } from "rxjs";

/**
 * Every on-chain u64 reaches a response as a BigInt and every u128 as a Prisma
 * Decimal. A JSON number silently loses digits past 2^53 and Fastify's
 * serializer refuses a BigInt outright, so both leave as decimal strings.
 * Global, so no route has to remember to map its own rows.
 */
@Injectable()
export class SerializationInterceptor implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(map(toJsonSafe));
  }
}

/** Recursive, returns new values; the Prisma rows passed in are never touched. */
export function toJsonSafe(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  // toFixed() rather than toString(): decimal.js switches to exponential
  // notation past 1e21, which a weight accumulator reaches easily.
  if (Prisma.Decimal.isDecimal(value)) return value.toFixed();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(toJsonSafe);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, inner]) => [key, toJsonSafe(inner)]),
    );
  }
  return value;
}
