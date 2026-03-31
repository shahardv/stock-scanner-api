import pandas as pd
import numpy as np
import yfinance as yf
import time
import io
import json
import urllib.request
import datetime as _dt


def get_sp500_tickers():
    """Scrape S&P 500 tickers and company names from Wikipedia."""
    url = "https://en.wikipedia.org/wiki/List_of_S%26P_500_companies"
    req = urllib.request.Request(url, headers={'User-Agent': 'StockScanner/1.0'})
    with urllib.request.urlopen(req) as resp:
        html = resp.read().decode('utf-8')
    tables = pd.read_html(io.StringIO(html))
    df = tables[0]
    # Wikipedia uses '.' but yfinance expects '-' (e.g. BRK.B -> BRK-B)
    df['Symbol'] = df['Symbol'].str.replace('.', '-', regex=False)
    return df[['Symbol', 'Security', 'GICS Sector']].rename(columns={
        'Symbol': 'ticker',
        'Security': 'name',
        'GICS Sector': 'sector'
    })


def get_all_nasdaq_tickers():
    """
    Fetch all NASDAQ-listed stocks from NASDAQ's screener API (returns JSON).
    Returns a DataFrame with columns: ticker, name, sector.
    """
    url = "https://api.nasdaq.com/api/screener/stocks?tableonly=true&exchange=NASDAQ&download=true"
    req = urllib.request.Request(url, headers={
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'application/json',
    })
    with urllib.request.urlopen(req, timeout=30) as resp:
        content = resp.read().decode('utf-8')

    data = json.loads(content)
    rows = data.get('data', {}).get('rows', [])

    if not rows:
        return pd.DataFrame(columns=['ticker', 'name', 'sector'])

    result = pd.DataFrame({
        'ticker': [r.get('symbol', '').strip() for r in rows],
        'name':   [r.get('name', '').strip() for r in rows],
        'sector': [r.get('sector', 'N/A').strip() for r in rows],
    })

    # Keep only clean ticker symbols (1-5 uppercase letters, optional class suffix)
    result = result[
        result['ticker'].str.match(r'^[A-Z]{1,5}(-[A-Z])?$')
    ].reset_index(drop=True)

    return result


##############################################################################
# Bullish Pattern Detection
##############################################################################

def detect_patterns(ohlc_df, market_close=None):
    """
    Detect bullish chart patterns and pre-breakout signals.
    DataFrame must have Open, High, Low, Close columns; Volume is optional but used when present.
    market_close: optional Series of S&P 500 daily closes for Relative Strength calculation.
    Returns a list of pattern name strings found.
    """
    if ohlc_df is None or len(ohlc_df) < 10:
        return []

    patterns = []
    close = ohlc_df['Close']

    # ── Classic chart patterns ──────────────────────────────────────────────
    if _is_golden_cross(close):
        patterns.append('Golden Cross')

    if _is_bullish_engulfing(ohlc_df):
        patterns.append('Bullish Engulfing')

    if _is_hammer(ohlc_df):
        patterns.append('Hammer')

    if _is_morning_star(ohlc_df):
        patterns.append('Morning Star')

    if _is_double_bottom(close):
        patterns.append('Double Bottom')

    if _is_cup_and_handle(close):
        patterns.append('Cup & Handle')

    # ── Pre-breakout signals ────────────────────────────────────────────────
    if _is_bollinger_squeeze(close):
        patterns.append('BB Squeeze')

    if 'Volume' in ohlc_df.columns and _is_volume_surge(ohlc_df):
        patterns.append('Volume Surge')

    if _is_tight_consolidation(close):
        patterns.append('Tight Base')

    if _is_near_52week_high(close):
        patterns.append('Near 52W High')

    if _is_macd_bullish_crossover(close):
        patterns.append('MACD Cross')

    if market_close is not None and _is_relative_strength(close, market_close):
        patterns.append('RS Leader')

    return patterns


def _is_golden_cross(close):
    """SMA 50 crosses above SMA 200 within the last 10 trading days."""
    if len(close) < 210:
        return False

    sma50 = close.rolling(50).mean()
    sma200 = close.rolling(200).mean()

    # Check if SMA50 crossed above SMA200 in the last 10 days
    recent = 10
    for i in range(-recent, 0):
        # Current bar: SMA50 > SMA200, Previous bar: SMA50 <= SMA200
        if (sma50.iloc[i] > sma200.iloc[i] and
                sma50.iloc[i - 1] <= sma200.iloc[i - 1]):
            return True

    return False


