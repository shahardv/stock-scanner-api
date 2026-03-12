from flask import Flask, render_template, request, Response, jsonify
from flask_cors import CORS
import json
import threading
import queue
import pandas as pd
from scanner import run_full_scan, fetch_financials, detect_patterns, get_sp500_tickers

app = Flask(__name__)
CORS(app)

# ── Cache for /api/stocks/all (refreshes every 5 min to save memory) ──
_all_stocks_cache = {
    'data': None,
    'timestamp': 0,
    'ttl': 300,
}

# In-memory scan state (single-user app)
scan_state = {
    'running': False,
    'results': None,
    'progress_queue': None,
}


@app.route('/')
def index():
    return render_template('index.html')


@app.route('/api/scan', methods=['POST'])
def start_scan():
    if scan_state['running']:
        return jsonify({'error': 'Scan already in progress'}), 409

    data = request.get_json() or {}
    threshold = float(data.get('threshold', 5.0))
    sma_period = int(data.get('sma_period', 150))

    if not (1.0 <= threshold <= 15.0):
        return jsonify({'error': 'Threshold must be between 1.0 and 15.0'}), 400

    if sma_period not in (20, 50, 100, 150, 200):
        return jsonify({'error': 'SMA period must be 20, 50, 100, 150, or 200'}), 400

    scan_state['running'] = True
    scan_state['results'] = None
    scan_state['progress_queue'] = queue.Queue()

    def run_scan():
        def progress_callback(stage, current, total, message, stock=None):
            event = {
                'stage': stage,
                'current': current,
                'total': total,
                'message': message
            }
            if stock is not None:
                event['stock'] = stock
            scan_state['progress_queue'].put(event)

        try:
            results = run_full_scan(threshold, sma_period, progress_callback)
            scan_state['results'] = results
        except Exception as e:
            scan_state['progress_queue'].put({
                'stage': 'error',
                'current': 0,
                'total': 0,
                'message': f'Scan failed: {str(e)}'
            })
        finally:
            scan_state['running'] = False

    thread = threading.Thread(target=run_scan, daemon=True)
    thread.start()

    return jsonify({'status': 'started'}), 202


@app.route('/api/scan/progress')
def scan_progress():
    def generate():
        q = scan_state['progress_queue']
        if q is None:
            yield f"data: {json.dumps({'stage': 'error', 'message': 'No scan in progress'})}\n\n"
            return

        while True:
            try:
                progress = q.get(timeout=30)
                yield f"data: {json.dumps(progress)}\n\n"

                if progress['stage'] in ('done', 'error'):
                    break
            except queue.Empty:
                # Keepalive to prevent proxy timeouts
                yield ": keepalive\n\n"

                if not scan_state['running']:
                    yield f"data: {json.dumps({'stage': 'done', 'message': 'Scan complete.'})}\n\n"
                    break

    return Response(
        generate(),
        mimetype='text/event-stream',
        headers={
            'Cache-Control': 'no-cache',
            'X-Accel-Buffering': 'no',
        }
    )


@app.route('/api/scan/stop', methods=['POST'])
def stop_scan():
    if not scan_state['running']:
        return jsonify({'status': 'no_scan_running'}), 200

    scan_state['running'] = False
    # Push a done event so SSE clients get notified immediately
    if scan_state['progress_queue']:
        try:
            scan_state['progress_queue'].put({
                'stage': 'done',
                'current': 0,
                'total': 0,
                'message': 'Scan stopped by user.'
            })
        except Exception:
            pass

    return jsonify({'status': 'stopped'}), 200


@app.route('/api/scan/results')
def scan_results():
    if scan_state['running']:
        return jsonify({'status': 'running'}), 202

    if scan_state['results'] is None:
        return jsonify({'status': 'no_results', 'data': []}), 200

    return jsonify({'status': 'complete', 'data': scan_state['results']}), 200


@app.route('/stock/<ticker>')
def stock_detail(ticker):
    # Sanitize ticker
    ticker = ticker.upper().strip()
    return render_template('detail.html', ticker=ticker)


