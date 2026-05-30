'use strict';

// ════════════════════════════════════════════════════════
// CONSTANTS & CONFIGURATION
// ════════════════════════════════════════════════════════

const MODEL_PRICING = {
  'claude-opus':    { input: 0.015,    output: 0.075,   label: 'Claude Opus',    tier: 'premium'   },
  'claude-sonnet':  { input: 0.003,    output: 0.015,   label: 'Claude Sonnet',  tier: 'standard'  },
  'claude-haiku':   { input: 0.00025,  output: 0.00125, label: 'Claude Haiku',   tier: 'efficient' },
  'gpt-4o':         { input: 0.005,    output: 0.015,   label: 'GPT-4o',         tier: 'premium'   },
  'gpt-4o-mini':    { input: 0.00015,  output: 0.0006,  label: 'GPT-4o Mini',    tier: 'efficient' },
};

const USE_CASES = {
  'support-copilot': {
    label:          'Support Copilot',
    icon:           '💬',
    color:          '#6366f1',
    defaultModel:   'claude-haiku',
    inputRange:     [140, 310],
    outputRange:    [55, 130],
    cacheRate:      0.42,
    rateWeight:     12,
    owner:          'team-support',
    budget:         'support-ops',
    complexityRange:[0.08, 0.42],
  },
  'doc-summarizer': {
    label:          'Document Summarizer',
    icon:           '📄',
    color:          '#8b5cf6',
    defaultModel:   'claude-sonnet',
    inputRange:     [680, 1300],
    outputRange:    [180, 360],
    cacheRate:      0.18,
    rateWeight:     7,
    owner:          'team-docs',
    budget:         'content-ops',
    complexityRange:[0.30, 0.72],
  },
  'proposal-assistant': {
    label:          'Proposal Assistant',
    icon:           '📋',
    color:          '#ec4899',
    defaultModel:   'claude-sonnet',
    inputRange:     [380, 720],
    outputRange:    [550, 1100],
    cacheRate:      0.09,
    rateWeight:     4,
    owner:          'team-sales',
    budget:         'sales-enablement',
    complexityRange:[0.50, 0.92],
  },
};

const THRESHOLDS = {
  promptBloat:    2100,   // input tokens above which a doc-summarizer req is bloated
  bloatTrigger:   3,      // consecutive bloated requests before agent fires
  premiumTrigger: 5,      // consecutive premium-on-simple reqs before agent fires
  retryBreaker:   3,      // retries before circuit breaker engages
  maxTableRows:   22,
  maxAgentEntries:25,
};

// ════════════════════════════════════════════════════════
// STATE
// ════════════════════════════════════════════════════════

const S = {
  requests:       [],
  interventions:  [],
  metrics: {
    totalSpend:   0,
    totalReqs:    0,
    cacheHits:    0,
    anomalies:    0,
    savings:      0,
    spendByUC:    {},
    spendByModel: {},
    reqsByUC:     {},
  },
  scenarios: {
    bloatActive:    false,
    premiumActive:  false,
    retryActive:    false,
  },
  requestSeq:     1,
  lastMinReqs:    [],
  simTimer:       null,
  startTime:      Date.now(),
};

Object.keys(USE_CASES).forEach(id => {
  S.metrics.spendByUC[id]  = 0;
  S.metrics.reqsByUC[id]   = 0;
});

// ════════════════════════════════════════════════════════
// UTILITIES
// ════════════════════════════════════════════════════════

const rnd  = (lo, hi) => Math.random() * (hi - lo) + lo;
const rndI = (lo, hi) => Math.floor(rnd(lo, hi + 1));

function calcCost(model, inTok, outTok) {
  const p = MODEL_PRICING[model];
  return (inTok / 1000) * p.input + (outTok / 1000) * p.output;
}

const fmtMoney = n => {
  if (n >= 10)  return '$' + n.toFixed(2);
  if (n >= 0.01) return '$' + n.toFixed(2);
  return '$' + n.toFixed(4);
};

const fmtTok = n => n >= 1000 ? (n / 1000).toFixed(1) + 'K' : String(n);

const fmtTime = d => d.toLocaleTimeString('en-US', { hour12: false });

const nextId = () => 'REQ-' + String(S.requestSeq++).padStart(4, '0');

// ════════════════════════════════════════════════════════
// SIMULATION ENGINE
// ════════════════════════════════════════════════════════

// Build a weighted pool of use-case IDs
function buildPool() {
  const pool = [];
  Object.entries(USE_CASES).forEach(([id, uc]) => {
    for (let i = 0; i < uc.rateWeight; i++) pool.push(id);
  });
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool;
}

let _pool = buildPool();
let _poolIdx = 0;

function pickUseCase() {
  if (_poolIdx >= _pool.length) { _pool = buildPool(); _poolIdx = 0; }
  return _pool[_poolIdx++];
}

