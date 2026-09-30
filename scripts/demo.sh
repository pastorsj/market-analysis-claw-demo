#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# The demo's lifecycle. Run ./scripts/demo.sh --help for the commands.
# Needs Docker Engine 28+, Compose 2.30+, bash (3.2 is fine) and curl; `test` also needs uv and Node.
# shellcheck source-path=SCRIPTDIR
set -Eeuo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
# shellcheck source=lib/common.sh
. "$ROOT/scripts/lib/common.sh"
# shellcheck source=lib/env.sh
. "$ROOT/scripts/lib/env.sh"
# shellcheck source=lib/doctor.sh
. "$ROOT/scripts/lib/doctor.sh"
# shellcheck source=lib/openshell.sh
. "$ROOT/scripts/lib/openshell.sh"

readonly COMPOSE_PROJECT=market-demo # the name in compose.yaml
readonly UP_TIMEOUT=3600 # the first data build downloads SEC EDGAR and embeds the corpus
readonly PYTHON_PROJECTS="agent api data tools/retrieval tools/market-analytics tools/auto-ontology"
readonly RUFF=ruff@0.16.9 # the version in .pre-commit-config.yaml
# Profile sets `test compose` renders; each must be valid with no .env.
readonly PROFILE_SETS="core core,retrieval,analytics core,retrieval,analytics-gpu,kumo
  core,retrieval,analytics,kumo,ontology replay build,tools"

usage() {
  cat <<'EOF'
Usage: ./scripts/demo.sh <command> [options]

Setup
  init                    create .env from .env.example and generate its internal secrets
  doctor [--keys]         check the host, .env and profiles; --keys also asks each endpoint
                          for its model list (authenticated, keys never printed)

Run
  up [--no-build]         build, prepare data, start the tools, Switchyard, Phoenix and the API,
                          then the OpenShell sandbox, the Hermes forwarder and the UI
  down [--volumes] [--prune]
                          delete the sandbox, then stop everything (--volumes: also delete data;
                          --prune: also remove this project's untagged images and Docker's unused
                          build cache, which is host-wide)
  restart SERVICE         agent: recreate the sandbox; switchyard: re-render its routes from
                          .env and refresh the API's model ids; anything else:
                          docker compose restart SERVICE
  status                  services, the sandbox, Switchyard routes and URLs
  logs [agent|routing|SERVICE...] [-f]
                          agent: Hermes in the sandbox; routing: Switchyard's routing decisions
  check                   prove the sandbox boundary on the running stack

Data and recordings
  data prepare            build the active data pack (and the corpus and index with retrieval)
  data reindex            rebuild the retrieval index, e.g. after changing the embed model
  data validate|verify|list|clean [--all]
  record [ARGS...]        record sessions from the running stack into
                          data/packs/$DATA_PACK/recordings (ARGS go to `demo-api record`)
  replay                  serve the UI on the recorded sessions only: no .env, keys or GPU

Development
  test [unit|ui|e2e|contracts|compose|switchyard|all]
                          default: unit ui contracts compose

Configuration comes from .env (see .env.example); a shell variable overrides it.
Profiles come from COMPOSE_PROFILES (default core,retrieval,analytics).
EOF
}

# up [--no-build]
cmd_up() {
  local build=true
  case ${1:-} in
    "") ;;
    --no-build) build=false ;;
    *) die "$EXIT_USAGE" "usage: demo.sh up [--no-build]" ;;
  esac
  load_env
  require_env
  doctor_for_up
  if has_profile ontology; then
    "$ROOT/tools/auto-ontology/prepare.sh"
  fi
  if $build; then
    log "building images (profiles $COMPOSE_PROFILES; agent features: ${AGENT_FEATURES:-none})"
    COMPOSE_PROFILES=$COMPOSE_PROFILES,build,tools dc build
  fi
  log "preparing data and starting the tools, Switchyard, Phoenix and the API"
  # shellcheck disable=SC2046 # one service per word
  dc up -d --wait --wait-timeout "$UP_TIMEOUT" $(backend_services)
  openshell_up
  log "starting the UI"
  dc up -d --wait ui
  summary
}

