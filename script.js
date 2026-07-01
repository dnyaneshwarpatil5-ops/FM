/* ---------------------------------------------------------
   window.storage SHIM
   The original app was built inside a Claude Artifact, which
   provides a built-in window.storage key/value API. Now that
   this app is split into plain index.html/style.css/script.js
   files for standalone hosting, that API doesn't exist — so we
   polyfill it here on top of localStorage. Behavior matches the
   original: get() rejects when a key is missing (callers already
   catch this and fall back to an empty array/object).
--------------------------------------------------------- */
if (!window.storage) {
  window.storage = {
    async get(key, shared) {
      const raw = localStorage.getItem('fm_' + key);
      if (raw === null) throw new Error('Key not found: ' + key);
      return { key, value: raw, shared: !!shared };
    },
    async set(key, value, shared) {
      localStorage.setItem('fm_' + key, value);
      return { key, value, shared: !!shared };
    },
    async delete(key, shared) {
      const existed = localStorage.getItem('fm_' + key) !== null;
      localStorage.removeItem('fm_' + key);
      return { key, deleted: existed, shared: !!shared };
    },
    async list(prefix, shared) {
      const p = 'fm_' + (prefix || '');
      const keys = Object.keys(localStorage)
        .filter(k => k.startsWith(p))
        .map(k => k.slice(3));
      return { keys, prefix, shared: !!shared };
    }
  };
}

window.FACILITY_MANAGER_ADDED_FEATURES = {
  photoAttachment:true,
  cameraIntegration:true,
  qrEquipment:true,
  amcTracker:true,
  vendorManagement:true,
  attendanceRegister:true,
  assetManagement:true,
  ppmInvoiceNotifications:true,
  googleDriveBackup:true,
  pdfReports:true,
  excelImportExport:true
};
/* ---------------------------------------------------------
   FACILITY MANAGER — single-file mobile web app
   Persistence: window.storage (personal, per device/browser)
--------------------------------------------------------- */

const STORAGE_KEYS = ['snags','tasks','ppm','monthlyreq','invoices','brsr','ghg','permits','attendance','counters'];
let DATA = { snags:[], tasks:[], ppm:[], monthlyreq:[], invoices:[], brsr:[], ghg:[], permits:[], attendance:[] };
let COUNTERS = {};
let currentTab = 'dashboard';
let activeFilter = 'All';
let gSync = { clientId:'', spreadsheetId:'', accessToken:'', tokenClient:null };
let gFire = { configText:'', autoSync:true, user:null, authListenerAttached:false };

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const thisYear = new Date().getFullYear();

function uid(){ return Math.random().toString(36).slice(2,9); }
function todayISO(){ return new Date().toISOString().slice(0,10); }
function fmtDate(d){
  if(!d) return '—';
  const dt = new Date(d+'T00:00:00');
  if(isNaN(dt)) return d;
  return dt.toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'});
}
function daysFromFrequency(f){
  return {Daily:1,Weekly:7,Monthly:30,Quarterly:90,'Half-Yearly':182,Yearly:365}[f] || 30;
}
function addDays(iso, n){
  const dt = new Date(iso+'T00:00:00');
  dt.setDate(dt.getDate()+n);
  return dt.toISOString().slice(0,10);
}

