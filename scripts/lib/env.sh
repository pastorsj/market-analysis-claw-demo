# shellcheck shell=bash
# SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# The configuration demo.sh works from: .env exactly as Compose reads it, plus derived values.
# .env is never sourced: bash and Compose parse it differently.

readonly DEFAULT_PROFILES=core,retrieval,analytics
readonly GENERATED_SECRETS="HERMES_API_SERVER_KEY HERMES_RECEIPT_API_KEY
  AUTO_ONTOLOGY_ADMIN_PASSWORD AUTO_ONTOLOGY_AUTH_SECRET"

# Every variable demo.sh reads. A shell value wins over .env, as in Compose.
readonly ENV_KEYS="COMPOSE_PROFILES UI_PORT DATA_PACK DATA_CORPORA SEC_USER_AGENT
  INFERENCE_BASE_URL INFERENCE_API_KEY CAPABLE_BASE_URL CAPABLE_API_KEY
  SWITCHYARD_ROUTES SWITCHYARD_CONFIRMATIONS
  AGENT_EFFICIENT_MODEL AGENT_CAPABLE_MODEL AGENT_JUDGE_MODEL
  AUTO_ONTOLOGY_REASONING_MODEL AUTO_ONTOLOGY_NON_REASONING_MODEL
  RETRIEVER_BASE_URL RETRIEVER_API_KEY RETRIEVER_EMBED_MODEL KUMO_RELATIONAL_URL
  $GENERATED_SECRETS OPENSHELL_SUPERVISOR_IMAGE OPENSHELL_SANDBOX_IMAGE"

# Read ENV_KEYS from Compose's own view of the environment (shell, versions.env, .env), then
# derive and export what Compose cannot compute itself:
#   COMPOSE_PROFILES    defaults to core,retrieval,analytics
#   DATA_DATABASE_NAME  the pack id in snake case (Compose has no ${VAR//-/_})
#   KUMO_RELATIONAL_URL the local NIM under the kumo profile
#   AUTO_ONTOLOGY_URL   the Auto Ontology web app under the ontology profile, for the API
#   AGENT_FEATURES      the optional tools baked into the agent image
#   RETRIEVER_API_KEY   INFERENCE_API_KEY when empty: one build.nvidia.com key serves both
# CAPABLE_BASE_URL and CAPABLE_API_KEY also fall back to the inference ones, here for doctor and
# in Switchyard's entrypoint for the stack.
load_env() {
  local environment key
  environment=$(dc config --environment) || die "$EXIT_CONFIG" "docker compose cannot read the configuration"
  for key in $ENV_KEYS; do
    printf -v "$key" '%s' "$(printf '%s\n' "$environment" | sed -n "s/^$key=//p")"
  done
  COMPOSE_PROFILES=${COMPOSE_PROFILES:-$DEFAULT_PROFILES}
  UI_PORT=${UI_PORT:-3100}
  DATA_PACK=${DATA_PACK:-market-analysis}
  DATA_DATABASE_NAME=${DATA_PACK//-/_}
  if has_profile kumo; then
    KUMO_RELATIONAL_URL=http://kumo-relational:8000
  fi
  AUTO_ONTOLOGY_URL=
  if has_profile ontology; then
    AUTO_ONTOLOGY_URL=http://auto-ontology-frontend:3000
  fi
  AGENT_FEATURES=$(agent_features)
  RETRIEVER_API_KEY=${RETRIEVER_API_KEY:-$INFERENCE_API_KEY}
  CAPABLE_BASE_URL=${CAPABLE_BASE_URL:-$INFERENCE_BASE_URL}
  CAPABLE_API_KEY=${CAPABLE_API_KEY:-$INFERENCE_API_KEY}
  export COMPOSE_PROFILES DATA_DATABASE_NAME KUMO_RELATIONAL_URL AUTO_ONTOLOGY_URL AGENT_FEATURES
  export RETRIEVER_API_KEY
}

# Commands that run the live stack need .env, and always include the core profile.
require_env() {
  [ -f "$ENV_FILE" ] || die "$EXIT_CONFIG" "no .env yet: run ./scripts/demo.sh init"
  if ! has_profile core; then
    COMPOSE_PROFILES=core,$COMPOSE_PROFILES
  fi
}

has_profile() {
  case ",$COMPOSE_PROFILES," in
    *",$1,"*) return 0 ;;
    *) return 1 ;;
  esac
}

# The agent image's features (agent/README.md): retrieval, analytics (also for analytics-gpu),
# kumo (the kumo profile or a hosted KUMO_RELATIONAL_URL) and ontology, in that order.
agent_features() {
  local features=""
  if has_profile retrieval; then
    features=retrieval
  fi
  if has_profile analytics || has_profile analytics-gpu; then
    features=${features:+$features,}analytics
  fi
  if [ -n "$KUMO_RELATIONAL_URL" ]; then
    features=${features:+$features,}kumo
  fi
  if has_profile ontology; then
    features=${features:+$features,}ontology
  fi
  echo "$features"
}

# init: create .env from .env.example (mode 600, never overwritten) and fill every empty
# generated secret with 64 random hex characters.
cmd_init() {
  [ $# -eq 0 ] || die "$EXIT_USAGE" "usage: demo.sh init"
  if [ -f "$ENV_FILE" ]; then
    log ".env exists; filling only its empty generated secrets"
  else
    (umask 077 && cp "$ROOT/.env.example" "$ENV_FILE")
    log "created .env (mode 600)"
  fi
  local key script="" tmp
  for key in $GENERATED_SECRETS; do
    script="$script s/^$key=\$/$key=$(random_hex)/;"
  done
  tmp=$(mktemp "$ENV_FILE.XXXXXX") # mode 600, next to .env
  sed "$script" "$ENV_FILE" >"$tmp" && mv "$tmp" "$ENV_FILE"
  cat >&2 <<'EOF'
Now edit .env:
  INFERENCE_API_KEY   the key for INFERENCE_BASE_URL (section 1): an nvapi- key for build.nvidia.com
  RETRIEVER_API_KEY   only for a different retriever key (section 2); empty uses INFERENCE_API_KEY
  COMPOSE_PROFILES    what runs (section 3)
  SEC_USER_AGENT      your name and email, for the SEC EDGAR corpus (section 4)
Then run: ./scripts/demo.sh doctor --keys && ./scripts/demo.sh up
EOF
}
