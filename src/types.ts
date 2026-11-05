import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

export type Bindings = {
  [
    K in keyof Omit<Env, "ADMIN_TOKEN" | "COLLECTOR_TOKEN" | "DEV_AUTH_TOKEN">
  ]: Env[K] extends string ? string : Env[K];
} & {
  ADMIN_TOKEN?: string;
  COLLECTOR_TOKEN?: string;
  DEV_AUTH_TOKEN?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GOOGLE_AUTH_ORIGIN?: string;
  GITHUB_AUTH_ORIGIN?: string;
  RESEND_API_KEY?: string;
  RESEND_SENDER_VERIFIED?: string;
  EMAIL_ALERTS_ENABLED?: string;
  X_CLIENT_ID?: string;
  X_CLIENT_SECRET?: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  STRIPE_PRICE_ID?: string;
  MEDIA?: R2Bucket;
  OAUTH_PROVIDER?: OAuthHelpers;
  SUPABASE_STORAGE_URL?: string;
  SUPABASE_STORAGE_KEY?: string;
  YOUTUBE_API_KEY?: string;
  SPONSORBLOCK_LICENSE_APPROVED?: string;
  MEDIA_SIGNING_SECRET?: string;
};
export type Actor = {
  userId: string;
  via: "session" | "api_key";
  pro: boolean;
};
export type AppEnv = {
  Bindings: Bindings;
  Variables: { actor: Actor; requestId: string };
};
export const now = () => new Date().toISOString();
export const later = (seconds: number) =>
  new Date(Date.now() + seconds * 1000).toISOString();
