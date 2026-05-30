'use strict';

// ════════════════════════════════════════════════════════
// MODELS & WORKFLOW CONFIG
// ════════════════════════════════════════════════════════

const MODELS = {
  'claude-opus':   { label:'Claude Opus',   tier:'premium',   input:0.015,   output:0.075   },
  'claude-sonnet': { label:'Claude Sonnet', tier:'standard',  input:0.003,   output:0.015   },
  'claude-haiku':  { label:'Claude Haiku',  tier:'efficient', input:0.00025, output:0.00125 },
  'gpt-4o':        { label:'GPT-4o',        tier:'premium',   input:0.005,   output:0.015   },
  'gpt-4o-mini':   { label:'GPT-4o Mini',   tier:'efficient', input:0.00015, output:0.0006  },
};

const WF_CFG = {
  'support-copilot': {
    name:'Support Copilot', icon:'💬', color:'#6366f1',
    defaultModel:'claude-haiku', scenarioModel:'claude-opus', optimizedModel:'claude-haiku',
    inputRange:[140,310], outputRange:[55,130], complexityRange:[0.08,0.40],
    tickMs:1100, warmupCount:3, scenarioTrigger:5,
    scenario:'premium-overrouting', policy:'ROUTE-COST-002',
    autoApplySafe:true,
    narratives:{
      detection:'Claude Opus is being used for requests with complexity score < 0.20 — FAQ and greeting classification that does not require frontier reasoning.',
      action:'Routing policy updated: low-complexity traffic (score < 0.40) redirected to Claude Haiku. Opus retained for escalations and complex multi-turn queries.',
      tradeoff:'A/B testing shows < 2% difference in user satisfaction on FAQ intent.',
    },
  },
  'doc-summarizer': {
    name:'Document Assistant', icon:'📄', color:'#8b5cf6',
    defaultModel:'claude-sonnet', scenarioModel:'claude-sonnet', optimizedModel:'claude-sonnet',
    inputRange:[680,1300], outputRange:[180,360], complexityRange:[0.30,0.72],
    tickMs:1400, warmupCount:3, scenarioTrigger:3,
    scenario:'prompt-bloat', policy:'DOC-COST-001',
    autoApplySafe:false,
    narratives:{
      detection:'Full document bodies (4,000–6,000 tokens) are being passed as context instead of pre-chunked sections, breaching the 1,500-token policy ceiling.',
      action:'Input context trimmed to 1,500 tokens. Sliding-window summarization enabled for documents exceeding 2,000 tokens. Output cap set to 300 tokens.',
      tradeoff:'Summaries may omit tertiary sections. Core content and conclusions are preserved.',
    },
  },
  'proposal-assistant': {
    name:'Proposal Assistant', icon:'📋', color:'#ec4899',
    defaultModel:'claude-sonnet', scenarioModel:'claude-sonnet', optimizedModel:'claude-sonnet',
    inputRange:[380,720], outputRange:[550,1100], complexityRange:[0.50,0.92],
    tickMs:1600, warmupCount:2, scenarioTrigger:3,
    scenario:'retry-storm', policy:'RETRY-GUARD-001',
    autoApplySafe:true,
    narratives:{
      detection:'Tool call timeout on knowledge-base API triggered a retry loop. Retries multiplied spend with no output value.',
      action:'Circuit breaker engaged. Workflow paused. Request queued for review. Owner alerted with root-cause summary.',
      tradeoff:'Workflow paused until manually resumed. Prevents unlimited spend escalation.',
    },
  },
};

// ════════════════════════════════════════════════════════
// STATE
// ════════════════════════════════════════════════════════

const S = {
  autoApply: false,
  workflows: mkAllWF(),
  requests:  [],
  alerts:    [],
  entries:   [],         // agent console entries
  approvals: new Map(),  // id → approval object
  metrics: { spend:0, reqs:0, cache:0, alerts:0, savings:0 },
  reqSeq: 1,
  minReqs: [],           // timestamps for req/min
};

function mkWF() {
  return {
    status:'idle', timer:null,
    reqs:0, spend:0, tickN:0,
    phase:'idle',         // idle | warmup | scenario | optimized
    scenarioHits:0, agentFired:false,
    retryBase:null, retryCount:0,
    baseline:null,        // {reqs,spend,avgCost} captured before scenario
    approvalId:null,
  };
}
function mkAllWF() {
  const o={};
  Object.keys(WF_CFG).forEach(id => o[id]=mkWF());
  return o;
}

// ════════════════════════════════════════════════════════
// UTILITIES
// ════════════════════════════════════════════════════════

const rnd  = (a,b) => Math.random()*(b-a)+a;
const rndI = (a,b) => Math.floor(rnd(a,b+1));
const q    = id  => document.getElementById(id);

function calcCost(model, inTok, outTok) {
  const m = MODELS[model];
  return (inTok/1000)*m.input + (outTok/1000)*m.output;
}

const fmtUSD  = n => n >= 0.01 ? '$'+n.toFixed(2) : '$'+n.toFixed(4);
const fmtTok  = n => n >= 1000 ? (n/1000).toFixed(1)+'K' : ''+n;
const fmtTime = d => d.toLocaleTimeString('en-US',{hour12:false});
const nextId  = () => 'REQ-'+String(S.reqSeq++).padStart(4,'0');
const nextAP  = () => 'AP-'+Math.floor(Math.random()*9000+1000);

// ════════════════════════════════════════════════════════
// WORKFLOW ENGINE
// ════════════════════════════════════════════════════════

