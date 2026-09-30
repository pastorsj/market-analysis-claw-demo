# SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""market_anomaly_scan: score later sessions against a PCA model of an earlier baseline window.

The detector standardizes four price/volume features on the training window, fits a PCA with up to three
components, and scores each session by its reconstruction error. Sessions above the training window's 95th
percentile error are flagged. On GPU, cuml.accel runs the same scikit-learn PCA.
"""

from __future__ import annotations

from datetime import datetime

import numpy as np
from sklearn import config_context
from sklearn.decomposition import PCA

from ..data import FEATURES
from ..data import MarketData
from ..models import AnomalyObservation
from ..models import InvalidRequest
from ..models import MarketAnomalyPayload
from .common import Output
from .common import check_window

LIMITATIONS = (
    "Anomaly scores describe unusual observed feature combinations; they are not forecasts or probabilities.",
    "Observed deviations are robust z-scores against the training window, not returns or percentages; they are "
    "descriptive reason codes and do not establish a cause or adverse event.",
)
MIN_TRAINING_ROWS = 8
FLAG_QUANTILE = 0.95


def run(
    data: MarketData,
    *,
    universe_id: str,
    training_start: datetime,
    training_end: datetime,
    scoring_start: datetime,
    scoring_end: datetime,
    limit: int = 10,
    minimum_percentile: float | None = None,
) -> Output:
    check_window(training_start, training_end)
    check_window(scoring_start, scoring_end)
    if scoring_start <= training_end:
        raise InvalidRequest("the scoring window must begin after the training window ends")
    features = data.features
    scoped = features[features["asset_id"].isin(data.universe(universe_id))]
    training = scoped[scoped["timestamp"].between(training_start, training_end)]
    scoring = scoped[scoped["timestamp"].between(scoring_start, scoring_end)]
    if len(training) < MIN_TRAINING_ROWS:
        raise InvalidRequest(f"the training window must contain at least {MIN_TRAINING_ROWS} observations")
    if scoring.empty:
        raise InvalidRequest("the scoring window contains no observations")

    # Plain host arrays: PCA runs on them through cuml.accel, and the arithmetic below is small NumPy work that
    # cudf.pandas would otherwise route through its array proxy.
    train = np.asarray(training[list(FEATURES)].to_numpy(np.float64))
    score = np.asarray(scoring[list(FEATURES)].to_numpy(np.float64))
    mean, scale = train.mean(axis=0), train.std(axis=0)
    scale[scale <= 1e-12] = 1.0
    train_z, score_z = (train - mean) / scale, (score - mean) / scale
    # Checked once here, on the host, and not again inside PCA: cuml.accel's own check compiles a CUDA kernel for
    # each new input size (about 5 s each on an A100), which no warm-up can cover. The error is scikit-learn's.
    if not (np.isfinite(train_z).all() and np.isfinite(score_z).all()):
        raise ValueError("the anomaly features contain NaN or infinity")
    with config_context(assume_finite=True):
        model = PCA(n_components=min(3, len(FEATURES), len(train) - 1), svd_solver="full").fit(train_z)
        train_error = np.mean((train_z - model.inverse_transform(model.transform(train_z))) ** 2, axis=1)
        score_error = np.mean((score_z - model.inverse_transform(model.transform(score_z))) ** 2, axis=1)
    threshold = np.quantile(train_error, FLAG_QUANTILE)

    ranked = scoring.assign(anomaly_score=score_error, decision_score=threshold - score_error).sort_values(
        ["anomaly_score", "asset_id", "timestamp"], ascending=[False, True, True], ignore_index=True
    )
    # NumPy positions, not index arithmetic: under cudf.pandas, dividing the index compiles a CUDA kernel on
    # first use, again for some index lengths (seconds each on an A100), which a warm-up cannot cover.
    position = np.arange(len(ranked))
    ranked["rank"] = position + 1
    ranked["cohort_percentile"] = 100 * (len(ranked) - position) / len(ranked)
    if minimum_percentile is not None:
        ranked = ranked[ranked["cohort_percentile"] >= minimum_percentile]
    top = ranked.head(limit)

    # Robust z-scores (median / MAD) against the training window explain which features moved.
    median = np.median(train, axis=0)
    mad = np.median(np.abs(train - median), axis=0) * 1.4826
    deviations = (np.asarray(top[list(FEATURES)].to_numpy(np.float64)) - median) / np.where(mad > 1e-12, mad, 1.0)
    observations = [
        AnomalyObservation(
            rank=row["rank"],
            asset_id=row["asset_id"],
            timestamp=row["timestamp"],
            anomaly_score=row["anomaly_score"],
            decision_score=row["decision_score"],
            cohort_percentile=row["cohort_percentile"],
            is_anomaly=row["decision_score"] < 0,
            observed_deviations=dict(zip(FEATURES, row_deviations.tolist(), strict=True)),
        )
        for row, row_deviations in zip(top.to_dict("records"), deviations, strict=True)
    ]
    payload = MarketAnomalyPayload(
        universe_id=universe_id,
        feature_names=list(FEATURES),
        training_observations=len(training),
        scoring_observations=len(scoring),
        flagged_observations=int((score_error > threshold).sum()),
        observations=observations,
    )
    return Output(payload, rows_scanned=len(training) + len(scoring), empty=not observations)