# What the sandbox calls, by profile, plus the Auto Ontology web app the API signs in to for the
# data viewer's ontology. The data and migration one-shots run as their dependencies.
backend_services() {
  local services="switchyard phoenix api" profile
  for profile in ${COMPOSE_PROFILES//,/ }; do
    case $profile in
      retrieval) services="$services retrieval" ;;
      analytics) services="$services market-analytics" ;;
      analytics-gpu) services="$services market-analytics-gpu" ;;
      kumo) services="$services kumo-relational" ;;
      ontology) services="$services auto-ontology-mcp auto-ontology-frontend" ;;
    esac
  done
  echo "$services"
}

summary() {
  local capable=""
  if uses_capable_model; then
    capable="capable $AGENT_CAPABLE_MODEL on $(endpoint_host "$CAPABLE_BASE_URL"), "
  fi
  cat >&2 <<EOF

The demo is up.
  UI        http://127.0.0.1:$UI_PORT
  Phoenix   http://127.0.0.1:6006   (on a remote host, use an SSH tunnel)
  Models    $SWITCHYARD_ROUTES on $(endpoint_host "$INFERENCE_BASE_URL"): efficient $AGENT_EFFICIENT_MODEL,
            ${capable}judge $AGENT_JUDGE_MODEL
  Data      $DATA_PACK
Next: ./scripts/demo.sh check
EOF
}

endpoint_host() {
  local host=${1#*://}
  echo "${host%%/*}"
}

# down [--volumes] [--prune]: the sandbox first, then Compose. Never --remove-orphans: the project
# is shared.
cmd_down() {
  local volumes=false prune=false arg
  for arg in "$@"; do
    case $arg in
      --volumes) volumes=true ;;
      --prune) prune=true ;;
      *) die "$EXIT_USAGE" "usage: demo.sh down [--volumes] [--prune]" ;;
    esac
  done
  load_env
  openshell_down
  log "stopping the stack"
  if $volumes; then
    dc --profile '*' down --volumes
  else
    dc --profile '*' down
  fi
  if $prune; then
    prune_builds
  fi
}

# What rebuilds leave behind. With Docker's classic image store, each rebuild leaves the previous
# image untagged; only those Compose labelled with this project are removed. With the containerd
# image store the old image goes away, but its layers stay in BuildKit's build cache, which grows by
# about 15 GB per rebuild of the RAPIDS image. The build cache is host-wide, not per project, so this
# also clears other projects' unused cache (never their images, containers or volumes).
prune_builds() {
  log "removing the untagged images of earlier $COMPOSE_PROJECT builds"
  docker image prune --force --filter "label=com.docker.compose.project=$COMPOSE_PROJECT"
  log "removing Docker's unused build cache (host-wide); the next build starts cold"
  docker builder prune --force
  docker system df
}

# restart SERVICE
cmd_restart() {
  [ $# -eq 1 ] || die "$EXIT_USAGE" "usage: demo.sh restart agent|switchyard|SERVICE"
  load_env
  require_env
  case $1 in
    agent) openshell_up --recreate ;;
    # The API recreates only if its model ids changed; --no-deps leaves the data one-shot alone.
    switchyard) dc up -d --wait --force-recreate switchyard && dc up -d --wait --no-deps api ;;
    *) dc restart "$1" ;;
  esac
}