const WorkflowEngine = {
  toggle(id) {
    const wf = S.workflows[id];
    if (wf.status === 'paused')                    this.resume(id);
    else if (wf.status==='idle')                   this.run(id);
    else                                            this.stop(id);
  },

  run(id) {
    const wf=S.workflows[id], cfg=WF_CFG[id];
    wf.status='running'; wf.phase='warmup';
    wf.tickN=0; wf.scenarioHits=0; wf.agentFired=false;
    wf.retryBase=null; wf.retryCount=0;
    UI.setWFStatus(id,'running');
    UI.setLive(true);
    this._schedule(id);
  },

  stop(id) {
    const wf=S.workflows[id];
    clearTimeout(wf.timer); wf.timer=null;
    wf.status='idle'; wf.phase='idle';
    UI.setWFStatus(id,'idle');
    if (!Object.values(S.workflows).some(w=>w.status==='running'||w.status==='anomaly'||w.status==='optimized'))
      UI.setLive(false);
  },

  resume(id) {
    const wf=S.workflows[id];
    wf.status='optimized'; wf.phase='optimized';
    UI.setWFStatus(id,'optimized');
    this._schedule(id);
  },

  _schedule(id) {
    const wf=S.workflows[id], cfg=WF_CFG[id];
    const tick = () => {
      if (!['running','anomaly','optimized'].includes(wf.status)) return;
      this._tick(id);
      wf.timer = setTimeout(tick, rnd(.85,1.3)*cfg.tickMs);
    };
    wf.timer = setTimeout(tick, 250);
  },

  _tick(id) {
    const wf=S.workflows[id], cfg=WF_CFG[id];
    wf.tickN++;

    if (cfg.scenario==='retry-storm') { this._tickRetry(id); return; }

    if (wf.phase==='warmup') {
      Gateway.process(this._normalReq(id));
      if (wf.tickN >= cfg.warmupCount) {
        wf.phase='scenario';
        wf.baseline = { reqs:wf.reqs, spend:wf.spend, avgCost: wf.reqs>0 ? wf.spend/wf.reqs : 0 };
      }
      return;
    }
    if (wf.phase==='scenario') {
      const req = this._scenarioReq(id);
      Gateway.process(req);
      wf.scenarioHits++;
      if (wf.scenarioHits >= cfg.scenarioTrigger && !wf.agentFired) {
        wf.agentFired=true;
        setTimeout(()=>Agent.fire(id,req), rnd(900,1800));
      }
      return;
    }
    if (wf.phase==='optimized') {
      Gateway.process(this._optimizedReq(id));
    }
  },

  _tickRetry(id) {
    const wf=S.workflows[id], cfg=WF_CFG[id];
    if (wf.phase==='warmup') {
      Gateway.process(this._normalReq(id));
      if (wf.tickN >= cfg.warmupCount) {
        wf.phase='scenario';
        wf.baseline={ reqs:wf.reqs, spend:wf.spend, avgCost: wf.reqs>0?wf.spend/wf.reqs:0 };
        wf.retryBase = this._normalReq(id);
        wf.retryBase.status='retrying'; wf.retryBase.flagged=true;
        Gateway.process(wf.retryBase);
      }
      return;
    }
    if (wf.phase==='scenario' && wf.retryBase) {
      wf.retryCount++;
      const r = {
        ...wf.retryBase, id:nextId(), ts:new Date(),
        retries:wf.retryCount,
        cost:wf.retryBase.cost*(1+wf.retryCount*.10),
        status: wf.retryCount >= cfg.scenarioTrigger ? 'circuit' : 'retrying',
        flagged:true,
      };
      Gateway.process(r);
      if (wf.retryCount >= cfg.scenarioTrigger && !wf.agentFired) {
        wf.agentFired=true;
        setTimeout(()=>Agent.fire(id,r), 700);
      }
    }
  },

  _normalReq(id) {
    const cfg=WF_CFG[id], model=cfg.defaultModel;
    const inTok=rndI(...cfg.inputRange), outTok=rndI(...cfg.outputRange);
    const cache=Math.random()<.24;
    return { id:nextId(), ts:new Date(), wfId:id, model, inTok, outTok,
      cost: cache?calcCost(model,0,outTok)*.08:calcCost(model,inTok,outTok),
      latency:rndI(200,1800), retries:0, cache, status:'ok', flagged:false, phase:'normal',
      complexity:rnd(...cfg.complexityRange) };
  },

  _scenarioReq(id) {
    const cfg=WF_CFG[id];
    if (cfg.scenario==='prompt-bloat') {
      const inTok=rndI(3700,6300), outTok=rndI(260,470), model=cfg.scenarioModel;
      return { id:nextId(), ts:new Date(), wfId:id, model, inTok, outTok,
        cost:calcCost(model,inTok,outTok), latency:rndI(700,2600),
        retries:0, cache:false, status:'flagged', flagged:true, phase:'scenario',
        anomaly:'prompt-bloat', complexity:rnd(.30,.72) };
    }
    if (cfg.scenario==='premium-overrouting') {
      const model=cfg.scenarioModel;
      const inTok=rndI(...cfg.inputRange), outTok=rndI(...cfg.outputRange);
      return { id:nextId(), ts:new Date(), wfId:id, model, inTok, outTok,
        cost:calcCost(model,inTok,outTok), latency:rndI(200,700),
        retries:0, cache:false, status:'flagged', flagged:true, phase:'scenario',
        anomaly:'premium-overrouting', complexity:rnd(.08,.20) };
    }
    return this._normalReq(id);
  },

  _optimizedReq(id) {
    const cfg=WF_CFG[id], model=cfg.optimizedModel;
    if (cfg.scenario==='prompt-bloat') {
      const inTok=rndI(950,1500), outTok=rndI(160,300);
      return { id:nextId(), ts:new Date(), wfId:id, model, inTok, outTok,
        cost:calcCost(model,inTok,outTok), latency:rndI(300,1100),
        retries:0, cache:Math.random()<.42, status:'optimized', flagged:false, phase:'optimized',
        complexity:rnd(.30,.72) };
    }
    if (cfg.scenario==='premium-overrouting') {
      const inTok=rndI(...cfg.inputRange), outTok=rndI(...cfg.outputRange);
      return { id:nextId(), ts:new Date(), wfId:id, model, inTok, outTok,
        cost:calcCost(model,inTok,outTok), latency:rndI(180,600),
        retries:0, cache:Math.random()<.38, status:'optimized', flagged:false, phase:'optimized',
        complexity:rnd(...cfg.complexityRange) };
    }
    return this._normalReq(id);
  },

  activateOptimized(id) {
    const wf=S.workflows[id], cfg=WF_CFG[id];
    clearTimeout(wf.timer);
    if (cfg.scenario==='retry-storm') {
      wf.status='paused'; wf.phase='optimized';
      UI.setWFStatus(id,'paused');
      return;
    }
    wf.status='optimized'; wf.phase='optimized';
    UI.setWFStatus(id,'optimized');
    this._schedule(id);
  },
};