function makeRequest(ucId, overrides = {}) {
  const uc      = USE_CASES[ucId];
  const model   = uc.defaultModel;
  const inTok   = rndI(...uc.inputRange);
  const outTok  = rndI(...uc.outputRange);
  const cache   = Math.random() < uc.cacheRate;
  const cost    = cache ? calcCost(model, 0, outTok) * 0.08 : calcCost(model, inTok, outTok);

  return {
    id:          nextId(),
    ts:          new Date(),
    ucId,
    model,
    inTok,
    outTok,
    latency:     rndI(180, 1900),
    retries:     0,
    cache,
    complexity:  rnd(...uc.complexityRange),
    cost,
    status:      'ok',
    flagged:     false,
    ...overrides,
  };
}

function tick() {
  if (!S.simTimer) return; // paused
  const ucId = pickUseCase();

  let req;
  if (S.scenarios.bloatActive    && ucId === 'doc-summarizer')    req = makeBloatReq();
  else if (S.scenarios.premiumActive && ucId === 'support-copilot') req = makePremiumReq();
  else req = makeRequest(ucId);

  processRequest(req);

  const delay = rnd(700, 1500);
  S.simTimer = setTimeout(tick, delay);
}

function startSim() {
  S.simTimer = setTimeout(tick, 400);
}

function stopSim() {
  clearTimeout(S.simTimer);
  S.simTimer = null;
}

// ════════════════════════════════════════════════════════
// GATEWAY — central request processing
// ════════════════════════════════════════════════════════

function processRequest(req) {
  S.requests.unshift(req);
  if (S.requests.length > 200) S.requests.pop();

  const m = S.metrics;
  m.totalSpend                += req.cost;
  m.totalReqs++;
  m.spendByUC[req.ucId]       = (m.spendByUC[req.ucId]   || 0) + req.cost;
  m.spendByModel[req.model]   = (m.spendByModel[req.model]|| 0) + req.cost;
  m.reqsByUC[req.ucId]        = (m.reqsByUC[req.ucId]     || 0) + 1;
  if (req.cache) m.cacheHits++;

  S.lastMinReqs.push(Date.now());
  S.lastMinReqs = S.lastMinReqs.filter(t => Date.now() - t < 60000);

  UI.addReqRow(req);
  UI.refreshKPIs();
  UI.refreshCharts();

  setTimeout(() => Agent.analyze(req), rnd(900, 2000));
}

// ════════════════════════════════════════════════════════
// AGENT — pattern detection + interventions
// ════════════════════════════════════════════════════════

