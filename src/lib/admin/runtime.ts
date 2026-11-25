// The only admin module that touches the Worker env (`cloudflare:workers`), so the rest stays node-testable.
import { env } from "cloudflare:workers";
import { adminConfigResolve } from "./config.ts";

/** Config (or null) and, when null, the NAME of the failing env field (never a value). Parses once. */
export const adminConfigState = () => adminConfigResolve(env as unknown as Record<string, unknown>);

export const adminConfig = () => adminConfigState().config;
