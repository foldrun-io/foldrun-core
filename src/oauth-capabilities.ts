// Every kind of OAuth foldrun meets, in each role, and what foldrun does
// about it: supported (with the tests that prove it), planned, refused (with
// the reason a person sees), or not needed. The single source the customer
// page `foldrun-docs/oauth.md` is generated from (`node scripts/oauth-doc.mjs`)
// — the same pattern as frontmatter-fields.ts. tests/oauth-capabilities.test.ts
// fails when a supported row names a test that does not exist, or the page is
// stale.
//
// The roles:
//   client   an agent reaches Google, Slack, a bank — foldrun holds the token
//   server   an AI app signs in to /api/mcp — foldrun issues the token

export type OAuthRole = "client" | "server";
export type OAuthStatus = "supported" | "planned" | "refused" | "not-needed";

/** A test that proves a row: the repo, the file in it, and the test's name
 *  as written (a substring of the title is enough). */
export interface OAuthProof {
  repo: "foldrun-core" | "foldrun-platform" | "foldrun-web" | "foldrun-cli";
  file: string;
  test: string;
}

export interface OAuthCapability {
  id: string;
  role: OAuthRole;
  /** What it is, in a person's words. */
  title: string;
  /** The RFC or spec that defines it. */
  spec: string;
  status: OAuthStatus;
  /** How to use it (supported), what is coming (planned), or why not. */
  note: string;
  proof?: OAuthProof[];
}

const core = (file: string, test: string): OAuthProof => ({ repo: "foldrun-core", file, test });
const platform = (file: string, test: string): OAuthProof => ({ repo: "foldrun-platform", file, test });
const web = (file: string, test: string): OAuthProof => ({ repo: "foldrun-web", file, test });
const cli = (file: string, test: string): OAuthProof => ({ repo: "foldrun-cli", file, test });
const KC = "tests/e2e-oauth-keycloak.test.ts";