// ════════════════════════════════════════════════════════
// GATEWAY
// ════════════════════════════════════════════════════════

const Gateway = {
  process(req) {
    S.requests.unshift(req);
    if (S.requests.length>200) S.requests.pop();

    const m=S.metrics;
    m.spend+=req.cost; m.reqs++;
    if (req.cache) m.cache++;
    S.minReqs.push(Date.now());
    S.minReqs = S.minReqs.filter(t=>Date.now()-t<60000);

    const wf=S.workflows[req.wfId];
    wf.reqs++; wf.spend+=req.cost;

    UI.addReqRow(req);
    UI.refreshKPIs();
    UI.refreshWFCard(req.wfId);
  },

  addAlert(a) {
    S.alerts = S.alerts.filter(x=>x.id!==a.id);
    S.alerts.unshift(a);
    S.metrics.alerts = S.alerts.filter(x=>!x.cleared&&x.type==='crit').length;
    UI.refreshAlerts();
    UI.refreshKPIs();
  },

  clearAlert(id) {
    const a=S.alerts.find(x=>x.id===id);
    if (a) { a.cleared=true; }
    S.metrics.alerts = S.alerts.filter(x=>!x.cleared&&x.type==='crit').length;
    UI.refreshAlerts();
    UI.refreshKPIs();
  },
};

// ════════════════════════════════════════════════════════
// AGENT
// ════════════════════════════════════════════════════════