cmd_status() {
  [ $# -eq 0 ] || die "$EXIT_USAGE" "usage: demo.sh status"
  local routes endpoints
  load_env
  dc ps -a --format 'table {{.Service}}\t{{.State}}\t{{.Status}}'
  echo
  if gateway_ready; then
    endpoints='"sandbox: \(.phase)", (.endpoint_statuses[]
      | "  \(.host):\(.ports | map(tostring) | join(",")) \(.path) \(.last_result)")'
    # shellcheck disable=SC2016 # expanded by the container's shell
    cli_sh 'json=$(openshell sandbox get hermes -o json 2>/dev/null) && echo "$json" | jq -r "$1" ||
      echo "sandbox: none"' "$endpoints"
  else
    echo "sandbox: the OpenShell gateway is not running"
  fi
  if routes=$(curl -fsS --max-time 3 http://127.0.0.1:4000/v1/models 2>/dev/null); then
    echo "switchyard: $SWITCHYARD_ROUTES on $(endpoint_host "$INFERENCE_BASE_URL"), routes:" \
      "$(echo "$routes" | tr ',' '\n' | sed -n 's/.*"id": *"\([^"]*\)".*/\1/p' | tr '\n' ' ')"
  fi
  echo "data pack: $DATA_PACK; profiles: $COMPOSE_PROFILES; agent features: ${AGENT_FEATURES:-none}"
  echo "UI: http://127.0.0.1:$UI_PORT  Phoenix: http://127.0.0.1:6006"
}

# logs [agent|routing|SERVICE...] [-f]
cmd_logs() {
  load_env
  case ${1:-} in
    agent)
      shift
      if [ "${1:-}" = -f ]; then cli logs "$SANDBOX" --tail; else cli logs "$SANDBOX"; fi
      ;;
    routing)
      shift
      if [ "${1:-}" = -f ]; then
        dc exec switchyard tail -n 50 -f /var/lib/switchyard/routing.jsonl
      else
        dc exec switchyard tail -n 50 /var/lib/switchyard/routing.jsonl
      fi
      ;;
    *) dc logs "$@" ;;
  esac
}

# replay: the UI alone on the pack's recordings. Works without .env.
cmd_replay() {
  [ $# -eq 0 ] || die "$EXIT_USAGE" "usage: demo.sh replay"
  export COMPOSE_PROFILES=replay UI_MODE=replay PHOENIX_URL=
  load_env
  dc up -d --build --wait ui
  log "replay: http://127.0.0.1:$UI_PORT (data pack $DATA_PACK)"
}

# record [ARGS...]: `demo-api record` against the running API, written to the pack's recordings.
cmd_record() {
  load_env
  require_env
  local out=data/packs/$DATA_PACK/recordings
  mkdir -p "$ROOT/$out"
  # As the host user, so the files are the user's; --no-deps leaves the running stack alone.
  dc run --rm --no-deps --user "$(id -u):$(id -g)" -v "$ROOT/$out:/out" --entrypoint demo-api api \
    record --out /out "$@"
  git -C "$ROOT" status --short -- "$out"
  log "review $out before committing: it holds questions, answers, evidence excerpts and model names"
}

# data prepare|reindex|validate|verify|list|clean [--all]
cmd_data() {
  local action=${1:-} service
  load_env
  case $action in
    prepare)
      dc run --rm --no-deps data prepare --structured
      if has_profile retrieval; then
        dc run --rm --no-deps data-corpus
        reindex
      fi
      # market-analytics keeps the build it resolved at startup; restart it on the new one.
      for service in market-analytics market-analytics-gpu; do
        if [ -n "$(dc ps -q --status running "$service" 2>/dev/null)" ]; then
          dc restart "$service"
        fi
      done
      ;;
    reindex) reindex ;;
    validate | verify | list | clean)
      shift
      dc run --rm --no-deps data "$action" "$@"
      ;;
    *) die "$EXIT_USAGE" "usage: demo.sh data prepare|reindex|validate|verify|list|clean [--all]" ;;
  esac
}

reindex() {
  dc up -d --wait milvus
  dc run --rm --no-deps retrieval-index
}

# test [SUITE...]
cmd_test() {
  local suites=${*:-unit ui contracts compose} suite
  [ "$suites" != all ] || suites="unit ui e2e contracts compose switchyard"
  for suite in $suites; do
    case $suite in
      unit | ui | e2e | contracts | compose | switchyard) log "test $suite" && "test_$suite" ;;
      *) die "$EXIT_USAGE" "usage: demo.sh test [unit|ui|e2e|contracts|compose|switchyard|all]" ;;
    esac
  done
}