def _is_bullish_engulfing(ohlc):
    """Last candle is green and fully engulfs the previous red candle."""
    if len(ohlc) < 2:
        return False

    # Check last 3 trading days for the pattern
    for offset in range(min(3, len(ohlc) - 1)):
        idx = -(1 + offset)
        prev_idx = idx - 1

        prev_open = ohlc['Open'].iloc[prev_idx]
        prev_close = ohlc['Close'].iloc[prev_idx]
        curr_open = ohlc['Open'].iloc[idx]
        curr_close = ohlc['Close'].iloc[idx]

        # Previous must be red (close < open)
        if prev_close >= prev_open:
            continue

        # Current must be green (close > open)
        if curr_close <= curr_open:
            continue

        # Current body must engulf previous body
        if curr_open <= prev_close and curr_close >= prev_open:
            # Ensure meaningful candle sizes (not tiny)
            prev_body = abs(prev_open - prev_close)
            curr_body = abs(curr_close - curr_open)
            avg_price = (curr_close + curr_open) / 2
            if prev_body > avg_price * 0.003 and curr_body > avg_price * 0.005:
                return True

    return False


def _is_hammer(ohlc):
    """
    Hammer: small body near the top, long lower wick (>2x body),
    appearing after a short decline.
    """
    if len(ohlc) < 5:
        return False

    # Check last 3 candles
    for offset in range(min(3, len(ohlc) - 3)):
        idx = -(1 + offset)

        o = ohlc['Open'].iloc[idx]
        h = ohlc['High'].iloc[idx]
        l = ohlc['Low'].iloc[idx]
        c = ohlc['Close'].iloc[idx]

        body = abs(c - o)
        candle_range = h - l

        if candle_range == 0 or body == 0:
            continue

        lower_wick = min(o, c) - l
        upper_wick = h - max(o, c)

        # Hammer criteria:
        # 1. Lower wick at least 2x the body
        # 2. Upper wick is small (< 30% of range)
        # 3. Close is in the top 35% of the range
        if (lower_wick >= 2.0 * body and
                upper_wick < 0.3 * candle_range and
                (c - l) > 0.65 * candle_range):
            # Verify it comes after a decline (at least 2% drop in prior 3-5 bars)
            lookback_close = ohlc['Close'].iloc[idx - 3:idx]
            if len(lookback_close) >= 2:
                prior_high = lookback_close.max()
                if prior_high > c * 1.015:  # at least 1.5% decline
                    return True

    return False


def _is_morning_star(ohlc):
    """
    Morning Star: 3-candle reversal pattern.
    1st: large red candle
    2nd: small body (indecision, can be red or green)
    3rd: large green candle closing above midpoint of 1st candle
    """
    if len(ohlc) < 5:
        return False

    # Check last few windows of 3 candles
    for offset in range(min(3, len(ohlc) - 4)):
        i = -(3 + offset)

        o1, c1 = ohlc['Open'].iloc[i], ohlc['Close'].iloc[i]
        o2, c2 = ohlc['Open'].iloc[i + 1], ohlc['Close'].iloc[i + 1]
        o3, c3 = ohlc['Open'].iloc[i + 2], ohlc['Close'].iloc[i + 2]

        body1 = abs(c1 - o1)
        body2 = abs(c2 - o2)
        body3 = abs(c3 - o3)

        avg_price = (o1 + c1) / 2
        if avg_price == 0:
            continue

        # 1st candle: red and large (> 0.8% of price)
        if c1 >= o1 or body1 < avg_price * 0.008:
            continue

        # 2nd candle: small body (< 40% of 1st candle body)
        if body2 > body1 * 0.4:
            continue

        # 3rd candle: green and large
        if c3 <= o3 or body3 < avg_price * 0.008:
            continue

        # 3rd candle closes above midpoint of 1st candle body
        midpoint = (o1 + c1) / 2
        if c3 >= midpoint:
            return True

    return False


