document.addEventListener('DOMContentLoaded', async () => {
    const loading = document.getElementById('loading');
    const content = document.getElementById('content');

    try {
        const response = await fetch(`/api/stock/${TICKER}/financials`);
        const data = await response.json();

        if (data.error) {
            loading.textContent = `Error loading data: ${data.error}`;
            return;
        }

        if (!data.years || data.years.length === 0) {
            loading.textContent = 'No financial data available for this stock.';
            return;
        }

        loading.classList.add('hidden');
        content.classList.remove('hidden');

        // Years are most recent first from the API, reverse for chronological display
        const years = [...data.years].reverse();
        const labels = years.map(y => `FY ${y.fiscal_year}`);

        renderHealthSummary(years, data);
        renderPatterns(data.patterns || []);
        renderCharts(years, labels);
        renderDataTable(years);

    } catch (e) {
        loading.textContent = `Failed to load data: ${e.message}`;
    }
});

function renderHealthSummary(years, data) {
    const grid = document.getElementById('health-grid');
    const newest = years[years.length - 1];
    const oldest = years[0];

    const metrics = [
        {
            label: 'P/E Ratio',
            check: () => {
                if (data.trailing_pe == null) return null;
                return data.trailing_pe > 0 && data.trailing_pe < 20;
            },
            goodText: 'Under 20 - Value',
            badText: data.trailing_pe != null && data.trailing_pe < 0 ? 'Negative Earnings' : 'Above 20 - Premium',
            detail: () => {
                const parts = [];
                if (data.trailing_pe != null) parts.push(`Trailing: ${data.trailing_pe.toFixed(1)}`);
                if (data.forward_pe != null) parts.push(`Forward: ${data.forward_pe.toFixed(1)}`);
                return parts.join(' | ') || '';
            }
        },
        {
            label: 'EPS',
            check: () => {
                if (newest.eps == null || oldest.eps == null) return null;
                return newest.eps > oldest.eps;
            },
            goodText: 'Growing',
            badText: 'Declining',
            detail: () => {
                const parts = [];
                if (data.trailing_eps != null) parts.push(`Trailing: $${data.trailing_eps.toFixed(2)}`);
                if (newest.eps != null && oldest.eps != null && oldest.eps !== 0) {
                    const pct = ((newest.eps - oldest.eps) / Math.abs(oldest.eps) * 100).toFixed(1);
                    parts.push(`${pct > 0 ? '+' : ''}${pct}% over 3 years`);
                }
                return parts.join(' | ') || '';
            }
        },
        {
            label: 'Revenue',
            check: () => {
                if (newest.revenue == null || oldest.revenue == null) return null;
                return newest.revenue > oldest.revenue;
            },
            goodText: 'Growing',
            badText: 'Declining',
            detail: () => {
                if (newest.revenue == null || oldest.revenue == null || oldest.revenue === 0) return '';
                const pct = ((newest.revenue - oldest.revenue) / Math.abs(oldest.revenue) * 100).toFixed(1);
                return `${pct > 0 ? '+' : ''}${pct}% over 3 years`;
            }
        },
        {
            label: 'Net Income',
            check: () => {
                if (newest.net_income == null || oldest.net_income == null) return null;
                return newest.net_income > oldest.net_income;
            },
            goodText: 'Growing',
            badText: 'Declining',
            detail: () => {
                if (newest.net_income == null || oldest.net_income == null || oldest.net_income === 0) return '';
                const pct = ((newest.net_income - oldest.net_income) / Math.abs(oldest.net_income) * 100).toFixed(1);
                return `${pct > 0 ? '+' : ''}${pct}% over 3 years`;
            }
        },
        {
            label: 'Profit Margin',
            check: () => {
                if (newest.profit_margin == null || oldest.profit_margin == null) return null;
                return newest.profit_margin > oldest.profit_margin;
            },
            goodText: 'Expanding',
            badText: 'Contracting',
            detail: () => {
                if (newest.profit_margin == null || oldest.profit_margin == null) return '';
                const diff = (newest.profit_margin - oldest.profit_margin).toFixed(1);
                return `${diff > 0 ? '+' : ''}${diff}pp change`;
            }
        },
        {
            label: 'Free Cash Flow',
            check: () => {
                if (newest.free_cash_flow == null || oldest.free_cash_flow == null) return null;
                return newest.free_cash_flow > oldest.free_cash_flow;
            },
            goodText: 'Growing',
            badText: 'Declining',
            detail: () => {
                if (newest.free_cash_flow == null || oldest.free_cash_flow == null || oldest.free_cash_flow === 0) return '';
                const pct = ((newest.free_cash_flow - oldest.free_cash_flow) / Math.abs(oldest.free_cash_flow) * 100).toFixed(1);
                return `${pct > 0 ? '+' : ''}${pct}% over 3 years`;
            }
        },
        {
            label: 'Assets > Liabilities',
            check: () => {
                if (newest.total_assets == null || newest.total_liabilities == null) return null;
                return newest.total_assets > newest.total_liabilities;
            },
            goodText: 'Yes - Healthy',
            badText: 'No - Overleveraged',
            detail: () => {
                if (newest.total_assets == null || newest.total_liabilities == null) return '';
                const ratio = (newest.total_assets / newest.total_liabilities).toFixed(2);
                return `Asset/Liability ratio: ${ratio}x`;
            }
        },
        {
            label: 'Shares Outstanding',
            check: () => {
                if (newest.shares_outstanding == null || oldest.shares_outstanding == null) return null;
                return newest.shares_outstanding < oldest.shares_outstanding;
            },
            goodText: 'Decreasing (Buybacks)',
            badText: 'Increasing (Dilution)',
            detail: () => {
                if (newest.shares_outstanding == null || oldest.shares_outstanding == null || oldest.shares_outstanding === 0) return '';
                const pct = ((newest.shares_outstanding - oldest.shares_outstanding) / Math.abs(oldest.shares_outstanding) * 100).toFixed(1);
                return `${pct > 0 ? '+' : ''}${pct}% over 3 years`;
            }
        }
    ];

    metrics.forEach(m => {
        const result = m.check();
        const card = document.createElement('div');
        card.className = `health-card ${result === null ? 'health-na' : result ? 'health-good' : 'health-bad'}`;

        const icon = result === null ? '?' : result ? '\u2713' : '\u2717';
        const status = result === null ? 'N/A' : result ? m.goodText : m.badText;
        const detail = m.detail();

        card.innerHTML = `
            <div class="health-icon">${icon}</div>
            <div class="health-label">${m.label}</div>
            <div class="health-status">${status}</div>
            <div class="health-detail">${detail}</div>
        `;
        grid.appendChild(card);
    });
}