/* ----------------- MODULE DEFINITIONS ----------------- */
const MODULES = {
  snags: {
    label:'Snag Points', prefix:'SNAG', icon:'⚠',
    titleField:'title', badgeField:'severity',
    badgeColors:{Low:'var(--success)',Medium:'var(--accent-deep)',High:'#B5651D',Critical:'var(--danger)'},
    filterField:'status', filterOptions:['All','Open','In Progress','Resolved'],
    metaFields:['location','assignedTo','dateReported'],
    fields:[
      {key:'title',label:'Snag title',type:'text',required:true,placeholder:'e.g. Transformer oil leak'},
      {key:'location',label:'Location',type:'text',placeholder:'e.g. Substation, B-Block'},
      {key:'description',label:'Description',type:'textarea'},
      {key:'severity',label:'Severity',type:'select',options:['Low','Medium','High','Critical'],default:'Medium'},
      {key:'status',label:'Status',type:'select',options:['Open','In Progress','Resolved'],default:'Open'},
      {key:'reportedBy',label:'Reported by',type:'text'},
      {key:'assignedTo',label:'Assigned to',type:'text'},
      {key:'dateReported',label:'Date reported',type:'date',default:()=>todayISO()},
      {key:'dateResolved',label:'Date resolved',type:'date'},
    ],
  },
  tasks: {
    label:'Task Management', prefix:'TASK', icon:'✓',
    titleField:'title', badgeField:'status',
    badgeColors:{'To Do':'var(--neutral)','In Progress':'var(--accent-deep)','Done':'var(--success)'},
    filterField:'status', filterOptions:['All','To Do','In Progress','Done'],
    metaFields:['assignedTo','priority','dueDate'],
    fields:[
      {key:'title',label:'Task title',type:'text',required:true},
      {key:'description',label:'Description',type:'textarea'},
      {key:'assignedTo',label:'Assigned to',type:'text'},
      {key:'priority',label:'Priority',type:'select',options:['Low','Medium','High'],default:'Medium'},
      {key:'dueDate',label:'Due date',type:'date'},
      {key:'status',label:'Status',type:'select',options:['To Do','In Progress','Done'],default:'To Do'},
      {key:'notes',label:'Notes',type:'textarea'},
    ],
  },
  ppm: {
    label:'PPM Management', prefix:'PPM', icon:'⚙',
    titleField:'equipmentName', badgeField:'__computedStatus',
    badgeColors:{'Overdue':'var(--danger)','Due Soon':'var(--accent-deep)','OK':'var(--success)','Not Scheduled':'var(--neutral)'},
    filterField:'__computedStatus', filterOptions:['All','Overdue','Due Soon','OK','Not Scheduled'],
    metaFields:['equipmentType','frequency','nextDue'],
    fields:[
      {key:'equipmentName',label:'Equipment name',type:'text',required:true,placeholder:'e.g. DG Set 1, 500kVA'},
      {key:'equipmentType',label:'Equipment type',type:'select',options:['Transformer','Diesel Generator','HVAC','Fire System','Electrical Panel','Pump','Other'],default:'Other'},
      {key:'frequency',label:'PPM frequency',type:'select',options:['Daily','Weekly','Monthly','Quarterly','Half-Yearly','Yearly'],default:'Monthly'},
      {key:'lastDone',label:'Last done',type:'date'},
      {key:'nextDue',label:'Next due (auto if left blank)',type:'date'},
      {key:'notes',label:'Checklist / notes',type:'textarea'},
    ],
    computeStatus(r){
      if(!r.nextDue) return 'Not Scheduled';
      const today = todayISO();
      const days = (new Date(r.nextDue) - new Date(today))/86400000;
      if(days < 0) return 'Overdue';
      if(days <= 7) return 'Due Soon';
      return 'OK';
    },
    beforeSave(r){
      if(r.lastDone && !r.nextDue){
        r.nextDue = addDays(r.lastDone, daysFromFrequency(r.frequency));
      }
    }
  },
  monthlyreq: {
    label:'Monthly Requirement', prefix:'MREQ', icon:'🗒',
    titleField:'item', badgeField:'status',
    badgeColors:{Requested:'var(--neutral)',Approved:'var(--info)',Ordered:'var(--accent-deep)',Received:'var(--success)'},
    filterField:'status', filterOptions:['All','Requested','Approved','Ordered','Received'],
    metaFields:['category','quantityDisplay','period'],
    fields:[
      {key:'item',label:'Item / requirement',type:'text',required:true,placeholder:'e.g. Diesel, Spare bearings'},
      {key:'category',label:'Category',type:'text',placeholder:'e.g. Consumables, Spares, Tools'},
      {key:'quantity',label:'Quantity',type:'number'},
      {key:'unit',label:'Unit',type:'text',placeholder:'e.g. Ltr, Nos, Kg'},
      {key:'month',label:'Month',type:'select',options:MONTHS,default:MONTHS[new Date().getMonth()]},
      {key:'year',label:'Year',type:'number',default:thisYear},
      {key:'status',label:'Status',type:'select',options:['Requested','Approved','Ordered','Received'],default:'Requested'},
      {key:'requestedBy',label:'Requested by',type:'text'},
      {key:'notes',label:'Notes',type:'textarea'},
    ],
    derive(r){
      r.quantityDisplay = [r.quantity,r.unit].filter(Boolean).join(' ');
      r.period = [r.month,r.year].filter(Boolean).join(' ');
    }
  },
  invoices: {
    label:'Invoice Process', prefix:'INV', icon:'₹',
    titleField:'vendor', badgeField:'status',
    badgeColors:{Pending:'var(--neutral)',Approved:'var(--info)',Paid:'var(--success)',Rejected:'var(--danger)'},
    filterField:'status', filterOptions:['All','Pending','Approved','Paid','Rejected'],
    metaFields:['invoiceNo','amountDisplay','dueDate'],
    fields:[
      {key:'vendor',label:'Vendor name',type:'text',required:true},
      {key:'invoiceNo',label:'Invoice number',type:'text'},
      {key:'category',label:'Category',type:'text',placeholder:'e.g. AMC, Spares, Services'},
      {key:'amount',label:'Amount (₹)',type:'number'},
      {key:'invoiceDate',label:'Invoice date',type:'date'},
      {key:'dueDate',label:'Due date',type:'date'},
      {key:'status',label:'Status',type:'select',options:['Pending','Approved','Paid','Rejected'],default:'Pending'},
      {key:'notes',label:'Notes',type:'textarea'},
    ],
    derive(r){ r.amountDisplay = r.amount ? '₹'+Number(r.amount).toLocaleString('en-IN') : ''; }
  },
  brsr: {
    label:'BRSR Data', prefix:'BRSR', icon:'🌐',
    titleField:'metric', badgeField:'category',
    badgeColors:{Environment:'var(--success)',Social:'var(--info)',Governance:'var(--accent-deep)'},
    filterField:'category', filterOptions:['All','Environment','Social','Governance'],
    metaFields:['valueDisplay','period'],
    fields:[
      {key:'category',label:'BRSR category',type:'select',options:['Environment','Social','Governance'],required:true},
      {key:'metric',label:'Metric',type:'text',required:true,placeholder:'e.g. Energy consumption, Safety incidents'},
      {key:'value',label:'Value',type:'number'},
      {key:'unit',label:'Unit',type:'text',placeholder:'e.g. GJ, KL, Nos, %'},
      {key:'month',label:'Month',type:'select',options:MONTHS,default:MONTHS[new Date().getMonth()]},
      {key:'year',label:'Year',type:'number',default:thisYear},
      {key:'notes',label:'Notes',type:'textarea'},
    ],
    derive(r){
      r.valueDisplay = [r.value,r.unit].filter(Boolean).join(' ');
      r.period = [r.month,r.year].filter(Boolean).join(' ');
    }
  },
  ghg: {
    label:'GHG Emissions', prefix:'GHG', icon:'🍃',
    titleField:'source', badgeField:'scope',
    badgeColors:{'Scope 1 - Direct':'var(--danger)','Scope 2 - Electricity':'var(--info)','Scope 3 - Other':'var(--neutral)'},
    filterField:'scope', filterOptions:['All','Scope 1 - Direct','Scope 2 - Electricity','Scope 3 - Other'],
    metaFields:['quantityDisplay','co2eDisplay','period'],
    fields:[
      {key:'scope',label:'Scope',type:'select',options:['Scope 1 - Direct','Scope 2 - Electricity','Scope 3 - Other'],required:true},
      {key:'source',label:'Source',type:'text',required:true,placeholder:'e.g. DG diesel, Grid electricity'},
      {key:'quantity',label:'Quantity consumed',type:'number'},
      {key:'unit',label:'Unit',type:'text',placeholder:'e.g. Litre, kWh'},
      {key:'emissionFactor',label:'Emission factor (kg CO2e per unit)',type:'number',
        hint:'Typical approx. values — confirm against your latest CEA / GHG Protocol factor: Diesel ≈ 2.68, Petrol ≈ 2.31, India grid electricity ≈ 0.7–0.85 per kWh.'},
      {key:'month',label:'Month',type:'select',options:MONTHS,default:MONTHS[new Date().getMonth()]},
      {key:'year',label:'Year',type:'number',default:thisYear},
      {key:'notes',label:'Notes',type:'textarea'},
    ],
    derive(r){
      const co2e = (Number(r.quantity)||0) * (Number(r.emissionFactor)||0);
      r.co2e = co2e;
      r.quantityDisplay = [r.quantity,r.unit].filter(Boolean).join(' ');
      r.co2eDisplay = co2e ? co2e.toLocaleString('en-IN',{maximumFractionDigits:1})+' kg CO2e' : '';
      r.period = [r.month,r.year].filter(Boolean).join(' ');
    }
  },
  permits: {
    label:'Permit Tracker', prefix:'PMT', icon:'🪪',
    titleField:'permitName', badgeField:'__computedStatus',
    badgeColors:{'Expired':'var(--danger)','Expiring Soon':'var(--accent-deep)','Valid':'var(--success)','Not Set':'var(--neutral)'},
    filterField:'__computedStatus', filterOptions:['All','Expired','Expiring Soon','Valid','Not Set'],
    metaFields:['permitType','issuingAuthority','expiryDate'],
    fields:[
      {key:'permitName',label:'Permit / license name',type:'text',required:true,placeholder:'e.g. Fire NOC, Lift License'},
      {key:'permitType',label:'Permit type',type:'select',
        options:['Fire NOC','Lift License','Electrical License','Consent to Operate (Pollution)','Labour License','DG Set Permit','Building Occupancy','Other'],
        default:'Other'},
      {key:'permitNumber',label:'Permit / license number',type:'text'},
      {key:'issuingAuthority',label:'Issuing authority',type:'text',placeholder:'e.g. MSEB, Fire Dept, MPCB'},
      {key:'issueDate',label:'Issue date',type:'date'},
      {key:'expiryDate',label:'Expiry date',type:'date'},
      {key:'renewalReminderDays',label:'Remind me (days before expiry)',type:'number',default:30,
        hint:'Status shows "Expiring Soon" once expiry is within this many days.'},
      {key:'responsiblePerson',label:'Responsible person',type:'text'},
      {key:'notes',label:'Notes / document reference',type:'textarea'},
    ],
    computeStatus(r){
      if(!r.expiryDate) return 'Not Set';
      const today = todayISO();
      const days = (new Date(r.expiryDate) - new Date(today))/86400000;
      const lead = Number(r.renewalReminderDays)||30;
      if(days < 0) return 'Expired';
      if(days <= lead) return 'Expiring Soon';
      return 'Valid';
    }
  },
  attendance: {
    label:'Daily Attendance', prefix:'ATT', icon:'🕘',
    titleField:'employeeName', badgeField:'status',
    badgeColors:{Present:'var(--success)',Absent:'var(--danger)','Half Day':'var(--accent-deep)',Leave:'var(--info)','Week Off':'var(--neutral)',Holiday:'var(--neutral)'},
    filterField:'status', filterOptions:['All','Present','Absent','Half Day','Leave','Week Off','Holiday'],
    metaFields:['designation','shift','date'],
    fields:[
      {key:'employeeName',label:'Employee name',type:'text',required:true},
      {key:'employeeId',label:'Employee ID',type:'text'},
      {key:'designation',label:'Designation',type:'text',placeholder:'e.g. Electrician, Technician, Housekeeping'},
      {key:'shift',label:'Shift',type:'select',options:['I Shift','II Shift','General Shift','III Shift'],default:'General Shift'},
      {key:'date',label:'Date',type:'date',default:()=>todayISO()},
      {key:'status',label:'Attendance status',type:'select',options:['Present','Absent','Half Day','Leave','Week Off','Holiday'],default:'Present'},
      {key:'inTime',label:'In time',type:'time'},
      {key:'outTime',label:'Out time',type:'time'},
      {key:'remarks',label:'Remarks',type:'textarea'},
    ],
  },
};
const TAB_ORDER = ['dashboard','snags','tasks','ppm','monthlyreq','invoices','brsr','ghg','permits','attendance'];
const NAV_LABELS = {dashboard:'Home',snags:'Snags',tasks:'Tasks',ppm:'PPM',monthlyreq:'Reqs',invoices:'Invoices',brsr:'BRSR',ghg:'GHG',permits:'Permits',attendance:'Attendance'};
const NAV_ICONS = {dashboard:'🏠',snags:'⚠',tasks:'✓',ppm:'⚙',monthlyreq:'🗒',invoices:'₹',brsr:'🌐',ghg:'🍃',permits:'🪪',attendance:'🕘'};

