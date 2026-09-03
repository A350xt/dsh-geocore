"""Studio 支撑动作（read/list）测试：地图前端的唯一数据通道。"""

from __future__ import annotations

from pathlib import Path

import pytest

from geocore.analysis.executor import execute_analyze
from geocore.api import list_inventory, read_layer
from geocore.protocol import E_INPUT_MISSING, GeoCoreError

SYNTH = Path(__file__).resolve().parents[1] / "datasets" / "synthetic"

SITE_OPS = [
    {"id": "a", "op": "query.filter",
     "input": str(SYNTH / "roads.geojson"), "where": "`class` == '主干道'"},
    {"id": "b", "op": "proximity.buffer", "input": "@a", "distance_m": 2000, "dissolve": True},
    {"id": "c", "op": "overlay.intersection", "a": str(SYNTH / "parcels.geojson"), "b": "@b"},
]


def test_read_dataset_geojson_wgs84(tmp_path):
    out = read_layer(tmp_path, {"source": str(SYNTH / "hospitals.geojson")})
    assert out["meta"]["crs_display"] == "EPSG:4326"
    assert out["meta"]["count_returned"] == 12
    feats = out["geojson"]["features"]
    lon, lat = feats[0]["geometry"]["coordinates"]
    assert 121 < lon < 122 and 31 < lat < 32


def test_read_artifact_reprojects_to_wgs84(tmp_path):
    res = execute_analyze(tmp_path, {"title": "t", "operations": SITE_OPS})
    assert res["crs"]["analysis"].startswith("EPSG:326")  # 分析坐标系是投影
    out = read_layer(tmp_path, {"source": res["artifact_id"]})
    assert out["meta"]["crs_display"] == "EPSG:4326"
    for f in out["geojson"]["features"]:
        for ring in _rings(f["geometry"]):
            for x, y in ring:
                assert -181 < x < 181 and -91 < y < 91  # 已是经纬度


def test_read_artifact_step_layer(tmp_path):
    res = execute_analyze(tmp_path, {"title": "t", "operations": SITE_OPS})
    out = read_layer(tmp_path, {"source": f"{res['artifact_id']}#a"})
    assert out["layer"] == "step_a"
    assert out["meta"]["count_returned"] == 4  # 主干道 4 条


def test_read_unknown_step_lists_available(tmp_path):
    res = execute_analyze(tmp_path, {"title": "t", "operations": SITE_OPS})
    with pytest.raises(GeoCoreError) as ei:
        read_layer(tmp_path, {"source": f"{res['artifact_id']}#nope"})
    assert ei.value.code == E_INPUT_MISSING
    assert "a" in ei.value.details["available_steps"]


def test_read_max_features_truncation(tmp_path):
    out = read_layer(tmp_path, {"source": str(SYNTH / "poi.csv"), "max_features": 10})
    assert out["meta"]["count_total"] == 60
    assert out["meta"]["count_returned"] == 10
    assert out["meta"]["truncated"] is True
    assert any("仅返回前" in w for w in out["warnings"])


def test_read_field_selection(tmp_path):
    out = read_layer(tmp_path, {"source": str(SYNTH / "hospitals.geojson"),
                                "fields": ["name", "beds"]})
    props = out["geojson"]["features"][0]["properties"]
    assert set(props) == {"name", "beds"}


def test_read_missing_source(tmp_path):
    with pytest.raises(GeoCoreError) as ei:
        read_layer(tmp_path, {"source": "D:/no/such/file.geojson"})
    assert ei.value.code == E_INPUT_MISSING


def test_list_inventory(tmp_path):
    out = list_inventory(tmp_path, {"datasets_dir": str(SYNTH)})
    names = {d["name"] for d in out["datasets"]}
    assert {"parcels", "roads", "hospitals", "poi"} <= names
    assert out["artifacts"] == []

    res = execute_analyze(tmp_path, {"title": "清单测试", "operations": SITE_OPS})
    out = list_inventory(tmp_path, {"datasets_dir": str(SYNTH)})
    assert out["artifacts"][0]["artifact_id"] == res["artifact_id"]
    assert out["artifacts"][0]["count"] == res["result"]["count"]
    assert set(out["artifacts"][0]["intermediate_layers"]) == {"a", "b", "c"}


def _rings(geom):
    t = geom["type"]
    if t == "Polygon":
        yield from geom["coordinates"]
    elif t == "MultiPolygon":
        for poly in geom["coordinates"]:
            yield from poly
    elif t in ("LineString",):
        yield geom["coordinates"]
    elif t == "MultiLineString":
        yield from geom["coordinates"]
