#!/usr/bin/env bash
# Create the R2 bucket and the scoped S3 credential the file store uses, then
# write the four values into infra/production/production.env.
#
# Idempotent: an existing bucket is left alone, and re-running mints a fresh
# token rather than failing. R2 shows a token's secret exactly once, at
# creation, so there is no way to "look up" the old one — minting again is the
# recovery path, and the old token should then be deleted in the dashboard.
#
#   CLOUDFLARE_ACCOUNT_ID   the account R2 lives in
#   CLOUDFLARE_EMAIL        with the global key below
#   CLOUDFLARE_API_KEY      global key (or use CLOUDFLARE_API_TOKEN instead)
#
# Read from the environment, or from the file named by CF_ENV (default:
# ~/owner/owner-website/.env.local).
#
#   ./scripts/r2-setup.sh                 # bucket foldrun-files, apac
#   BUCKET=foldrun-dev ./scripts/r2-setup.sh
set -euo pipefail

BUCKET="${BUCKET:-foldrun-files}"
# Bucket location. apac is the closest R2 hint to the box and to the people
# using it; R2 has no egress cost either way, so this is latency only.
LOCATION="${LOCATION:-apac}"
CF_ENV="${CF_ENV:-$HOME/owner/owner-website/.env.local}"
OUT="$(cd "$(dirname "$0")/.." && pwd)/infra/production/production.env"

if [ -z "${CLOUDFLARE_ACCOUNT_ID:-}" ] && [ -f "$CF_ENV" ]; then
  set -a; . "$CF_ENV"; set +a
fi
: "${CLOUDFLARE_ACCOUNT_ID:?set CLOUDFLARE_ACCOUNT_ID, or point CF_ENV at a file holding it}"

# Two auth styles: a scoped API token, or the account's global key + email.
if [ -n "${CLOUDFLARE_API_TOKEN:-}" ]; then
  AUTH=(-H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}")
else
  : "${CLOUDFLARE_API_KEY:?set CLOUDFLARE_API_TOKEN, or CLOUDFLARE_API_KEY with CLOUDFLARE_EMAIL}"
  : "${CLOUDFLARE_EMAIL:?}"
  AUTH=(-H "X-Auth-Email: ${CLOUDFLARE_EMAIL}" -H "X-Auth-Key: ${CLOUDFLARE_API_KEY}")
fi

API="https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}"
say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

# ---------------------------------------------------------------- bucket
say "bucket ${BUCKET}"
create=$(curl -sS -X POST "${API}/r2/buckets" "${AUTH[@]}" \
  -H "content-type: application/json" \
  --data "{\"name\":\"${BUCKET}\",\"locationHint\":\"${LOCATION}\"}")

python3 - "$create" <<'PY'
import json, sys
d = json.loads(sys.argv[1])
if d.get("success"):
    print("created"); raise SystemExit(0)
codes = {e.get("code") for e in d.get("errors", [])}
if 10004 in codes or any("exist" in (e.get("message") or "").lower() for e in d.get("errors", [])):
    print("already there — left alone"); raise SystemExit(0)
if 10042 in codes:
    print(
        "R2 is not enabled on this account.\n\n"
        "  One click, in the dashboard — it cannot be done over the API,\n"
        "  because enabling R2 means accepting its terms:\n\n"
        "    https://dash.cloudflare.com/?to=/:account/r2\n"
        "    → Enable R2  (a payment method is required; the free tier is\n"
        "      10 GB stored, 1M writes and 10M reads a month, egress free)\n\n"
        "  Then run this script again.",
        file=sys.stderr,
    )
    raise SystemExit(2)
print(json.dumps(d.get("errors"), indent=1), file=sys.stderr)
raise SystemExit(1)
PY

# ---------------------------------------------------------------- token
# Scoped to this one bucket, object read+write. Deliberately not account-wide
# and deliberately not admin: this credential's whole job is to PUT, GET and
# DELETE objects under one bucket, so a leak cannot create buckets, read
# another product's data or change account settings.
say "S3 credential, scoped to ${BUCKET}"
now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
token=$(curl -sS -X POST "${API}/tokens" "${AUTH[@]}" \
  -H "content-type: application/json" \
  --data @- <<JSON
{
  "name": "foldrun-files ${now}",
  "policies": [
    {
      "effect": "allow",
      "permission_groups": [{ "id": "2efd5506f9c8494dacb1fa10a3e7d5b6" }],
      "resources": {
        "com.cloudflare.edge.r2.bucket.${CLOUDFLARE_ACCOUNT_ID}_default_${BUCKET}": "*"
      }
    }
  ]
}
JSON
)

python3 - "$token" "$CLOUDFLARE_ACCOUNT_ID" "$BUCKET" "$OUT" <<'PY'
import hashlib, json, os, re, sys

raw, account, bucket, out = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
d = json.loads(raw)
if not d.get("success"):
    print(json.dumps(d.get("errors"), indent=1), file=sys.stderr)
    raise SystemExit(1)

result = d["result"]
# R2's S3 credentials are derived from the API token, not returned separately:
# the access key id *is* the token id, and the secret is the SHA-256 of the
# token value. Documented, stable, and the only way to get them without the
# dashboard.
access_key_id = result["id"]
secret = hashlib.sha256(result["value"].encode()).hexdigest()

values = {
    "FOLDRUN_FILES_DRIVER": "s3",
    "FOLDRUN_S3_ENDPOINT": f"https://{account}.r2.cloudflarestorage.com",
    "FOLDRUN_S3_BUCKET": bucket,
    "FOLDRUN_S3_ACCESS_KEY_ID": access_key_id,
    "FOLDRUN_S3_SECRET_ACCESS_KEY": secret,
}

body = ""
if os.path.exists(out):
    body = open(out).read()
else:
    example = out.replace("production.env", "production.env.example")
    if os.path.exists(example):
        # Start from the template so the file that reaches the box has every
        # key it needs, not only the ones this script knows about.
        body = re.sub(r"^(FOLDRUN_S3_|FOLDRUN_FILES_DRIVER).*$", "", open(example).read(), flags=re.M)

for key, value in values.items():
    line = f"{key}={value}"
    if re.search(rf"^{key}=.*$", body, flags=re.M):
        body = re.sub(rf"^{key}=.*$", line, body, flags=re.M)
    else:
        body = body.rstrip("\n") + "\n" + line + "\n"

os.makedirs(os.path.dirname(out), exist_ok=True)
with open(out, "w") as f:
    f.write(re.sub(r"\n{3,}", "\n\n", body))
os.chmod(out, 0o600)

print(f"wrote {out} (0600)")
print(f"  endpoint  {values['FOLDRUN_S3_ENDPOINT']}")
print(f"  bucket    {bucket}")
print(f"  key id    {access_key_id[:8]}… (secret written to the file, not shown)")
PY

say "next"
cat <<'TEXT'
  Verify the credential actually works before shipping it:

    ./scripts/r2-verify.mjs

  Then put it on the box and roll the deployment:

    scp infra/production/production.env root@<box>:/etc/foldrun/env
    ssh root@<box> 'bash /opt/foldrun/infra/production/bootstrap.sh && \
      k3s kubectl -n foldrun rollout restart deploy/foldrun-platform'
TEXT
