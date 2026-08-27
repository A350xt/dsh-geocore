"""Thematic map rendering (matplotlib, offline)."""

from __future__ import annotations

from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
from matplotlib.patches import Patch  # noqa: E402

plt.rcParams["font.sans-serif"] = ["Microsoft YaHei", "SimHei", "DejaVu Sans"]
plt.rcParams["axes.unicode_minus"] = False

DEFAULT_CMAP = "YlOrRd"
_CLASSIFICATIONS = ("quantile", "equal_interval")


def _classification(values, n_classes: int, method: str):
    import numpy as np

    v = values.dropna().astype(float)
    if len(v) == 0:
        return [0.0, 1.0]
    if method == "equal_interval":
        lo, hi = float(v.min()), float(v.max())
        return list(np.linspace(lo, hi, max(2, n_classes) + 1))
    qs = np.quantile(v.to_numpy(), [i / max(2, n_classes) for i in range(max(2, n_classes) + 1)])
    return sorted({float(q) for q in qs})


def render_map(gdf, *, style: dict, out_path: Path, title: str) -> list[str]:
    """Render `gdf` into out_path; returns legend entries."""
    mode = str(style.get("mode") or style.get("type") or "single").lower()
    figsize = tuple(style.get("figsize", [10, 8]))
    dpi = int(style.get("dpi", 150))
    color = str(style.get("color", "#3b82f6"))

    fig, ax = plt.subplots(figsize=figsize)
    ax.set_aspect("equal")
    legend_entries: list[str] = []

    try:
        if mode in ("categorical", "category"):
            field = style.get("field")
            if not field or field not in gdf.columns:
                raise ValueError(f"categorical 模式需要有效字段：{field!r}")
            cats = sorted(gdf[field].fillna("<空>").astype(str).unique())
            cmap = plt.get_cmap("tab20", max(len(cats), 1))
            colors = {c: cmap(i % 20) for i, c in enumerate(cats)}
            gdf.plot(ax=ax, color=[colors[c] for c in gdf[field].fillna("<空>").astype(str)],
                     edgecolor="white", linewidth=0.6)
            handles = [Patch(facecolor=colors[c], label=str(c)) for c in cats]
            ax.legend(handles=handles, loc="lower left", fontsize=9, title=str(field))
            legend_entries = [f"{field}={c}" for c in cats]

        elif mode in ("choropleth", "graded"):
            field = style.get("field")
            if not field or field not in gdf.columns:
                raise ValueError(f"choropleth 模式需要有效数值字段：{field!r}")
            method = str(style.get("classification", "quantile")).lower()
            if method not in _CLASSIFICATIONS:
                raise ValueError(f"不支持的分级方式:{method}（可选 {list(_CLASSIFICATIONS)}）")
            n_classes = max(2, min(int(style.get("classes", 5)), 9))
            breaks = _classification(gdf[field], n_classes, method)
            cmap_name = str(style.get("cmap", DEFAULT_CMAP))
            gdf.plot(ax=ax, column=field, cmap=cmap_name, edgecolor="white",
                     linewidth=0.5, scheme=None,
                     legend=False,
                     missing_kwds={"color": "#cccccc", "label": "无数据"})
            import matplotlib.cm as cm
            import numpy as np

            cmap_obj = plt.get_cmap(cmap_name)
            norm = matplotlib.colors.Normalize(vmin=breaks[0], vmax=breaks[-1])
            handles = []
            labels = []
            for i in range(len(breaks) - 1):
                mid = (breaks[i] + breaks[i + 1]) / 2
                handles.append(Patch(facecolor=cmap_obj(norm(mid))))
                unit = "%" if field.endswith("_pct") else ""
                labels.append(f"{breaks[i]:,.4g} ~ {breaks[i + 1]:,.4g}{unit}")
            ax.legend(handles, labels, loc="lower left", fontsize=8, title=f"{field}（{method}）")
            legend_entries = labels

        elif mode == "point":
            size = float(style.get("size", 25))
            gdf.plot(ax=ax, color=color, markersize=size, edgecolor="white", linewidth=0.5)
            legend_entries = []

        else:  # single
            fam_point = set(map(str, gdf.geometry.geom_type)) <= {"Point", "MultiPoint"}
            if fam_point:
                gdf.plot(ax=ax, color=color, markersize=float(style.get("size", 25)),
                         edgecolor="white", linewidth=0.5)
            else:
                gdf.plot(ax=ax, color=color, alpha=0.75, edgecolor="white", linewidth=0.7)

        ax.set_title(title, fontsize=14)
        ax.set_axis_off()
        out_path = Path(out_path)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        fig.savefig(out_path, dpi=dpi, bbox_inches="tight", facecolor="white")
        return legend_entries
    finally:
        plt.close(fig)


def render_bar_chart(labels: list[str], values: list[float], *, out_path: Path,
                     title: str, ylabel: str = "") -> None:
    fig, ax = plt.subplots(figsize=(8, 5))
    ax.bar(range(len(labels)), values, color="#3b82f6")
    ax.set_xticks(range(len(labels)))
    ax.set_xticklabels(labels, rotation=30, ha="right", fontsize=9)
    ax.set_title(title)
    if ylabel:
        ax.set_ylabel(ylabel)
    fig.tight_layout()
    fig.savefig(out_path, dpi=150, facecolor="white")
    plt.close(fig)
