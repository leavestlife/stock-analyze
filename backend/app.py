from __future__ import annotations

from pathlib import Path
from io import BytesIO

from dotenv import load_dotenv
from flask import Flask, jsonify, request, send_file, send_from_directory
from flask_cors import CORS

from backend.backtest.engine import run_backtest
from backend.services.cache import load_price_history
from backend.services.chart import render_price_chart
from backend.services.dart import fetch_basic_financials
from backend.services.json_safe import json_safe
from backend.services.scoring import score_security
from backend.universe import find_security, get_universe


ROOT = Path(__file__).resolve().parents[1]
load_dotenv(ROOT / ".env")

app = Flask(__name__, static_folder=str(ROOT), static_url_path="")
CORS(app)


@app.get("/")
def index():
    return send_from_directory(ROOT, "index.html")


@app.get("/api/universe")
def universe():
    return jsonify(get_universe())


@app.get("/api/stocks")
def stocks():
    market = request.args.get("market", "all")
    items = []
    errors = []
    for security in get_universe(market):
        try:
            history = load_price_history(security["yf_symbol"])
            items.append(score_security(security, history))
        except Exception as exc:
            errors.append({"ticker": security["ticker"], "error": str(exc)})
    return jsonify(json_safe({"items": items, "errors": errors}))


@app.get("/api/stocks/<ticker>")
def stock_detail(ticker):
    security = find_security(ticker)
    if not security:
        return jsonify({"error": "unknown ticker"}), 404
    history = load_price_history(security["yf_symbol"])
    scored = score_security(security, history)
    if security.get("market") == "kr":
        scored["dart"] = fetch_basic_financials(security.get("dart_code"))
    return jsonify(json_safe(scored))


@app.get("/api/stocks/<ticker>/history")
def stock_history(ticker):
    security = find_security(ticker)
    if not security:
        return jsonify({"error": "unknown ticker"}), 404
    history = load_price_history(security["yf_symbol"])
    return jsonify(json_safe(
        {
            "ticker": security["ticker"],
            "items": history.tail(260).to_dict(orient="records"),
        }
    ))


@app.get("/api/stocks/<ticker>/chart.png")
def stock_chart_png(ticker):
    security = find_security(ticker)
    if not security:
        return jsonify({"error": "unknown ticker"}), 404
    history = load_price_history(security["yf_symbol"])
    image = render_price_chart(history, f"{security['company']} ({security['ticker']})")
    return send_file(BytesIO(image), mimetype="image/png")


@app.get("/api/backtest")
def backtest():
    market = request.args.get("market", "all")
    return jsonify(json_safe(run_backtest(market)))


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000, debug=True)
