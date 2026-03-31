from flask import Flask, render_template, request, Response, jsonify
from flask_cors import CORS
import json
import threading
import queue
import pandas as pd
from scanner import run_full_scan, fetch_financials, detect_patterns, get_sp500_tickers, get_all_nasdaq_tickers

app = Flask(__name__)
CORS(app)

# ── Cache for /api/stocks/all ──
# TTL is 60s during market hours, 300s when closed
_all_stocks_cache = {
    'data': None,
    'timestamp': 0,
    'ttl': 60,       # default 60s, adjusted dynamically
    'ttl_open': 60,  # during market/pre-market/after-hours
    'ttl_closed': 300,  # when market is closed
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

        # Try pre/post market price first, then regular
        price = (info.get('preMarketPrice')
                 or info.get('postMarketPrice')
                 or info.get('currentPrice')
                 or info.get('regularMarketPrice'))
        if price is None:
            return jsonify({'error': 'Ticker not found'}), 404

        prev_close = info.get('previousClose') or info.get('regularMarketPreviousClose') or price
        change = round(float(price) - float(prev_close), 2)
        change_pct = round((change / float(prev_close)) * 100, 2) if prev_close else 0.0

        # Determine which session the price is from
        price_session = 'regular'
        if info.get('preMarketPrice'):
            price_session = 'pre_market'
        elif info.get('postMarketPrice'):
            price_session = 'after_hours'

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
            'price_session': price_session,
        }), 200
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/stocks/live-prices', methods=['POST'])
def live_stock_prices():
    """Fetch real-time prices (including pre/post market) for a list of tickers."""
    import yfinance as yf

    data = request.get_json() or {}
    tickers = data.get('tickers', [])

    if not tickers or not isinstance(tickers, list):
        return jsonify({'error': 'Provide a non-empty list of tickers'}), 400
    if len(tickers) > 30:
        return jsonify({'error': 'Maximum 30 tickers per request'}), 400

    tickers = [t.upper().strip() for t in tickers]
    results = {}

    for t in tickers:
        try:
            info = yf.Ticker(t).info
            price = (info.get('preMarketPrice')
                     or info.get('postMarketPrice')
                     or info.get('currentPrice')
                     or info.get('regularMarketPrice'))
            if price is None:
                continue

            prev_close = info.get('previousClose') or price
            change = round(float(price) - float(prev_close), 2)
            change_pct = round((change / float(prev_close)) * 100, 2) if prev_close else 0.0

            session = 'regular'
            if info.get('preMarketPrice'):
                session = 'pre_market'
            elif info.get('postMarketPrice'):
                session = 'after_hours'

            results[t] = {
                'price': round(float(price), 2),
                'previous_close': round(float(prev_close), 2),
                'change': change,
                'change_pct': change_pct,
                'price_session': session,
            }
        except Exception:
            continue

    return jsonify({'prices': results}), 200


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




@app.route('/api/stocks/all')
def all_stocks():
    import yfinance as yf
    import pandas as pd
    import time as _time
    import gc

    now = _time.time()
    cache = _all_stocks_cache

    # Determine TTL based on market status
    eastern_now = pd.Timestamp.now(tz='US/Eastern')
    weekday = eastern_now.weekday()
    time_min = eastern_now.hour * 60 + eastern_now.minute
    is_active = (weekday < 5 and 4 * 60 <= time_min < 20 * 60)
    ttl = cache['ttl_open'] if is_active else cache['ttl_closed']

    # Return cached data if fresh
    if cache['data'] is not None and (now - cache['timestamp']) < ttl:
        return jsonify(cache['data'])

    try:
        # Get S&P 500 + all NASDAQ tickers
        sp500_df = get_sp500_tickers()

        try:
            nasdaq_df = get_all_nasdaq_tickers()
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