/* ----------------- STORAGE ----------------- */
async function loadAll(){
  for(const key of Object.keys(DATA)){
    try{
      const res = await window.storage.get(key,false);
      DATA[key] = res && res.value ? JSON.parse(res.value) : [];
    }catch(e){ DATA[key] = []; }
  }
  try{
    const res = await window.storage.get('counters',false);
    COUNTERS = res && res.value ? JSON.parse(res.value) : {};
  }catch(e){ COUNTERS = {}; }
}
async function saveModule(key){
  try{ await window.storage.set(key, JSON.stringify(DATA[key]), false); }
  catch(e){ showToast('Could not save — try again'); }
  if(typeof syncModuleToFirestore === 'function') syncModuleToFirestore(key);
}
async function saveCounters(){
  try{ await window.storage.set('counters', JSON.stringify(COUNTERS), false); }
  catch(e){}
}
function nextTag(modKey){
  COUNTERS[modKey] = (COUNTERS[modKey]||0)+1;
  saveCounters();
  return MODULES[modKey].prefix+'-'+String(COUNTERS[modKey]).padStart(4,'0');
}

/* ----------------- RENDER ----------------- */
function el(html){ const d=document.createElement('div'); d.innerHTML=html.trim(); return d.firstChild; }

function render(){
  const app = document.getElementById('app');
  app.innerHTML = '';
  app.appendChild(renderHeader());
  app.appendChild(renderTabstrip());
  const main = document.createElement('main');
  if(currentTab==='dashboard') main.appendChild(renderDashboard());
  else main.appendChild(renderModuleList(currentTab));
  app.appendChild(main);
  app.appendChild(renderBottomNav());
  if(currentTab!=='dashboard'){
    app.appendChild(renderFab());
  }
}

