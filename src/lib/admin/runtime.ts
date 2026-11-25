// The only admin module that touches the Worker env (`cloudflare:workers`), so the rest stays node-testable.
import { env } from "cloudflare:workers";
import { adminConfigFrom, type AdminConfig } from "./config.ts";

export const adminConfig = (): AdminConfig | null => adminConfigFrom(env as unknown as Record<string, unknown>);
