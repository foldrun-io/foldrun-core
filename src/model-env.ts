// The model environment for work an ACCOUNT asks for outside a step: an eval's
// judge, the dashboard's "draft a flow with AI". Resolved the way a step
// resolves it — the workspace's provider: block, else the account's, else the
// account's own key from Settings → Model — and only then the platform's own
// credential, which a hosted platform keeps for its operator's accounts
// (platform.platformKeyAllowed). Every other account brings an API key;
// asking for the platform's here is refused, not quietly billed to it.

import { accountDir, workspaceDir, parseProvider, providerEnvFor } from "./store.ts";
import { readAgentsMd } from "./runner.ts";
import { getSecret } from "./secrets.ts";
import { platform } from "./platform.ts";
import { accountModelBlock, isClaudeLoginToken } from "./model-credential.ts";

/** Refused for want of a usable key; `status` is what an HTTP layer answers. */
export class ModelKeyError extends Error {
  readonly status: number;
  constructor(message: string, status = 402) {
    super(message);
    this.status = status;
  }
}

export const NO_MODEL_KEY =
  "no model key: this account runs on its own API key, and none is set — add one in Settings → Model " +
  "(or `foldrun model set <provider> --key …`), or write a provider: block in AGENTS.md";

/**
 * `platform` is a function: the caller's own way to build the platform's env
 * (a step's, or the SDK's host env), called only when this account may use
 * it. `format` says what the endpoint speaks — a caller with no translator
 * refuses anything but anthropic.
 */
export function accountModelEnv(
  tenant: string,
  workspace: string,
  platformEnv: () => Record<string, string | undefined>,
): { env: Record<string, string | undefined>; supply: "provider" | "platform"; format: string } {
  const raw =
    (readAgentsMd(workspaceDir(tenant, workspace))?.data?.provider as Record<string, unknown> | undefined) ??
    (readAgentsMd(accountDir(tenant))?.data?.provider as Record<string, unknown> | undefined) ??
    accountModelBlock((name) => getSecret(tenant, name)?.value ?? null);
  const spec = parseProvider(raw);
  if (!spec?.baseUrl) {
    if (!platform.platformKeyAllowed(tenant)) throw new ModelKeyError(NO_MODEL_KEY);
    return { env: platformEnv(), supply: "platform", format: "anthropic" };
  }
  const sub = (text: string) =>
    text.replace(/\$\{([A-Z][A-Z0-9_]*)\}/g, (whole, name) => getSecret(tenant, name, workspace)?.value ?? whole);
  const token = sub(spec.token);
  if (token.includes("${")) throw new ModelKeyError("the provider's token secret is not set — `foldrun secrets` sets it", 422);
  if (!platform.platformKeyAllowed(tenant) && isClaudeLoginToken(token)) {
    throw new ModelKeyError("model key: a Claude login token (sk-ant-oat…) cannot be used here — use an API key from your provider", 422);
  }
  return {
    env: providerEnvFor({
      baseUrl: spec.baseUrl,
      token,
      auth: spec.auth,
      models: spec.models,
      headers: Object.fromEntries(Object.entries(spec.headers).map(([k, v]) => [k, sub(v)])),
    }),
    supply: "provider",
    format: spec.format,
  };
}