function renderHeader(){
  const linked = !!(gFire.user || gSync.spreadsheetId);
  const synced = !!(gFire.user || gSync.accessToken);
  const wrap = el(`<div>
    <header class="top">
      <div class="header-row">
        <div class="brand"><span class="dot"></span>Facility Manager</div>
        <button class="sync-btn ${linked? 'linked':''}" id="syncBtn">☁ ${synced? 'Synced' : 'Sync'}</button>
      </div>
      <div class="sub">${currentTab==='dashboard' ? 'OVERVIEW' : MODULES[currentTab].label.toUpperCase()}</div>
    </header>
    <div class="accent-bar"></div>
  </div>`);
  wrap.querySelector('#syncBtn').onclick = openSyncPanel;
  return wrap;
}

function renderTabstrip(){
  const wrap = el(`<div class="tabstrip"></div>`);
  TAB_ORDER.forEach(key=>{
    const label = key==='dashboard' ? 'Dashboard' : MODULES[key].label;
    const chip = el(`<div class="tabchip ${currentTab===key?'active':''}">${label}</div>`);
    chip.onclick = ()=>{ currentTab=key; activeFilter='All'; render(); };
    wrap.appendChild(chip);
  });
  return wrap;
}

function renderBottomNav(){
  const wrap = el(`<div class="bottomnav"></div>`);
  TAB_ORDER.forEach(key=>{
    const item = el(`<div class="bn-item ${currentTab===key?'active':''}">
      <span class="ic">${NAV_ICONS[key]}</span>${NAV_LABELS[key]}
    </div>`);
    item.onclick = ()=>{ currentTab=key; activeFilter='All'; render(); };
    wrap.appendChild(item);
  });
  return wrap;
}

function renderFab(){
  const btn = el(`<button class="fab">+</button>`);
  btn.onclick = ()=> openForm(currentTab, null);
  return btn;
}

/* ---- Dashboard ---- */
function renderDashboard(){
  const wrap = el(`<div></div>`);
  const openSnags = DATA.snags.filter(r=>r.status==='Open').length;
  const criticalSnags = DATA.snags.filter(r=>r.severity==='Critical' && r.status!=='Resolved').length;
  const tasksPending = DATA.tasks.filter(r=>r.status!=='Done').length;
  const ppmOverdue = DATA.ppm.filter(r=>MODULES.ppm.computeStatus(r)==='Overdue').length;
  const invPending = DATA.invoices.filter(r=>r.status==='Pending').length;
  const reqPending = DATA.monthlyreq.filter(r=>r.status==='Requested').length;
  const brsrCount = DATA.brsr.length;
  const ghgTotal = DATA.ghg.reduce((s,r)=> s + (Number(r.quantity)||0)*(Number(r.emissionFactor)||0), 0);
  const permitsAction = DATA.permits.filter(r=>{
    const s = MODULES.permits.computeStatus(r);
    return s==='Expired' || s==='Expiring Soon';
  }).length;
  const today = todayISO();
  const attendanceToday = DATA.attendance.filter(r=>r.date===today);
  const absentToday = attendanceToday.filter(r=>r.status==='Absent').length;
  const presentToday = attendanceToday.filter(r=>r.status==='Present' || r.status==='Half Day').length;

  const cards = [
    {tab:'snags', num:openSnags, lbl:'Open snags', flag: criticalSnags ? criticalSnags+' critical' : null, flagColor:'var(--danger)'},
    {tab:'tasks', num:tasksPending, lbl:'Tasks pending'},
    {tab:'ppm', num:ppmOverdue, lbl:'PPM overdue', flag: ppmOverdue? 'Needs attention':null, flagColor:'var(--danger)'},
    {tab:'invoices', num:invPending, lbl:'Invoices pending'},
    {tab:'monthlyreq', num:reqPending, lbl:'Requirements requested'},
    {tab:'brsr', num:brsrCount, lbl:'BRSR entries logged'},
    {tab:'permits', num:permitsAction, lbl:'Permits expiring/expired', flag: permitsAction? 'Action needed':null, flagColor:'var(--danger)'},
    {tab:'attendance', num:presentToday, lbl:'Present today', flag: absentToday? absentToday+' absent':null, flagColor:'var(--danger)'},
  ];
  const grid = el(`<div class="dash-grid"></div>`);
  cards.forEach(c=>{
    const card = el(`<div class="stat-card">
      <div class="num">${c.num}</div>
      <div class="lbl">${c.lbl}</div>
      ${c.flag? `<div class="flag" style="background:${c.flagColor};color:#fff;">${c.flag}</div>`:''}
    </div>`);
    card.onclick = ()=>{ currentTab=c.tab; activeFilter='All'; render(); };
    grid.appendChild(card);
  });
  wrap.appendChild(grid);

  const ghgCard = el(`<div class="ghg-total">
    <div>
      <div style="font-size:12px;color:#B9C2CC;">Total GHG logged</div>
      <div style="font-size:11px;color:#8A94A0;margin-top:2px;">across all entries</div>
    </div>
    <div class="v">${ghgTotal.toLocaleString('en-IN',{maximumFractionDigits:0})} kg CO2e</div>
  </div>`);
  ghgCard.onclick = ()=>{ currentTab='ghg'; render(); };
  wrap.appendChild(ghgCard);

  wrap.appendChild(el(`<div class="section-title">Quick add</div>`));
  const quickRow = el(`<div class="filter-row"></div>`);
  TAB_ORDER.filter(k=>k!=='dashboard').forEach(key=>{
    const chip = el(`<div class="filter-chip">${MODULES[key].icon} ${MODULES[key].label}</div>`);
    chip.onclick = ()=> openForm(key, null);
    quickRow.appendChild(chip);
  });
  wrap.appendChild(quickRow);
  return wrap;
}

