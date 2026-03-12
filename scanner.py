import pandas as pd
import numpy as np
import yfinance as yf
import time
import io
import urllib.request


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


##############################################################################
# Bullish Pattern Detection
##############################################################################

def detect_patterns(ohlc_df):
    """
    Detect bullish chart patterns from a DataFrame with Open, High, Low, Close columns.
    Returns a list of pattern name strings found.
    """
    if ohlc_df is None or len(ohlc_df) < 10:
        return []

    patterns = []

    if _is_golden_cross(ohlc_df['Close']):
        patterns.append('Golden Cross')

    if _is_bullish_engulfing(ohlc_df):
        patterns.append('Bullish Engulfing')

    if _is_hammer(ohlc_df):
        patterns.append('Hammer')

    if _is_morning_star(ohlc_df):
        patterns.append('Morning Star')

    if _is_double_bottom(ohlc_df['Close']):
        patterns.append('Double Bottom')

    if _is_cup_and_handle(ohlc_df['Close']):
        patterns.append('Cup & Handle')

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


def _extract_ohlc(data, ticker, tickers):
    """Extract OHLC DataFrame for a single ticker from batch download data."""
    try:
        if len(tickers) == 1:
            ohlc = pd.DataFrame({
                'Open': data['Open'],
                'High': data['High'],
                'Low': data['Low'],
                'Close': data['Close'],
            })
        else:
            ohlc = pd.DataFrame({
                'Open': data[(ticker, 'Open')],
                'High': data[(ticker, 'High')],
                'Low': data[(ticker, 'Low')],
                'Close': data[(ticker, 'Close')],
            })
        return ohlc.dropna()
    except (KeyError, TypeError):
        return None


def scan_for_sma_proximity(tickers, threshold_pct=5.0, sma_period=150, progress_callback=None):
    """
    Batch-download prices for all tickers, compute N-day SMA,
    and filter for stocks within threshold_pct of their SMA.

    Returns list of dicts: ticker, current_price, sma_value, distance_pct
    """
    if progress_callback:
        progress_callback('download', 0, 1, 'Downloading price data for all S&P 500 stocks...')

    # Need enough trading days for the SMA period
    # 200 days needs ~1y, shorter periods still benefit from 1y of data
    data = yf.download(
        tickers=tickers,
        period='1y',
        interval='1d',
        group_by='ticker',
        threads=True,
        progress=False
    )

    if progress_callback:
        progress_callback('download', 1, 1, 'Price data downloaded.')

    results = []
    total = len(tickers)

    for i, ticker in enumerate(tickers):
        if progress_callback and i % 50 == 0:
            progress_callback('sma_calc', i, total, f'Calculating SMA ({i}/{total})...')

        try:
            if len(tickers) == 1:
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
                # Detect bullish patterns from OHLC data
                ohlc = _extract_ohlc(data, ticker, tickers)
                patterns = detect_patterns(ohlc) if ohlc is not None else []

                results.append({
                    'ticker': ticker,
                    'current_price': round(float(current_price), 2),
                    'sma_value': round(float(sma_value), 2),
                    'distance_pct': round(float(distance_pct), 2),
                    'patterns': patterns,
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

        for date_col in date_cols:
            year_data = {
                'fiscal_year': str(date_col.year) if hasattr(date_col, 'year') else str(date_col),
            }

            def safe_get(df, row_label, col):
                try:
                    val = df.loc[row_label, col]
                    if pd.isna(val):
                        return None
                    return float(val)
                except (KeyError, TypeError):
                    return None

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
        except Exception:
            trailing_pe = None
            forward_pe = None
            current_price = None
            trailing_eps = None

        return {
            'ticker': ticker_symbol,
            'years': years,
            'trailing_pe': round(float(trailing_pe), 2) if trailing_pe is not None else None,
            'forward_pe': round(float(forward_pe), 2) if forward_pe is not None else None,
            'current_price': round(float(current_price), 2) if current_price is not None else None,
            'trailing_eps': round(float(trailing_eps), 2) if trailing_eps is not None else None,
            'error': None
        }

    except Exception as e:
        return {'ticker': ticker_symbol, 'years': [], 'error': str(e)}


def run_full_scan(threshold_pct=5.0, sma_period=150, progress_callback=None):
    """
    Full scan pipeline:
    1. Fetch S&P 500 ticker list
    2. Batch download prices, compute SMA, filter
    3. Fetch financials for matching stocks
    """
    # Stage 1: Get tickers
    if progress_callback:
        progress_callback('init', 0, 1, 'Fetching S&P 500 ticker list...')

    sp500_df = get_sp500_tickers()
    ticker_list = sp500_df['ticker'].tolist()
    ticker_to_name = dict(zip(sp500_df['ticker'], sp500_df['name']))
    ticker_to_sector = dict(zip(sp500_df['ticker'], sp500_df['sector']))

    if progress_callback:
        progress_callback('init', 1, 1, f'Found {len(ticker_list)} tickers.')

    # Stage 2: SMA scan
    matches = scan_for_sma_proximity(ticker_list, threshold_pct, sma_period, progress_callback)

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