const Agent = {
  bloatStreak:       0,
  premiumStreak:     0,
  bloatFired:        false,
  premiumFired:      false,
  retryFired:        false,

  analyze(req) {
    // Prompt bloat detection
    if (req.ucId === 'doc-summarizer' && req.inTok > THRESHOLDS.promptBloat) {
      this.bloatStreak++;
      if (this.bloatStreak >= THRESHOLDS.bloatTrigger && !this.bloatFired) {
        this.bloatFired = true;
        this._onPromptBloat(req);
      }
    } else if (req.ucId === 'doc-summarizer') {
      this.bloatStreak = Math.max(0, this.bloatStreak - 0.5);
    }

    // Premium over-routing detection
    if (req.ucId === 'support-copilot' &&
        MODEL_PRICING[req.model].tier === 'premium' &&
        req.complexity < 0.35) {
      this.premiumStreak++;
      if (this.premiumStreak >= THRESHOLDS.premiumTrigger && !this.premiumFired) {
        this.premiumFired = true;
        this._onPremiumOverrouting(req);
      }
    } else if (req.ucId === 'support-copilot' && MODEL_PRICING[req.model].tier !== 'premium') {
      this.premiumStreak = Math.max(0, this.premiumStreak - 0.5);
    }
  },

  // ── Prompt Bloat handler ─────────────────────
  _onPromptBloat(trigger) {
    S.metrics.anomalies++;

    const avgIn    = rndI(4400, 5900);
    const baseline = calcCost('claude-sonnet', 950, 270);
    const current  = calcCost('claude-sonnet', avgIn, 360);
    const dailyWaste = (current - baseline) * USE_CASES['doc-summarizer'].rateWeight * 60 * 8;

    UI.addAgentEntry({
      type:     'anomaly',
      ts:       new Date(),
      title:    'ANOMALY DETECTED — PROMPT BLOAT',
      workflow: 'Document Summarizer',
      reqId:    trigger.id,
      lines: [
        `Input token volume exceeded threshold on 3 consecutive requests.`,
        `Average input size: ${fmtTok(avgIn)} tokens (policy ceiling: 1,500 tokens).`,
        `Current cost per request: ${fmtMoney(current)} — ${(current / baseline).toFixed(1)}× above baseline.`,
        `Likely cause: Full document bodies passed as context instead of pre-chunked sections.`,
        `Estimated daily excess spend at current rate: ${fmtMoney(dailyWaste)}.`,
      ],
    });

    setTimeout(() => {
      const saving = current - baseline;

      UI.addAgentEntry({
        type:     'recommend',
        ts:       new Date(),
        title:    'RECOMMENDATION — CONTEXT PRUNING',
        workflow: 'Document Summarizer',
        reqId:    trigger.id,
        lines: [
          `Recommended action: Trim input context to 1,500 tokens before model call.`,
          `Apply sliding-window summarization for documents exceeding 2,000 tokens.`,
          '',
          `Expected savings: 74% reduction in per-request cost.`,
          `After intervention: ${fmtMoney(baseline)}/request (from ${fmtMoney(current)}).`,
          `Trade-off: Summary may omit tertiary sections. Core content preserved.`,
          '',
          `Policy triggered: DOC-COST-001 (Max $0.08 per summarization request)`,
          `Action type: RECOMMENDATION — requires product team review.`,
          `Audit entry: #AG-001 · team-docs@company.com notified.`,
        ],
        comparison: {
          before:     { val: fmtMoney(current),  sub: `${fmtTok(avgIn)} input tokens` },
          after:      { val: fmtMoney(baseline), sub: '1,500 input tokens' },
          savings:    fmtMoney(dailyWaste),
          savingsLbl: 'Daily savings',
        },
      });

      S.interventions.unshift({
        id:         'INT-001',
        type:       'context-pruning',
        actionType: 'recommendation',
        workflow:   'Document Summarizer',
        ts:         new Date(),
        savings:    dailyWaste,
        status:     'recommend',
        critical:   false,
      });
      S.metrics.savings += dailyWaste * 0.5;

      UI.refreshInterventions();
      UI.refreshExec();
      UI.refreshKPIs();
    }, 1600);
  },

  // ── Premium Over-routing handler ─────────────
  _onPremiumOverrouting(trigger) {
    S.metrics.anomalies++;

    const cheapCost   = calcCost('claude-haiku', 220, 90);
    const premiumCost = calcCost('claude-opus',  220, 90);
    const ratio       = Math.round(premiumCost / cheapCost);
    const dailyReqs   = USE_CASES['support-copilot'].rateWeight * 60 * 8;
    const dailySaving = (premiumCost - cheapCost) * dailyReqs * 0.70;

    UI.addAgentEntry({
      type:     'anomaly',
      ts:       new Date(),
      title:    'ANOMALY DETECTED — PREMIUM MODEL OVER-ROUTING',
      workflow: 'Support Copilot',
      reqId:    trigger.id,
      lines: [
        `Claude Opus is being used for requests with complexity score < 0.20.`,
        `Last 8 requests: avg complexity 0.14 (FAQ/greeting classification).`,
        `Cost per request: ${fmtMoney(premiumCost)} — ${ratio}× more expensive than Claude Haiku.`,
        `Premium models are appropriate for complex reasoning, not intent detection.`,
      ],
    });

    setTimeout(() => {
      UI.addAgentEntry({
        type:     'autonomous',
        ts:       new Date(),
        title:    'AUTONOMOUS ACTION — MODEL DOWNGRADE',
        workflow: 'Support Copilot',
        reqId:    trigger.id,
        lines: [
          `Action taken: Routing requests with complexity < 0.40 to Claude Haiku.`,
          `Claude Opus retained for escalations and complex multi-turn queries.`,
          '',
          `Savings applied immediately: ${fmtMoney(premiumCost - cheapCost)}/request on low-complexity traffic.`,
          `Estimated daily savings: ${fmtMoney(dailySaving)} at current volume.`,
          `Quality impact: A/B comparison shows <2% difference in user satisfaction.`,
          '',
          `Policy triggered: ROUTE-COST-002 (Model must match intent complexity)`,
          `Action type: AUTONOMOUS — applied immediately per standing policy.`,
          `Audit entry: #AG-002 · routing-config updated.`,
        ],
        comparison: {
          before:     { val: fmtMoney(premiumCost), sub: 'Claude Opus' },
          after:      { val: fmtMoney(cheapCost),   sub: 'Claude Haiku' },
          savings:    fmtMoney(dailySaving),
          savingsLbl: 'Daily savings',
        },
      });

      S.scenarios.premiumActive = false;
      S.interventions.unshift({
        id:         'INT-002',
        type:       'model-downgrade',
        actionType: 'autonomous',
        workflow:   'Support Copilot',
        ts:         new Date(),
        savings:    dailySaving,
        status:     'applied',
        critical:   false,
      });
      S.metrics.savings += dailySaving;

      UI.refreshInterventions();
      UI.refreshExec();
      UI.refreshKPIs();
    }, 1300);
  },

  // ── Retry Storm handler ──────────────────────
  onRetryStorm(retryReq, retryCount) {
    if (retryCount < THRESHOLDS.retryBreaker || this.retryFired) return;
    this.retryFired = true;
    S.metrics.anomalies++;

    const perReqCost  = retryReq.cost;
    const wasted      = perReqCost * retryCount;
    const prevented   = perReqCost * (20 - retryCount);

    UI.addAgentEntry({
      type:     'anomaly',
      ts:       new Date(),
      title:    'ANOMALY DETECTED — RETRY STORM',
      workflow: 'Proposal Assistant',
      reqId:    retryReq.id,
      lines: [
        `Retry count on request ${retryReq.id}: ${retryCount} retries in 45 seconds.`,
        `Root cause: Tool call timeout on knowledge-base API (avg 12s, threshold 3s).`,
        `Accumulated cost from retries: ${fmtMoney(wasted)} (${retryCount}× request cost of ${fmtMoney(perReqCost)}).`,
        `Without intervention, this pattern multiplies spend with no output value.`,
      ],
    });

    setTimeout(() => {
      UI.addAgentEntry({
        type:     'autonomous',
        ts:       new Date(),
        title:    'AUTONOMOUS ACTION — CIRCUIT BREAKER ENGAGED',
        workflow: 'Proposal Assistant',
        reqId:    retryReq.id,
        lines: [
          `Action taken: Workflow paused. Retry circuit breaker triggered.`,
          `Fallback: Request queued for manual review. Owner alerted.`,
          '',
          `Spend prevented: ${fmtMoney(prevented)} (${20 - retryCount} future retries blocked).`,
          `Budget protected at scale: ${fmtMoney(prevented * 3)}/day if pattern recurred.`,
          '',
          `Root cause: knowledge-base API latency spike — likely upstream degradation.`,
          `Recommendation: Increase timeout threshold or implement cached fallback.`,
          '',
          `Policy triggered: RETRY-GUARD-001 (Max 3 retries per request)`,
          `Action type: AUTONOMOUS — circuit breaker engaged per standing policy.`,
          `Audit entry: #AG-003 · owner-proposals@company.com alerted.`,
          `Workflow status: PAUSED — requires manual restart.`,
        ],
        comparison: {
          before:     { val: `${retryCount} retries`,                sub: fmtMoney(wasted) + ' wasted' },
          after:      { val: `${THRESHOLDS.retryBreaker} max retries`, sub: 'Circuit breaker active' },
          savings:    fmtMoney(prevented),
          savingsLbl: 'Spend prevented',
        },
      });

      S.scenarios.retryActive = false;
      S.interventions.unshift({
        id:         'INT-003',
        type:       'circuit-breaker',
        actionType: 'autonomous',
        workflow:   'Proposal Assistant',
        ts:         new Date(),
        savings:    prevented * 3,
        status:     'applied',
        critical:   true,
      });
      S.metrics.savings += prevented;

      UI.setScenarioStatus('PAUSED: Proposal Assistant circuit breaker engaged. Retries halted.', 'danger');
      UI.refreshInterventions();
      UI.refreshExec();
      UI.refreshKPIs();
    }, 1100);
  },
};