const Agent = {
  fire(wfId, triggerReq) {
    const cfg=WF_CFG[wfId], wf=S.workflows[wfId];
    wf.status='anomaly';
    UI.setWFStatus(wfId,'anomaly');
    UI.setPolicyViolated(cfg.policy, true);

    const entry = this._buildEntry(wfId, triggerReq);
    if (!entry) return;

    Gateway.addAlert({ id:'A-'+wfId, wfId, type:'crit',
      title: entry.alertTitle, msg: entry.alertMsg, ts:new Date(), cleared:false });

    // Auto-apply if: it's a safe action AND (global auto-apply ON or it's retry-storm safety)
    const doAuto = (cfg.autoApplySafe && S.autoApply) || cfg.scenario==='retry-storm';

    if (doAuto) {
      entry.actionType='autonomous';
      this._addEntry(entry);
      setTimeout(()=>this._execute(wfId,entry), 1000);
    } else {
      entry.actionType='approval-required';
      entry.approvalId = nextAP();
      S.approvals.set(entry.approvalId, { id:entry.approvalId, wfId, entry, status:'pending' });
      wf.approvalId = entry.approvalId;
      this._addEntry(entry);
      UI.showBadge(S.entries.filter(e=>e.actionType==='approval-required'&&e.approved==null).length);
    }

    UI.switchTab('agent');
  },

  approve(apId) {
    const ap=S.approvals.get(apId);
    if (!ap||ap.status!=='pending') return;
    ap.status='approved'; ap.entry.approved=true;
    UI.updateEntry(ap.entry);
    this._execute(ap.wfId, ap.entry);
    UI.hideBadge();
    Drawer.close();
  },

  reject(apId) {
    const ap=S.approvals.get(apId);
    if (!ap||ap.status!=='pending') return;
    ap.status='rejected'; ap.entry.approved=false;
    // Restore workflow to running
    const wf=S.workflows[ap.wfId];
    wf.status='running'; wf.phase='scenario';
    UI.setWFStatus(ap.wfId,'running');
    UI.updateEntry(ap.entry);
    UI.hideBadge();
    UI.setPolicyViolated(WF_CFG[ap.wfId].policy, false);
    Drawer.close();
  },

  _execute(wfId, entry) {
    const cfg=WF_CFG[wfId], wf=S.workflows[wfId];
    Gateway.clearAlert('A-'+wfId);
    UI.setPolicyViolated(cfg.policy, false);

    // Applied entry
    const applied = {
      id: entry.id+'-applied', type:'applied', ts:new Date(),
      title: entry.appliedTitle, workflow:cfg.name,
      lines: entry.appliedLines, comparison: entry.comparison,
    };
    this._addEntry(applied);

    S.metrics.savings += entry.projectedSavings;

    wf.baseline = wf.baseline || { reqs:wf.reqs, spend:wf.spend, avgCost:wf.reqs>0?wf.spend/wf.reqs:0 };
    wf.spendAtOpt = wf.spend;
    wf.reqsAtOpt  = wf.reqs;

    WorkflowEngine.activateOptimized(wfId);
    UI.refreshKPIs();
    setTimeout(()=>UI.refreshExec(), 1800);
  },

  _addEntry(entry) {
    S.entries.unshift(entry);
    UI.addAgentEntry(entry);
  },

  _buildEntry(wfId, req) {
    const cfg=WF_CFG[wfId];
    const s=cfg.scenario;

    if (s==='prompt-bloat') {
      const avgIn   = rndI(4400,5900);
      const base    = calcCost('claude-sonnet',950,270);
      const cur     = calcCost('claude-sonnet',avgIn,360);
      const daily   = (cur-base)*80;
      return {
        id:'AE-bloat-'+Date.now(), type:'anomaly', ts:new Date(),
        title:'PROMPT BLOAT DETECTED', workflow:cfg.name,
        alertTitle:'Prompt bloat — Document Assistant',
        alertMsg:`Input tokens averaging ${fmtTok(avgIn)} vs 1,500 policy ceiling.`,
        lines:[
          `${cfg.scenarioTrigger} consecutive requests exceeded policy ceiling.`,
          `Average input: ${fmtTok(avgIn)} tokens — policy max: 1,500 tokens.`,
          `Cost per request: ${fmtUSD(cur)} — ${(cur/base).toFixed(1)}× above baseline.`,
          `Policy violated: DOC-COST-001 (Max $0.08 per summarization request).`,
        ],
        suggestedAction:{
          name:'Context Pruning + Output Cap',
          desc:'Trim input to 1,500 tokens. Apply sliding-window summarization for long documents.',
          saving:`${fmtUSD(cur-base)}/request (74% reduction)`,
          tradeoff:'Summary may omit tertiary sections. Core content preserved.',
        },
        comparison:{
          before:{val:fmtUSD(cur),  sub:`${fmtTok(avgIn)} input tokens`},
          after: {val:fmtUSD(base), sub:'~1,200 tokens (trimmed)'},
          label:'Projected daily savings', saving:fmtUSD(daily),
        },
        projectedSavings:daily*.3,
        appliedTitle:'OPTIMIZATION APPLIED — CONTEXT PRUNING',
        appliedLines:[
          `Input context trimmed to 1,500 tokens per request.`,
          `Output cap set to 300 tokens.`,
          `Per-request cost: ${fmtUSD(cur)} → ${fmtUSD(base)} (74% reduction).`,
        ],
      };
    }

    if (s==='premium-overrouting') {
      const cheap   = calcCost('claude-haiku',225,90);
      const prem    = calcCost('claude-opus',225,90);
      const daily   = (prem-cheap)*5760*.70;
      return {
        id:'AE-routing-'+Date.now(), type:'anomaly', ts:new Date(),
        title:'PREMIUM MODEL OVER-ROUTING', workflow:cfg.name,
        alertTitle:'Premium over-routing — Support Copilot',
        alertMsg:`Claude Opus used for low-complexity (< 0.20) FAQ traffic.`,
        lines:[
          `Claude Opus used for requests with complexity score < 0.20.`,
          `Last ${cfg.scenarioTrigger} requests: avg complexity 0.14 (FAQ/greeting classification).`,
          `Cost per request: ${fmtUSD(prem)} — ${Math.round(prem/cheap)}× more expensive than Claude Haiku.`,
          `Policy violated: ROUTE-COST-002 (Model must match intent complexity).`,
        ],
        suggestedAction:{
          name:'Model Routing Optimization',
          desc:'Route requests with complexity < 0.40 to Claude Haiku. Retain Opus for complex queries.',
          saving:`${fmtUSD(prem-cheap)}/request on low-complexity traffic`,
          tradeoff:'A/B testing shows < 2% difference in user satisfaction on FAQ intent.',
        },
        comparison:{
          before:{val:fmtUSD(prem), sub:'Claude Opus (premium)'},
          after: {val:fmtUSD(cheap), sub:'Claude Haiku (efficient)'},
          label:'Estimated daily savings', saving:fmtUSD(daily),
        },
        projectedSavings:daily*.3,
        appliedTitle:'ACTION APPLIED — MODEL ROUTING UPDATED',
        appliedLines:[
          `Routing policy updated: complexity < 0.40 → Claude Haiku.`,
          `Claude Opus retained for complex queries and escalations.`,
          `Per-request cost: ${fmtUSD(prem)} → ${fmtUSD(cheap)} on low-complexity traffic.`,
        ],
      };
    }

    if (s==='retry-storm') {
      const per = req.cost, wasted=per*req.retries, prevented=per*(20-req.retries);
      return {
        id:'AE-retry-'+Date.now(), type:'anomaly', ts:new Date(),
        title:'RETRY STORM DETECTED', workflow:cfg.name,
        alertTitle:'Retry storm — Proposal Assistant',
        alertMsg:`${req.retries} retries in 45 seconds. Circuit breaker engaging.`,
        lines:[
          `Retry count on request ${req.id}: ${req.retries} retries in 45 seconds.`,
          `Root cause: Tool call timeout on knowledge-base API (avg 12s, threshold 3s).`,
          `Accumulated cost from retries: ${fmtUSD(wasted)} (${req.retries}× request cost).`,
          `Policy violated: RETRY-GUARD-001 (Max 3 retries per request).`,
        ],
        suggestedAction:{
          name:'Circuit Breaker',
          desc:'Pause workflow. Queue request for manual review. Alert workflow owner.',
          saving:`${fmtUSD(prevented)} in prevented retries`,
          tradeoff:'Workflow paused until manually resumed. Owner notified.',
        },
        comparison:{
          before:{val:`${req.retries} retries`, sub:fmtUSD(wasted)+' wasted'},
          after: {val:'3 max retries', sub:'Circuit breaker active'},
          label:'Spend prevented', saving:fmtUSD(prevented),
        },
        projectedSavings:prevented,
        appliedTitle:'CIRCUIT BREAKER ENGAGED',
        appliedLines:[
          `Workflow paused. Retry loop halted at ${req.retries} retries.`,
          `${fmtUSD(prevented)} in future retries prevented.`,
          `Root cause: knowledge-base API latency spike — likely upstream.`,
          `Recommendation: Increase timeout threshold or add cached fallback.`,
          `Workflow status: PAUSED — click "Resume" on the card when ready.`,
        ],
      };
    }
    return null;
  },
};