@app.route('/api/news')
def get_news():
    """
    Fetch recent news for a set of tickers + broad market ETFs.
    Query param: tickers=AAPL,MSFT,...  (optional, max 15 stock tickers)
    Always includes SPY / QQQ / DIA / IWM for general market news.
    Returns up to 60 articles sorted newest-first, with pre-market flag.
    """
    import yfinance as yf
    import time as _time

    tickers_param = request.args.get('tickers', '')
    requested = [t.strip().upper() for t in tickers_param.split(',') if t.strip()][:15]

    # Always include broad market tickers for general news
    market_tickers = ['SPY', 'QQQ', 'DIA', 'IWM']
    all_tickers = list(dict.fromkeys(market_tickers + requested))   # preserve order, deduplicate

    news_items = []
    seen_uuids = set()

    for ticker in all_tickers:
        try:
            t_obj = yf.Ticker(ticker)
            raw_news = t_obj.news or []
            for item in raw_news[:8]:       # up to 8 articles per ticker
                # ── Support both old flat format and new nested 'content' format ──
                content = item.get('content') or {}
                is_new_format = bool(content)

                uuid = item.get('id') or item.get('uuid', '')
                if not uuid:
                    continue
                if uuid in seen_uuids:
                    continue
                seen_uuids.add(uuid)

                if is_new_format:
                    title     = content.get('title', '')
                    publisher = (content.get('provider') or {}).get('displayName', '')
                    link      = ((content.get('canonicalUrl') or {}).get('url')
                                 or content.get('previewUrl', ''))
                    # pubDate is ISO string e.g. "2026-03-25T05:30:00Z"
                    pub_str   = content.get('pubDate', '') or content.get('displayTime', '')
                    try:
                        import datetime
                        publish_time = int(datetime.datetime.fromisoformat(
                            pub_str.replace('Z', '+00:00')).timestamp()) if pub_str else 0
                    except Exception:
                        publish_time = 0

                    # Thumbnail
                    thumb_obj   = content.get('thumbnail') or {}
                    resolutions = thumb_obj.get('resolutions') or []
                    thumbnail   = (resolutions[0].get('url') if resolutions
                                   else thumb_obj.get('originalUrl', ''))

                    related = item.get('relatedTickers') or []
                else:
                    # Old flat format
                    title        = item.get('title', '')
                    publisher    = item.get('publisher', '')
                    link         = item.get('link', '')
                    publish_time = item.get('providerPublishTime', 0)
                    thumb_data   = item.get('thumbnail') or {}
                    resolutions  = thumb_data.get('resolutions') or []
                    thumbnail    = resolutions[0].get('url', '') if resolutions else ''
                    related      = item.get('relatedTickers', [])

                news_items.append({
                    'uuid':            uuid,
                    'title':           title,
                    'publisher':       publisher,
                    'link':            link,
                    'publish_time':    publish_time,
                    'related_tickers': related,
                    'thumbnail':       thumbnail,
                    'source_ticker':   ticker,
                })
        except Exception:
            continue

    # Sort newest-first
    news_items.sort(key=lambda x: x['publish_time'], reverse=True)

    # Add human-readable relative time
    now_ts = _time.time()
    for item in news_items:
        pt = item['publish_time']
        if pt:
            age = now_ts - pt
            if age < 3600:
                item['time_label'] = f"{int(age / 60)}m ago"
            elif age < 86400:
                item['time_label'] = f"{int(age / 3600)}h ago"
            else:
                item['time_label'] = f"{int(age / 86400)}d ago"
        else:
            item['time_label'] = ''

    # Flag pre-market news: published after midnight ET but before 9:30 AM ET today
    eastern_now = pd.Timestamp.now(tz='US/Eastern')
    midnight_et  = eastern_now.normalize().timestamp()
    open_et      = eastern_now.normalize().replace(hour=9, minute=30).timestamp()
    for item in news_items:
        pt = item['publish_time']
        item['is_premarket'] = bool(pt and midnight_et <= pt < open_et)

    return jsonify({'news': news_items[:60]}), 200