def _is_double_bottom(close):
    """
    Double Bottom: two significant lows at similar price levels (within 3%),
    separated by 15-50 bars, with a rebound above the midpoint between them.
    """
    if len(close) < 60:
        return False

    # Look at last 60 trading days
    recent = close.iloc[-60:]
    prices = recent.values

    # Find local minima (lows lower than 3 bars on each side)
    swing_lows = []
    for i in range(3, len(prices) - 3):
        window = prices[i - 3:i + 4]
        if prices[i] == window.min():
            swing_lows.append((i, prices[i]))

    if len(swing_lows) < 2:
        return False

    # Check pairs of swing lows
    for j in range(len(swing_lows)):
        for k in range(j + 1, len(swing_lows)):
            idx1, low1 = swing_lows[j]
            idx2, low2 = swing_lows[k]

            # Must be 15-50 bars apart
            gap = idx2 - idx1
            if gap < 15 or gap > 50:
                continue

            # Lows must be within 3% of each other
            avg_low = (low1 + low2) / 2
            if avg_low == 0:
                continue
            diff_pct = abs(low1 - low2) / avg_low * 100
            if diff_pct > 3.0:
                continue

            # Price between the two lows must have risen significantly (> 3%)
            peak_between = prices[idx1:idx2 + 1].max()
            if (peak_between - avg_low) / avg_low < 0.03:
                continue

            # Current price must be above the neckline (peak between lows)
            current = prices[-1]
            if current > peak_between * 0.98:
                return True

    return False


def _is_cup_and_handle(close):
    """
    Cup and Handle: U-shaped recovery (the cup) followed by a small pullback
    (the handle), then price breaks above the cup's rim.
    Looks at last 90-120 trading days.
    """
    if len(close) < 90:
        return False

    # Look at last 120 days (or whatever is available)
    lookback = min(120, len(close))
    prices = close.iloc[-lookback:].values

    # Find the highest point at the start (left rim of cup)
    # Look at first 20% of the window for the left rim
    left_section = int(lookback * 0.2)
    left_rim_idx = np.argmax(prices[:left_section])
    left_rim = prices[left_rim_idx]

    # Find the lowest point in the middle section (cup bottom)
    # Middle section: 20%-70% of the window
    mid_start = int(lookback * 0.2)
    mid_end = int(lookback * 0.7)
    if mid_end <= mid_start:
        return False

    mid_section = prices[mid_start:mid_end]
    cup_bottom_rel = np.argmin(mid_section)
    cup_bottom_idx = mid_start + cup_bottom_rel
    cup_bottom = prices[cup_bottom_idx]

    # Cup must be at least 5% deep from the left rim
    if left_rim == 0:
        return False
    cup_depth = (left_rim - cup_bottom) / left_rim
    if cup_depth < 0.05 or cup_depth > 0.35:
        return False

    # Find the right rim area (70%-90% of window)
    right_start = int(lookback * 0.7)
    right_end = int(lookback * 0.9)
    if right_end <= right_start:
        return False

    right_section = prices[right_start:right_end]
    right_rim = right_section.max()

    # Right rim should be close to left rim (within 5%)
    rim_diff = abs(right_rim - left_rim) / left_rim
    if rim_diff > 0.05:
        return False

    # Handle: small pullback in the last 10-20% of the window
    handle_section = prices[right_end:]
    if len(handle_section) < 3:
        return False

    handle_low = handle_section.min()
    handle_depth = (right_rim - handle_low) / right_rim

    # Handle should be a small dip (1%-10% of right rim)
    if handle_depth < 0.01 or handle_depth > 0.10:
        return False

    # Current price should be near or above the rim (breakout)
    current = prices[-1]
    neckline = min(left_rim, right_rim)
    if current >= neckline * 0.97:
        return True

    return False


##############################################################################
# Pre-Breakout Signal Detectors
##############################################################################

def _is_bollinger_squeeze(close):
    """
    Bollinger Band Squeeze: bands are significantly narrower than their 6-month average.
    Low volatility (tight coil) almost always precedes a large directional move.
    """
    if len(close) < 30:
        return False

    period = 20
    rolling_mean = close.rolling(period).mean()
    rolling_std  = close.rolling(period).std()

    # Normalised band-width = (Upper - Lower) / Middle
    band_width = ((rolling_mean + 2 * rolling_std) - (rolling_mean - 2 * rolling_std)) / rolling_mean
    band_width = band_width.dropna()

    if len(band_width) < 20:
        return False

    current_bw = band_width.iloc[-1]
    # Compare against last 126 trading days (~6 months)
    lookback_bw = band_width.iloc[-126:] if len(band_width) >= 126 else band_width
    avg_bw = lookback_bw.mean()

    # Squeeze: current width is less than 50 % of the recent average
    return current_bw > 0 and current_bw < avg_bw * 0.50


