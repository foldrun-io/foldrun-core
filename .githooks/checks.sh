# shellcheck shell=bash
# What pre-push runs in this repo, after the gitleaks scans in pre-push.
# Mirror CI (.github/workflows) and the box deploy gate; keep it read only.
repo_checks() {
  step "typecheck (npx tsc --noEmit -p .)" npx --no-install tsc --noEmit -p .
  step "tests (npm test)" npm test
}