/* ---- Module list ---- */
function renderModuleList(modKey){
  const mod = MODULES[modKey];
  const wrap = el(`<div></div>`);

  if(mod.filterOptions){
    const frow = el(`<div class="filter-row"></div>`);
    mod.filterOptions.forEach(opt=>{
      const chip = el(`<div class="filter-chip ${activeFilter===opt?'active':''}">${opt}</div>`);
      chip.onclick = ()=>{ activeFilter=opt; render(); };
      frow.appendChild(chip);
    });
    wrap.appendChild(frow);
  }

  let list = DATA[modKey].slice().sort((a,b)=> (b._ts||0)-(a._ts||0));
  if(mod.filterField && activeFilter!=='All'){
    list = list.filter(r=>{
      const val = mod.filterField==='__computedStatus' ? mod.computeStatus(r) : r[mod.filterField];
      return val===activeFilter;
    });
  }

  if(list.length===0){
    wrap.appendChild(el(`<div class="empty">
      <div class="e-icon">${mod.icon}</div>
      <div class="e-title">No ${mod.label.toLowerCase()} yet</div>
      <div class="e-sub">Tap the + button to add the first entry.</div>
    </div>`));
    return wrap;
  }

  list.forEach(r=>{
    if(mod.derive) mod.derive(r);
    const badgeVal = mod.badgeField==='__computedStatus' ? mod.computeStatus(r) : r[mod.badgeField];
    const badgeColor = (mod.badgeColors && mod.badgeColors[badgeVal]) || 'var(--neutral)';
    const metaParts = mod.metaFields.map(f=>r[f]).filter(Boolean);
    const card = el(`<div class="card" style="border-left-color:${badgeColor}">
      <div class="card-top">
        <span class="card-tag">${r._tag||''}</span>
        ${badgeVal ? `<span class="badge" style="background:${badgeColor}">${badgeVal}</span>` : ''}
      </div>
      <div class="card-title">${(r[mod.titleField]||'Untitled')}</div>
      <div class="card-meta">${metaParts.join(' · ')}</div>
    </div>`);
    card.onclick = ()=> openForm(modKey, r);
    wrap.appendChild(card);
  });
  return wrap;
}

/* ----------------- FORM SHEET ----------------- */
function openForm(modKey, record){
  const mod = MODULES[modKey];
  const isEdit = !!record;
  const overlay = document.getElementById('overlay');
  const sheet = document.getElementById('sheet');
  sheet.innerHTML = '';

  const head = el(`<div class="sheet-handle"></div>`);
  sheet.appendChild(head);
  sheet.appendChild(el(`<h3>${isEdit? 'Edit':'New'} — ${mod.label}</h3>`));
  if(isEdit) sheet.appendChild(el(`<div class="tag-preview">${record._tag}</div>`));

  const formVals = {};
  mod.fields.forEach(f=>{
    const fieldWrap = el(`<div class="field"></div>`);
    fieldWrap.appendChild(el(`<label>${f.label}${f.required?' *':''}</label>`));
    let value = isEdit ? (record[f.key]!==undefined?record[f.key]:'') : (typeof f.default==='function'? f.default() : (f.default!==undefined?f.default:''));
    let input;
    if(f.type==='select'){
      input = el(`<select></select>`);
      f.options.forEach(opt=>{
        const o = el(`<option value="${opt}">${opt}</option>`);
        if(opt===value) o.selected = true;
        input.appendChild(o);
      });
    } else if(f.type==='textarea'){
      input = el(`<textarea>${value||''}</textarea>`);
    } else {
      input = el(`<input type="${f.type}" value="${value||''}" placeholder="${f.placeholder||''}">`);
    }
    fieldWrap.appendChild(input);
    if(f.hint) fieldWrap.appendChild(el(`<div class="hint">${f.hint}</div>`));
    formVals[f.key] = input;
    sheet.appendChild(fieldWrap);
  });

  // live computed preview for GHG
  if(modKey==='ghg'){
    const box = el(`<div class="computed-box">Estimated emissions: <b id="ghgPreview">0</b> kg CO2e</div>`);
    sheet.insertBefore(box, sheet.querySelector('.sheet-actions') || null);
    const updatePreview = ()=>{
      const q = Number(formVals.quantity.value)||0;
      const ef = Number(formVals.emissionFactor.value)||0;
      box.querySelector('#ghgPreview').textContent = (q*ef).toLocaleString('en-IN',{maximumFractionDigits:1});
    };
    formVals.quantity.oninput = updatePreview;
    formVals.emissionFactor.oninput = updatePreview;
  }

  const actions = el(`<div class="sheet-actions"></div>`);
  const cancelBtn = el(`<button class="btn btn-ghost">Cancel</button>`);
  cancelBtn.onclick = closeSheet;
  const saveBtn = el(`<button class="btn btn-primary">Save</button>`);
  saveBtn.onclick = ()=> handleSave(modKey, record, formVals);
  actions.appendChild(cancelBtn);
  if(isEdit){
    const delBtn = el(`<button class="btn btn-danger">Delete</button>`);
    delBtn.onclick = ()=> handleDelete(modKey, record);
    actions.appendChild(delBtn);
  }
  actions.appendChild(saveBtn);
  sheet.appendChild(actions);

  overlay.classList.add('open');
}
function closeSheet(){ document.getElementById('overlay').classList.remove('open'); }

async function handleSave(modKey, record, formVals){
  const mod = MODULES[modKey];
  const data = {};
  for(const f of mod.fields){
    data[f.key] = formVals[f.key].value;
  }
  // required validation
  for(const f of mod.fields){
    if(f.required && !data[f.key]){
      showToast(`${f.label} is required`);
      return;
    }
  }
  if(mod.beforeSave) mod.beforeSave(data);

  if(record){
    Object.assign(record, data);
  } else {
    data._tag = nextTag(modKey);
    data._ts = Date.now();
    DATA[modKey].push(data);
  }
  await saveModule(modKey);
  closeSheet();
  render();
  showToast('Saved');
}

async function handleDelete(modKey, record){
  DATA[modKey] = DATA[modKey].filter(r=>r!==record);
  await saveModule(modKey);
  closeSheet();
  render();
  showToast('Deleted');
}

function showToast(msg){
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(()=>t.classList.remove('show'), 1500);
}