def _is_volume_surge(ohlc):
    """
    Volume Surge: today's volume ≥ 2× the 20-day average AND the candle is green.
    Signals institutional accumulation / demand entering the stock.
    """
    if 'Volume' not in ohlc.columns or len(ohlc) < 25:
        return False

    vol   = ohlc['Volume'].fillna(0)
    close = ohlc['Close']
    open_ = ohlc['Open']

    avg_vol = vol.iloc[-21:-1].mean()
    if avg_vol == 0:
        return False

    current_vol   = vol.iloc[-1]
    current_close = close.iloc[-1]
    current_open  = open_.iloc[-1]

    return (current_vol >= avg_vol * 2.0) and (current_close > current_open)


def _is_tight_consolidation(close):
    """
    Tight Consolidation / Flat Base: price range < 5 % over the last 10 trading days.
    Stock is coiling energy before a potential breakout.
    """
    if len(close) < 10:
        return False

    recent = close.iloc[-10:]
    low    = recent.min()
    if low == 0:
        return False

    range_pct = (recent.max() - low) / low * 100
    return range_pct < 5.0


def _is_near_52week_high(close):
    """
    Near 52-Week High: price is within 3 % below its 52-week high.
    Breakouts from prior highs into new highs generate the biggest momentum runs.
    """
    if len(close) < 50:
        return False

    lookback   = min(252, len(close))
    year_high  = close.iloc[-lookback:].max()
    current    = close.iloc[-1]

    if year_high == 0:
        return False

    pct_below = (year_high - current) / year_high * 100
    return pct_below <= 3.0


def _is_macd_bullish_crossover(close):
    """
    MACD Bullish Crossover: MACD line crossed above the signal line within the last 5 bars.
    A momentum shift that often precedes a sustained upswing.
    """
    if len(close) < 35:
        return False

    ema12       = close.ewm(span=12, adjust=False).mean()
    ema26       = close.ewm(span=26, adjust=False).mean()
    macd_line   = ema12 - ema26
    signal_line = macd_line.ewm(span=9, adjust=False).mean()

    for i in range(-5, 0):
        if (macd_line.iloc[i]     > signal_line.iloc[i] and
                macd_line.iloc[i - 1] <= signal_line.iloc[i - 1]):
            return True
    return False


def _is_relative_strength(close, market_close):
    """
    Relative Strength Leader: stock outperforms the S&P 500 by ≥ 5 pp over 3 months (63 days).
    RS leaders attract institutional buying and tend to continue outperforming.
    """
    if len(close) < 63 or market_close is None or len(market_close) < 63:
        return False

    stock_return  = (close.iloc[-1]        / close.iloc[-63]        - 1) * 100
    market_return = (market_close.iloc[-1] / market_close.iloc[-63] - 1) * 100

    return stock_return > market_return + 5.0


##############################################################################
# New Trading Indicators
##############################################################################

def _calculate_rsi(close, period=14):
    """RSI(14) — returns latest value as float, or None."""
    if len(close) < period + 1:
        return None
    delta = close.diff()
    gain = delta.clip(lower=0)
    loss = -delta.clip(upper=0)
    avg_gain = gain.ewm(com=period - 1, min_periods=period).mean()
    avg_loss = loss.ewm(com=period - 1, min_periods=period).mean()
    rs = avg_gain / avg_loss
    rsi = 100 - (100 / (1 + rs))
    val = rsi.iloc[-1]
    return None if pd.isna(val) else round(float(val), 1)


def _calculate_rvol(ohlc):
    """Relative Volume: today's volume / 20-day average volume."""
    if 'Volume' not in ohlc.columns or len(ohlc) < 22:
        return None
    vol = ohlc['Volume'].fillna(0)
    avg = vol.iloc[-21:-1].mean()
    if avg == 0:
        return None
    return round(float(vol.iloc[-1] / avg), 2)