function renderPatterns(patterns) {
    const section = document.getElementById('patterns-section');
    const grid = document.getElementById('patterns-grid');

    const patternDescriptions = {
        'Golden Cross': {
            icon: '\u2728',
            desc: 'The 50-day SMA recently crossed above the 200-day SMA, a classic long-term bullish signal indicating the trend may be shifting upward.'
        },
        'Bullish Engulfing': {
            icon: '\uD83D\uDD25',
            desc: 'A large green candle fully engulfed the previous red candle, suggesting buyers have overwhelmed sellers and a reversal may be underway.'
        },
        'Hammer': {
            icon: '\uD83D\uDD28',
            desc: 'A candle with a long lower wick and small body appeared after a decline, indicating sellers pushed the price down but buyers fought back strongly.'
        },
        'Morning Star': {
            icon: '\u2B50',
            desc: 'A 3-candle reversal pattern: a large red candle, followed by a small indecision candle, then a strong green candle — signaling a potential bottom.'
        },
        'Double Bottom': {
            icon: '\u0057',
            desc: 'The price hit a similar support level twice and bounced back, forming a W-shape. This suggests strong support and a potential upward breakout.'
        },
        'Cup & Handle': {
            icon: '\u2615',
            desc: 'A U-shaped recovery (cup) followed by a small pullback (handle), then a breakout above the rim. This is a classic continuation pattern signaling further upside.'
        }
    };

    if (patterns.length === 0) {
        section.classList.remove('hidden');
        grid.innerHTML = '<p class="no-patterns-msg">No bullish chart patterns detected in recent price action.</p>';
        return;
    }

    section.classList.remove('hidden');

    patterns.forEach(name => {
        const info = patternDescriptions[name] || { icon: '\u2713', desc: '' };
        const card = document.createElement('div');
        card.className = 'pattern-card';
        card.innerHTML = `
            <div class="pattern-icon">${info.icon}</div>
            <div class="pattern-name">${name}</div>
            <div class="pattern-desc">${info.desc}</div>
        `;
        grid.appendChild(card);
    });
}

