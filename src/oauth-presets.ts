// Prefills for the common OAuth providers: URLs and quirks, never
// credentials. One list, read by the CLI (`foldrun connect`), the dashboard's
// Connections form and the platform's consent callback, so a provider's
// refresh-token quirk is written down once.
//
// What stays with the account is the OAuth *client* (id + secret): a consent
// screen belongs to a registered app, so the developer brings those two
// values from the provider's console and everything else is here.

export interface OAuthPreset {
  authorize_url: string;
  token_url: string;
  /** Extra authorize-URL params (Google: access_type=offline&prompt=consent). */
  authorize_extra?: Record<string, string>;
  /** Scopes to start from — every provider names them differently, and a
   *  form with the right shape in it is worth more than a blank field. */
  scopes_example?: string;
  /** The one thing about this provider that costs an afternoon to learn. */
  hint: string;
}

export const OAUTH_PRESETS: Record<string, OAuthPreset> = {
  google: {
    authorize_url: "https://accounts.google.com/o/oauth2/v2/auth",
    token_url: "https://oauth2.googleapis.com/token",
    authorize_extra: { access_type: "offline", prompt: "consent" },
    scopes_example: "https://www.googleapis.com/auth/adwords",
    hint: "Scopes are full URLs. Offline access is requested for you, so a refresh token comes back.",
  },
  github: {
    authorize_url: "https://github.com/login/oauth/authorize",
    token_url: "https://github.com/login/oauth/access_token",
    scopes_example: "repo read:org",
    hint: "GitHub issues long-lived tokens and no refresh token — stored as a static secret.",
  },
  microsoft: {
    authorize_url: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    token_url: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    scopes_example: "offline_access https://graph.microsoft.com/.default",
    hint: "Include offline_access in the scopes or no refresh token is issued.",
  },
  linkedin: {
    authorize_url: "https://www.linkedin.com/oauth/v2/authorization",
    token_url: "https://www.linkedin.com/oauth/v2/accessToken",
    scopes_example: "openid profile w_organization_social r_organization_social",
    hint:
      "Posting as a company page needs w_organization_social and a page admin signing in. " +
      "Access tokens last 60 days; a refresh token is issued only to apps LinkedIn has enabled for it, " +
      "otherwise the token is stored as is and you connect again when it expires. " +
      "The redirect URL must match what the app registers exactly, and only localhost may be plain http.",
  },
};

export const OAUTH_PRESET_NAMES = Object.keys(OAUTH_PRESETS);