// ════════════════════════════════════════════════════════
// SCENARIO GENERATORS
// ════════════════════════════════════════════════════════

function makeBloatReq() {
  const inTok = rndI(3700, 6400);
  const outTok = rndI(270, 460);
  const model = 'claude-sonnet';
  return {
    id:         nextId(),
    ts:         new Date(),
    ucId:       'doc-summarizer',
    model,
    inTok,
    outTok,
    latency:    rndI(750, 2400),
    retries:    0,
    cache:      false,
    complexity: rnd(0.3, 0.7),
    cost:       calcCost(model, inTok, outTok),
    status:     'flagged',
    flagged:    true,
  };
}

function makePremiumReq() {
  const inTok = rndI(140, 310);
  const outTok = rndI(55, 130);
  const model = 'claude-opus';
  return {
    id:         nextId(),
    ts:         new Date(),
    ucId:       'support-copilot',
    model,
    inTok,
    outTok,
    latency:    rndI(180, 620),
    retries:    0,
    cache:      false,
    complexity: rnd(0.08, 0.22),
    cost:       calcCost(model, inTok, outTok),
    status:     'flagged',
    flagged:    true,
  };
}

// ════════════════════════════════════════════════════════
// SCENARIOS
// ════════════════════════════════════════════════════════

const Scenarios = {
  triggerPromptBloat() {
    if (S.scenarios.bloatActive) return;
    Agent.bloatFired  = false;
    Agent.bloatStreak = 0;
    S.scenarios.bloatActive = true;

    UI.setScenarioStatus('Scenario active: Prompt Bloat — watching Document Summarizer…', 'warn');
    UI.addAgentEntry({
      type: 'info', ts: new Date(),
      title: 'SCENARIO STARTED — PROMPT BLOAT',
      lines: [
        'Document Summarizer is now sending full document bodies without chunking.',
        'Monitoring for cost threshold breach…',
      ],
    });

    setTimeout(() => {
      if (S.scenarios.bloatActive) {
        S.scenarios.bloatActive = false;
        UI.setScenarioStatus('Prompt Bloat scenario complete', 'success');
      }
    }, 30000);
  },

  triggerPremiumOverrouting() {
    if (S.scenarios.premiumActive) return;
    Agent.premiumFired  = false;
    Agent.premiumStreak = 0;
    S.scenarios.premiumActive = true;

    UI.setScenarioStatus('Scenario active: Premium Over-routing — Support Copilot switched to Claude Opus…', 'warn');
    UI.addAgentEntry({
      type: 'info', ts: new Date(),
      title: 'SCENARIO STARTED — PREMIUM OVER-ROUTING',
      lines: [
        'Support Copilot now routing all traffic to Claude Opus.',
        'Monitoring for cost/complexity mismatch…',
      ],
    });
  },

  triggerRetryStorm() {
    if (S.scenarios.retryActive) return;
    Agent.retryFired     = false;
    S.scenarios.retryActive = true;

    UI.setScenarioStatus('Scenario active: Retry Storm — Proposal Assistant experiencing tool failures…', 'danger');
    UI.addAgentEntry({
      type: 'info', ts: new Date(),
      title: 'SCENARIO STARTED — RETRY STORM',
      lines: [
        'Proposal Assistant knowledge-base API timeout triggered.',
        'Monitoring retry accumulation…',
      ],
    });

    // Fire base request then retry sequence
    const base = makeRequest('proposal-assistant', { status: 'retrying', flagged: true });
    processRequest(base);

    const delays = [2200, 4000, 5800, 7600, 9400, 11200, 13000, 14800];
    delays.forEach((delay, idx) => {
      setTimeout(() => {
        if (!S.scenarios.retryActive) return;
        const count = idx + 1;
        const req = {
          ...base,
          id:      nextId(),
          ts:      new Date(),
          retries: count,
          cost:    base.cost * (1 + count * 0.08),
          status:  count >= THRESHOLDS.retryBreaker ? 'circuit' : 'retrying',
          flagged: true,
        };

        S.requests.unshift(req);
        S.metrics.totalSpend              += req.cost;
        S.metrics.totalReqs++;
        S.metrics.spendByUC['proposal-assistant'] += req.cost;
        S.metrics.reqsByUC['proposal-assistant']  = (S.metrics.reqsByUC['proposal-assistant'] || 0) + 1;

        UI.addReqRow(req);
        UI.refreshKPIs();

        setTimeout(() => Agent.onRetryStorm(req, count), 600);
      }, delay);
    });
  },

  reset() {
    stopSim();

    // Reset state
    S.requests      = [];
    S.interventions = [];
    S.metrics = {
      totalSpend:   0,
      totalReqs:    0,
      cacheHits:    0,
      anomalies:    0,
      savings:      0,
      spendByUC:    {},
      spendByModel: {},
      reqsByUC:     {},
    };
    Object.keys(USE_CASES).forEach(id => {
      S.metrics.spendByUC[id]  = 0;
      S.metrics.reqsByUC[id]   = 0;
    });
    S.scenarios     = { bloatActive: false, premiumActive: false, retryActive: false };
    S.requestSeq    = 1;
    S.lastMinReqs   = [];

    // Reset agent counters
    Agent.bloatStreak  = 0;
    Agent.premiumStreak = 0;
    Agent.bloatFired   = false;
    Agent.premiumFired = false;
    Agent.retryFired   = false;

    UI.reset();
    setTimeout(() => { S.simTimer = true; startSim(); }, 400);
  },
};