function renderCharts(years, labels) {
    const chartColors = {
        blue: 'rgba(67, 97, 238, 0.8)',
        green: 'rgba(46, 125, 50, 0.8)',
        red: 'rgba(198, 40, 40, 0.8)',
        purple: 'rgba(124, 58, 237, 0.8)',
        orange: 'rgba(230, 126, 34, 0.8)',
    };

    const defaultOpts = {
        responsive: true,
        maintainAspectRatio: true,
        plugins: {
            legend: { display: false },
            tooltip: {
                callbacks: {
                    label: (ctx) => formatLargeNumber(ctx.raw)
                }
            }
        },
        scales: {
            y: {
                ticks: {
                    callback: (v) => formatLargeNumber(v)
                }
            }
        }
    };

    // Revenue
    new Chart(document.getElementById('chart-revenue'), {
        type: 'bar',
        data: {
            labels,
            datasets: [{
                data: years.map(y => y.revenue),
                backgroundColor: chartColors.blue
            }]
        },
        options: defaultOpts
    });

    // Net Income
    new Chart(document.getElementById('chart-net-income'), {
        type: 'bar',
        data: {
            labels,
            datasets: [{
                data: years.map(y => y.net_income),
                backgroundColor: years.map(y => y.net_income >= 0 ? chartColors.green : chartColors.red)
            }]
        },
        options: defaultOpts
    });

    // FCF
    new Chart(document.getElementById('chart-fcf'), {
        type: 'bar',
        data: {
            labels,
            datasets: [{
                data: years.map(y => y.free_cash_flow),
                backgroundColor: years.map(y => y.free_cash_flow >= 0 ? chartColors.green : chartColors.red)
            }]
        },
        options: defaultOpts
    });

    // Profit Margin
    new Chart(document.getElementById('chart-margin'), {
        type: 'bar',
        data: {
            labels,
            datasets: [{
                data: years.map(y => y.profit_margin),
                backgroundColor: chartColors.purple
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: true,
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        label: (ctx) => `${ctx.raw?.toFixed(1)}%`
                    }
                }
            },
            scales: {
                y: {
                    ticks: {
                        callback: (v) => `${v}%`
                    }
                }
            }
        }
    });

    // Assets vs Liabilities
    new Chart(document.getElementById('chart-balance'), {
        type: 'bar',
        data: {
            labels,
            datasets: [
                {
                    label: 'Assets',
                    data: years.map(y => y.total_assets),
                    backgroundColor: chartColors.green
                },
                {
                    label: 'Liabilities',
                    data: years.map(y => y.total_liabilities),
                    backgroundColor: chartColors.red
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: true,
            plugins: {
                legend: { display: true, position: 'top' },
                tooltip: {
                    callbacks: {
                        label: (ctx) => `${ctx.dataset.label}: ${formatLargeNumber(ctx.raw)}`
                    }
                }
            },
            scales: {
                y: {
                    ticks: {
                        callback: (v) => formatLargeNumber(v)
                    }
                }
            }
        }
    });

    // Shares Outstanding
    new Chart(document.getElementById('chart-shares'), {
        type: 'bar',
        data: {
            labels,
            datasets: [{
                data: years.map(y => y.shares_outstanding),
                backgroundColor: chartColors.orange
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: true,
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        label: (ctx) => formatShares(ctx.raw)
                    }
                }
            },
            scales: {
                y: {
                    ticks: {
                        callback: (v) => formatShares(v)
                    }
                }
            }
        }
    });

    // EPS
    new Chart(document.getElementById('chart-eps'), {
        type: 'bar',
        data: {
            labels,
            datasets: [{
                data: years.map(y => y.eps),
                backgroundColor: years.map(y => y.eps != null && y.eps >= 0 ? chartColors.green : chartColors.red)
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: true,
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        label: (ctx) => ctx.raw != null ? `$${ctx.raw.toFixed(2)}` : 'N/A'
                    }
                }
            },
            scales: {
                y: {
                    ticks: {
                        callback: (v) => `$${v.toFixed(2)}`
                    }
                }
            }
        }
    });
}