/* ----------------- INIT ----------------- */
async function init(){
  document.getElementById('app').innerHTML = `<div style="padding:40px;text-align:center;color:#76808C;font-family:Inter,sans-serif;">Loading…</div>`;
  await loadAll();
  if(typeof loadSyncSettings === 'function') await loadSyncSettings();
  if(typeof loadFireSettings === 'function'){
    await loadFireSettings();
    if(gFire.configText && typeof initFirebaseApp === 'function') initFirebaseApp();
  }
  render();
}
init();
function exportToExcel(){
  const wb = XLSX.utils.book_new();
  const modules=['snags','tasks','ppm','monthlyreq','invoices','brsr','ghg','permits','attendance'];
  modules.forEach(m=>{
    const ws = XLSX.utils.json_to_sheet(DATA[m]||[]);
    XLSX.utils.book_append_sheet(wb, ws, m.substring(0,31));
  });
  XLSX.writeFile(wb,'Facility_Manager_Report.xlsx');
}
function importFromExcel(file){
  const reader = new FileReader();
  reader.onload = function(e){
    const wb = XLSX.read(e.target.result,{type:'array'});
    Object.keys(DATA).forEach(k=>DATA[k]=[]);
    wb.SheetNames.forEach(name=>{
      if(DATA[name]!==undefined){
        DATA[name]=XLSX.utils.sheet_to_json(wb.Sheets[name]);
        saveModule(name);
      }
    });
    render();
    showToast('Excel imported');
  };
  reader.readAsArrayBuffer(file);
}
document.addEventListener('DOMContentLoaded',()=>{
  setTimeout(()=>{
    const btn=document.createElement('button');
    btn.innerText='Export Excel';
    btn.style.cssText='position:fixed;left:10px;bottom:88px;z-index:40;padding:10px;';
    btn.onclick=exportToExcel;
    document.body.appendChild(btn);

    const inp=document.createElement('input');
    inp.type='file';
    inp.accept='.xlsx,.xls';
    inp.style.cssText='position:fixed;left:10px;bottom:130px;z-index:40;max-width:140px;';
    inp.onchange=(e)=>{ if(e.target.files[0]) importFromExcel(e.target.files[0]); };
    document.body.appendChild(inp);
  },1000);
});
/* ---------------------------------------------------------
   GOOGLE SHEETS SYNC
   Every module pushes/pulls to its own tab in one Google Sheet
   you own. Requires a Google Cloud OAuth Client ID configured
   with this page's exact URL under "Authorized JavaScript
   origins". Will NOT work from a local file:// path — this
   page must be hosted at a real http(s) URL first.
--------------------------------------------------------- */
const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';
const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

async function loadSyncSettings(){
  try{
    const res = await window.storage.get('googleSyncSettings', false);
    if(res && res.value){
      const s = JSON.parse(res.value);
      gSync.clientId = s.clientId || '';
      gSync.spreadsheetId = s.spreadsheetId || '';
    }
  }catch(e){ /* no saved settings yet */ }
}
async function saveSyncSettings(){
  try{
    await window.storage.set('googleSyncSettings', JSON.stringify({
      clientId: gSync.clientId, spreadsheetId: gSync.spreadsheetId
    }), false);
  }catch(e){ showToast('Could not save sync settings'); }
}

function ensureTokenClient(){
  if(!window.google || !window.google.accounts || !window.google.accounts.oauth2){
    showToast('Google sign-in script still loading — try again in a moment');
    return null;
  }
  if(!gSync.clientId){
    showToast('Enter your Google OAuth Client ID first');
    return null;
  }
  if(!gSync.tokenClient || gSync.tokenClient._clientIdUsed !== gSync.clientId){
    gSync.tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: gSync.clientId,
      scope: SHEETS_SCOPE,
      callback: (resp)=>{
        if(resp.error){ showToast('Sign-in failed: '+resp.error); return; }
        gSync.accessToken = resp.access_token;
        showToast('Signed in to Google');
        render();
        openSyncPanel();
      }
    });
    gSync.tokenClient._clientIdUsed = gSync.clientId;
  }
  return gSync.tokenClient;
}

function signInGoogle(){
  const tc = ensureTokenClient();
  if(tc) tc.requestAccessToken({prompt:'consent'});
}
function signOutGoogle(){
  gSync.accessToken = '';
  showToast('Signed out');
  render();
  openSyncPanel();
}

function moduleColumns(modKey){
  const mod = MODULES[modKey];
  return [...new Set(['_tag','_ts', ...mod.fields.map(f=>f.key)])];
}

async function sheetsApiFetch(url, options={}){
  if(!gSync.accessToken){ showToast('Sign in to Google first'); throw new Error('Not signed in'); }
  const res = await fetch(url, {
    ...options,
    headers:{
      'Authorization':'Bearer '+gSync.accessToken,
      'Content-Type':'application/json',
      ...(options.headers||{})
    }
  });
  if(!res.ok){
    const text = await res.text().catch(()=>'');
    throw new Error('Sheets API '+res.status+': '+text.slice(0,180));
  }
  return res.json();
}

async function ensureSpreadsheet(){
  if(gSync.spreadsheetId) return gSync.spreadsheetId;
  const body = {
    properties:{ title:'Facility Manager Data' },
    sheets: Object.keys(MODULES).map(k=>({ properties:{ title:k } }))
  };
  const data = await sheetsApiFetch(SHEETS_API, { method:'POST', body: JSON.stringify(body) });
  gSync.spreadsheetId = data.spreadsheetId;
  await saveSyncSettings();
  showToast('Created new Google Sheet');
  return gSync.spreadsheetId;
}

async function pushAllToSheet(){
  try{
    showToast('Pushing data to Google Sheet…');
    const ssId = await ensureSpreadsheet();
    for(const modKey of Object.keys(MODULES)){
      const cols = moduleColumns(modKey);
      const rows = (DATA[modKey]||[]).map(r => cols.map(c => r[c]!==undefined && r[c]!==null ? String(r[c]) : ''));
      const values = [cols, ...rows];
      const clearRange = encodeURIComponent(modKey+'!A1:ZZ200000');
      const writeRange = encodeURIComponent(modKey+'!A1');
      await sheetsApiFetch(`${SHEETS_API}/${ssId}/values/${clearRange}:clear`, { method:'POST', body:'{}' });
      await sheetsApiFetch(`${SHEETS_API}/${ssId}/values/${writeRange}?valueInputOption=USER_ENTERED`, {
        method:'PUT',
        body: JSON.stringify({ range: modKey+'!A1', majorDimension:'ROWS', values })
      });
    }
    showToast('All data pushed to Google Sheet');
  }catch(e){ showToast('Push failed: '+e.message); }
}

