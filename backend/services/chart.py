from __future__ import annotations

from io import BytesIO

import matplotlib

matplotlib.use("Agg")

import matplotlib.pyplot as plt
import pandas as pd

plt.rcParams["font.family"] = ["Malgun Gothic", "DejaVu Sans"]
plt.rcParams["axes.unicode_minus"] = False


def render_price_chart(history: pd.DataFrame, title: str) -> bytes:
    frame = history.tail(120).copy()
    fig, ax = plt.subplots(figsize=(10, 4.8), dpi=140)
    ax.plot(frame["date"], frame["close"], color="#0ea5b7", linewidth=2.8)
    ax.fill_between(frame["date"], frame["close"], alpha=0.08, color="#0ea5b7")
    ax.set_title(title, fontsize=14, fontweight="bold")
    ax.grid(True, color="#e5e7eb", linewidth=0.8)
    ax.spines[["top", "right"]].set_visible(False)
    ax.text(
        0.98,
        0.04,
        "CAN SLIM Quant Scanner",
        transform=ax.transAxes,
        ha="right",
        va="bottom",
        color="#94a3b8",
        fontsize=9,
        alpha=0.85,
    )
    fig.autofmt_xdate()
    buffer = BytesIO()
    fig.tight_layout()
    fig.savefig(buffer, format="png")
    plt.close(fig)
    return buffer.getvalue()
