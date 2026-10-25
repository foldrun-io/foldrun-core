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
import { providerPreset } from "./providers.ts";
import { startTranslator, translatorSpecFor, type TranslatorSpec } from "./translator.ts";

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
  "(or `foldrun account model set <provider> --key …`), or write a provider: block in AGENTS.md";

/**
 * `platform` is a function: the caller's own way to build the platform's env
 * (a step's, or the SDK's host env), called only when this account may use
 * it. `format` says what the endpoint speaks; `translator` is set when it is
 * not Anthropic's, and `withModelEnv` puts the step's translator in front of
 * it, so a judge or a draft works on any key a run works on (FOL-16).
 */
export function accountModelEnv(
  tenant: string,
  workspace: string,
  platformEnv: () => Record<string, string | undefined>,
): {
  env: Record<string, string | undefined>;
  supply: "provider" | "platform";
  format: string;
  translator: TranslatorSpec | null;
} {
  const raw =
    (readAgentsMd(workspaceDir(tenant, workspace))?.data?.provider as Record<string, unknown> | undefined) ??
    (readAgentsMd(accountDir(tenant))?.data?.provider as Record<string, unknown> | undefined) ??
    accountModelBlock((name) => getSecret(tenant, name)?.value ?? null);
  const spec = parseProvider(raw);
  if (!spec?.baseUrl) {
    if (!platform.platformKeyAllowed(tenant)) throw new ModelKeyError(NO_MODEL_KEY);
    return { env: platformEnv(), supply: "platform", format: "anthropic", translator: null };
  }
  const sub = (text: string) =>
    text.replace(/\$\{([A-Z][A-Z0-9_]*)\}/g, (whole, name) => getSecret(tenant, name, workspace)?.value ?? whole);
  const token = sub(spec.token);
  if (token.includes("${")) throw new ModelKeyError("the provider's token secret is not set — `foldrun secrets` sets it", 422);
  if (!platform.platformKeyAllowed(tenant) && isClaudeLoginToken(token)) {
    throw new ModelKeyError("model key: a Claude login token (sk-ant-oat…) cannot be used here — use an API key from your provider", 422);
  }
  const headers = Object.fromEntries(Object.entries(spec.headers).map(([k, v]) => [k, sub(v)]));
  const preset = providerPreset(spec.name);
  return {
    env: providerEnvFor({ baseUrl: spec.baseUrl, token, auth: spec.auth, models: spec.models, headers }),
    supply: "provider",
    format: spec.format,
    translator: translatorSpecFor({
      format: spec.format,
      baseUrl: spec.baseUrl,
      token,
      headers,
      params: spec.params,
      name: spec.name,
      maxTokensParam: preset?.maxTokensParam,
      reasoningEffort: preset?.reasoningEffort,
    }),
  };
}

/**
 * Run `fn` with the model env, through a translator on this host when the
 * provider speaks Chat Completions or Responses — the same one a step uses
 * (runner.ts), started for this call and closed after it.
 */
export async function withModelEnv<T>(
  m: { env: Record<string, string | undefined>; translator?: TranslatorSpec | null },
  fn: (env: Record<string, string | undefined>) => Promise<T>,
): Promise<T> {
  if (!m.translator) return fn(m.env);
  const t = await startTranslator(m.translator);
  try {
    return await fn({ ...m.env, ...t.env });
  } finally {
    await t.close();
  }
}