async function pullAllFromSheet(){
  try{
    if(!gSync.spreadsheetId){ showToast('No spreadsheet linked yet — push once first'); return; }
    showToast('Pulling data from Google Sheet…');
    for(const modKey of Object.keys(MODULES)){
      const range = encodeURIComponent(modKey+'!A1:ZZ200000');
      const data = await sheetsApiFetch(`${SHEETS_API}/${gSync.spreadsheetId}/values/${range}`);
      const rows = data.values || [];
      if(rows.length < 1) continue;
      const header = rows[0];
      const records = rows.slice(1)
        .filter(row => row.some(cell => cell !== '' && cell !== undefined))
        .map(row=>{
          const obj = {};
          header.forEach((h,i)=>{ obj[h] = row[i]!==undefined ? row[i] : ''; });
          if(obj._ts) obj._ts = Number(obj._ts);
          return obj;
        });
      DATA[modKey] = records;
      await saveModule(modKey);
    }
    render();
    showToast('Data pulled from Google Sheet');
  }catch(e){ showToast('Pull failed: '+e.message); }
}

/* ----------------- SYNC PANEL UI ----------------- */
function openSyncPanel(){
  const overlay = document.getElementById('overlay');
  const sheet = document.getElementById('sheet');
  sheet.innerHTML = '';
  sheet.appendChild(el(`<div class="sheet-handle"></div>`));
  sheet.appendChild(el(`<h3>Cloud Backup</h3>`));
  sheet.appendChild(el(`<div class="tag-preview">Every module's data, backed up live to your own free Firebase database.</div>`));

  /* ---- Firebase section (primary) ---- */
  sheet.appendChild(el(`<div class="computed-box">Setup (one-time, free): create a project at console.firebase.google.com → Build → Firestore Database (start in production mode) → enable Google as a sign-in provider under Authentication → grab your Web app config from Project Settings and paste it below. Add this page's exact URL under Authentication → Settings → Authorized domains. Won't work from a local file:// path — host the page at a real http(s) URL first.</div>`));

  const fbStatus = el(`<div class="fb-status"><span class="pill ${gFire.user?'on':''}"></span><span>${gFire.user ? 'Signed in as '+(gFire.user.email||gFire.user.displayName) : 'Not signed in'}</span></div>`);
  sheet.appendChild(fbStatus);

  const cfgField = el(`<div class="field"><label>Firebase config (paste the whole object from your console)</label></div>`);
  const cfgInput = el(`<textarea placeholder='{"apiKey":"...","authDomain":"...","projectId":"...","storageBucket":"...","messagingSenderId":"...","appId":"..."}' style="min-height:90px;"></textarea>`);
  cfgInput.value = gFire.configText;
  cfgField.appendChild(cfgInput);
  sheet.appendChild(cfgField);

  const toggleRow = el(`<div class="toggle-row"><span>Auto-sync every change</span></div>`);
  const toggleInput = el(`<input type="checkbox" style="width:18px;height:18px;">`);
  toggleInput.checked = gFire.autoSync;
  toggleRow.appendChild(toggleInput);
  sheet.appendChild(toggleRow);

  const fbSaveBtn = el(`<button class="btn btn-ghost" style="width:100%;margin-bottom:10px;">Save config</button>`);
  fbSaveBtn.onclick = async ()=>{
    gFire.configText = cfgInput.value.trim();
    gFire.autoSync = toggleInput.checked;
    await saveFireSettings();
    if(initFirebaseApp()) showToast('Firebase config saved');
  };
  sheet.appendChild(fbSaveBtn);

  const fbActions = el(`<div class="sheet-actions"></div>`);
  if(!gFire.user){
    const signInBtn = el(`<button class="btn btn-primary">Sign in with Google</button>`);
    signInBtn.onclick = async ()=>{
      gFire.configText = cfgInput.value.trim();
      gFire.autoSync = toggleInput.checked;
      await saveFireSettings();
      signInFirebaseFn();
    };
    fbActions.appendChild(signInBtn);
  } else {
    const pullBtn = el(`<button class="btn btn-ghost">Pull from cloud</button>`);
    pullBtn.onclick = pullAllFromFirestore;
    const pushBtn = el(`<button class="btn btn-primary">Push all now</button>`);
    pushBtn.onclick = pushAllToFirestore;
    fbActions.appendChild(pullBtn);
    fbActions.appendChild(pushBtn);
  }
  sheet.appendChild(fbActions);

  if(gFire.user){
    const signOutBtn = el(`<button class="btn btn-danger" style="width:100%;margin-top:10px;">Sign out of Firebase</button>`);
    signOutBtn.onclick = signOutFirebaseFn;
    sheet.appendChild(signOutBtn);
  }

  /* ---- Google Sheets section (optional / advanced) ---- */
  const details = el(`<details class="adv-details"><summary>Advanced: also back up to Google Sheets (optional)</summary></details>`);
  const sheetsBody = el(`<div></div>`);

  sheetsBody.appendChild(el(`<div class="computed-box" style="margin-top:10px;">Separate setup: create an OAuth Client ID (Web application) in Google Cloud Console, enable the Google Sheets API, and add this page's exact URL to "Authorized JavaScript origins".</div>`));

  const clientField = el(`<div class="field"><label>Google OAuth Client ID</label></div>`);
  const clientInput = el(`<input type="text" placeholder="xxxxxxxxxxxx.apps.googleusercontent.com">`);
  clientInput.value = gSync.clientId;
  clientField.appendChild(clientInput);
  sheetsBody.appendChild(clientField);

  const ssField = el(`<div class="field"><label>Spreadsheet ID (leave blank to auto-create on first push)</label></div>`);
  const ssInput = el(`<input type="text" placeholder="auto-created on first push">`);
  ssInput.value = gSync.spreadsheetId;
  ssField.appendChild(ssInput);
  sheetsBody.appendChild(ssField);

  const statusParts = [];
  statusParts.push(gSync.accessToken ? 'Signed in ✓' : 'Not signed in');
  if(gSync.spreadsheetId) statusParts.push('Sheet linked ✓');
  sheetsBody.appendChild(el(`<div class="hint" style="margin-bottom:12px;">${statusParts.join(' · ')}</div>`));

  const saveBtn = el(`<button class="btn btn-ghost" style="width:100%;margin-bottom:10px;">Save settings</button>`);
  saveBtn.onclick = async ()=>{
    gSync.clientId = clientInput.value.trim();
    gSync.spreadsheetId = ssInput.value.trim();
    await saveSyncSettings();
    showToast('Settings saved');
  };
  sheetsBody.appendChild(saveBtn);

  const actions = el(`<div class="sheet-actions"></div>`);
  if(!gSync.accessToken){
    const signInBtn = el(`<button class="btn btn-primary">Sign in with Google</button>`);
    signInBtn.onclick = async ()=>{
      gSync.clientId = clientInput.value.trim();
      gSync.spreadsheetId = ssInput.value.trim();
      await saveSyncSettings();
      signInGoogle();
    };
    actions.appendChild(signInBtn);
  } else {
    const pullBtn = el(`<button class="btn btn-ghost">Pull from Sheet</button>`);
    pullBtn.onclick = pullAllFromSheet;
    const pushBtn = el(`<button class="btn btn-primary">Push to Sheet</button>`);
    pushBtn.onclick = pushAllToSheet;
    actions.appendChild(pullBtn);
    actions.appendChild(pushBtn);
  }
  sheetsBody.appendChild(actions);

  if(gSync.accessToken){
    const signOutBtn = el(`<button class="btn btn-danger" style="width:100%;margin-top:10px;">Sign out</button>`);
    signOutBtn.onclick = signOutGoogle;
    sheetsBody.appendChild(signOutBtn);
  }

  details.appendChild(sheetsBody);
  sheet.appendChild(details);

  const closeBtn = el(`<button class="btn btn-ghost" style="width:100%;margin-top:14px;">Close</button>`);
  closeBtn.onclick = closeSheet;
  sheet.appendChild(closeBtn);

  overlay.classList.add('open');
}
/* ---------------------------------------------------------
   FIREBASE FIRESTORE SYNC (primary cloud database)
   Free Spark plan: ~1GiB storage, 50k reads/day, 20k writes/day —
   far more than this app needs. Each module's full record list is
   stored as one document, mirroring local window.storage, and is
   pushed automatically on every save when auto-sync is on.
--------------------------------------------------------- */
async function loadFireSettings(){
  try{
    const res = await window.storage.get('firebaseSyncSettings', false);
    if(res && res.value){
      const s = JSON.parse(res.value);
      gFire.configText = s.configText || '';
      gFire.autoSync = s.autoSync !== false;
    }
  }catch(e){ /* no saved settings yet */ }
}
async function saveFireSettings(){
  try{
    await window.storage.set('firebaseSyncSettings', JSON.stringify({
      configText: gFire.configText, autoSync: gFire.autoSync
    }), false);
  }catch(e){ showToast('Could not save Firebase settings'); }
}

