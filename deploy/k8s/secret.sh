#!/usr/bin/env bash
# Recreates the app-secrets Secret from the repo's .env, without printing any value.
#
#   deploy/k8s/secret.sh [path/to/.env]
#
# The Secret is deleted first on purpose: applying over an older one keeps the keys it had
# (MONGODB_URI, SEAWEED_S3_*), and a leftover SEAWEED_S3_ENDPOINT would point the app's S3
# client at that endpoint with static keys instead of the node's LabRole credentials.
set -euo pipefail

ENV_FILE="${1:-$(cd "$(dirname "$0")/../.." && pwd)/.env}"
KEYS=(SESSION_SECRET STRIPE_SECRET_KEY STRIPE_WEBHOOK_SECRET GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET)

[[ -f $ENV_FILE ]] || { echo "no env file at $ENV_FILE" >&2; exit 1; }

# The last KEY=value line for a key, with a trailing CR and one pair of quotes removed.
value() {
  local line
  line=$(grep -E "^$1=" "$ENV_FILE" | tail -n 1) || return 0
  line=${line#*=}
  line=${line%$'\r'}
  if [[ ${#line} -ge 2 && ( $line == \"*\" || $line == \'*\' ) ]]; then
    line=${line:1:${#line}-2}
  fi
  printf '%s' "$line"
}

session_secret=$(value SESSION_SECRET)
if [[ ${#session_secret} -lt 32 ]]; then
  echo "SESSION_SECRET must be set in $ENV_FILE and be at least 32 characters" >&2
  exit 1
fi

tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT
chmod 600 "$tmp"

for key in "${KEYS[@]}"; do
  v=$(value "$key")
  if [[ -z $v ]]; then
    echo "skip $key (not set)"
    continue
  fi
  printf '%s=%s\n' "$key" "$v" >> "$tmp"
  echo "set  $key"
done

kubectl -n g-hub delete secret app-secrets --ignore-not-found
kubectl -n g-hub create secret generic app-secrets --from-env-file="$tmp"