@app.route('/api/gap-scanner/stream')
def gap_scanner_stream():
    """
    SSE endpoint: streams gap stocks as each batch is downloaded.
    Yields: init → progress (per batch) → stock (per gap stock) → done
    """
    import yfinance as yf
    import pandas as pd
    import gc

    min_gap = float(request.args.get('min_gap', 1.5))
    max_cards = int(request.args.get('limit', 25))

    def generate():
        try:
            yield f"data: {json.dumps({'stage': 'init', 'message': 'Fetching ticker list...'})}\n\n"

            sp500_df = get_sp500_tickers()
            try:
                nasdaq_df = get_all_nasdaq_tickers()
            except Exception:
                nasdaq_df = pd.DataFrame(columns=['ticker', 'name', 'sector'])

            combined_df = pd.concat([sp500_df, nasdaq_df], ignore_index=True)
            combined_df = combined_df.drop_duplicates(subset='ticker', keep='first')
            tickers = combined_df['ticker'].tolist()
            ticker_to_name   = dict(zip(combined_df['ticker'], combined_df['name']))
            ticker_to_sector = dict(zip(combined_df['ticker'], combined_df['sector']))

            total = len(tickers)
            yield f"data: {json.dumps({'stage': 'init', 'message': f'Downloading prices for {total} stocks...', 'total': total})}\n\n"

            batch_size = 500
            for batch_start in range(0, total, batch_size):
                batch = tickers[batch_start:batch_start + batch_size]
                try:
                    df = yf.download(batch, period='1mo', interval='1d',
                                     progress=False, threads=True)
                except Exception:
                    continue

                if df is None or len(df) == 0:
                    continue

                for ticker in batch:
                    try:
                        if len(batch) == 1:
                            if isinstance(df.columns, pd.MultiIndex):
                                df.columns = df.columns.get_level_values(0)
                            close_s = df['Close'].dropna()
                            high_s  = df['High'].dropna()
                            vol_s   = df['Volume']
                        else:
                            close_s = df['Close'][ticker].dropna()
                            high_s  = df['High'][ticker].dropna()
                            vol_s   = df['Volume'][ticker]

                        if len(close_s) < 2:
                            continue

                        current = round(float(close_s.iloc[-1]), 2)
                        prev    = round(float(close_s.iloc[-2]), 2)
                        if prev == 0:
                            continue
                        change     = round(current - prev, 2)
                        change_pct = round((change / prev) * 100, 2)
                        volume     = int(vol_s.iloc[-1]) if pd.notna(vol_s.iloc[-1]) else 0

                        # Resistance: max high of all bars except today
                        resistance = None
                        near_resistance = False
                        broke_resistance = False
                        pct_to_resistance = None
                        if len(high_s) >= 5:
                            resistance = round(float(high_s.iloc[:-1].max()), 2)
                            if resistance > 0:
                                pct_to_resistance = round((resistance - current) / resistance * 100, 2)
                                near_resistance   = 0 < pct_to_resistance <= 5   # within 5% below roof
                                broke_resistance  = current > resistance          # broke above today

                        # RVOL: today volume vs avg of prior bars
                        rvol = None
                        vol_hist = vol_s.iloc[:-1].dropna()
                        if len(vol_hist) >= 5 and volume > 0:
                            avg_vol = float(vol_hist.mean())
                            if avg_vol > 0:
                                rvol = round(volume / avg_vol, 2)

                        if abs(change_pct) >= min_gap:
                            stock = {
                                'ticker':           ticker,
                                'name':             ticker_to_name.get(ticker, ticker),
                                'sector':           ticker_to_sector.get(ticker, ''),
                                'price':            current,
                                'previous_close':   prev,
                                'change':           change,
                                'change_pct':       change_pct,
                                'volume':           volume,
                                'resistance':       resistance,
                                'pct_to_resistance': pct_to_resistance,
                                'near_resistance':  near_resistance,
                                'broke_resistance': broke_resistance,
                                'rvol':             rvol,
                            }
                            yield f"data: {json.dumps({'stage': 'stock', 'stock': stock})}\n\n"
                    except Exception:
                        continue

                del df
                gc.collect()

                processed = min(batch_start + batch_size, total)
                yield f"data: {json.dumps({'stage': 'progress', 'processed': processed, 'total': total, 'message': f'Scanned {processed:,}/{total:,} stocks...'})}\n\n"

            yield f"data: {json.dumps({'stage': 'done', 'message': 'Gap scan complete!'})}\n\n"

        except Exception as e:
            yield f"data: {json.dumps({'stage': 'error', 'message': str(e)})}\n\n"

    return Response(
        generate(),
        mimetype='text/event-stream',
        headers={'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no'},
    )


@app.route('/api/gap-scanner')
def gap_scanner():
    """
    Return top gainers and losers from the cached all-stocks data.
    Optionally filter by minimum absolute gap %.
    """
    import time as _time

    limit = min(int(request.args.get('limit', 25)), 50)
    min_gap = float(request.args.get('min_gap', 1.5))

    cache = _all_stocks_cache
    if cache['data'] is None:
        return jsonify({
            'gainers': [], 'losers': [],
            'total_gainers': 0, 'total_losers': 0,
            'cached': False,
            'message': 'No stock data cached yet. Trigger /api/stocks/all first.',
        }), 200

    all_s = cache['data'].get('stocks', [])

    gainers = sorted(
        [s for s in all_s if s.get('change_pct', 0) >= min_gap],
        key=lambda x: x['change_pct'], reverse=True
    )[:limit]

    losers = sorted(
        [s for s in all_s if s.get('change_pct', 0) <= -min_gap],
        key=lambda x: x['change_pct']
    )[:limit]

    return jsonify({
        'gainers': gainers,
        'losers': losers,
        'total_gainers': len([s for s in all_s if s.get('change_pct', 0) >= min_gap]),
        'total_losers': len([s for s in all_s if s.get('change_pct', 0) <= -min_gap]),
        'total_stocks': len(all_s),
        'cached': True,
        'cached_age_s': int(_time.time() - cache['timestamp']),
    }), 200


if __name__ == '__main__':
    import os
    port = int(os.environ.get('PORT', 5003))
    app.run(debug=True, threaded=True, port=port, host='0.0.0.0')