function parseFirebaseConfig(text){
  if(!text || !text.trim()) return null;
  const t = text.trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if(start===-1 || end===-1 || end<=start) return null;
  try{ return new Function('return (' + t.slice(start, end+1) + ')')(); }
  catch(e){ return null; }
}

function initFirebaseApp(){
  if(!window.firebase){ showToast('Firebase SDK still loading — try again in a moment'); return false; }
  const cfg = parseFirebaseConfig(gFire.configText);
  if(!cfg || !cfg.apiKey || !cfg.projectId){
    showToast('Paste a valid Firebase config object first');
    return false;
  }
  try{
    if(!firebase.apps.length){ firebase.initializeApp(cfg); }
    if(!gFire.authListenerAttached){
      firebase.auth().onAuthStateChanged(user=>{
        gFire.user = user;
        render();
        if(document.getElementById('overlay').classList.contains('open')) openSyncPanel();
      });
      gFire.authListenerAttached = true;
    }
    return true;
  }catch(e){ showToast('Firebase init failed: '+e.message); return false; }
}

function signInFirebaseFn(){
  if(!initFirebaseApp()) return;
  firebase.auth().signInWithPopup(new firebase.auth.GoogleAuthProvider())
    .then(()=> showToast('Signed in to Firebase'))
    .catch(e=> showToast('Sign-in failed: '+e.message));
}
function signOutFirebaseFn(){
  if(window.firebase && firebase.apps.length && firebase.auth().currentUser){
    firebase.auth().signOut().then(()=> showToast('Signed out'));
  }
}

function fsModuleDoc(modKey){
  return firebase.firestore().collection('facilityManager').doc(gFire.user.uid).collection('modules').doc(modKey);
}
async function syncModuleToFirestore(modKey){
  if(!gFire.user || !gFire.autoSync) return;
  try{
    await fsModuleDoc(modKey).set({
      data: DATA[modKey] || [],
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    });
  }catch(e){ /* fail silently on auto-sync; manual push surfaces errors */ }
}
async function pushAllToFirestore(){
  if(!gFire.user){ showToast('Sign in to Firebase first'); return; }
  try{
    showToast('Pushing data to Firestore…');
    for(const modKey of Object.keys(MODULES)){
      await fsModuleDoc(modKey).set({
        data: DATA[modKey] || [],
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      });
    }
    showToast('All data pushed to Firestore');
  }catch(e){ showToast('Push failed: '+e.message); }
}
async function pullAllFromFirestore(){
  if(!gFire.user){ showToast('Sign in to Firebase first'); return; }
  try{
    showToast('Pulling data from Firestore…');
    for(const modKey of Object.keys(MODULES)){
      const snap = await fsModuleDoc(modKey).get();
      if(snap.exists){
        const d = snap.data();
        DATA[modKey] = Array.isArray(d.data) ? d.data : [];
        await window.storage.set(modKey, JSON.stringify(DATA[modKey]), false);
      }
    }
    render();
    showToast('Data pulled from Firestore');
  }catch(e){ showToast('Pull failed: '+e.message); }
}