@app.route('/api/stock/<ticker>/financials')
def stock_financials(ticker):
    import yfinance as yf
    import pandas as pd

    ticker = ticker.upper().strip()
    fin_data = fetch_financials(ticker)

    # Also detect chart patterns for this ticker
    try:
        price_data = yf.download(ticker, period='1y', interval='1d', progress=False)
        if price_data is not None and len(price_data) > 0:
            # Flatten MultiIndex columns if present (yfinance returns ('Open','TICKER'))
            if isinstance(price_data.columns, pd.MultiIndex):
                price_data.columns = price_data.columns.get_level_values(0)
            ohlc = pd.DataFrame({
                'Open': price_data['Open'],
                'High': price_data['High'],
                'Low': price_data['Low'],
                'Close': price_data['Close'],
            }).dropna()
            fin_data['patterns'] = detect_patterns(ohlc)
        else:
            fin_data['patterns'] = []
    except Exception as e:
        fin_data['patterns'] = []

    return jsonify(fin_data)


@app.route('/api/stock/<ticker>/price')
def stock_price(ticker):
    import yfinance as yf

    ticker = ticker.upper().strip()
    try:
        info = yf.Ticker(ticker).info
        price = info.get('currentPrice') or info.get('regularMarketPrice')
        if price is None:
            return jsonify({'error': 'Price not available'}), 404
        return jsonify({
            'ticker': ticker,
            'price': round(float(price), 2),
            'name': info.get('shortName', ticker),
        }), 200
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/stock/<ticker>/quote')
def stock_quote(ticker):
    """Full quote for any ticker — used for searching stocks not in S&P/NASDAQ."""
    import yfinance as yf

    ticker = ticker.upper().strip()
    try:
        t = yf.Ticker(ticker)
        info = t.info

        price = info.get('currentPrice') or info.get('regularMarketPrice')
        if price is None:
            return jsonify({'error': 'Ticker not found'}), 404

        prev_close = info.get('previousClose') or info.get('regularMarketPreviousClose') or price
        change = round(float(price) - float(prev_close), 2)
        change_pct = round((change / float(prev_close)) * 100, 2) if prev_close else 0.0

        return jsonify({
            'ticker': ticker,
            'name': info.get('shortName', ticker),
            'sector': info.get('sector', info.get('industry', 'N/A')),
            'price': round(float(price), 2),
            'previous_close': round(float(prev_close), 2),
            'change': change,
            'change_pct': change_pct,
            'volume': info.get('volume', 0) or 0,
            'day_high': round(float(info.get('dayHigh', price)), 2),
            'day_low': round(float(info.get('dayLow', price)), 2),
        }), 200
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/stocks/prices', methods=['POST'])
def batch_stock_prices():
    import yfinance as yf
    import pandas as pd

    data = request.get_json() or {}
    tickers = data.get('tickers', [])

    if not tickers or not isinstance(tickers, list):
        return jsonify({'error': 'Provide a non-empty list of tickers'}), 400

    if len(tickers) > 50:
        return jsonify({'error': 'Maximum 50 tickers per request'}), 400

    # Sanitize
    tickers = [t.upper().strip() for t in tickers]

    try:
        df = yf.download(tickers=tickers, period='1d', interval='1d', progress=False)

        prices = {}
        if df is not None and len(df) > 0:
            if len(tickers) == 1:
                # Single ticker: columns are just ['Open','Close',...]
                if isinstance(df.columns, pd.MultiIndex):
                    df.columns = df.columns.get_level_values(0)
                close = df['Close'].iloc[-1]
                if pd.notna(close):
                    prices[tickers[0]] = round(float(close), 2)
            else:
                # Multiple tickers: columns are MultiIndex (metric, ticker)
                for t in tickers:
                    try:
                        close = df['Close'][t].iloc[-1]
                        if pd.notna(close):
                            prices[t] = round(float(close), 2)
                    except (KeyError, IndexError):
                        pass

        return jsonify({'prices': prices}), 200
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/market/status')
def market_status():
    import pandas as pd

    now = pd.Timestamp.now(tz='US/Eastern')
    weekday = now.weekday()  # 0=Monday, 6=Sunday
    hour = now.hour
    minute = now.minute
    time_minutes = hour * 60 + minute

    if weekday >= 5:
        status = 'closed'
        label = 'Market Closed (Weekend)'
    else:
        pre_market_start = 4 * 60         # 4:00 AM ET
        market_open_time = 9 * 60 + 30    # 9:30 AM ET
        market_close_time = 16 * 60       # 4:00 PM ET
        after_hours_end = 20 * 60         # 8:00 PM ET

        if time_minutes < pre_market_start:
            status = 'closed'
            label = 'Market Closed'
        elif time_minutes < market_open_time:
            status = 'pre_market'
            label = 'Pre-Market'
        elif time_minutes < market_close_time:
            status = 'open'
            label = 'Market Open'
        elif time_minutes < after_hours_end:
            status = 'after_hours'
            label = 'After Hours'
        else:
            status = 'closed'
            label = 'Market Closed'

    return jsonify({
        'status': status,
        'label': label,
        'timestamp': now.isoformat(),
    })


