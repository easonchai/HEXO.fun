import { Controller, Get } from "@nestjs/common";

@Controller()
export class HealthController {
  @Get("healthz")
  healthz(): { ok: true } {
    return { ok: true };
  }
}
