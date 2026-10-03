#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# The Kumo service's proxy, unchanged, in front of a stub NIM (compose.test.yaml) on this Docker host: no GPU,
# no NIM. It runs under a throwaway Compose project with random keys, on a free loopback port, and removes the
# containers and network afterwards (pulled images stay). Checks: 401 without a key, with a wrong one and with a
# near miss; 200 with the key and with the previous key; the key never reaches the NIM; a prediction-sized POST
# arrives whole; 413 past the body limit; /healthz without a key; no nginx version; 429 past the rate limit; no
# key in any log.
#
#   infra/kumo-service/tests/proxy-test.sh     (or ./scripts/demo.sh test kumo-service)
#
# Needs Docker with Compose 2.30+, bash and curl.
set -Eeuo pipefail

dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
project=kumo-service-test-$$
work=$(mktemp -d)
failures=0

random_key() { od -An -tx1 -N32 /dev/urandom | tr -d ' \n'; }
sha256() { if command -v sha256sum >/dev/null; then sha256sum; else shasum -a 256; fi | cut -d' ' -f1; }

free_port() {
  local port _
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    port=$((20000 + RANDOM % 20000))
    if ! (: </dev/tcp/127.0.0.1/"$port") 2>/dev/null; then
      echo "$port"
      return 0
    fi
  done
  return 1
}

key=$(random_key)
previous=$(random_key)
wrong=$(random_key)
port=$(free_port)
url=http://127.0.0.1:$port
(umask 077 && printf '%s\n' "KUMO_SERVICE_API_KEY=$key" "KUMO_SERVICE_PREVIOUS_API_KEY=$previous" \
  KUMO_SERVICE_BIND=127.0.0.1 "KUMO_SERVICE_PORT=$port" >"$work/env")

dc() {
  docker compose -p "$project" -f "$dir/compose.yaml" -f "$dir/tests/compose.test.yaml" --env-file "$work/env" "$@"
}
cleanup() {
  dc down --volumes --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

# request KEY CURL_ARGS...: the status code (000 when the connection failed), the body in $work/body. The key
# reaches curl on stdin, never on its command line.
request() {
  local key=$1
  shift
  { [ -z "$key" ] || printf 'header = "X-API-Key: %s"\n' "$key"; } |
    curl -sS -o "$work/body" -w '%{http_code}' --max-time 120 --config - "$@" 2>/dev/null || true
}

# check NAME EXPECTED ACTUAL
check() {
  if [ "$2" = "$3" ]; then
    printf 'ok    %s\n' "$1"
  else
    printf 'FAIL  %s: expected %s, got %s\n' "$1" "$2" "$3"
    failures=$((failures + 1))
  fi
}

body_has() { grep -qF -- "$1" "$work/body" && echo yes || echo no; }

echo "==> kumo-service proxy test: project $project, $url"
dc up -d --wait proxy stub
for _ in $(seq 30); do
  [ "$(request "" "$url/healthz")" = 200 ] && break
  sleep 1
done

check "GET /healthz without a key" 200 "$(request "" "$url/healthz")"
check "  is the NIM's readiness" yes "$(body_has '"path": "/v1/health/ready"')"
check "GET /v1/models without a key" 401 "$(request "" "$url/v1/models")"
check "  says why" yes "$(body_has 'missing or invalid X-API-Key')"
check "GET /v1/models with a wrong key" 401 "$(request "$wrong" "$url/v1/models")"
check "GET /v1/models with the key in upper case" 401 "$(request "$(printf '%s' "$key" | tr a-f A-F)" "$url/v1/models")"
check "GET /v1/models with the key's first half" 401 "$(request "${key:0:32}" "$url/v1/models")"
check "GET /v1/models with the key and more" 401 "$(request "${key}0" "$url/v1/models")"
check "GET /v1/models with the key" 200 "$(request "$key" "$url/v1/models")"
check "  passes the NIM's answer through" yes "$(body_has '"id": "kumo-relational"')"
check "  without the key" yes "$(body_has '"x_api_key": false')"
check "GET /v1/models with the previous key" 200 "$(request "$previous" "$url/v1/models")"

# A prediction request is about 7 to 10 MB of JSON; this one is 32 MiB, half the limit.
head -c 33554432 /dev/urandom >"$work/large"
digest=$(sha256 <"$work/large")
check "POST 32 MiB without a key" 401 "$(request "" -X POST --data-binary @"$work/large" "$url/v1/predictions")"
check "POST 32 MiB with the key" 200 \
  "$(request "$key" -X POST -H 'Content-Type: application/json' --data-binary @"$work/large" "$url/v1/predictions")"
check "  arrives whole" yes "$(body_has "\"bytes\": 33554432, \"sha256\": \"$digest\"")"
head -c 68157440 /dev/urandom >"$work/too-large"
check "POST 65 MiB with the key" 413 "$(request "$key" -X POST --data-binary @"$work/too-large" "$url/v1/predictions")"

server=$(curl -sS -o /dev/null -D - "$url/healthz" | tr -d '\r' | sed -n 's/^[Ss]erver: //p')
check "Server header without a version" nginx "$server"

limited=0
for _ in $(seq 100); do
  [ "$(request "" "$url/healthz")" != 429 ] || limited=$((limited + 1))
done
check "100 quick requests are rate limited" yes "$([ "$limited" -gt 0 ] && echo yes || echo "no ($limited)")"

logs=$(dc logs --no-color proxy stub 2>&1)
check "the proxy logs requests" yes "$(grep -q '"GET /v1/models HTTP/1.1" 401' <<<"$logs" && echo yes || echo no)"
for name in key previous wrong; do
  check "no $name key in the logs" no "$(grep -qF -- "${!name}" <<<"$logs" && echo yes || echo no)"
done

if [ "$failures" -ne 0 ]; then
  printf '%s\n' "$logs" | tail -n 20 >&2
  echo "==> $failures check(s) failed" >&2
  exit 1
fi
echo "==> every check passed"
