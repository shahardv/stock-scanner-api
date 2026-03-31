document.addEventListener('DOMContentLoaded', () => {

    // ──────────────────────────────────────────────────────────────────────
    // Tab Navigation
    // ──────────────────────────────────────────────────────────────────────
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const target = btn.dataset.tab;
            document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
            document.querySelectorAll('.tab-panel').forEach(p => p.classList.add('hidden'));
            btn.classList.add('active');
            document.getElementById(`tab-${target}`).classList.remove('hidden');
            if (target === 'news') {
                document.getElementById('news-dot').classList.add('hidden');
            }
            if (target === 'watchlist') {
                renderWatchlist();
            }
        });
    });

    // ──────────────────────────────────────────────────────────────────────
    // Shared scan-state (hoisted so both Scanner and Gap Scanner can use it)
    // ──────────────────────────────────────────────────────────────────────
    let gapScanRunning = false;

    function setScannerBusy(busy) {
        // Called when the stock scanner starts/stops — disables Gap Scanner controls
        const gapLB = document.getElementById('gap-load-btn');
        const gapRB = document.getElementById('gap-refresh-btn');
        if (!gapLB) return;
        gapLB.disabled = busy;
        if (gapRB) gapRB.disabled = busy;
        if (busy) {
            gapLB.title = 'Stop the stock scanner first';
        } else {
            gapLB.title = '';
        }
    }

    function setGapScannerBusy(busy) {
        // Called when gap scanner starts/stops — disables stock scanner button
        scanBtn.disabled = busy;
        scanBtn.title = busy ? 'Stop the Gap Scanner first' : '';
    }

    // ──────────────────────────────────────────────────────────────────────
    // Signal definitions
    // ──────────────────────────────────────────────────────────────────────
    const BREAKOUT_SIGNALS = {
        'BB Squeeze':    'Bollinger Band squeeze: volatility contracting — big move loading',
        'Volume Surge':  'Volume 2×+ above average: institutional accumulation signal',
        'Tight Base':    'Tight consolidation (<5% range over 10 days): coiled spring',
        'Near 52W High': 'Within 3% of 52-week high: strong momentum, potential new highs',
        'MACD Cross':    'MACD bullish crossover: momentum shifted to the upside',
        'RS Leader':     'Outperforming S&P 500 over last 3 months: market leader',
    };
    const CLASSIC_PATTERNS = {
        'Golden Cross':      '50-day SMA crossed above 200-day SMA in the last 10 days',
        'Bullish Engulfing': 'Large green candle fully engulfed the previous red candle',
        'Hammer':            'Long lower wick with small body — reversal signal after a decline',
        'Morning Star':      '3-candle reversal: red → small doji → strong green',
        'Double Bottom':     'Price bounced twice from the same support level',
        'Cup & Handle':      'Rounded base + small consolidation — classic breakout setup',
    };
    const EXIT_SIGNALS = {
        'RSI Overbought':    'RSI > 75: stock is overextended — consider taking partial profits',
        'MACD Fading':       'MACD histogram just turned negative: momentum fading, reduce exposure',
        'Extended+Bearish':  'Price > 10% above SMA20 with bearish candle: potential pullback',
        'Volume Dry-Up':     'Volume dried up after big run: institutional selling may be starting',
    };

    const financialMetrics = [
        { key: 'revenue',            label: 'Revenue' },
        { key: 'net_income',         label: 'Net Income' },
        { key: 'free_cash_flow',     label: 'FCF' },
        { key: 'profit_margin',      label: 'Margin (%)' },
        { key: 'total_assets',       label: 'Assets' },
        { key: 'total_liabilities',  label: 'Liabilities' },
        { key: 'shares_outstanding', label: 'Shares Out' },
    ];

    const baseColumns = () => [
        { key: '_position',       label: 'Position' },
        { key: 'ticker',          label: 'Ticker' },
        { key: 'name',            label: 'Company' },
        { key: 'sector',          label: 'Sector' },
        { key: 'current_price',   label: 'Price ($)' },
        { key: 'sma_value',       label: `SMA ${currentSmaPeriod}` },
        { key: 'distance_pct',    label: 'Dist (%)' },
        { key: 'rsi',             label: 'RSI' },
        { key: 'rvol',            label: 'RVOL' },
        { key: 'stop_loss',       label: 'Stop ($)' },
        { key: 'target1',         label: 'Target ($)' },
        { key: 'risk_reward',     label: 'R:R' },
        { key: 'short_pct',       label: 'Short %' },
        { key: 'days_to_earnings',label: 'Earnings' },
        { key: '_patterns',       label: 'Entry Signals' },
        { key: '_exit_signals',   label: 'Exit Signals' },
        { key: '_action',         label: '' },
    ];

    // ──────────────────────────────────────────────────────────────────────
    // Scanner Tab
    // ──────────────────────────────────────────────────────────────────────
    const thresholdSlider    = document.getElementById('threshold');
    const thresholdValue     = document.getElementById('threshold-value');
    const scanBtn            = document.getElementById('scan-btn');
    const stopBtn            = document.getElementById('stop-btn');
    const progressSection    = document.getElementById('progress');
    const progressBar        = document.getElementById('progress-bar');
    const progressMessage    = document.getElementById('progress-message');
    const resultsSection     = document.getElementById('results');
    const resultsSummary     = document.getElementById('results-summary');
    const filterInput        = document.getElementById('filter-input');
    const signalsFilterBtn   = document.getElementById('signals-filter-btn');
    const exitFilterBtn      = document.getElementById('exit-filter-btn');
    const rrFilterBtn        = document.getElementById('rr-filter-btn');
    const smaPeriodSelect    = document.getElementById('sma-period');

    let allResults = [];
    let currentSort = { column: null, direction: 'asc' };
    let currentSmaPeriod = 150;
    let tableInitialized = false;
    let streamingFiscalYears = [];
    let userSorted = false;
    let signalsFilterActive = false;
    let exitFilterActive    = false;
    let rrFilterActive      = false;

    thresholdSlider.addEventListener('input', () => {
        thresholdValue.textContent = `${parseFloat(thresholdSlider.value).toFixed(1)}%`;
    });

    scanBtn.addEventListener('click', async () => {
        if (gapScanRunning) {
            alert('Stop the Gap Scanner first before starting a scan.');
            return;
        }
        scanBtn.disabled = true;
        scanBtn.textContent = 'Scanning...';
        stopBtn.classList.remove('hidden');
        stopBtn.disabled = false;
        stopBtn.textContent = 'Stop Scan';
        setScannerBusy(true);
        progressSection.classList.remove('hidden');
        resultsSection.classList.add('hidden');
        progressBar.style.width = '0%';
        progressMessage.textContent = 'Starting scan...';

        allResults = [];
        tableInitialized = false;
        streamingFiscalYears = [];
        userSorted = false;
        currentSort = { column: null, direction: 'asc' };

        const threshold = parseFloat(thresholdSlider.value);
        currentSmaPeriod = parseInt(smaPeriodSelect.value);

        try {
            let response = await fetch('/api/scan', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ threshold, sma_period: currentSmaPeriod })
            });

            // If lock is stale (server reloaded mid-scan), clear it and retry once
            if (response.status === 409) {
                progressMessage.textContent = 'Clearing stale scan lock — retrying...';
                await fetch('/api/scan/stop', { method: 'POST' });
                response = await fetch('/api/scan', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ threshold, sma_period: currentSmaPeriod })
                });
            }

            if (!response.ok) {
                const err = await response.json();
                progressMessage.textContent = err.error || 'Failed to start scan.';
                resetScanBtn();
                return;
            }
            listenForProgress();
        } catch (e) {
            progressMessage.textContent = `Error: ${e.message}`;
            resetScanBtn();
        }
    });

    function resetScanBtn() {
        scanBtn.disabled = false;
        scanBtn.textContent = 'Scan Now';
        scanBtn.title = '';
        stopBtn.classList.add('hidden');
        setScannerBusy(false);
    }

    stopBtn.addEventListener('click', async () => {
        stopBtn.disabled = true;
        stopBtn.textContent = 'Stopping...';
        try { await fetch('/api/scan/stop', { method: 'POST' }); } catch (e) {}
    });

    function listenForProgress() {
        const evtSource = new EventSource('/api/scan/progress');
        evtSource.onmessage = (event) => {
            const data = JSON.parse(event.data);
            progressMessage.textContent = data.message;

            let pct = 0;
            if (data.stage === 'init') pct = 5;
            else if (data.stage === 'download') pct = 10 + (data.total > 0 ? (data.current / data.total) * 20 : 0);
            else if (data.stage === 'sma_calc') pct = 30 + (data.total > 0 ? (data.current / data.total) * 30 : 0);
            else if (data.stage === 'financials' || data.stage === 'stock_ready') {
                pct = 60 + (data.total > 0 ? (data.current / data.total) * 35 : 0);
            }
            else if (data.stage === 'done') pct = 100;
            progressBar.style.width = `${pct}%`;

            if (data.stage === 'stock_ready' && data.stock) {
                allResults.push(data.stock);
                addStockToTable(data.stock);
                updateSummary();
            }

            if (data.stage === 'done' || data.stage === 'error') {
                evtSource.close();
                resetScanBtn();
                if (data.stage === 'done' && allResults.length > 0) {
                    document.getElementById('news-dot').classList.remove('hidden');
                    document.getElementById('gap-dot').classList.remove('hidden');
                }
                if (data.stage === 'done' && allResults.length === 0) {
                    resultsSection.classList.remove('hidden');
                    resultsSummary.textContent = '';
                    document.querySelector('.table-controls').classList.add('hidden');
                    document.querySelector('.table-container').innerHTML =
                        '<p class="no-results">No stocks found within the specified threshold. Try increasing the percentage.</p>';
                }
            }
        };
        evtSource.onerror = () => {
            evtSource.close();
            progressMessage.textContent = 'Connection lost. Fetching remaining results...';
            resetScanBtn();
            fetchResults();
        };
    }

    async function fetchResults() {
        try {
            const response = await fetch('/api/scan/results');
            const result = await response.json();
            if (result.status === 'complete' && result.data && result.data.length > 0) {
                allResults = result.data;
                tableInitialized = false;
                buildFullTable(allResults);
            }
        } catch (e) {
            progressMessage.textContent = `Failed to fetch results: ${e.message}`;
        }
    }

    function updateSummary() {
        const aboveCount = allResults.filter(d => d.distance_pct >= 0).length;
        const belowCount = allResults.filter(d => d.distance_pct < 0).length;
        const withSignals = allResults.filter(d => (d.patterns || []).some(p => BREAKOUT_SIGNALS[p])).length;
        const withExit = allResults.filter(d => (d.exit_signals || []).length > 0).length;
        const goodRR = allResults.filter(d => d.risk_reward != null && d.risk_reward >= 1.5).length;

        resultsSummary.innerHTML =
            `Found <strong>${allResults.length}</strong> stocks near their ${currentSmaPeriod}-day SMA ` +
            `(${aboveCount} above, ${belowCount} below) &nbsp;|&nbsp; ` +
            `<span class="summary-fire">${withSignals} with breakout signals</span> &nbsp;|&nbsp; ` +
            `<span class="summary-exit">${withExit} with exit signals</span> &nbsp;|&nbsp; ` +
            `<span class="summary-rr">${goodRR} with R:R &ge; 1.5</span>`;
    }

    // ── Table initialization ────────────────────────────────────────────
    function initTableIfNeeded(stock) {
        if (tableInitialized) return;
        tableInitialized = true;

        resultsSection.classList.remove('hidden');
        document.querySelector('.table-controls').classList.remove('hidden');

        streamingFiscalYears = (stock.financials && stock.financials.length > 0)
            ? stock.financials.map(f => f.fiscal_year)
            : [];

        buildTableHeader(streamingFiscalYears);
    }

    function buildTableHeader(fiscalYears) {
        const table = document.getElementById('results-table');
        const thead = table.querySelector('thead');
        const tbody = table.querySelector('tbody');
        thead.innerHTML = '';
        tbody.innerHTML = '';

        const cols = baseColumns();

        // Row 1: group headers
        const groupRow = document.createElement('tr');
        const baseGroupTh = document.createElement('th');
        baseGroupTh.colSpan = cols.length;
        baseGroupTh.className = 'year-group';
        baseGroupTh.textContent = 'Stock Info & Trading Signals';
        groupRow.appendChild(baseGroupTh);

        fiscalYears.forEach(year => {
            const th = document.createElement('th');
            th.colSpan = financialMetrics.length;
            th.className = 'year-group';
            th.textContent = `FY ${year}`;
            groupRow.appendChild(th);
        });

        if (fiscalYears.length >= 2) {
            const trendTh = document.createElement('th');
            trendTh.colSpan = financialMetrics.length;
            trendTh.className = 'year-group trend-group';
            trendTh.textContent = '3Y Trend';
            groupRow.appendChild(trendTh);
        }
        thead.appendChild(groupRow);

        // Row 2: sortable column headers
        const headerRow = document.createElement('tr');
        cols.forEach(col => {
            const th = document.createElement('th');
            if (col.key === '_action') {
                th.textContent = '';
                th.style.cursor = 'default';
            } else {
                const sortKey = col.key === '_position' ? '_position' : col.key;
                th.innerHTML = `${col.label}<span class="sort-arrow">${getSortArrow(sortKey)}</span>`;
                if (currentSort.column === sortKey) th.classList.add('sorted');
                th.addEventListener('click', () => {
                    userSorted = true;
                    sortTable(sortKey, allResults, streamingFiscalYears);
                });
            }
            headerRow.appendChild(th);
        });

        fiscalYears.forEach((year, yearIdx) => {
            financialMetrics.forEach(metric => {
                const key = `fin_${yearIdx}_${metric.key}`;
                const th = document.createElement('th');
                th.innerHTML = `${metric.label}<span class="sort-arrow">${getSortArrow(key)}</span>`;
                if (currentSort.column === key) th.classList.add('sorted');
                th.addEventListener('click', () => {
                    userSorted = true;
                    sortTable(key, allResults, streamingFiscalYears);
                });
                headerRow.appendChild(th);
            });
        });

        if (fiscalYears.length >= 2) {
            financialMetrics.forEach(metric => {
                const key = `trend_${metric.key}`;
                const th = document.createElement('th');
                th.innerHTML = `${metric.label}<span class="sort-arrow">${getSortArrow(key)}</span>`;
                th.className = 'trend-header';
                if (currentSort.column === key) th.classList.add('sorted');
                th.addEventListener('click', () => {
                    userSorted = true;
                    sortTable(key, allResults, streamingFiscalYears);
                });
                headerRow.appendChild(th);
            });
        }

        thead.appendChild(headerRow);
    }

    function addStockToTable(stock) {
        initTableIfNeeded(stock);
        if (userSorted && currentSort.column) {
            rebuildSorted(allResults, streamingFiscalYears);
            return;
        }
        const tbody = document.getElementById('results-table').querySelector('tbody');
        const tr = createStockRow(stock, streamingFiscalYears);
        tr.classList.add('row-new');
        tbody.appendChild(tr);
        requestAnimationFrame(() => requestAnimationFrame(() => tr.classList.remove('row-new')));
    }

    // ── Row creation ────────────────────────────────────────────────────
    function createStockRow(stock, fiscalYears) {
        const tr = document.createElement('tr');

        // Position
        const tdPos = document.createElement('td');
        const isAbove = stock.distance_pct >= 0;
        tdPos.textContent = isAbove ? '▲ Above' : '▼ Below';
        tdPos.className = `position-cell ${isAbove ? 'pos-above' : 'pos-below'}`;
        tr.appendChild(tdPos);

        // Ticker
        const tdTicker = document.createElement('td');
        tdTicker.textContent = stock.ticker;
        tr.appendChild(tdTicker);

        // Name
        const tdName = document.createElement('td');
        tdName.textContent = stock.name || '';
        tr.appendChild(tdName);

        // Sector
        const tdSector = document.createElement('td');
        tdSector.textContent = stock.sector || '';
        tr.appendChild(tdSector);

        // Price
        const tdPrice = document.createElement('td');
        tdPrice.textContent = `$${stock.current_price.toFixed(2)}`;
        tr.appendChild(tdPrice);

        // SMA
        const tdSma = document.createElement('td');
        tdSma.textContent = `$${stock.sma_value.toFixed(2)}`;
        tr.appendChild(tdSma);

        // Distance
        const tdDist = document.createElement('td');
        tdDist.textContent = `${stock.distance_pct > 0 ? '+' : ''}${stock.distance_pct.toFixed(2)}%`;
        tdDist.className = stock.distance_pct >= 0 ? 'positive' : 'negative';
        tr.appendChild(tdDist);

        // RSI
        const tdRsi = document.createElement('td');
        if (stock.rsi != null) {
            tdRsi.textContent = stock.rsi.toFixed(1);
            tdRsi.className = getRsiClass(stock.rsi);
            tdRsi.title = getRsiLabel(stock.rsi);
        } else {
            tdRsi.textContent = '—';
            tdRsi.style.color = '#bbb';
        }
        tr.appendChild(tdRsi);

        // RVOL
        const tdRvol = document.createElement('td');
        if (stock.rvol != null) {
            tdRvol.textContent = stock.rvol.toFixed(2) + 'x';
            tdRvol.className = getRvolClass(stock.rvol);
            tdRvol.title = `Volume is ${stock.rvol.toFixed(2)}× the 20-day average`;
        } else {
            tdRvol.textContent = '—';
            tdRvol.style.color = '#bbb';
        }
        tr.appendChild(tdRvol);

        // Stop Loss
        const tdStop = document.createElement('td');
        if (stock.stop_loss != null) {
            tdStop.textContent = `$${stock.stop_loss.toFixed(2)}`;
            const riskPct = ((stock.current_price - stock.stop_loss) / stock.current_price * 100).toFixed(1);
            tdStop.title = `Stop loss — risk: ${riskPct}% from current price`;
            tdStop.className = 'stop-cell';
        } else {
            tdStop.textContent = '—';
            tdStop.style.color = '#bbb';
        }
        tr.appendChild(tdStop);

        // Target
        const tdTarget = document.createElement('td');
        if (stock.target1 != null) {
            tdTarget.textContent = `$${stock.target1.toFixed(2)}`;
            const gainPct = ((stock.target1 - stock.current_price) / stock.current_price * 100).toFixed(1);
            tdTarget.title = `Target 1 (1.5× risk) — potential gain: +${gainPct}%\nTarget 2 (3× risk): $${stock.target2 != null ? stock.target2.toFixed(2) : 'N/A'}`;
            tdTarget.className = 'target-cell';
        } else {
            tdTarget.textContent = '—';
            tdTarget.style.color = '#bbb';
        }
        tr.appendChild(tdTarget);

        // R:R
        const tdRR = document.createElement('td');
        if (stock.risk_reward != null) {
            tdRR.textContent = `${stock.risk_reward.toFixed(1)}:1`;
            tdRR.className = getRRClass(stock.risk_reward);
            tdRR.title = `Risk:Reward ratio — ${stock.risk_reward >= 1.5 ? 'Favorable setup' : 'Below ideal 1.5:1 threshold'}`;
        } else {
            tdRR.textContent = '—';
            tdRR.style.color = '#bbb';
        }
        tr.appendChild(tdRR);

        // Short %
        const tdShort = document.createElement('td');
        if (stock.short_pct != null) {
            tdShort.textContent = `${stock.short_pct.toFixed(1)}%`;
            tdShort.className = getShortClass(stock.short_pct);
            tdShort.title = getShortLabel(stock.short_pct);
        } else {
            tdShort.textContent = '—';
            tdShort.style.color = '#bbb';
        }
        tr.appendChild(tdShort);

        // Days to Earnings
        const tdEarnings = document.createElement('td');
        if (stock.days_to_earnings != null) {
            const d = stock.days_to_earnings;
            tdEarnings.textContent = d <= 0 ? 'Today/Past' : `${d}d`;
            tdEarnings.className = getEarningsClass(d);
            tdEarnings.title = d <= 0 ? 'Earnings today or recently past' : `Earnings in ${d} days`;
        } else {
            tdEarnings.textContent = '—';
            tdEarnings.style.color = '#bbb';
        }
        tr.appendChild(tdEarnings);

        // Entry Patterns (breakout signals first, then classic)
        const tdPatterns = document.createElement('td');
        const patterns = stock.patterns || [];
        if (patterns.length > 0) {
            const sorted = [
                ...patterns.filter(p => BREAKOUT_SIGNALS[p]),
                ...patterns.filter(p => !BREAKOUT_SIGNALS[p]),
            ];
            sorted.forEach(p => {
                const isHot = !!BREAKOUT_SIGNALS[p];
                const tooltip = BREAKOUT_SIGNALS[p] || CLASSIC_PATTERNS[p] || '';
                const badge = document.createElement('span');
                badge.className = isHot ? 'pattern-badge signal-hot' : 'pattern-badge';
                badge.textContent = isHot ? `🔥 ${p}` : p;
                if (tooltip) { badge.title = tooltip; badge.classList.add('has-tooltip'); }
                tdPatterns.appendChild(badge);
            });
        } else {
            tdPatterns.textContent = '—';
            tdPatterns.className = 'no-pattern';
        }
        tr.appendChild(tdPatterns);

        // Exit Signals
        const tdExit = document.createElement('td');
        const exitSignals = stock.exit_signals || [];
        if (exitSignals.length > 0) {
            exitSignals.forEach(s => {
                const badge = document.createElement('span');
                badge.className = 'pattern-badge signal-exit';
                badge.textContent = `⚠️ ${s}`;
                const tooltip = EXIT_SIGNALS[s] || '';
                if (tooltip) { badge.title = tooltip; badge.classList.add('has-tooltip'); }
                tdExit.appendChild(badge);
            });
        } else {
            tdExit.textContent = '—';
            tdExit.className = 'no-pattern';
        }
        tr.appendChild(tdExit);

        // Financials button + add to watchlist
        const tdAction = document.createElement('td');
        const finBtn = document.createElement('a');
        finBtn.href = `/stock/${stock.ticker}`;
        finBtn.target = '_blank';
        finBtn.className = 'detail-btn';
        finBtn.textContent = 'Financials';
        tdAction.appendChild(finBtn);

        const wlBtn = document.createElement('button');
        wlBtn.className = 'watchlist-add-inline-btn';
        wlBtn.textContent = '+ Watch';
        wlBtn.title = 'Add to Watchlist';
        wlBtn.addEventListener('click', () => {
            addToWatchlist(stock.ticker, stock.current_price);
            wlBtn.textContent = '✓ Added';
            wlBtn.disabled = true;
        });
        tdAction.appendChild(wlBtn);
        tr.appendChild(tdAction);

        // Fiscal year financial data
        fiscalYears.forEach((year, yearIdx) => {
            const yearData = stock.financials?.[yearIdx] || {};
            financialMetrics.forEach(metric => {
                const td = document.createElement('td');
                const val = yearData[metric.key];
                if (metric.key === 'profit_margin') {
                    td.textContent = val != null ? `${val.toFixed(1)}%` : 'N/A';
                } else if (metric.key === 'shares_outstanding') {
                    td.textContent = val != null ? formatShares(val) : 'N/A';
                } else {
                    td.textContent = val != null ? formatLargeNumber(val) : 'N/A';
                }
                if (val == null) td.style.color = '#bbb';
                tr.appendChild(td);
            });
        });

        // Trend summary
        if (fiscalYears.length >= 2) {
            const newest = stock.financials?.[0] || {};
            const oldest = stock.financials?.[stock.financials.length - 1] || {};
            financialMetrics.forEach(metric => {
                const td = document.createElement('td');
                td.className = 'trend-cell';
                const newVal = newest[metric.key];
                const oldVal = oldest[metric.key];
                if (newVal == null || oldVal == null || oldVal === 0) {
                    td.textContent = 'N/A';
                    td.style.color = '#bbb';
                } else {
                    const changePct = ((newVal - oldVal) / Math.abs(oldVal)) * 100;
                    const lowerIsBetter = metric.key === 'total_liabilities' || metric.key === 'shares_outstanding';
                    const isImproving = lowerIsBetter ? changePct < 0 : changePct > 0;
                    const arrow = isImproving ? '▲' : '▼';
                    const sign = changePct > 0 ? '+' : '';
                    td.textContent = `${arrow} ${sign}${changePct.toFixed(1)}%`;
                    td.className = `trend-cell ${isImproving ? 'trend-up' : 'trend-down'}`;
                }
                tr.appendChild(td);
            });
        }

        return tr;
    }

    // ── Color helpers ───────────────────────────────────────────────────
    function getRsiClass(rsi) {
        if (rsi < 30) return 'rsi-oversold';
        if (rsi < 50) return 'rsi-neutral';
        if (rsi < 70) return 'rsi-bullish';
        if (rsi < 75) return 'rsi-hot';
        return 'rsi-overbought';
    }

    function getRsiLabel(rsi) {
        if (rsi < 30) return `RSI ${rsi} — Oversold: potential bounce incoming`;
        if (rsi < 50) return `RSI ${rsi} — Neutral zone`;
        if (rsi < 70) return `RSI ${rsi} — Bullish momentum`;
        if (rsi < 75) return `RSI ${rsi} — Getting hot, watch carefully`;
        return `RSI ${rsi} — Overbought: consider taking profits`;
    }

    function getRvolClass(rvol) {
        if (rvol >= 2.0) return 'rvol-surge';
        if (rvol >= 1.2) return 'rvol-high';
        if (rvol >= 0.8) return 'rvol-normal';
        return 'rvol-low';
    }

    function getRRClass(rr) {
        if (rr >= 2.0) return 'rr-excellent';
        if (rr >= 1.5) return 'rr-good';
        if (rr >= 1.0) return 'rr-ok';
        return 'rr-poor';
    }

    function getShortClass(pct) {
        if (pct >= 30) return 'short-extreme';
        if (pct >= 20) return 'short-high';
        if (pct >= 10) return 'short-moderate';
        return 'short-low';
    }

    function getShortLabel(pct) {
        if (pct >= 30) return `${pct}% short float — Extreme: high squeeze potential`;
        if (pct >= 20) return `${pct}% short float — High: potential short squeeze on breakout`;
        if (pct >= 10) return `${pct}% short float — Moderate`;
        return `${pct}% short float — Low`;
    }

    function getEarningsClass(days) {
        if (days <= 7) return 'earnings-soon';
        if (days <= 30) return 'earnings-upcoming';
        return 'earnings-distant';
    }

    // ── Full table rebuild ──────────────────────────────────────────────
    function buildFullTable(data) {
        const table = document.getElementById('results-table');
        const fiscalYears = (data.length > 0 && data[0].financials)
            ? data[0].financials.map(f => f.fiscal_year)
            : streamingFiscalYears;

        resultsSection.classList.remove('hidden');
        document.querySelector('.table-controls').classList.remove('hidden');

        buildTableHeader(fiscalYears);

        const tbody = table.querySelector('tbody');
        data.forEach(stock => tbody.appendChild(createStockRow(stock, fiscalYears)));
        updateSummary();
    }

    // ── Formatting helpers ──────────────────────────────────────────────
    function formatLargeNumber(value) {
        if (value == null) return 'N/A';
        const abs = Math.abs(value);
        const sign = value < 0 ? '-' : '';
        if (abs >= 1e12) return `${sign}$${(abs / 1e12).toFixed(1)}T`;
        if (abs >= 1e9)  return `${sign}$${(abs / 1e9).toFixed(1)}B`;
        if (abs >= 1e6)  return `${sign}$${(abs / 1e6).toFixed(0)}M`;
        if (abs >= 1e3)  return `${sign}$${(abs / 1e3).toFixed(0)}K`;
        return `${sign}$${abs.toFixed(0)}`;
    }

    function formatShares(value) {
        if (value == null) return 'N/A';
        const abs = Math.abs(value);
        if (abs >= 1e9) return `${(abs / 1e9).toFixed(2)}B`;
        if (abs >= 1e6) return `${(abs / 1e6).toFixed(1)}M`;
        if (abs >= 1e3) return `${(abs / 1e3).toFixed(0)}K`;
        return abs.toFixed(0);
    }

    function getTrendValue(stock, metricKey) {
        if (!stock.financials || stock.financials.length < 2) return null;
        const newest = stock.financials[0]?.[metricKey];
        const oldest = stock.financials[stock.financials.length - 1]?.[metricKey];
        if (newest == null || oldest == null || oldest === 0) return null;
        return ((newest - oldest) / Math.abs(oldest)) * 100;
    }

    function getSortArrow(key) {
        if (currentSort.column !== key) return ' ↕';
        return currentSort.direction === 'asc' ? ' ↑' : ' ↓';
    }

    function sortTable(key, data, fiscalYears) {
        if (currentSort.column === key) {
            currentSort.direction = currentSort.direction === 'asc' ? 'desc' : 'asc';
        } else {
            currentSort.column = key;
            currentSort.direction = 'asc';
        }
        rebuildSorted(data, fiscalYears);
    }

    function rebuildSorted(data, fiscalYears) {
        const key = currentSort.column;
        const sorted = [...data].sort((a, b) => {
            let valA, valB;
            if (key === '_position') {
                valA = a.distance_pct >= 0 ? 1 : 0;
                valB = b.distance_pct >= 0 ? 1 : 0;
            } else if (key === '_patterns') {
                valA = (a.patterns || []).length;
                valB = (b.patterns || []).length;
            } else if (key === '_exit_signals') {
                valA = (a.exit_signals || []).length;
                valB = (b.exit_signals || []).length;
            } else if (key.startsWith('trend_')) {
                const metricKey = key.replace('trend_', '');
                valA = getTrendValue(a, metricKey);
                valB = getTrendValue(b, metricKey);
            } else if (key.startsWith('fin_')) {
                const parts = key.split('_');
                const yearIdx = parseInt(parts[1]);
                const metricKey = parts.slice(2).join('_');
                valA = a.financials?.[yearIdx]?.[metricKey] ?? null;
                valB = b.financials?.[yearIdx]?.[metricKey] ?? null;
            } else {
                valA = a[key];
                valB = b[key];
            }
            if (valA === null && valB === null) return 0;
            if (valA === null) return 1;
            if (valB === null) return -1;
            if (typeof valA === 'string') {
                return currentSort.direction === 'asc' ? valA.localeCompare(valB) : valB.localeCompare(valA);
            }
            return currentSort.direction === 'asc' ? valA - valB : valB - valA;
        });
        buildFullTable(sorted);
    }

    function applyFilters() {
        const query = filterInput.value.toLowerCase();
        let filtered = allResults;
        if (signalsFilterActive) {
            filtered = filtered.filter(r => (r.patterns || []).some(p => BREAKOUT_SIGNALS[p]));
        }
        if (exitFilterActive) {
            filtered = filtered.filter(r => (r.exit_signals || []).length > 0);
        }
        if (rrFilterActive) {
            filtered = filtered.filter(r => r.risk_reward != null && r.risk_reward >= 1.5);
        }
        if (query) {
            filtered = filtered.filter(r =>
                r.ticker.toLowerCase().includes(query) ||
                (r.name || '').toLowerCase().includes(query) ||
                (r.sector || '').toLowerCase().includes(query)
            );
        }
        buildFullTable(filtered);
    }

    filterInput.addEventListener('input', applyFilters);

    signalsFilterBtn.addEventListener('click', () => {
        signalsFilterActive = !signalsFilterActive;
        signalsFilterBtn.classList.toggle('active', signalsFilterActive);
        signalsFilterBtn.textContent = signalsFilterActive ? '🔥 Showing Breakout Signals Only' : '🔥 Breakout Signals Only';
        applyFilters();
    });

    exitFilterBtn.addEventListener('click', () => {
        exitFilterActive = !exitFilterActive;
        exitFilterBtn.classList.toggle('active', exitFilterActive);
        exitFilterBtn.textContent = exitFilterActive ? '⚠️ Showing Exit Signals Only' : '⚠️ Exit Signals Only';
        applyFilters();
    });

    rrFilterBtn.addEventListener('click', () => {
        rrFilterActive = !rrFilterActive;
        rrFilterBtn.classList.toggle('active', rrFilterActive);
        rrFilterBtn.textContent = rrFilterActive ? 'R:R ≥ 1.5 ✓' : 'R:R ≥ 1.5 Only';
        applyFilters();
    });

    // ══════════════════════════════════════════════════════════════════════
    // Gap Scanner Tab
    // ══════════════════════════════════════════════════════════════════════
    const gapLoadBtn    = document.getElementById('gap-load-btn');
    const gapStopBtn    = document.getElementById('gap-stop-btn');
    const gapRefreshBtn = document.getElementById('gap-refresh-btn');
    const gapMinSlider  = document.getElementById('gap-min-pct');
    const gapMinValue   = document.getElementById('gap-min-value');
    const gapStatus     = document.getElementById('gap-status');
    const gapEmpty      = document.getElementById('gap-empty');
    const gapContent    = document.getElementById('gap-content');
    const gapSummary    = document.getElementById('gap-summary');
    const gapGainers    = document.getElementById('gap-gainers');
    const gapLosers     = document.getElementById('gap-losers');

    let gapEvtSource = null;
    const GAP_MAX_CARDS = 25;

    // All streamed gap stocks — used for filtering/sorting
    let gapAllGainers = [];
    let gapAllLosers  = [];
    let gapSectors    = new Set();

    const gapProgressSection    = document.getElementById('gap-progress');
    const gapProgressBar        = document.getElementById('gap-progress-bar');
    const gapProgressMsg        = document.getElementById('gap-progress-message');
    const gapSearchInput        = document.getElementById('gap-search');
    const gapSectorFilter       = document.getElementById('gap-sector-filter');
    const gapSortBy             = document.getElementById('gap-sort-by');
    const gapNearResistanceBtn  = document.getElementById('gap-near-resistance-btn');
    const gapBreakoutBtn        = document.getElementById('gap-breakout-btn');
    const gapFilterInfo         = document.getElementById('gap-filter-info');

    let gapNearResistanceActive = false;
    let gapBreakoutActive       = false;

    gapMinSlider.addEventListener('input', () => {
        gapMinValue.textContent = `${parseFloat(gapMinSlider.value).toFixed(1)}%`;
    });

    gapLoadBtn.addEventListener('click', () => {
        if (scan_state_running()) {
            showGapStatus('Stop the stock scanner first.', 'warn');
            return;
        }
        startGapStream();
    });

    gapStopBtn.addEventListener('click', () => {
        if (gapEvtSource) { gapEvtSource.close(); gapEvtSource = null; }
        resetGapScanner();
        showGapStatus('Gap scan stopped.', 'warn');
    });

    gapRefreshBtn.addEventListener('click', () => {
        if (scan_state_running()) {
            showGapStatus('Stop the stock scanner first.', 'warn');
            return;
        }
        startGapStream();
    });

    // Filter event listeners
    gapSearchInput.addEventListener('input', applyGapFilters);
    gapSectorFilter.addEventListener('change', applyGapFilters);
    gapSortBy.addEventListener('change', applyGapFilters);

    gapNearResistanceBtn.addEventListener('click', () => {
        gapBreakoutActive = false;
        gapBreakoutBtn.classList.remove('active');
        gapNearResistanceActive = !gapNearResistanceActive;
        gapNearResistanceBtn.classList.toggle('active', gapNearResistanceActive);
        applyGapFilters();
    });

    gapBreakoutBtn.addEventListener('click', () => {
        gapNearResistanceActive = false;
        gapNearResistanceBtn.classList.remove('active');
        gapBreakoutActive = !gapBreakoutActive;
        gapBreakoutBtn.classList.toggle('active', gapBreakoutActive);
        applyGapFilters();
    });

    function scan_state_running() {
        return scanBtn.disabled && scanBtn.textContent === 'Scanning...';
    }

    function resetGapScanner() {
        gapScanRunning = false;
        gapLoadBtn.disabled = false;
        gapLoadBtn.textContent = gapContent.classList.contains('hidden') ? 'Load Gap Scanner' : 'Reload';
        gapStopBtn.classList.add('hidden');
        gapProgressSection.classList.add('hidden');
        gapProgressBar.style.width = '0%';
        setGapScannerBusy(false);
    }

    function applyGapFilters() {
        const query   = gapSearchInput.value.trim().toLowerCase();
        const sector  = gapSectorFilter.value;
        const sortKey = gapSortBy.value;

        function filterAndSort(arr, ascending) {
            let filtered = arr;
            if (query) {
                filtered = filtered.filter(s =>
                    s.ticker.toLowerCase().includes(query) ||
                    (s.name   || '').toLowerCase().includes(query) ||
                    (s.sector || '').toLowerCase().includes(query)
                );
            }
            if (sector) {
                filtered = filtered.filter(s => s.sector === sector);
            }
            if (gapNearResistanceActive) {
                filtered = filtered.filter(s => s.near_resistance && !s.broke_resistance);
            }
            if (gapBreakoutActive) {
                filtered = filtered.filter(s => s.broke_resistance);
            }
            filtered = [...filtered].sort((a, b) => {
                if (sortKey === 'volume') {
                    return ascending ? a.volume - b.volume : b.volume - a.volume;
                } else if (sortKey === 'rvol') {
                    const ra = a.rvol || 0, rb = b.rvol || 0;
                    return ascending ? ra - rb : rb - ra;
                } else {
                    return ascending ? a.change_pct - b.change_pct : b.change_pct - a.change_pct;
                }
            });
            return filtered.slice(0, GAP_MAX_CARDS);
        }

        const gainers = filterAndSort(gapAllGainers, false);
        const losers  = filterAndSort(gapAllLosers,  true);

        gapGainers.innerHTML = '';
        gapLosers.innerHTML  = '';
        gainers.forEach(s => gapGainers.appendChild(createGapCard(s, true)));
        losers.forEach(s  => gapLosers.appendChild(createGapCard(s, false)));

        // Summary counts
        const totalG = gapAllGainers.length;
        const totalL = gapAllLosers.length;
        const nearG  = gapAllGainers.filter(s => s.near_resistance).length;
        const nearL  = gapAllLosers.filter(s => s.near_resistance).length;
        const brkG   = gapAllGainers.filter(s => s.broke_resistance).length;
        const brkL   = gapAllLosers.filter(s => s.broke_resistance).length;

        gapSummary.innerHTML =
            `<span class="gap-stat gap-up-stat">▲ ${totalG} Gainers</span>` +
            `<span class="gap-stat gap-dn-stat">▼ ${totalL} Losers</span>` +
            (nearG + nearL > 0 ? `<span class="gap-stat gap-near-stat">🎯 ${nearG + nearL} Near Resistance</span>` : '') +
            (brkG + brkL > 0 ? `<span class="gap-stat gap-break-stat">🚀 ${brkG + brkL} Breakouts</span>` : '');

        const shown = gainers.length + losers.length;
        const total = totalG + totalL;
        gapFilterInfo.textContent = (shown < total && total > 0)
            ? `Showing ${shown} of ${total} results`
            : '';
    }

    function startGapStream() {
        if (gapEvtSource) { gapEvtSource.close(); gapEvtSource = null; }

        gapScanRunning = true;
        gapLoadBtn.disabled = true;
        gapLoadBtn.textContent = 'Scanning...';
        gapStopBtn.classList.remove('hidden');
        gapRefreshBtn.classList.add('hidden');
        setGapScannerBusy(true);

        // Reset stored data
        gapAllGainers = [];
        gapAllLosers  = [];
        gapSectors    = new Set();
        gapSectorFilter.innerHTML = '<option value="">All Sectors</option>';
        gapNearResistanceActive = false;
        gapBreakoutActive = false;
        gapNearResistanceBtn.classList.remove('active');
        gapBreakoutBtn.classList.remove('active');

        // Reset display
        gapGainers.innerHTML = '';
        gapLosers.innerHTML  = '';
        gapSummary.innerHTML = '<span class="gap-stat">Scanning...</span>';
        gapFilterInfo.textContent = '';
        gapEmpty.classList.add('hidden');
        gapContent.classList.remove('hidden');
        gapProgressSection.classList.remove('hidden');
        gapProgressBar.style.width = '2%';
        showGapStatus('Starting gap scan (loading 1 month of data for resistance levels)...', 'info');

        const minGap = parseFloat(gapMinSlider.value);

        gapEvtSource = new EventSource(`/api/gap-scanner/stream?min_gap=${minGap}&limit=${GAP_MAX_CARDS}`);

        gapEvtSource.onmessage = (event) => {
            const data = JSON.parse(event.data);

            if (data.stage === 'init') {
                gapProgressMsg.textContent = data.message;
                showGapStatus(data.message, 'info');

            } else if (data.stage === 'progress') {
                const pct = data.total > 0 ? Math.round((data.processed / data.total) * 100) : 0;
                gapProgressBar.style.width = `${pct}%`;
                gapProgressMsg.textContent = data.message;
                showGapStatus(data.message, 'info');

            } else if (data.stage === 'stock') {
                const stock = data.stock;
                const isGainer = stock.change_pct > 0;

                if (isGainer) {
                    gapAllGainers.push(stock);
                } else {
                    gapAllLosers.push(stock);
                }

                // Update sector dropdown
                if (stock.sector && !gapSectors.has(stock.sector)) {
                    gapSectors.add(stock.sector);
                    const opt = document.createElement('option');
                    opt.value = stock.sector;
                    opt.textContent = stock.sector;
                    gapSectorFilter.appendChild(opt);
                }

                applyGapFilters();

            } else if (data.stage === 'done' || data.stage === 'error') {
                gapEvtSource.close();
                gapEvtSource = null;
                gapProgressBar.style.width = '100%';
                if (data.stage === 'done') {
                    showGapStatus(
                        `Scan complete — ${gapAllGainers.length} gapping up ≥${minGap}%, ${gapAllLosers.length} gapping down ≥${minGap}%`,
                        'ok'
                    );
                    gapRefreshBtn.classList.remove('hidden');
                } else {
                    showGapStatus(`Error: ${data.message}`, 'error');
                }
                resetGapScanner();
            }
        };

        gapEvtSource.onerror = () => {
            if (gapEvtSource) { gapEvtSource.close(); gapEvtSource = null; }
            showGapStatus('Connection lost.', 'error');
            resetGapScanner();
        };
    }

    function createGapCard(stock, isGainer) {
        const card = document.createElement('div');
        card.className = `gap-card ${isGainer ? 'gap-card-up' : 'gap-card-down'}`;
        if (stock.broke_resistance) card.classList.add('gap-card-breakout');
        else if (stock.near_resistance) card.classList.add('gap-card-near');

        const sign = stock.change_pct > 0 ? '+' : '';
        const vol  = stock.volume ? formatVolume(stock.volume) : '—';
        const rvol = stock.rvol != null ? stock.rvol.toFixed(1) + 'x' : '—';

        // Resistance badge
        let resBadge = '';
        if (stock.broke_resistance) {
            resBadge = `<span class="gap-badge gap-badge-breakout">BREAKOUT</span>`;
        } else if (stock.near_resistance && stock.pct_to_resistance != null) {
            resBadge = `<span class="gap-badge gap-badge-near">${stock.pct_to_resistance.toFixed(1)}% to roof</span>`;
        }

        // Resistance level text
        const resText = stock.resistance != null
            ? `<div class="gap-resistance">Resistance: $${stock.resistance.toFixed(2)}</div>`
            : '';

        card.innerHTML = `
            <div class="gap-card-left">
                <div class="gap-ticker-row">
                    <span class="gap-ticker">${escHtml(stock.ticker)}</span>
                    ${resBadge}
                </div>
                <div class="gap-name">${escHtml(stock.name || '')}</div>
                <div class="gap-sector">${escHtml(stock.sector || '')}</div>
                ${resText}
            </div>
            <div class="gap-card-right">
                <div class="gap-price">$${stock.price.toFixed(2)}</div>
                <div class="gap-change ${isGainer ? 'gap-change-up' : 'gap-change-down'}">${sign}${stock.change_pct.toFixed(2)}%</div>
                <div class="gap-volume">Vol: ${vol} &nbsp;|&nbsp; RVOL: ${rvol}</div>
            </div>
            <div class="gap-card-actions">
                <a href="/stock/${escHtml(stock.ticker)}" target="_blank" class="detail-btn">Financials</a>
                <button class="watchlist-add-inline-btn">+ Watch</button>
            </div>`;

        card.querySelector('.watchlist-add-inline-btn').addEventListener('click', (e) => {
            addToWatchlist(stock.ticker, stock.price);
            e.target.textContent = '✓';
            e.target.disabled = true;
        });

        return card;
    }

    function formatVolume(vol) {
        if (vol >= 1e9) return `${(vol / 1e9).toFixed(1)}B`;
        if (vol >= 1e6) return `${(vol / 1e6).toFixed(1)}M`;
        if (vol >= 1e3) return `${(vol / 1e3).toFixed(0)}K`;
        return vol.toString();
    }

    function showGapStatus(msg, type) {
        gapStatus.textContent = msg;
        gapStatus.className = `news-status news-status-${type}`;
        gapStatus.classList.remove('hidden');
    }

    // ══════════════════════════════════════════════════════════════════════
    // Watchlist Tab
    // ══════════════════════════════════════════════════════════════════════
    const WATCHLIST_KEY = 'stock_scanner_watchlist';
    let watchlistRefreshTimer = null;

    const watchlistTickerInput  = document.getElementById('watchlist-ticker-input');
    const watchlistTargetInput  = document.getElementById('watchlist-target-input');
    const watchlistNoteInput    = document.getElementById('watchlist-note-input');
    const watchlistAddBtn       = document.getElementById('watchlist-add-btn');
    const watchlistRefreshBtn   = document.getElementById('watchlist-refresh-btn');
    const watchlistFromScanBtn  = document.getElementById('watchlist-from-scan-btn');
    const watchlistEmpty        = document.getElementById('watchlist-empty');
    const watchlistContent      = document.getElementById('watchlist-content');
    const watchlistGrid         = document.getElementById('watchlist-grid');

    // Escape HTML to prevent XSS when inserting user data via innerHTML
    function escHtml(str) {
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function getWatchlist() {
        try { return JSON.parse(localStorage.getItem(WATCHLIST_KEY) || '[]'); } catch { return []; }
    }

    function saveWatchlist(list) {
        localStorage.setItem(WATCHLIST_KEY, JSON.stringify(list));
        const count = list.length;
        const dot = document.getElementById('watchlist-dot');
        if (count > 0) dot.classList.remove('hidden');
        else dot.classList.add('hidden');
    }

    function addToWatchlist(ticker, addedPrice) {
        ticker = ticker.toUpperCase().trim();
        const list = getWatchlist();
        if (list.find(w => w.ticker === ticker)) return;
        list.push({
            ticker,
            added_price: addedPrice || null,
            target_price: null,
            note: '',
            added_date: new Date().toISOString().split('T')[0],
        });
        saveWatchlist(list);
        renderWatchlist();
        document.getElementById('watchlist-dot').classList.remove('hidden');
    }

    watchlistAddBtn.addEventListener('click', () => {
        const ticker = watchlistTickerInput.value.trim().toUpperCase();
        if (!ticker) return;
        const target = parseFloat(watchlistTargetInput.value) || null;
        const note   = watchlistNoteInput.value.trim();

        const list = getWatchlist();
        const existing = list.find(w => w.ticker === ticker);
        if (existing) {
            if (target) existing.target_price = target;
            if (note)   existing.note = note;
        } else {
            list.push({
                ticker,
                added_price: null,
                target_price: target,
                note,
                added_date: new Date().toISOString().split('T')[0],
            });
        }
        saveWatchlist(list);
        watchlistTickerInput.value = '';
        watchlistTargetInput.value = '';
        watchlistNoteInput.value = '';
        renderWatchlist();
    });

    watchlistRefreshBtn.addEventListener('click', () => renderWatchlist(true));

    watchlistFromScanBtn.addEventListener('click', () => {
        if (allResults.length === 0) return;
        const top = allResults
            .filter(r => (r.patterns || []).some(p => BREAKOUT_SIGNALS[p]))
            .slice(0, 10);
        if (top.length === 0) allResults.slice(0, 10).forEach(r => addToWatchlist(r.ticker, r.current_price));
        else top.forEach(r => addToWatchlist(r.ticker, r.current_price));
        renderWatchlist();
    });

    async function renderWatchlist(fetchPrices = true) {
        const list = getWatchlist();
        if (list.length === 0) {
            watchlistEmpty.classList.remove('hidden');
            watchlistContent.classList.add('hidden');
            return;
        }
        watchlistEmpty.classList.add('hidden');
        watchlistContent.classList.remove('hidden');

        // Render skeleton first
        watchlistGrid.innerHTML = list.map(w => `
            <div class="wl-card" id="wl-${escHtml(w.ticker)}">
                <div class="wl-header">
                    <span class="wl-ticker">${escHtml(w.ticker)}</span>
                    <span class="wl-price loading-text">Loading...</span>
                </div>
                <div class="wl-change loading-text">—</div>
                ${w.target_price ? `<div class="wl-target">Target: $${parseFloat(w.target_price).toFixed(2)}</div>` : ''}
                ${w.note ? `<div class="wl-note">${escHtml(w.note)}</div>` : ''}
                <div class="wl-meta">Added ${escHtml(w.added_date)}${w.added_price ? ` · Entry $${parseFloat(w.added_price).toFixed(2)}` : ''}</div>
                <div class="wl-actions">
                    <button class="wl-remove-btn" data-ticker="${escHtml(w.ticker)}">Remove</button>
                </div>
            </div>`
        ).join('');

        // Wire remove buttons
        watchlistGrid.querySelectorAll('.wl-remove-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const ticker = btn.dataset.ticker;
                const list = getWatchlist().filter(w => w.ticker !== ticker);
                saveWatchlist(list);
                renderWatchlist();
            });
        });

        if (!fetchPrices) return;

        // Fetch live prices
        try {
            const tickers = list.map(w => w.ticker);
            const chunks = [];
            for (let i = 0; i < tickers.length; i += 30) chunks.push(tickers.slice(i, i + 30));

            let prices = {};
            for (const chunk of chunks) {
                const resp = await fetch('/api/stocks/live-prices', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ tickers: chunk }),
                });
                const data = await resp.json();
                prices = { ...prices, ...(data.prices || {}) };
            }

            list.forEach(w => {
                const card = document.getElementById(`wl-${w.ticker}`);
                if (!card) return;
                const p = prices[w.ticker];
                if (p) {
                    const sign = p.change_pct >= 0 ? '+' : '';
                    const changeClass = p.change_pct >= 0 ? 'wl-change-up' : 'wl-change-down';
                    card.querySelector('.wl-price').textContent = `$${p.price.toFixed(2)}`;
                    card.querySelector('.wl-price').classList.remove('loading-text');
                    card.querySelector('.wl-change').textContent = `${sign}${p.change}  (${sign}${p.change_pct}%)`;
                    card.querySelector('.wl-change').className = `wl-change ${changeClass}`;

                    // Target hit indicator
                    if (w.target_price && p.price >= w.target_price) {
                        card.classList.add('wl-target-hit');
                        const targetEl = card.querySelector('.wl-target');
                        if (targetEl) targetEl.textContent = `🎯 Target hit! $${parseFloat(w.target_price).toFixed(2)}`;
                    }

                    // P&L vs added price
                    if (w.added_price) {
                        const pnl = ((p.price - w.added_price) / w.added_price * 100).toFixed(2);
                        const pnlEl = card.querySelector('.wl-meta');
                        if (pnlEl) {
                            const pnlSign = pnl >= 0 ? '+' : '';
                            pnlEl.innerHTML = pnlEl.innerHTML +
                                ` · P&L: <span class="${pnl >= 0 ? 'positive' : 'negative'}">${pnlSign}${pnl}%</span>`;
                        }
                    }
                } else {
                    card.querySelector('.wl-price').textContent = 'N/A';
                    card.querySelector('.wl-price').classList.remove('loading-text');
                    card.querySelector('.wl-change').textContent = '—';
                    card.querySelector('.wl-change').classList.remove('loading-text');
                }
            });
        } catch (e) {
            console.warn('Watchlist price fetch failed:', e);
        }

        // Auto-refresh every 60s while watchlist tab is visible
        clearInterval(watchlistRefreshTimer);
        watchlistRefreshTimer = setInterval(() => {
            const activeTab = document.querySelector('.tab-btn.active');
            if (activeTab && activeTab.dataset.tab === 'watchlist') renderWatchlist(true);
        }, 60000);
    }

    // Init watchlist dot on load
    (() => {
        const list = getWatchlist();
        if (list.length > 0) document.getElementById('watchlist-dot').classList.remove('hidden');
    })();

    // ══════════════════════════════════════════════════════════════════════
    // Breaking News Tab
    // ══════════════════════════════════════════════════════════════════════
    const newsTickerInput = document.getElementById('news-ticker-input');
    const newsLoadBtn     = document.getElementById('news-load-btn');
    const newsScanBtn     = document.getElementById('news-scan-btn');
    const newsStatus      = document.getElementById('news-status');
    const newsCards       = document.getElementById('news-cards');
    const newsEmpty       = document.getElementById('news-empty');

    let newsRefreshTimer = null;

    newsLoadBtn.addEventListener('click', () => {
        const raw = newsTickerInput.value.trim();
        const tickers = raw ? raw.split(/[,\s]+/).map(t => t.toUpperCase()).filter(Boolean) : [];
        fetchNews(tickers);
    });

    newsScanBtn.addEventListener('click', () => {
        const scanTickers = allResults.slice(0, 15).map(r => r.ticker);
        if (scanTickers.length === 0) {
            showNewsStatus('No scan results yet — run a scan first.', 'warn');
            return;
        }
        newsTickerInput.value = scanTickers.join(', ');
        fetchNews(scanTickers);
    });

    async function fetchNews(tickers = []) {
        newsLoadBtn.disabled = true;
        newsLoadBtn.textContent = 'Loading...';
        showNewsStatus('Fetching news...', 'info');

        const param = tickers.length ? `?tickers=${tickers.join(',')}` : '';
        try {
            const resp = await fetch(`/api/news${param}`);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const data = await resp.json();
            renderNews(data.news || []);
            showNewsStatus(`Loaded ${(data.news || []).length} articles · auto-refreshes every 5 min`, 'ok');
            clearInterval(newsRefreshTimer);
            newsRefreshTimer = setInterval(() => fetchNews(tickers), 5 * 60 * 1000);
        } catch (e) {
            showNewsStatus(`Error: ${e.message}`, 'error');
        } finally {
            newsLoadBtn.disabled = false;
            newsLoadBtn.textContent = 'Load News';
        }
    }

    function renderNews(items) {
        if (!items.length) {
            newsCards.classList.add('hidden');
            newsEmpty.classList.remove('hidden');
            return;
        }
        newsEmpty.classList.add('hidden');
        newsCards.classList.remove('hidden');
        newsCards.innerHTML = '';

        const premarket = items.filter(n => n.is_premarket);
        const rest      = items.filter(n => !n.is_premarket);

        if (premarket.length) {
            const header = document.createElement('div');
            header.className = 'news-section-header premarket-header';
            header.innerHTML = '<span class="premarket-badge-big">PRE-MARKET</span> Breaking Before The Bell';
            newsCards.appendChild(header);
            premarket.forEach(n => newsCards.appendChild(createNewsCard(n, true)));
            const divider = document.createElement('div');
            divider.className = 'news-section-header';
            divider.textContent = 'Recent Market News';
            newsCards.appendChild(divider);
        }
        rest.forEach(n => newsCards.appendChild(createNewsCard(n, false)));
    }

    function createNewsCard(item, isPremarket) {
        const card = document.createElement('div');
        card.className = `news-card${isPremarket ? ' news-premarket' : ''}`;

        const tickers = [...new Set([item.source_ticker, ...(item.related_tickers || [])])].slice(0, 5);
        const tagsHtml = tickers.map(t => `<span class="news-ticker-tag">${t}</span>`).join('');
        const thumbHtml = item.thumbnail ? `<img class="news-thumb" src="${item.thumbnail}" alt="" loading="lazy">` : '';

        card.innerHTML = `
            <div class="news-card-inner">
                ${thumbHtml}
                <div class="news-card-body">
                    <div class="news-meta">
                        ${isPremarket ? '<span class="premarket-badge">PRE-MARKET</span>' : ''}
                        <span class="news-time">${item.time_label}</span>
                        <span class="news-publisher">${item.publisher}</span>
                    </div>
                    <a href="${item.link}" target="_blank" rel="noopener" class="news-title">${item.title}</a>
                    <div class="news-tags">${tagsHtml}</div>
                </div>
            </div>`;
        return card;
    }

    function showNewsStatus(msg, type) {
        newsStatus.textContent = msg;
        newsStatus.className = `news-status news-status-${type}`;
        newsStatus.classList.remove('hidden');
    }
});