// ════════════════════════════════════════════════════════
// DRAWER
// ════════════════════════════════════════════════════════

const Drawer = {
  open(reqId) {
    const req=S.requests.find(r=>r.id===reqId);
    if (!req) return;
    q('drawerTitle').textContent='Request Inspection';
    q('drawerBody').innerHTML = this._reqHTML(req);
    q('drawer').classList.add('open');
    q('drawerScrim').classList.add('show');
  },

  openApproval(apId) {
    const ap=S.approvals.get(apId);
    if (!ap) return;
    q('drawerTitle').textContent='Agent Recommendation';
    q('drawerBody').innerHTML = this._apHTML(ap);
    q('drawer').classList.add('open');
    q('drawerScrim').classList.add('show');
  },

  close() {
    q('drawer').classList.remove('open');
    q('drawerScrim').classList.remove('show');
  },

  _reqHTML(req) {
    const cfg=WF_CFG[req.wfId], m=MODELS[req.model];
    const policyMax={'doc-summarizer':0.08,'support-copilot':0.05,'proposal-assistant':0.20};
    const max=policyMax[req.wfId]||0.12;
    const over=req.cost>max?req.cost-max:0;

    // Find pending approval for this workflow
    const ap=[...S.approvals.values()].find(a=>a.wfId===req.wfId&&a.status==='pending');
    const actionHTML = ap ? `
      <div class="drawer-section">
        <h3>Suggested Action</h3>
        <div class="drawer-action-name">${ap.entry.suggestedAction.name}</div>
        <div class="drawer-action-desc">${ap.entry.suggestedAction.desc}</div>
        <div class="drawer-action-saving">💰 ${ap.entry.suggestedAction.saving}</div>
        <div class="drawer-action-trade">⚖ Trade-off: ${ap.entry.suggestedAction.tradeoff}</div>
        <div class="drawer-action-btns">
          <button class="btn-approve" onclick="Agent.approve('${ap.id}')">✓ Approve Optimization</button>
          <button class="btn-reject"  onclick="Agent.reject('${ap.id}')">✕ Reject</button>
        </div>
      </div>` : '';

    const diagHTML = req.anomaly ? `
      <div class="drawer-section">
        <h3>Agent Diagnosis</h3>
        <div class="drawer-diagnosis">${this._diag(req)}</div>
      </div>` : '';

    return `
      <div class="drawer-section">
        <div class="drawer-req-id">${req.id}</div>
        <div class="drawer-req-meta">
          <span style="color:${cfg.color}">${cfg.icon} ${cfg.name}</span>
          <span>${fmtTime(req.ts)}</span>
        </div>
        <div class="drawer-req-tags">
          <span class="model-pill ${m.tier}">${m.label}</span>
          ${req.cache   ? '<span class="tag-cache">Cached</span>'   : ''}
          ${req.retries ? `<span class="tag-retry">Retry ×${req.retries}</span>` : ''}
          ${req.flagged ? '<span class="tag-flagged">⚠ Flagged</span>' : ''}
        </div>
      </div>
      <div class="drawer-section">
        <h3>Token Breakdown</h3>
        <div class="drawer-metric"><span class="key">Input tokens</span><span class="${req.inTok>2000?'val-hi':'val-mono'}">${fmtTok(req.inTok)}</span></div>
        <div class="drawer-metric"><span class="key">Output tokens</span><span class="val-mono">${fmtTok(req.outTok)}</span></div>
        <div class="drawer-metric"><span class="key">Total tokens</span><span class="val-mono">${fmtTok(req.inTok+req.outTok)}</span></div>
        ${req.retries?`<div class="drawer-metric"><span class="key">Retries</span><span class="val-hi">×${req.retries}</span></div>`:''}
      </div>
      <div class="drawer-section">
        <h3>Cost Analysis</h3>
        <div class="drawer-metric"><span class="key">This request</span><span class="${req.cost>max?'val-hi':'val-mono'}">${fmtUSD(req.cost)}</span></div>
        <div class="drawer-metric"><span class="key">Policy ceiling</span><span class="val-mono">${fmtUSD(max)}</span></div>
        ${over>0?`<div class="drawer-metric"><span class="key">Overage</span><span class="val-hi">+${fmtUSD(over)} (+${Math.round(over/max*100)}%)</span></div>`:''}
        <div class="drawer-metric"><span class="key">Model tier</span><span class="tier-${m.tier}">${m.tier}</span></div>
      </div>
      ${diagHTML}${actionHTML}`;
  },

  _apHTML(ap) {
    const e=ap.entry;
    return `
      <div class="drawer-section">
        <div class="drawer-req-id" style="font-size:14px">${e.title}</div>
        <div class="drawer-req-meta"><span>${e.workflow}</span><span>${fmtTime(e.ts)}</span></div>
      </div>
      <div class="drawer-section">
        <h3>Detection</h3>
        ${e.lines.map(l=>`<div class="drawer-diag-line">${l}</div>`).join('')}
      </div>
      <div class="drawer-section">
        <h3>Proposed Action</h3>
        <div class="drawer-action-name">${e.suggestedAction.name}</div>
        <div class="drawer-action-desc">${e.suggestedAction.desc}</div>
        <div class="drawer-action-saving">💰 ${e.suggestedAction.saving}</div>
        <div class="drawer-action-trade">⚖ Trade-off: ${e.suggestedAction.tradeoff}</div>
        <div class="drawer-action-btns">
          <button class="btn-approve" onclick="Agent.approve('${ap.id}')">✓ Approve</button>
          <button class="btn-reject"  onclick="Agent.reject('${ap.id}')">✕ Reject</button>
        </div>
      </div>`;
  },

  _diag(req) {
    if (req.anomaly==='prompt-bloat')
      return `Full document body (${fmtTok(req.inTok)} tokens) sent as context. Policy DOC-COST-001 requires max 1,500 input tokens. Consider chunking documents before sending.`;
    if (req.anomaly==='premium-overrouting')
      return `Request complexity score ${req.complexity.toFixed(2)} is below the 0.35 threshold. Claude Opus is ${Math.round(calcCost('claude-opus',225,90)/calcCost('claude-haiku',225,90))}× more expensive than Claude Haiku for the same intent classification task.`;
    if (req.retries)
      return `Request entered retry loop after tool call timeout. ${req.retries} retries attempted. Policy RETRY-GUARD-001 limits retries to 3.`;
    return 'Anomalous cost pattern detected. See agent console for full diagnosis.';
  },
};

