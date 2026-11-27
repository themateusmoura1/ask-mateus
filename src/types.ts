export interface Note {
  id: string;
  title: string;
  source: string;
  url: string;
  keywords: string[];
  body: string;
}

/** Who the site is about and the words it opens with. Lives next to the notes. */
export interface Site {
  title: string;
  name: string;
  firstName: string;
  /** "him", "her" or "them", used in the fixed wording. */
  pronoun: string;
  opening: string;
  /** Greeting when the access code has a label. "{label}" is replaced. */
  openingFor: string;
  starters: string[];
  links: { label: string; url: string }[];
}

/** Everything the assistant knows. Stored privately in KV, never in the repo. */
export interface Bundle {
  site: Site;
  notes: Note[];
  /** Working re-creations of things the owner built, run on made-up cases. */
  demos?: import("./demo").AnyDemo[];
}

/** The small part of KV this project uses. Tests pass an in-memory version. */
export interface Store {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
  list(options: { prefix: string; cursor?: string }): Promise<{ keys: { name: string }[]; list_complete?: boolean; cursor?: string }>;
}

/** The part of a Durable Object namespace this project uses. Tests pass a fake. */
export interface Rooms {
  idFromName(name: string): unknown;
  get(id: any): { fetch(input: Request | string, init?: RequestInit): Promise<Response> };
}

export interface Env {
  STORE: Store;
  ASSETS?: { fetch(request: Request): Promise<Response> };
  /** One room per visitor session, for live updates. */
  LIVE?: Rooms;
  /** Lets Telegram's Approve and Decline buttons call back. Any long random string. */
  TELEGRAM_WEBHOOK_SECRET?: string;

  // Secrets. See .dev.vars.example.
  ANTHROPIC_API_KEY?: string;
  /** https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/anthropic. A secret, because it holds the account id. */
  AI_GATEWAY_URL?: string;
  /** The token that proves to the gateway who is calling. A Secrets Store binding, or a plain string in tests. */
  AI_GATEWAY_TOKEN?: string | { get(): Promise<string> };
  /** Which providers the gateway holds a key for, comma separated: "anthropic,openai". */
  GATEWAY_PROVIDERS?: string;
  /** Turns on embedding search over the notes and the OpenAI voice. */
  OPENAI_API_KEY?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  RESEND_API_KEY?: string;
  NOTIFY_EMAIL_TO?: string;
  NOTIFY_EMAIL_FROM?: string;
  ADMIN_TOKEN?: string;
  /** Cloudflare Access in front of the admin page. Both set, or both left out. */
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  VISITOR_SALT?: string;
  SESSION_SECRET?: string;

  // Plain settings from wrangler.jsonc.
  SITE_URL?: string;
  MODEL?: string;
  // Demos route work to two models: a small fast one and a stronger one.
  DEMO_FAST_MODEL?: string;
  DEMO_FAST_PRICE_INPUT_PER_MTOK?: string;
  DEMO_FAST_PRICE_OUTPUT_PER_MTOK?: string;
  DEMO_STRONG_MODEL?: string;
  DEMO_STRONG_PRICE_INPUT_PER_MTOK?: string;
  DEMO_STRONG_PRICE_OUTPUT_PER_MTOK?: string;
  PRICE_INPUT_PER_MTOK?: string;
  PRICE_OUTPUT_PER_MTOK?: string;
  DAILY_SPEND_CAP_USD?: string;
  VISITOR_DAILY_MESSAGES?: string;
  VISITOR_DAILY_CONTACT_REQUESTS?: string;
  VISITOR_DAILY_WRONG_CODES?: string;
  MAX_MESSAGE_CHARS?: string;
  SESSION_DAYS?: string;
  LOG_RETENTION_DAYS?: string;
  OPENAI_EMBEDDING_MODEL?: string;
  OPENAI_EMBEDDING_PRICE_PER_MTOK?: string;
  OPENAI_TTS_MODEL?: string;
  OPENAI_TTS_VOICE?: string;
  DAILY_VOICE_CHARS?: string;
}

/** Things tests replace: the clock and outbound HTTP. */
export interface Deps {
  fetch: typeof fetch;
  now: () => Date;
}

export type Kind = "answer" | "unknown" | "off_limits" | "contact" | "smalltalk";

/** What the model (or the stub) is asked to return. Never trusted as is. */
export interface Draft {
  kind: Kind;
  answer: string;
  sources: string[];
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

/** What the visitor's browser receives. */
export interface Reply {
  kind: Kind | "limit";
  text: string;
  sources: { id: string; title: string; source: string; url: string }[];
  openContact: boolean;
  speak?: string;
  /** Set when the reply opens a demo. */
  demo?: string;
  /** The steps behind this reply. Also sent live, one by one, as they happen. */
  trace?: { id: string; label: string; status: "running" | "ok" | "blocked" | "info"; detail: string; ms: number }[];
}

/** One access code. The code itself is never stored, only its hash (the KV key). */
export interface CodeRecord {
  id: string;
  label: string;
  /** Steers what the assistant leads with. Never a source of facts. */
  note: string;
  /** Which variant of the demos this visitor sees, if any. */
  variant?: string;
  createdAt: string;
  expiresAt?: string;
  revoked: boolean;
  uses: number;
  lastUsedAt?: string;
}

export interface Session {
  sid: string;
  code: CodeRecord;
}