def get_nasdaq100_tickers():
    """Scrape NASDAQ-100 tickers from Wikipedia."""
    import io
    import urllib.request
    url = "https://en.wikipedia.org/wiki/Nasdaq-100"
    req = urllib.request.Request(url, headers={'User-Agent': 'StockScanner/1.0'})
    with urllib.request.urlopen(req) as resp:
        html = resp.read().decode('utf-8')
    tables = pd.read_html(io.StringIO(html))
    for table in tables:
        if 'Ticker' in table.columns and 'Company' in table.columns:
            # Find the sector/industry column (name varies)
            sector_col = None
            for col in table.columns:
                if 'industry' in col.lower() or 'sector' in col.lower():
                    sector_col = col
                    break
            result = pd.DataFrame({
                'ticker': table['Ticker'],
                'name': table['Company'],
                'sector': table[sector_col] if sector_col else 'N/A',
            })
            return result
    return pd.DataFrame(columns=['ticker', 'name', 'sector'])


@app.route('/api/stocks/all')
def all_stocks():
    import yfinance as yf
    import pandas as pd
    import time as _time
    import gc

    now = _time.time()
    cache = _all_stocks_cache

    # Return cached data if fresh
    if cache['data'] is not None and (now - cache['timestamp']) < cache['ttl']:
        return jsonify(cache['data'])

    try:
        # Get S&P 500 + NASDAQ-100 tickers
        sp500_df = get_sp500_tickers()

        try:
            nasdaq_df = get_nasdaq100_tickers()
        except Exception:
            nasdaq_df = pd.DataFrame(columns=['ticker', 'name', 'sector'])

        combined_df = pd.concat([sp500_df, nasdaq_df], ignore_index=True)
        combined_df = combined_df.drop_duplicates(subset='ticker', keep='first')

        tickers = combined_df['ticker'].tolist()
        ticker_to_name = dict(zip(combined_df['ticker'], combined_df['name']))
        ticker_to_sector = dict(zip(combined_df['ticker'], combined_df['sector']))

        # Download all tickers in one call (Railway has enough memory)
        df = yf.download(tickers=tickers, period='2d', interval='1d', progress=False)

        stocks = []
        if df is not None and len(df) > 0:
            for t in tickers:
                try:
                    if isinstance(df.columns, pd.MultiIndex):
                        close_series = df['Close'][t].dropna()
                        vol_series = df['Volume'][t]
                        high_series = df['High'][t]
                        low_series = df['Low'][t]
                    else:
                        close_series = df['Close'].dropna()
                        vol_series = df['Volume']
                        high_series = df['High']
                        low_series = df['Low']

                    if len(close_series) < 2:
                        continue

                    current = round(float(close_series.iloc[-1]), 2)
                    prev_close = round(float(close_series.iloc[-2]), 2)
                    change = round(current - prev_close, 2)
                    change_pct = round((change / prev_close) * 100, 2) if prev_close != 0 else 0.0

                    volume = int(vol_series.iloc[-1]) if pd.notna(vol_series.iloc[-1]) else 0
                    day_high = round(float(high_series.iloc[-1]), 2) if pd.notna(high_series.iloc[-1]) else current
                    day_low = round(float(low_series.iloc[-1]), 2) if pd.notna(low_series.iloc[-1]) else current

                    stocks.append({
                        'ticker': t,
                        'name': ticker_to_name.get(t, t),
                        'sector': ticker_to_sector.get(t, ''),
                        'price': current,
                        'previous_close': prev_close,
                        'change': change,
                        'change_pct': change_pct,
                        'volume': volume,
                        'day_high': day_high,
                        'day_low': day_low,
                    })
                except Exception:
                    continue

            del df
            gc.collect()

        stocks.sort(key=lambda x: x['ticker'])

        result = {'stocks': stocks, 'count': len(stocks)}
        cache['data'] = result
        cache['timestamp'] = now

        return jsonify(result)
    except Exception as e:
        return jsonify({'error': str(e)}), 500


if __name__ == '__main__':
    import os
    port = int(os.environ.get('PORT', 5000))
    app.run(debug=True, threaded=True, port=port, host='0.0.0.0')
