"""Step orchestration shared types."""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class StepResult:
    gdf: object                      # geopandas.GeoDataFrame
    summaries: list[str] = field(default_factory=list)


def need(params: dict, key: str, op: str):
    if key not in params:
        raise KeyError(f"操作 {op} 缺少必填参数 {key}")
    return params[key]


def opt(params: dict, key: str, default):
    v = params.get(key, default)
    return default if v is None else v