// ════════════════════════════════════════════════════════
// UI
// ════════════════════════════════════════════════════════

const UI = {
  refreshKPIs() {
    const m=S.metrics, rpm=S.minReqs.length;
    const cacheRate = m.reqs>0 ? Math.round(m.cache/m.reqs*100) : 0;
    const savPct    = m.spend>0 ? Math.round(m.savings/(m.spend+m.savings)*100) : 0;
    const alerts    = S.alerts.filter(a=>!a.cleared&&a.type==='crit').length;

    q('kpiSpend').textContent   = fmtUSD(m.spend);
    q('kpiReqs').textContent    = m.reqs.toLocaleString();
    q('kpiReqRate').textContent = rpm+' req/min';
    q('kpiCacheRate').textContent = cacheRate+'% cache';
    q('kpiAlerts').textContent  = alerts;
    q('kpiSavings').textContent = fmtUSD(m.savings);
    q('kpiSavingsPct').textContent = m.savings>0 ? savPct+'% of spend' : '—';
    q('streamCount').textContent = m.reqs+' requests';
    q('kpiAlertCard').classList.toggle('has-alert', alerts>0);
  },

  setWFStatus(id, status) {
    const card=q('card-'+id), dot=q('dot-'+id), badge=q('badge-'+id), btn=q('btn-'+id);
    card.className='wf-card'+(status!=='idle'?' wf-'+status:'');
    dot.className ='wf-dot '+status;
    badge.className='wf-badge '+status;
    const labels={idle:'IDLE',running:'RUNNING',anomaly:'ANOMALY DETECTED',paused:'PAUSED',optimized:'OPTIMIZED'};
    const btns  ={idle:'▶ Run Workflow',running:'⏸ Stop',anomaly:'⏸ Stop',paused:'▶ Resume',optimized:'⏸ Stop'};
    badge.textContent=labels[status]||'IDLE';
    btn.textContent  =btns[status]||'▶ Run Workflow';
  },

  refreshWFCard(id) {
    const wf=S.workflows[id], el=q('stats-'+id);
    if (!el) return;
    if (wf.reqs===0){ el.innerHTML='—'; return; }
    const avg=wf.spend/wf.reqs;
    el.innerHTML=`<span>${wf.reqs} requests</span><span>${fmtUSD(wf.spend)} total</span><span>avg ${fmtUSD(avg)}/req</span>`;
  },

  addReqRow(req) {
    const tbody=q('reqBody');
    const emp=tbody.querySelector('.empty-row'); if(emp) emp.remove();

    const cfg=WF_CFG[req.wfId], m=MODELS[req.model];
    const cCls=req.cost>.10?'hi':req.cost>.04?'mid':'';
    const rCls=req.status==='circuit'?'row-crit':req.flagged?'row-warn':req.status==='optimized'?'row-opt':'';

    const stMap={ok:{l:'OK',c:'ok'},flagged:{l:'Flagged',c:'flagged'},retrying:{l:`Retry ${req.retries}`,c:'retrying'},circuit:{l:'Circuit Break',c:'circuit'},optimized:{l:'Optimized',c:'optimized'}};
    const st=stMap[req.status]||stMap.ok;

    const inspBtn=(req.flagged||req.retries>0)?`<button class="inspect-btn" onclick="Drawer.open('${req.id}')">Inspect</button>`:'';

    const tr=document.createElement('tr');
    tr.className=`req-row new ${rCls}`;
    if(req.flagged||req.retries>0){ tr.style.cursor='pointer'; tr.onclick=()=>Drawer.open(req.id); }
    tr.innerHTML=`
      <td class="time-col">${fmtTime(req.ts)}</td>
      <td><span class="uc-lbl" style="color:${cfg.color}">${cfg.icon} ${cfg.name}</span></td>
      <td><span class="model-pill ${m.tier}">${m.label}</span></td>
      <td class="tok-col">
        <span class="tok-in">↑${fmtTok(req.inTok)}</span>
        <span class="tok-out">↓${fmtTok(req.outTok)}</span>
        ${req.cache  ?'<span class="tag-cache">cached</span>':''}
        ${req.retries?`<span class="tag-retry">×${req.retries}</span>`:''}
      </td>
      <td class="cost-col ${cCls}">${fmtUSD(req.cost)}</td>
      <td><span class="status-pill ${st.c}">${st.l}</span></td>
      <td>${inspBtn}</td>`;

    tbody.insertBefore(tr, tbody.firstChild);
    setTimeout(()=>tr.classList.remove('new'), 400);
    while(tbody.children.length>26) tbody.removeChild(tbody.lastChild);
  },

  refreshAlerts() {
    const active=S.alerts.filter(a=>!a.cleared);
    const el=q('alertsList');
    if(!active.length){ el.innerHTML='<div class="empty-cell" style="padding:18px">No alerts</div>'; return; }
    el.innerHTML=active.map(a=>`
      <div class="alert-card ${a.type==='crit'?'crit':''}">
        <div class="alert-ico">${a.type==='crit'?'⚠':'ℹ'}</div>
        <div class="alert-body">
          <div class="alert-title">${a.title}</div>
          <div class="alert-msg">${a.msg}</div>
          <div class="alert-time">${fmtTime(a.ts)}</div>
        </div>
        ${a.type==='crit'?`<div class="alert-view"><button class="inspect-btn" onclick="UI.switchTab('agent')">View →</button></div>`:''}
      </div>`).join('');
  },

  addAgentEntry(entry) {
    const feed=q('agentFeed');
    const idle=feed.querySelector('.agent-idle'); if(idle) idle.remove();

    const tMap={
      anomaly:          {ico:'🔍',pLbl:'DETECTED',   pCls:'p-anomaly',   eCls:'ae-anomaly'},
      'approval-required':{ico:'💡',pLbl:'NEEDS APPROVAL',pCls:'p-approval',eCls:'ae-approval'},
      autonomous:       {ico:'⚡',pLbl:'AUTO-APPLIED',pCls:'p-autonomous',eCls:'ae-autonomous'},
      applied:          {ico:'✅',pLbl:'APPLIED',     pCls:'p-applied',   eCls:'ae-applied'},
      rejected:         {ico:'✕', pLbl:'REJECTED',   pCls:'p-rejected',  eCls:'ae-rejected'},
      info:             {ico:'ℹ', pLbl:'INFO',        pCls:'p-info',      eCls:'ae-info'},
    };
    const t=tMap[entry.type]||tMap.info;

    const linesHTML=(entry.lines||[]).map(l=>
      l===''?'<div class="ae-spacer"></div>':`<div class="ae-line">${l}</div>`).join('');

    let cmpHTML='';
    if(entry.comparison){
      const c=entry.comparison;
      cmpHTML=`<div class="comparison">
        <div class="cmp-col"><div class="cmp-lbl">BEFORE</div><div class="cmp-val hi">${c.before.val}</div><div class="cmp-sub">${c.before.sub}</div></div>
        <div class="cmp-arrow">→</div>
        <div class="cmp-col"><div class="cmp-lbl">AFTER</div><div class="cmp-val lo">${c.after.val}</div><div class="cmp-sub">${c.after.sub}</div></div>
        <div class="cmp-savings"><div class="cmp-sav-lbl">${c.label}</div><div class="cmp-sav-val">${c.saving}</div></div>
      </div>`;
    }

    let actHTML='';
    if(entry.actionType==='approval-required' && entry.approved==null){
      actHTML=`<div class="ae-actions">
        <button class="btn-approve" onclick="Agent.approve('${entry.approvalId}')">✓ Approve Optimization</button>
        <button class="btn-reject"  onclick="Agent.reject('${entry.approvalId}')">✕ Reject</button>
        <button class="btn-details" onclick="Drawer.openApproval('${entry.approvalId}')">Full details →</button>
      </div>`;
    }

    const div=document.createElement('div');
    div.className=`agent-entry new ${t.eCls}`;
    div.setAttribute('data-eid', entry.id);
    div.innerHTML=`
      <div class="ae-head">
        <span class="ae-ico">${t.ico}</span>
        <div class="ae-titles">
          <span class="ae-pill ${t.pCls}">${t.pLbl}</span>
          <span class="ae-title">${entry.title}</span>
        </div>
        <span class="ae-time">${fmtTime(entry.ts)}</span>
      </div>
      ${entry.workflow?`<div class="ae-wf">Workflow: ${entry.workflow}</div>`:''}
      <div class="ae-body">${linesHTML}</div>
      ${cmpHTML}${actHTML}`;

    feed.insertBefore(div, feed.firstChild);
    setTimeout(()=>div.classList.remove('new'), 500);
    while(feed.children.length>30) feed.removeChild(feed.lastChild);
  },

  updateEntry(entry) {
    const el=document.querySelector(`[data-eid="${entry.id}"]`);
    if(!el) return;
    const pill=el.querySelector('.ae-pill');
    const acts=el.querySelector('.ae-actions');
    if(entry.approved===true){
      if(pill){ pill.className='ae-pill p-applied'; pill.textContent='APPROVED'; }
      if(acts) acts.innerHTML='<div class="ae-approved-badge">✓ Optimization approved</div>';
    } else if(entry.approved===false){
      if(pill){ pill.className='ae-pill p-rejected'; pill.textContent='REJECTED'; }
      if(acts) acts.innerHTML='<div class="ae-rejected-badge">✕ Rejected — no changes applied</div>';
      el.className=el.className.replace('ae-approval','ae-rejected');
    }
  },

  setPolicyViolated(policyId, v) {
    const el=q('pdot-'+policyId);
    if(el) el.className='policy-dot '+(v?'violated':'ok');
  },

  refreshExec() {
    const m=S.metrics;
    if(!S.entries.some(e=>e.type==='applied')) return;

    const savPct  = m.spend>0?Math.round(m.savings/(m.spend+m.savings)*100):0;
    const cacheRt = m.reqs>0?Math.round(m.cache/m.reqs*100):0;
    const avgCost = m.reqs>0?m.spend/m.reqs:0;

    const narratives={
      'prompt-bloat':       'Document Assistant was sending full document bodies (4,000–6,000 tokens) instead of pre-chunked sections, violating policy DOC-COST-001. Context pruning intervention reduced input tokens by 74% while preserving core summary quality.',
      'premium-overrouting':'Support Copilot was routing all traffic — including simple FAQ intents (complexity < 0.20) — to Claude Opus. Model routing optimization redirected low-complexity traffic to Claude Haiku, a model suited to intent classification.',
      'retry-storm':        'Proposal Assistant entered a retry loop after a knowledge-base API timeout. 8 retries in 45 seconds multiplied spend with no output value. Circuit breaker halted the loop and preserved budget pending root-cause resolution.',
    };

    const wfCards = Object.entries(WF_CFG).map(([id,cfg])=>{
      const wf=S.workflows[id];
      const applied=S.entries.find(e=>e.type==='applied'&&e.id.includes(id.split('-')[0]));
      if(!applied) return '';

      const bAvg=wf.baseline?wf.baseline.avgCost:0;
      const aReqs=wf.reqs-(wf.reqsAtOpt||wf.reqs);
      const aSpend=wf.spend-(wf.spendAtOpt||wf.spend);
      const aAvg=aReqs>0?aSpend/aReqs:0;
      const pct=bAvg>0&&aAvg>0?Math.round((1-aAvg/bAvg)*100):0;

      const baHTML=bAvg>0?`
        <div class="exec-ba">
          <div class="exec-ba-col"><div class="exec-ba-lbl">BEFORE</div><div class="exec-ba-val hi">${fmtUSD(bAvg)}/req</div></div>
          <div class="exec-ba-arrow">→</div>
          <div class="exec-ba-col"><div class="exec-ba-lbl">AFTER</div><div class="exec-ba-val lo">${fmtUSD(aAvg||bAvg*.28)}/req</div></div>
          <div class="exec-ba-saving"><div class="exec-ba-sav-lbl">Cost reduction</div><div class="exec-ba-sav-val">${pct||72}%</div></div>
        </div>`:'';

      return `<div class="exec-wf-card">
        <div class="exec-wf-title">${cfg.name}</div>
        <div class="exec-wf-type">${cfg.scenario.replace(/-/g,' ').toUpperCase()} · ${applied.id.includes('applied')?'Optimization applied':''}</div>
        ${baHTML}
        <div class="exec-narrative">${narratives[cfg.scenario]||''}</div>
      </div>`;
    }).filter(Boolean).join('');

    q('execContent').innerHTML=`
      <div class="exec-stats-row">
        <div class="exec-stat"><div class="exec-stat-val">${fmtUSD(m.spend)}</div><div class="exec-stat-lbl">Total AI spend</div></div>
        <div class="exec-stat green"><div class="exec-stat-val">${fmtUSD(m.savings)}</div><div class="exec-stat-lbl">Savings captured (${savPct}%)</div></div>
        <div class="exec-stat"><div class="exec-stat-val">${fmtUSD(avgCost)}</div><div class="exec-stat-lbl">Avg cost per request</div></div>
        <div class="exec-stat"><div class="exec-stat-val">${cacheRt}%</div><div class="exec-stat-lbl">Cache hit rate</div></div>
      </div>
      ${wfCards}
      <div class="exec-tagline">Every token this session became observable, interpretable, and governable.</div>`;
  },

  switchTab(id) {
    document.querySelectorAll('.tab-btn').forEach(b=>b.classList.toggle('active',b.dataset.tab===id));
    document.querySelectorAll('.tab-panel').forEach(p=>p.classList.toggle('active',p.id==='tab-'+id));
  },

  showBadge(n) { const b=q('agentBadge'); b.textContent=n; b.classList.remove('hidden'); },
  hideBadge()  { q('agentBadge').classList.add('hidden'); },
  setLive(on)  {
    const c=q('liveChip'), l=q('liveLabel');
    c.classList.toggle('active',on);
    l.textContent=on?'Live':'Ready';
  },
};

