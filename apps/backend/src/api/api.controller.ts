import { BadRequestException, Controller, Get, Param, Query } from "@nestjs/common";
import { PublicKey } from "@solana/web3.js";

import { ApiService } from "./api.service";

/** Cap borrowed from the api-design rule; the frontend never asks for more. */
const MAX_LIMIT = 100;

const parseLimit = (raw: string | undefined, fallback: number): number => {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new BadRequestException("`limit` must be a whole number of 1 or more.");
  }
  return Math.min(value, MAX_LIMIT);
};

const parseRoundId = (raw: string): bigint => {
  if (!/^\d+$/.test(raw)) {
    throw new BadRequestException("A round id is a whole number, for example 12.");
  }
  return BigInt(raw);
};

const parseOwner = (raw: string): string => {
  try {
    return new PublicKey(raw).toBase58();
  } catch {
    throw new BadRequestException("That is not a valid Solana wallet address.");
  }
};

/** The read half of spec.md §3.5. Everything comes from Postgres. */
@Controller()
export class ApiController {
  constructor(private readonly api: ApiService) {}

  @Get("pool")
  getPool() {
    return this.api.getPool();
  }

  @Get("epochs")
  getEpochs(@Query("limit") limit?: string) {
    return this.api.getEpochs(parseLimit(limit, 20));
  }

  @Get("epochs/current")
  getCurrentEpoch() {
    return this.api.getCurrentEpoch();
  }

  @Get("rounds")
  getRounds(@Query("limit") limit?: string) {
    return this.api.getRounds(parseLimit(limit, 50));
  }

  @Get("rounds/:id")
  getRound(@Param("id") id: string) {
    return this.api.getRound(parseRoundId(id));
  }

  @Get("players/:owner")
  getPlayer(@Param("owner") owner: string) {
    return this.api.getPlayer(parseOwner(owner));
  }

  @Get("leaderboard")
  getLeaderboard(@Query("limit") limit?: string) {
    return this.api.getLeaderboard(parseLimit(limit, 20));
  }

  @Get("feed")
  getFeed(@Query("limit") limit?: string) {
    return this.api.getFeed(parseLimit(limit, 50));
  }

  @Get("status")
  getStatus() {
    return this.api.getStatus();
  }
}
