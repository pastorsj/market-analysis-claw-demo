# SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Kumo is configured by its service's URL and key, together or not at all: doctor's rule and the agent feature.

Runs scripts/lib's check_kumo, check_profiles and agent_features in bash, as demo.sh does, with no Docker.
"""

import os
import subprocess

import pytest
from common import ROOT

URL = "https://kumo.example.com"
KEY = "k" * 64  # a placeholder, not a key

SCRIPT = """
set -euo pipefail
ROOT=$1
. "$ROOT/scripts/lib/common.sh"
. "$ROOT/scripts/lib/env.sh"
. "$ROOT/scripts/lib/doctor.sh"
COMPOSE_PROFILES=$T_PROFILES KUMO_RELATIONAL_URL=$T_URL KUMO_API_KEY=$T_KEY
check_profiles
check_kumo
echo "features=$(agent_features) problems=$problems"
"""


def doctor(profiles: str, url: str = "", key: str = "") -> tuple[str, str]:
    """(stdout, stderr) of the Kumo checks for these settings."""
    env = os.environ | {"T_PROFILES": profiles, "T_URL": url, "T_KEY": key}
    done = subprocess.run(
        ["bash", "-c", SCRIPT, "doctor", str(ROOT)], env=env, capture_output=True, text=True, check=True
    )
    return done.stdout.strip(), done.stderr


@pytest.mark.parametrize("profiles", ["core,retrieval,analytics", "core,retrieval,analytics-gpu"])
def test_url_and_key_turn_kumo_on(profiles):
    out, err = doctor(profiles, URL, KEY)
    assert out == "features=retrieval,analytics,kumo problems=0"
    assert "problem" not in err and "Kumo prediction is off" not in err


def test_neither_leaves_kumo_off_and_says_how_to_turn_it_on():
    out, err = doctor("core,retrieval,analytics")
    assert out == "features=retrieval,analytics problems=0"
    assert err.count("Kumo prediction is off") == 1
    assert "set KUMO_RELATIONAL_URL and KUMO_API_KEY to a Kumo service" in err


@pytest.mark.parametrize(("url", "key", "empty"), [(URL, "", "KUMO_API_KEY"), ("", KEY, "KUMO_RELATIONAL_URL")])
def test_one_without_the_other_is_a_problem_naming_both(url, key, empty):
    out, err = doctor("core,retrieval,analytics", url, key)
    assert out == "features=retrieval,analytics problems=1"  # and no kumo feature
    assert f"problem: {empty} is empty: set KUMO_RELATIONAL_URL and KUMO_API_KEY together, or neither" in err


def test_the_url_must_be_https():
    out, err = doctor("core,retrieval,analytics", "http://kumo.example.com:8080", KEY)
    assert out.endswith("problems=1")
    assert "KUMO_RELATIONAL_URL must be an https:// URL" in err
    assert KEY not in out + err  # doctor names variables, never their values


def test_kumo_needs_the_market_analytics_server():
    out, err = doctor("core,retrieval", URL, KEY)
    assert out.endswith("problems=1")
    assert "needs the analytics or analytics-gpu profile" in err


def test_the_kumo_profile_is_gone():
    out, err = doctor("core,retrieval,analytics,kumo", URL, KEY)
    assert out.endswith("problems=1")
    assert "the kumo profile is gone: remove it from COMPOSE_PROFILES" in err