// ════════════════════════════════════════════════════════
// SETTINGS & CONTROLS
// ════════════════════════════════════════════════════════

function toggleAutoApply() {
  S.autoApply=!S.autoApply;
  q('autoApplyToggle').classList.toggle('on',S.autoApply);
  const cb=q('autoApplyCb'); if(cb) cb.checked=S.autoApply;
}

function toggleTheme() {
  const h=document.documentElement;
  const next=h.getAttribute('data-theme')==='dark'?'light':'dark';
  h.setAttribute('data-theme',next);
  localStorage.setItem('tokenops-theme',next);
  q('themeBtn').textContent=next==='dark'?'☀':'⏾';
}

// ════════════════════════════════════════════════════════
// APP RESET
// ════════════════════════════════════════════════════════

const App = {
  reset() {
    Object.values(S.workflows).forEach(wf=>clearTimeout(wf.timer));
    S.workflows=mkAllWF();
    S.requests=[]; S.alerts=[]; S.entries=[]; S.approvals=new Map();
    S.metrics={spend:0,reqs:0,cache:0,alerts:0,savings:0};
    S.reqSeq=1; S.minReqs=[];

    Object.keys(WF_CFG).forEach(id=>{
      UI.setWFStatus(id,'idle');
      UI.refreshWFCard(id);
      UI.setPolicyViolated(WF_CFG[id].policy,false);
    });

    q('reqBody').innerHTML='<tr class="empty-row"><td colspan="7" class="empty-cell">Run a workflow to see live requests</td></tr>';
    q('agentFeed').innerHTML='<div class="agent-idle"><div class="agent-idle-ico">🔍</div><div>Start a workflow to see the agent in action.</div></div>';
    q('alertsList').innerHTML='<div class="empty-cell" style="padding:18px">No alerts</div>';
    q('execContent').innerHTML='<div class="exec-empty"><div style="font-size:32px;margin-bottom:10px">📊</div><div>Run a workflow and approve an optimization to see the impact summary.</div></div>';

    UI.refreshKPIs();
    UI.hideBadge();
    UI.setLive(false);
    UI.switchTab('operations');
    Drawer.close();
  },
};

// ════════════════════════════════════════════════════════
// INIT
// ════════════════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', ()=>{
  const saved=localStorage.getItem('tokenops-theme')||'dark';
  document.documentElement.setAttribute('data-theme',saved);
  const tb=q('themeBtn'); if(tb) tb.textContent=saved==='dark'?'☀':'⏾';

  document.querySelectorAll('.tab-btn').forEach(b=>{
    b.addEventListener('click',()=>UI.switchTab(b.dataset.tab));
  });

  setInterval(()=>{
    S.minReqs=S.minReqs.filter(t=>Date.now()-t<60000);
    UI.refreshKPIs();
  }, 2000);
});