test_unit() {
  local project skill
  for project in $PYTHON_PROJECTS; do
    log "$project"
    (cd "$ROOT/$project" && uv run --locked pytest -q -m "not gpu and not slow and not live")
  done
  # shellcheck disable=SC2086 # one project per word
  (cd "$ROOT" && uvx "$RUFF" check $PYTHON_PROJECTS && uvx "$RUFF" format --check $PYTHON_PROJECTS)
  for skill in "$ROOT"/agent/profile/skills/*/; do
    (cd "$ROOT/agent" && uv run --locked agentskills validate "$skill")
  done
}

test_ui() {
  (cd "$ROOT/ui" && npm ci && npm run lint && npm run type-check && npm run test:ci)
}

# On Linux, Playwright also installs Chromium's system libraries (apt, through sudo), as CI does;
# a server image such as Ubuntu 22.04 on a cloud VM lacks them.
test_e2e() {
  local install=(npx playwright install chromium)
  if [ "$(uname -s)" = Linux ]; then
    install=(npx playwright install --with-deps chromium)
  fi
  (cd "$ROOT/ui" && { [ -d node_modules ] || npm ci; } && npm run build && "${install[@]}" && npm run e2e)
}

test_contracts() {
  "$ROOT/scripts/gen-contracts.sh" --check
}

# Every profile set renders with only the OpenShell pins: no .env, as in CI and `replay`.
test_compose() {
  local profiles
  for profiles in $PROFILE_SETS; do
    COMPOSE_PROFILES=$profiles docker compose -f "$ROOT/compose.yaml" --env-file "$VERSIONS_FILE" config -q
    # Every port is on loopback; UI_BIND_HOST moves the UI's alone.
    if UI_BIND_HOST='' published_hosts "$profiles" | grep -v ' 127\.0\.0\.1$' ||
      UI_BIND_HOST=0.0.0.0 published_hosts "$profiles" | grep -v -e ' 127\.0\.0\.1$' -e '^ui 0\.0\.0\.0$'; then
      die "$EXIT_CONFIG" "compose publishes a port beyond 127.0.0.1 (profiles $profiles)"
    fi
    case ,$profiles, in
      *,core,* | *,replay,*)
        UI_BIND_HOST=0.0.0.0 published_hosts "$profiles" | grep -qx 'ui 0\.0\.0\.0' ||
          die "$EXIT_CONFIG" "UI_BIND_HOST does not reach the ui port (profiles $profiles)"
        ;;
    esac
    log "compose config: $profiles"
  done
}

# The host addresses Compose publishes on, one "service address" line per port.
published_hosts() {
  COMPOSE_PROFILES=$1 docker compose -f "$ROOT/compose.yaml" --env-file "$VERSIONS_FILE" config |
    awk '/^services:/ { in_services = 1; next }
      /^[^ ]/ { in_services = 0 }
      in_services && /^  [^ ]/ { service = $1; sub(/:$/, "", service) }
      in_services && $1 == "host_ip:" { print service, $2 }'
}

# Builds the image `up` runs: a plain `docker build` would retag it with a different ID.
test_switchyard() {
  dc build -q switchyard >/dev/null
  docker run --rm -v "$ROOT/infra/switchyard/tests:/opt/switchyard/tests:ro" \
    --entrypoint /opt/switchyard/tests/render-all.sh market-demo/switchyard:local
}

main() {
  local command=${1:-}
  case $command in
    "" | -h | --help | help) usage ;;
    init | doctor | up | down | restart | status | logs | replay | record | data | test | check)
      shift
      "cmd_$command" "$@"
      ;;
    *)
      usage >&2
      exit "$EXIT_USAGE"
      ;;
  esac
}

main "$@"