def _calculate_stop_target(ohlc, current_price):
    """
    Stop Loss: 1% below the 10-bar swing low.
    Target 1: 1.5× risk (good entry). Target 2: 3× risk (runner).
    Returns (stop_loss, target1, target2, risk_reward).
    """
    if len(ohlc) < 10 or current_price <= 0:
        return None, None, None, None
    recent_low = float(ohlc['Low'].iloc[-10:].min())
    stop_loss = round(recent_low * 0.99, 2)
    risk = current_price - stop_loss
    if risk <= 0:
        return round(stop_loss, 2), None, None, None
    target1 = round(current_price + risk * 1.5, 2)
    target2 = round(current_price + risk * 3.0, 2)
    rr = round((target1 - current_price) / risk, 2)
    return stop_loss, target1, target2, rr


def _detect_exit_signals(ohlc, rsi_value):
    """
    Detect profit-taking / exit signals.
    Returns list of signal strings.
    """
    signals = []
    if ohlc is None or len(ohlc) < 20:
        return signals
    close = ohlc['Close']

    # RSI overbought (>75)
    if rsi_value is not None and rsi_value > 75:
        signals.append('RSI Overbought')

    # MACD histogram turning negative (momentum fading)
    if len(close) >= 35:
        ema12 = close.ewm(span=12, adjust=False).mean()
        ema26 = close.ewm(span=26, adjust=False).mean()
        macd_line = ema12 - ema26
        signal_line = macd_line.ewm(span=9, adjust=False).mean()
        hist = macd_line - signal_line
        if hist.iloc[-1] < 0 and hist.iloc[-2] >= 0:
            signals.append('MACD Fading')

    # Price extended >10% above 20-day SMA with a bearish candle
    if len(close) >= 20:
        sma20 = close.rolling(20).mean().iloc[-1]
        if sma20 > 0:
            extension = (close.iloc[-1] - sma20) / sma20 * 100
            if extension > 10 and ohlc['Close'].iloc[-1] < ohlc['Open'].iloc[-1]:
                signals.append('Extended+Bearish')

    # Volume dry-up after a big run (RVOL <0.5 after 20%+ gain over 20 days)
    if 'Volume' in ohlc.columns and len(ohlc) >= 21:
        vol = ohlc['Volume'].fillna(0)
        avg_vol = vol.iloc[-21:-1].mean()
        rvol = float(vol.iloc[-1] / avg_vol) if avg_vol > 0 else 1.0
        recent_gain = (close.iloc[-1] / close.iloc[-20] - 1) * 100
        if rvol < 0.5 and recent_gain > 20:
            signals.append('Volume Dry-Up')

    return signals


def _extract_ohlc(data, ticker, tickers):
    """Extract OHLC + Volume DataFrame for a single ticker from batch download data."""
    try:
        if len(tickers) == 1:
            ohlc = pd.DataFrame({
                'Open':   data['Open'],
                'High':   data['High'],
                'Low':    data['Low'],
                'Close':  data['Close'],
                'Volume': data['Volume'],
            })
        else:
            ohlc = pd.DataFrame({
                'Open':   data[(ticker, 'Open')],
                'High':   data[(ticker, 'High')],
                'Low':    data[(ticker, 'Low')],
                'Close':  data[(ticker, 'Close')],
                'Volume': data[(ticker, 'Volume')],
            })
        # Only drop rows where price data is missing; keep zero-volume rows
        return ohlc.dropna(subset=['Open', 'High', 'Low', 'Close'])
    except (KeyError, TypeError):
        return None