export const OAUTH_CAPABILITIES: OAuthCapability[] = [
  // ------------------------------------------------------------ client
  {
    id: "client.authorization-code-pkce", role: "client", title: "Authorization code with PKCE (S256)", spec: "RFC 6749 §4.1, RFC 7636",
    status: "supported", note: "Settings → Connections or `foldrun connect`. PKCE is on for every connection.",
    proof: [platform("tests/oauth-connect.test.ts", "PKCE: on by default"), platform(KC, "authorization code + PKCE S256 + PAR"), cli("tests/cli-connect.test.ts", "connect: PKCE by default")],
  },
  {
    id: "client.refresh-rotation", role: "client", title: "Refresh, and refresh-token rotation", spec: "RFC 6749 §6, RFC 9700 §2.2.2",
    status: "supported", note: "Refreshed before every use; a rotated refresh token replaces the stored one.",
    proof: [core("tests/secret-types.test.ts", "a rotated refresh token is saved where the old one was"), core("tests/oauth-provider-fixtures.test.ts", "rotating refresh tokens: every refresh returns a new one"), platform(KC, "the refresh works and rotates")],
  },
  {
    id: "client.client-credentials", role: "client", title: "Client credentials (machine to machine)", spec: "RFC 6749 §4.4",
    status: "supported", note: "The \"OAuth — client credentials\" connection, or `foldrun secrets set NAME --kind m2m`.",
    proof: [platform(KC, "client credentials (machine to machine)")],
  },
  {
    id: "client.secret-post", role: "client", title: "Client secret in the form body", spec: "RFC 6749 §2.3.1",
    status: "supported", note: "The default (`token_auth: client_secret_post`).",
    proof: [core("tests/oauth-token.test.ts", "client_secret_post (and absent with a secret)"), platform(KC, "client_secret_post")],
  },
  {
    id: "client.secret-basic", role: "client", title: "Client secret as HTTP Basic", spec: "RFC 6749 §2.3.1",
    status: "supported", note: "`token_auth: client_secret_basic`, or `--token-auth basic`. Notion, Spotify, Reddit and Zoom need it.",
    proof: [core("tests/oauth-token.test.ts", "a Basic-only token endpoint"), platform("tests/oauth-connect.test.ts", "token_auth client_secret_basic"), platform(KC, "client_secret_basic"), cli("tests/cli-connect.test.ts", "connect --token-auth basic")],
  },
  {
    id: "client.public", role: "client", title: "Public app (no secret), PKCE only", spec: "RFC 9700 §2.1.1",
    status: "supported", note: "Leave the client secret empty.",
    proof: [platform("tests/oauth-connect.test.ts", "a public app (no secret) connects with PKCE"), platform(KC, "a public app (no secret)")],
  },
  {
    id: "client.discovery", role: "client", title: "Metadata discovery from an issuer", spec: "RFC 8414, OpenID Connect Discovery",
    status: "supported", note: "The Issuer field's Discover, or `--issuer`.",
    proof: [core("tests/oauth-discovery-revoke.test.ts", "an RFC 8414 server"), core("tests/oauth-discovery-revoke.test.ts", "refused: a document naming another issuer"), platform(KC, "discovery (RFC 8414 / OIDC)"), cli("tests/cli-connect.test.ts", "connect --issuer: the metadata fills the URLs")],
  },
  {
    id: "client.iss-parameter", role: "client", title: "Issuer in the authorization response (mix-up defence)", spec: "RFC 9207",
    status: "supported", note: "With an issuer, the `iss` that comes back must be it.",
    proof: [platform("tests/oauth-connect.test.ts", "iss: a pinned issuer must come back exactly"), platform(KC, "a callback whose iss is not the realm is refused"), cli("tests/cli-connect.test.ts", "a callback whose iss is another server is refused")],
  },
  {
    id: "client.revocation", role: "client", title: "Revocation when a connection ends", spec: "RFC 7009",
    status: "supported", note: "Deleting a connection, or reconnecting it with another app, revokes the old grant.",
    proof: [core("tests/oauth-discovery-revoke.test.ts", "revoking: the refresh token, then the cached access token"), web("tests/secrets-revoke.test.ts", "deleting revokes"), platform(KC, "revocation (RFC 7009)")],
  },
  {
    id: "client.par", role: "client", title: "Pushed authorization requests", spec: "RFC 9126",
    status: "supported", note: "Used whenever the provider has a PAR endpoint.",
    proof: [platform("tests/oauth-connect.test.ts", "PAR (RFC 9126)"), platform(KC, "authorization code + PKCE S256 + PAR"), cli("tests/cli-connect.test.ts", "with a PAR endpoint")],
  },
  {
    id: "client.token-response", role: "client", title: "Token responses as providers send them", spec: "RFC 6749 §5.1",
    status: "supported", note: "JSON or form-encoded, `expires_in` as a string, Slack's `authed_user`.",
    proof: [core("tests/oauth-token.test.ts", "Slack: a user token alone"), core("tests/oauth-token.test.ts", "a form-encoded answer"), core("tests/oauth-provider-fixtures.test.ts", "no expires_in; instance_url the agent needs"), core("tests/oauth-provider-fixtures.test.ts", "form-encoded unless asked for JSON")],
  },
  {
    id: "client.jwt-bearer", role: "client", title: "JWT bearer grant (service accounts)", spec: "RFC 7523 §2.1",
    status: "supported", note: "The service-account connection (`--kind service-account`).",
    proof: [core("tests/secret-types.test.ts", "service account with a subject")],
  },
  {
    id: "client.rar", role: "client", title: "Rich authorization requests", spec: "RFC 9396",
    status: "supported", note: "`authorization_details` as an extra authorize parameter (a JSON value).",
    proof: [platform("tests/oauth-connect.test.ts", "authorization_details (RFC 9396)")],
  },
  {
    id: "client.private-key-jwt", role: "client", title: "Signed client assertion (private_key_jwt)", spec: "RFC 7523 §2.2",
    status: "supported", note: "`token_auth: private_key_jwt` with a key you paste or foldrun makes; a certificate adds Entra's thumbprint. `--token-auth jwt`.",
    proof: [core("tests/oauth-assertion.test.ts", "an oauth2 secret with private_key_jwt refreshes"), platform("tests/oauth-connect.test.ts", "private_key_jwt: a saved app can have its key made"), platform(KC, "private_key_jwt (RFC 7523): code + PKCE + PAR signed"), cli("tests/cli-connect.test.ts", "connect --token-auth jwt --key-file")],
  },
  {
    id: "client.device", role: "client", title: "Device authorization", spec: "RFC 8628",
    status: "planned", note: "Part F: `foldrun connect --device`.",
  },
  {
    id: "client.token-exchange", role: "client", title: "Token exchange", spec: "RFC 8693",
    status: "planned", note: "Part I: a `token-exchange` secret kind. Cloud STS is covered today by the keyless identity kind.",
  },
  {
    id: "client.dpop", role: "client", title: "DPoP sender-constrained tokens", spec: "RFC 9449",
    status: "planned", note: "Part H: Bluesky/atproto, Okta DPoP.",
  },
  {
    id: "client.mtls", role: "client", title: "Mutual-TLS client auth and bound tokens", spec: "RFC 8705",
    status: "planned", note: "Part H: the client-cert secret at the token endpoint.",
  },
  {
    id: "client.ciba", role: "client", title: "Client-initiated backchannel authentication", spec: "OpenID CIBA",
    status: "not-needed", note: "No provider an agent needs uses it.",
  },
  // ------------------------------------------------------------ server (/api/mcp)
  {
    id: "server.authorization-code-pkce", role: "server", title: "Authorization code with PKCE (S256)", spec: "OAuth 2.1, MCP authorization",
    status: "supported", note: "How claude.ai and other AI apps sign in to /api/mcp.",
    proof: [web("tests/mcp-oauth.test.ts", "the code: PKCE, once, for its own app and redirect"), web("tests/mcp-sdk-oauth.test.ts", "the MCP SDK: 401 → discovery → registration")],
  },
  {
    id: "server.refresh-rotation", role: "server", title: "Refresh rotation, reuse revokes", spec: "OAuth 2.1 §4.3.1",
    status: "supported", note: "A refresh token used twice ends the connection.",
    proof: [web("tests/mcp-oauth.test.ts", "refresh rotates; a refresh token used twice ends the connection")],
  },
  {
    id: "server.client-auth", role: "server", title: "Client secret (Basic or body), or a public app", spec: "RFC 6749 §2.3.1",
    status: "supported", note: "Registered apps choose `none`, `client_secret_post` or `client_secret_basic`.",
    proof: [web("tests/mcp-oauth.test.ts", "a confidential app proves itself with its secret")],
  },
  {
    id: "server.metadata", role: "server", title: "Authorization server and resource metadata", spec: "RFC 8414, RFC 9728",
    status: "supported", note: "`/.well-known/oauth-authorization-server` and `/.well-known/oauth-protected-resource`.",
    proof: [web("tests/mcp-oauth.test.ts", "discovery: the resource names its server")],
  },
  {
    id: "server.registration", role: "server", title: "Dynamic registration and client metadata documents", spec: "RFC 7591, CIMD",
    status: "supported", note: "An app registers itself, or names itself by an https URL.",
    proof: [web("tests/mcp-oauth.test.ts", "registration: https or loopback redirect URIs only")],
  },
  {
    id: "server.resource-indicators", role: "server", title: "Resource indicators", spec: "RFC 8707",
    status: "supported", note: "Tokens are bound to /api/mcp.",
    proof: [web("tests/mcp-oauth.test.ts", "the access token opens /api/mcp and its tools")],
  },
  {
    id: "server.iss-parameter", role: "server", title: "Issuer in the authorization response", spec: "RFC 9207",
    status: "supported", note: "Every answer carries `iss`.",
    proof: [web("tests/mcp-oauth.test.ts", "the approval page's request")],
  },
  {
    id: "server.revocation", role: "server", title: "Revocation endpoint", spec: "RFC 7009",
    status: "supported", note: "`POST /api/mcp/oauth/revoke`: an app ends its own connection.",
    proof: [web("tests/mcp-oauth.test.ts", "revocation (RFC 7009): advertised")],
  },
  {
    id: "server.client-credentials", role: "server", title: "Client credentials for machine clients", spec: "RFC 6749 §4.4",
    status: "planned", note: "Part G: machine MCP clients an admin registers.",
  },
  {
    id: "server.private-key-jwt", role: "server", title: "Signed client assertion (private_key_jwt)", spec: "RFC 7523 §2.2",
    status: "supported", note: "Apps that register `jwks` or `jwks_uri` sign in with assertions; each `jti` is used once.",
    proof: [web("tests/mcp-oauth.test.ts", "private_key_jwt (RFC 7523): an app with a JWKS signs in"), core("tests/oauth-assertion.test.ts", "the verifier refuses")],
  },
  // ------------------------------------------------------------ refused, both roles
  {
    id: "refused.implicit", role: "client", title: "Implicit grant", spec: "RFC 9700 §2.1.2",
    status: "refused", note: "Tokens in the browser's URL leak; OAuth 2.1 removes it.",
  },
  {
    id: "refused.password", role: "client", title: "Resource owner password grant", spec: "RFC 9700 §2.4",
    status: "refused", note: "foldrun never holds a person's password for another service.",
  },
  {
    id: "refused.pkce-plain", role: "server", title: "PKCE `plain`", spec: "RFC 9700 §2.1.1",
    status: "refused", note: "Only S256 is accepted: `plain` protects nothing if the request is seen.",
    proof: [web("tests/mcp-oauth.test.ts", "the approval page's request")],
  },
  {
    id: "refused.wildcard-redirect", role: "server", title: "Wildcard or prefix redirect matching", spec: "RFC 9700 §4.1",
    status: "refused", note: "Redirect URIs match exactly (a loopback port may vary).",
    proof: [web("tests/mcp-oauth.test.ts", "the approval page's request")],
  },
];
