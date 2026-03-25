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
        });
    });

    // ──────────────────────────────────────────────────────────────────────
    // Breaking News Tab
    // ──────────────────────────────────────────────────────────────────────
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
        // Use tickers from scan results
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

            const count = (data.news || []).length;
            showNewsStatus(`Loaded ${count} articles · auto-refreshes every 5 min`, 'ok');

            // Auto-refresh every 5 minutes
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

        // Group pre-market first
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

        // Ticker tags
        const tickers = [...new Set([item.source_ticker, ...(item.related_tickers || [])])].slice(0, 5);
        const tagsHtml = tickers.map(t =>
            `<span class="news-ticker-tag">${t}</span>`
        ).join('');

        // Thumbnail
        const thumbHtml = item.thumbnail
            ? `<img class="news-thumb" src="${item.thumbnail}" alt="" loading="lazy">`
            : '';

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

    // ──────────────────────────────────────────────────────────────────────
    // Scanner Tab (existing logic below)
    // ──────────────────────────────────────────────────────────────────────
    const thresholdSlider = document.getElementById('threshold');
    const thresholdValue = document.getElementById('threshold-value');
    const scanBtn = document.getElementById('scan-btn');
    const progressSection = document.getElementById('progress');
    const progressBar = document.getElementById('progress-bar');
    const progressMessage = document.getElementById('progress-message');
    const resultsSection = document.getElementById('results');
    const resultsSummary = document.getElementById('results-summary');
    const filterInput = document.getElementById('filter-input');
    const signalsFilterBtn = document.getElementById('signals-filter-btn');

    const smaPeriodSelect = document.getElementById('sma-period');

    let allResults = [];
    let currentSort = { column: null, direction: 'asc' };
    let currentSmaPeriod = 150;
    let tableInitialized = false;
    let streamingFiscalYears = [];
    let userSorted = false;  // track if user clicked a sort header
    let signalsFilterActive = false;

    // Pre-breakout fire signals — shown in orange with explanations
    const BREAKOUT_SIGNALS = {
        'BB Squeeze':    'Bollinger Band squeeze: volatility is contracting — a big move is loading',
        'Volume Surge':  'Volume 2×+ above average: unusual accumulation, smart money may be entering',
        'Tight Base':    'Tight consolidation (<3% range over 10 days): coiled spring before a breakout',
        'Near 52W High': 'Within 5% of 52-week high: strong momentum, potential breakout to new highs',
        'MACD Cross':    'MACD bullish crossover: momentum shifted to the upside',
        'RS Leader':     'Outperforming S&P 500 over the last 3 months: market leader',
    };
    // Classic candle/chart patterns — shown in green
    const CLASSIC_PATTERNS = {
        'Golden Cross':      '50-day SMA crossed above 200-day SMA in the last 10 days',
        'Bullish Engulfing': 'Large green candle fully engulfed the previous red candle',
        'Hammer':            'Long lower wick with small body — reversal signal after a decline',
        'Morning Star':      '3-candle reversal pattern: red → small doji → strong green',
        'Double Bottom':     'Price bounced twice from the same support level',
        'Cup & Handle':      'Rounded base followed by a small consolidation — classic breakout setup',
    };

    const financialMetrics = [
        { key: 'revenue', label: 'Revenue' },
        { key: 'net_income', label: 'Net Income' },
        { key: 'free_cash_flow', label: 'FCF' },
        { key: 'profit_margin', label: 'Margin (%)' },
        { key: 'total_assets', label: 'Assets' },
        { key: 'total_liabilities', label: 'Liabilities' },
        { key: 'shares_outstanding', label: 'Shares Out' },
    ];

    const baseColumns = () => [
        { key: '_position', label: 'Position' },
        { key: 'ticker', label: 'Ticker' },
        { key: 'name', label: 'Company' },
        { key: 'sector', label: 'Sector' },
        { key: 'current_price', label: 'Price ($)' },
        { key: 'sma_value', label: `SMA ${currentSmaPeriod} ($)` },
        { key: 'distance_pct', label: 'Distance (%)' },
        { key: '_patterns', label: 'Patterns' },
        { key: '_action', label: '' },
    ];

    // Threshold slider
    thresholdSlider.addEventListener('input', () => {
        thresholdValue.textContent = `${parseFloat(thresholdSlider.value).toFixed(1)}%`;
    });

    // Start scan
    scanBtn.addEventListener('click', async () => {
        scanBtn.disabled = true;
        scanBtn.textContent = 'Scanning...';
        progressSection.classList.remove('hidden');
        resultsSection.classList.add('hidden');
        progressBar.style.width = '0%';
        progressMessage.textContent = 'Starting scan...';

        // Reset state for new scan
        allResults = [];
        tableInitialized = false;
        streamingFiscalYears = [];
        userSorted = false;
        currentSort = { column: null, direction: 'asc' };

        const threshold = parseFloat(thresholdSlider.value);
        currentSmaPeriod = parseInt(smaPeriodSelect.value);

        try {
            const response = await fetch('/api/scan', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ threshold, sma_period: currentSmaPeriod })
            });

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
    }

    function listenForProgress() {
        const evtSource = new EventSource('/api/scan/progress');

        evtSource.onmessage = (event) => {
            const data = JSON.parse(event.data);
            progressMessage.textContent = data.message;

            // Progress bar
            let pct = 0;
            if (data.stage === 'init') pct = 5;
            else if (data.stage === 'download') pct = 10 + (data.total > 0 ? (data.current / data.total) * 20 : 0);
            else if (data.stage === 'sma_calc') pct = 30 + (data.total > 0 ? (data.current / data.total) * 30 : 0);
            else if (data.stage === 'financials' || data.stage === 'stock_ready') {
                pct = 60 + (data.total > 0 ? (data.current / data.total) * 35 : 0);
            }
            else if (data.stage === 'done') pct = 100;
            progressBar.style.width = `${pct}%`;

            // Handle incoming stock data — add row to table immediately
            if (data.stage === 'stock_ready' && data.stock) {
                allResults.push(data.stock);
                addStockToTable(data.stock);
                updateSummary();
            }

            if (data.stage === 'done' || data.stage === 'error') {
                evtSource.close();
                resetScanBtn();

                // Show a dot on the News tab so user knows scan results are ready
                if (data.stage === 'done' && allResults.length > 0) {
                    document.getElementById('news-dot').classList.remove('hidden');
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

    // Fallback: fetch all results at once (used on connection error)
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
        resultsSummary.textContent = `Found ${allResults.length} stocks near their ${currentSmaPeriod}-day SMA (${aboveCount} above, ${belowCount} below)`;
    }

    // Initialize table header on first stock arrival
    function initTableIfNeeded(stock) {
        if (tableInitialized) return;
        tableInitialized = true;

        resultsSection.classList.remove('hidden');
        document.querySelector('.table-controls').classList.remove('hidden');

        // Determine fiscal years from first stock
        streamingFiscalYears = (stock.financials && stock.financials.length > 0)
            ? stock.financials.map(f => f.fiscal_year)
            : [];

        const table = document.getElementById('results-table');
        const thead = table.querySelector('thead');
        const tbody = table.querySelector('tbody');
        thead.innerHTML = '';
        tbody.innerHTML = '';

        const cols = baseColumns();

        // Row 1: Year group headers
        const groupRow = document.createElement('tr');
        const baseGroupTh = document.createElement('th');
        baseGroupTh.colSpan = cols.length;
        baseGroupTh.className = 'year-group';
        baseGroupTh.textContent = 'Stock Info';
        groupRow.appendChild(baseGroupTh);

        streamingFiscalYears.forEach(year => {
            const th = document.createElement('th');
            th.colSpan = financialMetrics.length;
            th.className = 'year-group';
            th.textContent = `FY ${year}`;
            groupRow.appendChild(th);
        });

        if (streamingFiscalYears.length >= 2) {
            const trendTh = document.createElement('th');
            trendTh.colSpan = financialMetrics.length;
            trendTh.className = 'year-group trend-group';
            trendTh.textContent = '3Y Trend';
            groupRow.appendChild(trendTh);
        }
        thead.appendChild(groupRow);

        // Row 2: Sortable column headers
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

        streamingFiscalYears.forEach((year, yearIdx) => {
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

        if (streamingFiscalYears.length >= 2) {
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

    // Add a single stock row to the table (called as each stock streams in)
    function addStockToTable(stock) {
        initTableIfNeeded(stock);

        // If user has sorted, rebuild the whole table in sorted order
        if (userSorted && currentSort.column) {
            rebuildSorted(allResults, streamingFiscalYears);
            return;
        }

        const tbody = document.getElementById('results-table').querySelector('tbody');
        const tr = createStockRow(stock, streamingFiscalYears);

        // Flash animation for new row
        tr.classList.add('row-new');
        tbody.appendChild(tr);
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                tr.classList.remove('row-new');
            });
        });
    }

    // Create a single <tr> for a stock
    function createStockRow(stock, fiscalYears) {
        const tr = document.createElement('tr');

        // Position (Above / Below SMA)
        const tdPos = document.createElement('td');
        const isAbove = stock.distance_pct >= 0;
        tdPos.textContent = isAbove ? '\u25B2 Above' : '\u25BC Below';
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

        // Patterns — fire signals (orange) first, then classic patterns (green)
        const tdPatterns = document.createElement('td');
        const patterns = stock.patterns || [];
        if (patterns.length > 0) {
            // Sort: breakout signals first
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
                if (tooltip) {
                    badge.title = tooltip;
                    badge.classList.add('has-tooltip');
                }
                tdPatterns.appendChild(badge);
            });
        } else {
            tdPatterns.textContent = '—';
            tdPatterns.className = 'no-pattern';
        }
        tr.appendChild(tdPatterns);

        // Financials button
        const tdAction = document.createElement('td');
        const btn = document.createElement('a');
        btn.href = `/stock/${stock.ticker}`;
        btn.target = '_blank';
        btn.className = 'detail-btn';
        btn.textContent = 'Financials';
        tdAction.appendChild(btn);
        tr.appendChild(tdAction);

        // Financial data for each year
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

                if (val === null || val === undefined) {
                    td.style.color = '#bbb';
                }
                tr.appendChild(td);
            });
        });

        // Trend summary cells
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

                    const arrow = isImproving ? '\u25B2' : '\u25BC';
                    const sign = changePct > 0 ? '+' : '';
                    td.textContent = `${arrow} ${sign}${changePct.toFixed(1)}%`;
                    td.className = `trend-cell ${isImproving ? 'trend-up' : 'trend-down'}`;
                }
                tr.appendChild(td);
            });
        }

        return tr;
    }

    // Full table rebuild (used for sorting/filtering after scan completes)
    function buildFullTable(data) {
        const table = document.getElementById('results-table');
        const thead = table.querySelector('thead');
        const tbody = table.querySelector('tbody');

        resultsSection.classList.remove('hidden');
        document.querySelector('.table-controls').classList.remove('hidden');

        const fiscalYears = (data.length > 0 && data[0].financials)
            ? data[0].financials.map(f => f.fiscal_year)
            : [];

        const cols = baseColumns();

        // Build header
        thead.innerHTML = '';

        // Row 1: Year group headers
        const groupRow = document.createElement('tr');
        const baseGroupTh = document.createElement('th');
        baseGroupTh.colSpan = cols.length;
        baseGroupTh.className = 'year-group';
        baseGroupTh.textContent = 'Stock Info';
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

        // Row 2: Sortable column headers
        const headerRow = document.createElement('tr');

        cols.forEach(col => {
            const th = document.createElement('th');
            if (col.key === '_action') {
                th.textContent = '';
                th.style.cursor = 'default';
            } else {
                const sortKey = col.key;
                th.innerHTML = `${col.label}<span class="sort-arrow">${getSortArrow(sortKey)}</span>`;
                if (currentSort.column === sortKey) th.classList.add('sorted');
                th.addEventListener('click', () => {
                    userSorted = true;
                    sortTable(sortKey, allResults, fiscalYears);
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
                    sortTable(key, allResults, fiscalYears);
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
                    sortTable(key, allResults, fiscalYears);
                });
                headerRow.appendChild(th);
            });
        }

        thead.appendChild(headerRow);

        // Build body
        tbody.innerHTML = '';
        data.forEach(stock => {
            tbody.appendChild(createStockRow(stock, fiscalYears));
        });

        updateSummary();
    }

    function formatLargeNumber(value) {
        if (value === null || value === undefined) return 'N/A';
        const abs = Math.abs(value);
        const sign = value < 0 ? '-' : '';
        if (abs >= 1e12) return `${sign}$${(abs / 1e12).toFixed(1)}T`;
        if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(1)}B`;
        if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(0)}M`;
        if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(0)}K`;
        return `${sign}$${abs.toFixed(0)}`;
    }

    function formatShares(value) {
        if (value === null || value === undefined) return 'N/A';
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
        if (currentSort.column !== key) return ' \u2195';
        return currentSort.direction === 'asc' ? ' \u2191' : ' \u2193';
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

    // Apply the current sort and rebuild the table (without toggling direction)
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
                return currentSort.direction === 'asc'
                    ? valA.localeCompare(valB)
                    : valB.localeCompare(valA);
            }

            return currentSort.direction === 'asc' ? valA - valB : valB - valA;
        });

        buildFullTable(sorted);
    }

    function applyFilters() {
        const query = filterInput.value.toLowerCase();
        let filtered = allResults;

        if (signalsFilterActive) {
            filtered = filtered.filter(r =>
                (r.patterns || []).some(p => BREAKOUT_SIGNALS[p])
            );
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

    // Text filter
    filterInput.addEventListener('input', applyFilters);

    // Signals-only toggle
    signalsFilterBtn.addEventListener('click', () => {
        signalsFilterActive = !signalsFilterActive;
        signalsFilterBtn.classList.toggle('active', signalsFilterActive);
        signalsFilterBtn.textContent = signalsFilterActive
            ? '🔥 Showing Breakout Signals Only'
            : '🔥 Breakout Signals Only';
        applyFilters();
    });
});