// ════════════════════════════════════════════════════════
// UI
// ════════════════════════════════════════════════════════

const UI = {
  // ── KPI refresh ───────────────────────────────
  refreshKPIs() {
    const m = S.metrics;
    const reqPerMin = S.lastMinReqs.length;
    const cacheRate = m.totalReqs > 0 ? Math.round(m.cacheHits / m.totalReqs * 100) : 0;
    const savPct    = m.totalSpend > 0
      ? Math.round(m.savings / (m.totalSpend + m.savings) * 100)
      : 0;

    q('kpiTotalSpend').textContent = fmtMoney(m.totalSpend);
    q('kpiRequests').textContent   = m.totalReqs.toLocaleString();
    q('kpiAnomalies').textContent  = m.anomalies;
    q('kpiSavings').textContent    = fmtMoney(m.savings);
    q('kpiCacheRate').textContent  = cacheRate + '%';
    q('kpiCacheHits').textContent  = m.cacheHits + ' hits';
    q('kpiReqRate').textContent    = reqPerMin + ' req/min';
    q('kpiSavingsPct').textContent = savPct + '% of spend';
    q('reqCount').textContent      = m.totalReqs + ' total';

    const card = q('kpiAnomalyCard');
    card.classList.toggle('kpi-alert', m.anomalies > 0);
  },

  // ── Request table row ─────────────────────────
  addReqRow(req) {
    const tbody = q('reqTableBody');

    // Clear idle placeholder
    const idle = tbody.querySelector('.idle-row');
    if (idle) idle.remove();

    const uc      = USE_CASES[req.ucId];
    const pricing = MODEL_PRICING[req.model];
    const costCls = req.cost > 0.10 ? 'cost-hi' : req.cost > 0.04 ? 'cost-mid' : '';
    const rowCls  = req.status === 'circuit' ? 'row-crit'
                  : req.flagged              ? 'row-warn' : '';

    const statusLabel = {
      ok:      'OK',
      flagged: 'Flagged',
      retrying:`Retry ${req.retries}`,
      circuit: 'Circuit Break',
      done:    'Intervened',
    }[req.status] || req.status;

    const tr = document.createElement('tr');
    tr.className = `req-row new ${rowCls}`;
    tr.innerHTML = `
      <td class="time-col">${fmtTime(req.ts)}</td>
      <td><span style="color:${uc.color}" class="uc-badge">${uc.icon} ${uc.label}</span></td>
      <td><span class="model-pill ${pricing.tier}">${pricing.label}</span></td>
      <td class="tokens-col">
        <span class="tok-in">↑${fmtTok(req.inTok)}</span>
        <span class="tok-out">↓${fmtTok(req.outTok)}</span>
        ${req.cache   ? '<span class="tag-cache">cached</span>' : ''}
        ${req.retries ? `<span class="tag-retry">×${req.retries}</span>` : ''}
      </td>
      <td class="cost-col ${costCls}">${fmtMoney(req.cost)}</td>
      <td><span class="status-pill ${req.status}">${statusLabel}</span></td>
    `;

    tbody.insertBefore(tr, tbody.firstChild);
    setTimeout(() => tr.classList.remove('new'), 500);

    while (tbody.children.length > THRESHOLDS.maxTableRows) {
      tbody.removeChild(tbody.lastChild);
    }
  },

  // ── Agent console entry ───────────────────────
  addAgentEntry(entry) {
    const log = q('agentLog');

    // Remove idle placeholder
    const idle = log.querySelector('.agent-idle');
    if (idle) idle.remove();

    const typeMap = {
      anomaly:    { icon: '🔍', label: 'DETECTED',   cls: 't-anomaly'   },
      recommend:  { icon: '💡', label: 'RECOMMEND',  cls: 't-recommend' },
      autonomous: { icon: '⚡', label: 'ACTION',     cls: 't-autonomous'},
      info:       { icon: 'ℹ',  label: 'INFO',       cls: 't-info'      },
    };
    const tm = typeMap[entry.type] || typeMap.info;

    const linesHtml = entry.lines.map(l =>
      l === '' ? '<div class="ae-line ae-spacer"></div>'
               : `<div class="ae-line">${l}</div>`
    ).join('');

    let cmpHtml = '';
    if (entry.comparison) {
      const c = entry.comparison;
      cmpHtml = `
        <div class="comparison">
          <div class="cmp-col">
            <div class="cmp-lbl">BEFORE</div>
            <div class="cmp-val hi">${c.before.val}</div>
            <div class="cmp-sub">${c.before.sub}</div>
          </div>
          <div class="cmp-arrow">→</div>
          <div class="cmp-col">
            <div class="cmp-lbl">AFTER</div>
            <div class="cmp-val lo">${c.after.val}</div>
            <div class="cmp-sub">${c.after.sub}</div>
          </div>
          <div class="cmp-savings">
            <div class="cmp-savings-lbl">${c.savingsLbl}</div>
            <div class="cmp-savings-val">${c.savings}</div>
          </div>
        </div>
      `;
    }

    const div = document.createElement('div');
    div.className = `agent-entry new ${tm.cls}`;
    div.innerHTML = `
      <div class="ae-head">
        <span class="ae-icon">${tm.icon}</span>
        <div class="ae-badges">
          <span class="ae-type-pill ${tm.cls}">${tm.label}</span>
          <span class="ae-title">${entry.title}</span>
        </div>
        <span class="ae-time">${fmtTime(entry.ts)}</span>
      </div>
      ${entry.workflow ? `<div class="ae-workflow">Workflow: ${entry.workflow}</div>` : ''}
      <div class="ae-details">${linesHtml}</div>
      ${cmpHtml}
    `;

    log.insertBefore(div, log.firstChild);
    setTimeout(() => div.classList.remove('new'), 500);

    while (log.children.length > THRESHOLDS.maxAgentEntries) {
      log.removeChild(log.lastChild);
    }

    // Update agent chip
    const chip = q('agentChip');
    if (entry.type === 'anomaly') {
      chip.className = 'agent-status-chip alert';
      chip.innerHTML = '<span class="chip-dot"></span>Anomaly Detected';
    } else if (entry.type === 'autonomous') {
      chip.className = 'agent-status-chip success';
      chip.innerHTML = '<span class="chip-dot"></span>Action Applied';
    } else {
      chip.className = 'agent-status-chip';
      chip.innerHTML = '<span class="chip-dot"></span>Monitoring';
    }
    setTimeout(() => {
      chip.className = 'agent-status-chip';
      chip.innerHTML = '<span class="chip-dot"></span>Monitoring';
    }, 6000);
  },

  // ── Spend / model charts ──────────────────────
  refreshCharts() {
    const m = S.metrics;
    if (m.totalSpend === 0) return;

    // Spend by use case
    const ucHtml = Object.entries(USE_CASES).map(([id, uc]) => {
      const spend = m.spendByUC[id] || 0;
      const pct   = m.totalSpend > 0 ? spend / m.totalSpend * 100 : 0;
      const reqs  = m.reqsByUC[id] || 0;
      const avg   = reqs > 0 ? spend / reqs : 0;
      return `
        <div class="bar-row">
          <div class="bar-lbl">
            <span>${uc.icon} ${uc.label}</span>
            <span class="bar-amt">${fmtMoney(spend)}</span>
          </div>
          <div class="bar-track"><div class="bar-fill" style="width:${pct.toFixed(1)}%;background:${uc.color}"></div></div>
          <div class="bar-meta">${reqs} req · avg ${fmtMoney(avg)}</div>
        </div>`;
    }).join('');
    q('spendBars').innerHTML = ucHtml;

    // Model distribution
    const tiers = { premium: '#ef4444', standard: '#f59e0b', efficient: '#10b981' };
    const sorted = Object.entries(m.spendByModel).sort((a, b) => b[1] - a[1]);
    const modelHtml = sorted.map(([mid, spend]) => {
      const p   = MODEL_PRICING[mid];
      const pct = m.totalSpend > 0 ? spend / m.totalSpend * 100 : 0;
      const col = tiers[p.tier];
      return `
        <div class="bar-row">
          <div class="bar-lbl">
            <span><span class="model-dot" style="background:${col}"></span>${p.label}</span>
            <span class="bar-amt">${fmtMoney(spend)}</span>
          </div>
          <div class="bar-track"><div class="bar-fill" style="width:${pct.toFixed(1)}%;background:${col}"></div></div>
          <div class="bar-meta"><span class="tier-chip ${p.tier}">${p.tier}</span> · ${pct.toFixed(1)}% of spend</div>
        </div>`;
    }).join('');
    q('modelBars').innerHTML = modelHtml || '<div class="empty-state">No data</div>';
  },

  // ── Intervention list ─────────────────────────
  refreshInterventions() {
    if (S.interventions.length === 0) {
      q('interventionList').innerHTML = '<div class="empty-state">No interventions yet</div>';
      return;
    }

    const icons = {
      'context-pruning': '✂️',
      'model-downgrade':  '⬇️',
      'circuit-breaker':  '🛑',
      'cache-reuse':      '♻️',
      'output-cap':       '📏',
    };

    const html = S.interventions.map(inv => {
      const cls = inv.actionType === 'autonomous' ? 'inv-critical' : 'inv-recommend';
      const stCls = inv.status === 'applied' ? 'applied' : 'recommend';
      const stLbl = inv.status === 'applied' ? 'Applied' : 'Recommended';
      return `
        <div class="inv-card ${cls}">
          <div class="inv-head">
            <span class="inv-icon">${icons[inv.type] || '⚡'}</span>
            <span class="inv-label">${inv.type.replace(/-/g,' ').toUpperCase()}</span>
            <span class="inv-status ${stCls}">${stLbl}</span>
          </div>
          <div class="inv-wf">${inv.workflow}</div>
          <div class="inv-saving">${fmtMoney(inv.savings)} ${inv.actionType === 'autonomous' ? 'saved/prevented' : 'projected'}</div>
          <div class="inv-time">${fmtTime(inv.ts)}</div>
        </div>`;
    }).join('');
    q('interventionList').innerHTML = html;
  },

  // ── Executive summary ─────────────────────────
  refreshExec() {
    const m = S.metrics;
    if (m.totalReqs < 8) return;

    const topUC = Object.entries(m.spendByUC).sort((a, b) => b[1] - a[1])[0];
    const topUCName = topUC ? USE_CASES[topUC[0]].label : '—';
    const topUCPct  = topUC && m.totalSpend > 0 ? Math.round(topUC[1] / m.totalSpend * 100) : 0;

    const cacheRate = m.totalReqs > 0 ? Math.round(m.cacheHits / m.totalReqs * 100) : 0;
    const savPct    = m.totalSpend > 0 ? Math.round(m.savings / (m.totalSpend + m.savings) * 100) : 0;
    const avgCost   = m.totalReqs > 0 ? m.totalSpend / m.totalReqs : 0;

    const auto   = S.interventions.filter(i => i.actionType === 'autonomous').length;
    const recs   = S.interventions.filter(i => i.actionType === 'recommendation').length;
    const total  = S.interventions.length;

    let narrative = '';
    if (total > 0) {
      const parts = [];
      if (auto  > 0) parts.push(`<strong>${auto} applied autonomously</strong>`);
      if (recs  > 0) parts.push(`<strong>${recs} recommended for team review</strong>`);
      narrative += `<p>The TokenOps Agent completed <strong>${total} intervention${total > 1 ? 's' : ''}</strong> this session: ${parts.join(' and ')}.</p>`;
    }

    narrative += `<p><strong>${topUCName}</strong> is the highest-cost workflow, representing ${topUCPct}% of total AI spend.</p>`;

    if (m.anomalies > 0) {
      narrative += `<p>${m.anomalies} policy violation${m.anomalies > 1 ? 's' : ''} detected and addressed. Each intervention prevents compounding waste before it reaches the billing cycle.</p>`;
    }

    narrative += `<p class="exec-tagline">Every token this session became observable, interpretable, and governable.</p>`;

    q('execContent').innerHTML = `
      <div class="exec-stats">
        <div class="exec-stat">
          <div class="exec-stat-val">${fmtMoney(m.totalSpend)}</div>
          <div class="exec-stat-lbl">Total AI spend</div>
        </div>
        <div class="exec-stat">
          <div class="exec-stat-val">${fmtMoney(m.savings)}</div>
          <div class="exec-stat-lbl">Savings captured (${savPct}%)</div>
        </div>
        <div class="exec-stat">
          <div class="exec-stat-val">${fmtMoney(avgCost)}</div>
          <div class="exec-stat-lbl">Avg cost per request</div>
        </div>
        <div class="exec-stat">
          <div class="exec-stat-val">${cacheRate}%</div>
          <div class="exec-stat-lbl">Cache hit rate</div>
        </div>
      </div>
      <div class="exec-narrative">${narrative}</div>
    `;
  },

  // ── Scenario status bar ───────────────────────
  setScenarioStatus(msg, type) {
    const el = q('scenarioStatusBar');
    el.textContent = msg;
    el.className = 'scenario-status-bar ' + type;
  },

  // ── Reset ─────────────────────────────────────
  reset() {
    q('reqTableBody').innerHTML   = '';
    q('agentLog').innerHTML       = `<div class="agent-idle"><div class="agent-idle-icon">🔍</div><div>Agent monitoring traffic. Trigger a scenario to see it in action.</div></div>`;
    q('spendBars').innerHTML      = '<div class="empty-state">Waiting for traffic…</div>';
    q('modelBars').innerHTML      = '<div class="empty-state">Waiting for traffic…</div>';
    q('interventionList').innerHTML = '<div class="empty-state">No interventions yet</div>';
    q('execContent').innerHTML    = '<div class="empty-state">Summary will appear once traffic is established.</div>';
    q('kpiTotalSpend').textContent = '$0.00';
    q('kpiRequests').textContent   = '0';
    q('kpiAnomalies').textContent  = '0';
    q('kpiSavings').textContent    = '$0.00';
    q('kpiCacheRate').textContent  = '0%';
    q('kpiCacheHits').textContent  = '0 hits';
    q('kpiReqRate').textContent    = '0 req/min';
    q('kpiSavingsPct').textContent = '0% of spend';
    q('reqCount').textContent      = '0 total';
    q('kpiAnomalyCard').classList.remove('kpi-alert');
    q('scenarioStatusBar').className = 'scenario-status-bar';
    q('agentChip').className    = 'agent-status-chip';
    q('agentChip').innerHTML    = '<span class="chip-dot"></span>Monitoring';
  },
};

// ════════════════════════════════════════════════════════
// THEME
// ════════════════════════════════════════════════════════

function toggleTheme() {
  const html  = document.documentElement;
  const next  = html.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  html.setAttribute('data-theme', next);
  localStorage.setItem('tokenops-theme', next);
  q('themeToggle').textContent = next === 'dark' ? '☀ Light' : '⏾ Dark';
}

// ════════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════════

function q(id) { return document.getElementById(id); }

// ════════════════════════════════════════════════════════
// INIT
// ════════════════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', () => {
  const saved = localStorage.getItem('tokenops-theme') || 'dark';
  document.documentElement.setAttribute('data-theme', saved);
  q('themeToggle').textContent = saved === 'dark' ? '☀ Light' : '⏾ Dark';

  startSim();
  setInterval(() => { UI.refreshExec(); UI.refreshKPIs(); }, 3000);
});