function renderDataTable(years) {
    const table = document.getElementById('data-table');
    const thead = table.querySelector('thead');
    const tbody = table.querySelector('tbody');

    // Header
    const headerRow = document.createElement('tr');
    const metricTh = document.createElement('th');
    metricTh.textContent = 'Metric';
    metricTh.style.textAlign = 'left';
    headerRow.appendChild(metricTh);

    years.forEach(y => {
        const th = document.createElement('th');
        th.textContent = `FY ${y.fiscal_year}`;
        headerRow.appendChild(th);
    });

    const trendTh = document.createElement('th');
    trendTh.textContent = 'Trend';
    trendTh.className = 'trend-header';
    headerRow.appendChild(trendTh);

    thead.appendChild(headerRow);

    // Rows
    const metrics = [
        { key: 'revenue', label: 'Revenue', format: formatLargeNumber, higherBetter: true },
        { key: 'net_income', label: 'Net Income', format: formatLargeNumber, higherBetter: true },
        { key: 'eps', label: 'EPS', format: v => v != null ? `$${v.toFixed(2)}` : 'N/A', higherBetter: true },
        { key: 'free_cash_flow', label: 'Free Cash Flow', format: formatLargeNumber, higherBetter: true },
        { key: 'profit_margin', label: 'Profit Margin', format: v => v != null ? `${v.toFixed(1)}%` : 'N/A', higherBetter: true },
        { key: 'total_assets', label: 'Total Assets', format: formatLargeNumber, higherBetter: true },
        { key: 'total_liabilities', label: 'Total Liabilities', format: formatLargeNumber, higherBetter: false },
        { key: 'shares_outstanding', label: 'Shares Outstanding', format: formatShares, higherBetter: false },
    ];

    metrics.forEach(m => {
        const tr = document.createElement('tr');
        const labelTd = document.createElement('td');
        labelTd.textContent = m.label;
        labelTd.style.textAlign = 'left';
        labelTd.style.fontWeight = '600';
        tr.appendChild(labelTd);

        years.forEach(y => {
            const td = document.createElement('td');
            const val = y[m.key];
            td.textContent = val != null ? m.format(val) : 'N/A';
            if (val == null) td.style.color = '#bbb';
            tr.appendChild(td);
        });

        // Trend cell
        const trendTd = document.createElement('td');
        const newest = years[years.length - 1][m.key];
        const oldest = years[0][m.key];

        if (newest != null && oldest != null && oldest !== 0) {
            const changePct = ((newest - oldest) / Math.abs(oldest) * 100).toFixed(1);
            const isImproving = m.higherBetter ? changePct > 0 : changePct < 0;
            const arrow = isImproving ? '\u25B2' : '\u25BC';
            trendTd.textContent = `${arrow} ${changePct > 0 ? '+' : ''}${changePct}%`;
            trendTd.className = isImproving ? 'trend-up' : 'trend-down';
            trendTd.style.fontWeight = '700';
        } else {
            trendTd.textContent = 'N/A';
            trendTd.style.color = '#bbb';
        }
        tr.appendChild(trendTd);

        tbody.appendChild(tr);
    });
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