def scan_for_sma_proximity(tickers, threshold_pct=5.0, sma_period=150, progress_callback=None):
    """
    Batch-download prices for all tickers, compute N-day SMA,
    and filter for stocks within threshold_pct of their SMA.

    Returns list of dicts: ticker, current_price, sma_value, distance_pct
    """
    if progress_callback:
        progress_callback('download', 0, 1, 'Downloading price data...')

    # Include SPY for Relative Strength calculation (add only if not already present)
    tickers_dl = tickers if 'SPY' in tickers else list(tickers) + ['SPY']

    data = yf.download(
        tickers=tickers_dl,
        period='1y',
        interval='1d',
        group_by='ticker',
        threads=True,
        progress=False
    )

    if progress_callback:
        progress_callback('download', 1, 1, 'Price data downloaded.')

    # Extract SPY closes for Relative Strength comparisons
    market_close = None
    try:
        if len(tickers_dl) == 1:
            market_close = data['Close'].dropna()
        else:
            market_close = data[('SPY', 'Close')].dropna()
    except (KeyError, TypeError):
        market_close = None

    results = []
    total = len(tickers)

    for i, ticker in enumerate(tickers):
        if progress_callback and i % 50 == 0:
            progress_callback('sma_calc', i, total, f'Calculating SMA ({i}/{total})...')

        try:
            if len(tickers_dl) == 1:
                close = data['Close']
            else:
                close = data[(ticker, 'Close')]

            close = close.dropna()

            if len(close) < sma_period:
                continue

            sma_value = close.tail(sma_period).mean()
            current_price = close.iloc[-1]
            distance_pct = ((current_price - sma_value) / sma_value) * 100

            if abs(distance_pct) <= threshold_pct:
                # Detect classic patterns + pre-breakout signals
                ohlc = _extract_ohlc(data, ticker, tickers_dl)
                patterns = detect_patterns(ohlc, market_close) if ohlc is not None else []

                # Trading indicators
                rsi_val = _calculate_rsi(close)
                rvol_val = _calculate_rvol(ohlc) if ohlc is not None else None
                stop_loss, target1, target2, risk_reward = (
                    _calculate_stop_target(ohlc, float(current_price))
                    if ohlc is not None else (None, None, None, None)
                )
                exit_signals = _detect_exit_signals(ohlc, rsi_val) if ohlc is not None else []

                results.append({
                    'ticker': ticker,
                    'current_price': round(float(current_price), 2),
                    'sma_value': round(float(sma_value), 2),
                    'distance_pct': round(float(distance_pct), 2),
                    'patterns': patterns,
                    'rsi': rsi_val,
                    'rvol': rvol_val,
                    'stop_loss': stop_loss,
                    'target1': target1,
                    'target2': target2,
                    'risk_reward': risk_reward,
                    'exit_signals': exit_signals,
                })
        except (KeyError, IndexError, TypeError):
            continue

    if progress_callback:
        progress_callback('sma_calc', total, total, f'SMA scan complete. Found {len(results)} matches.')

    return results


def fetch_financials(ticker_symbol):
    """
    Fetch 3 years of financial data for a single ticker.
    Returns dict with yearly data for key metrics.
    """
    try:
        tk = yf.Ticker(ticker_symbol)

        income = tk.income_stmt
        cashflow = tk.cashflow
        balance = tk.balance_sheet

        date_cols = list(income.columns[:3])  # up to 3 most recent fiscal years
        years = []

        def safe_get(df, row_label, col):
            try:
                val = df.loc[row_label, col]
                if pd.isna(val):
                    return None
                return float(val)
            except (KeyError, TypeError):
                return None

        for date_col in date_cols:
            year_data = {
                'fiscal_year': str(date_col.year) if hasattr(date_col, 'year') else str(date_col),
            }

            revenue = safe_get(income, 'Total Revenue', date_col)
            net_income = safe_get(income, 'Net Income', date_col)

            year_data['revenue'] = revenue
            year_data['net_income'] = net_income
            year_data['profit_margin'] = (
                round((net_income / revenue) * 100, 2)
                if revenue and net_income and revenue != 0
                else None
            )
            year_data['free_cash_flow'] = safe_get(cashflow, 'Free Cash Flow', date_col)
            year_data['total_assets'] = safe_get(balance, 'Total Assets', date_col)

            # Try both common label variants for liabilities
            liabilities = safe_get(balance, 'Total Liabilities Net Minority Interest', date_col)
            if liabilities is None:
                liabilities = safe_get(balance, 'Total Liabilities', date_col)
            year_data['total_liabilities'] = liabilities

            shares = safe_get(balance, 'Share Issued', date_col)
            if shares is None:
                shares = safe_get(balance, 'Ordinary Shares Number', date_col)
            year_data['shares_outstanding'] = shares

            # Calculate EPS: Net Income / Shares Outstanding
            if net_income is not None and shares is not None and shares > 0:
                year_data['eps'] = round(net_income / shares, 2)
            else:
                year_data['eps'] = None

            years.append(year_data)

        # Fetch P/E ratio and current price from ticker info
        try:
            info = tk.info
            trailing_pe = info.get('trailingPE')
            forward_pe = info.get('forwardPE')
            current_price = info.get('currentPrice') or info.get('regularMarketPrice')
            trailing_eps = info.get('trailingEps')

            # Short interest
            short_pct = None
            raw_short = info.get('shortPercentOfFloat')
            if raw_short is not None:
                try:
                    short_pct = round(float(raw_short) * 100, 1)
                except Exception:
                    pass
        except Exception:
            trailing_pe = None
            forward_pe = None
            current_price = None
            trailing_eps = None
            short_pct = None

        # Days to next earnings
        days_to_earnings = None
        try:
            cal = tk.calendar
            if isinstance(cal, dict):
                dates = cal.get('Earnings Date', [])
                if dates:
                    next_date = dates[0] if isinstance(dates, list) else dates
                    if hasattr(next_date, 'date'):
                        dte = (next_date.date() - _dt.date.today()).days
                    elif hasattr(next_date, 'to_pydatetime'):
                        dte = (next_date.to_pydatetime().date() - _dt.date.today()).days
                    else:
                        dte = None
                    if dte is not None and -30 <= dte <= 180:
                        days_to_earnings = int(dte)
        except Exception:
            pass

        return {
            'ticker': ticker_symbol,
            'years': years,
            'trailing_pe': round(float(trailing_pe), 2) if trailing_pe is not None else None,
            'forward_pe': round(float(forward_pe), 2) if forward_pe is not None else None,
            'current_price': round(float(current_price), 2) if current_price is not None else None,
            'trailing_eps': round(float(trailing_eps), 2) if trailing_eps is not None else None,
            'short_pct': short_pct,
            'days_to_earnings': days_to_earnings,
            'error': None
        }

    except Exception as e:
        return {'ticker': ticker_symbol, 'years': [], 'error': str(e)}


def run_full_scan(threshold_pct=5.0, sma_period=150, progress_callback=None):
    """
    Full scan pipeline:
    1. Fetch S&P 500 + all NASDAQ ticker lists
    2. Batch download prices, compute SMA, filter
    3. Fetch financials for matching stocks
    """
    # Stage 1: Get tickers
    if progress_callback:
        progress_callback('init', 0, 1, 'Fetching S&P 500 + NASDAQ ticker lists...')

    sp500_df = get_sp500_tickers()

    try:
        nasdaq_df = get_all_nasdaq_tickers()
    except Exception:
        nasdaq_df = pd.DataFrame(columns=['ticker', 'name', 'sector'])

    combined_df = pd.concat([sp500_df, nasdaq_df], ignore_index=True)
    combined_df = combined_df.drop_duplicates(subset='ticker', keep='first')

    ticker_list = combined_df['ticker'].tolist()
    ticker_to_name = dict(zip(combined_df['ticker'], combined_df['name']))
    ticker_to_sector = dict(zip(combined_df['ticker'], combined_df['sector']))

    if progress_callback:
        progress_callback('init', 1, 1, f'Found {len(ticker_list)} tickers (S&P 500 + NASDAQ).')

    # Stage 2: SMA scan
    matches = scan_for_sma_proximity(ticker_list, threshold_pct, sma_period, progress_callback)

    # Deduplicate matches — same ticker can appear from both S&P 500 and NASDAQ lists
    seen_tickers = set()
    unique_matches = []
    for m in matches:
        if m['ticker'] not in seen_tickers:
            seen_tickers.add(m['ticker'])
            unique_matches.append(m)
    matches = unique_matches

    # Stage 3: Fetch financials for matches only — stream each result as it's ready
    total_matches = len(matches)
    for i, match in enumerate(matches):
        if progress_callback:
            progress_callback(
                'financials', i, total_matches,
                f'Fetching financials for {match["ticker"]} ({i + 1}/{total_matches})...'
            )

        fin_data = fetch_financials(match['ticker'])
        match['name'] = ticker_to_name.get(match['ticker'], 'Unknown')
        match['sector'] = ticker_to_sector.get(match['ticker'], 'Unknown')
        match['financials'] = fin_data['years']
        match['financial_error'] = fin_data['error']
        match['short_pct'] = fin_data.get('short_pct')
        match['days_to_earnings'] = fin_data.get('days_to_earnings')

        # Send completed stock data to the frontend immediately
        if progress_callback:
            progress_callback(
                'stock_ready', i + 1, total_matches,
                f'Fetched {match["ticker"]} ({i + 1}/{total_matches})',
                stock=match
            )

        # Rate limiting between individual API calls
        if i < total_matches - 1:
            time.sleep(0.3)

    if progress_callback:
        progress_callback('done', total_matches, total_matches, 'Scan complete!')

    return matches
