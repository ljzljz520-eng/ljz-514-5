/* 会展中心逛展路径工具 —— 前端逻辑 */
"use strict";

const SVG_W = 980;
const FLOOR_H = { 1: 430, 2: 370, 3: 360 };
const FLOOR_PAD = 14;
const FLOOR_OFF = {};           // 楼层 -> y 偏移
const FLOOR_TITLE_H = 34;

const TYPE_STYLE = {
  entrance:  { fill: "#2563eb", color: "#fff", icon: "🚪", r: 12 },
  booth:     { fill: "#38bdf8", color: "#082f49", icon: "▣", r: 9 },
  dining:    { fill: "#f97316", color: "#fff", icon: "🍜", r: 11 },
  meeting:   { fill: "#10b981", color: "#fff", icon: "🎤", r: 11 },
  corridor:  { fill: "#cbd5e1", color: "#334155", icon: "", r: 4.5 },
  elevator:  { fill: "#8b5cf6", color: "#fff", icon: "EL", r: 11 },
  escalator: { fill: "#a78bfa", color: "#fff", icon: "ESC", r: 11 },
  stairs:    { fill: "#c4b5fd", color: "#4c1d95", icon: "ST", r: 11 },
};

const state = {
  venue: null,
  nodes: {},
  edges: [],
  selected: { entrance: null, booths: [], dining: null, meeting: null },
  route: null,
  avoidCrowd: false,
};

const $ = (sel) => document.querySelector(sel);

// ---------------------------------------------------------------------------
// 初始化
// ---------------------------------------------------------------------------
async function init() {
  const data = await fetch("/api/venue").then(r => r.json());
  state.venue = data;
  data.nodes.forEach(n => state.nodes[n.id] = n);
  state.edges = data.edges;
  state.selected.entrance = "E1";

  renderLegend(data.crowdLevels);
  populateForm();
  buildOffsets();
  renderMap();
  bindEvents();
}

function buildOffsets() {
  let y = 0;
  for (const f of state.venue.floors) {
    FLOOR_OFF[f.id] = y;
    y += FLOOR_H[f.id] + FLOOR_PAD;
  }
  state.svgHeight = y;
}

function renderLegend(levels) {
  const box = $("#legend");
  box.innerHTML = levels.map(l =>
    `<span class="item"><span class="sw" style="background:${l.color}"></span>${l.label}</span>`
  ).join("") +
  `<span class="item"><span class="sw dash"></span>封闭通道</span>` +
  `<span class="item"><span class="sw" style="background:repeating-linear-gradient(90deg,#8b5cf6 0 5px,transparent 5px 9px)"></span>跨层垂直交通</span>`;
}

// ---------------------------------------------------------------------------
// 表单
// ---------------------------------------------------------------------------
function nodeList(type) {
  return state.venue.nodes.filter(n => n.type === type && !n.closed);
}
function allOfType(type) {
  return state.venue.nodes.filter(n => n.type === type);
}

function populateForm() {
  // 入口
  $("#entrance").innerHTML = allOfType("entrance").map(n =>
    `<option value="${n.id}">${n.name}</option>`).join("");
  $("#entrance").value = state.selected.entrance;

  // 展位（按楼层分组）
  const boothBox = $("#boothList");
  boothBox.innerHTML = state.venue.floors.map(f => {
    const list = allOfType("booth").filter(n => n.floor === f.id);
    if (!list.length) return "";
    return `<div class="booth-group">
      <div class="grp-title">${f.name}</div>
      ${list.map(n => `
        <label class="booth-item ${n.closed ? "closed" : ""}" data-id="${n.id}">
          <input type="checkbox" value="${n.id}" ${n.closed ? "disabled" : ""}>
          <span>${n.name}</span>
          ${n.closed ? `<span class="tag-closed">闭展</span>` : ""}
          <span class="order-badge"></span>
        </label>`).join("")}
    </div>`;
  }).join("");

  const diningOpts = [{ id: "", name: "不安排就餐" }].concat(allOfType("dining"));
  $("#dining").innerHTML = diningOpts.map(n =>
    `<option value="${n.id}">${n.name}</option>`).join("");
  const meetOpts = [{ id: "", name: "不前往会议室" }].concat(allOfType("meeting"));
  $("#meeting").innerHTML = meetOpts.map(n =>
    `<option value="${n.id}">${n.name}</option>`).join("");
}

function refreshBoothUI() {
  document.querySelectorAll(".booth-item").forEach(el => {
    const id = el.dataset.id;
    const cb = el.querySelector("input");
    const order = state.selected.booths.indexOf(id);
    el.classList.toggle("picked", order >= 0);
    cb.checked = order >= 0;
    const badge = el.querySelector(".order-badge");
    badge.textContent = order >= 0 ? (order + 1) : "";
  });
}

function collectSelection() {
  state.selected.entrance = $("#entrance").value || null;
  state.selected.dining = $("#dining").value || null;
  state.selected.meeting = $("#meeting").value || null;
  state.avoidCrowd = $("#avoidCrowd").checked;
}

// 选点/策略变更后，旧规划结果即失效：清除路线高亮，避免旧路线残留在拓扑图上
function clearRoute() {
  state.route = null;
}

function bindEvents() {
  $("#entrance").addEventListener("change", () => {
    state.selected.entrance = $("#entrance").value;
    clearRoute();
    renderMap();
  });
  $("#dining").addEventListener("change", () => {
    state.selected.dining = $("#dining").value || null;
    clearRoute();
    renderMap();
  });
  $("#meeting").addEventListener("change", () => {
    state.selected.meeting = $("#meeting").value || null;
    clearRoute();
    renderMap();
  });
  $("#avoidCrowd").addEventListener("change", () => {
    state.avoidCrowd = $("#avoidCrowd").checked;
    clearRoute();
    renderMap();
  });
  $("#clearBooths").addEventListener("click", () => {
    state.selected.booths = [];
    clearRoute();
    refreshBoothUI();
    renderMap();
  });
  $("#boothList").addEventListener("change", (ev) => {
    const cb = ev.target.closest("input");
    if (!cb) return;
    const id = cb.value;
    const arr = state.selected.booths;
    const i = arr.indexOf(id);
    if (cb.checked && i < 0) arr.push(id);
    if (!cb.checked && i >= 0) arr.splice(i, 1);
    clearRoute();
    refreshBoothUI();
    renderMap();
  });
  $("#planBtn").addEventListener("click", planRoute);

  document.querySelectorAll(".chip[data-example]").forEach(btn => {
    btn.addEventListener("click", () => loadExample(btn.dataset.example));
  });
}

function loadExample(key) {
  const S = state.selected;
  S.booths = [];
  S.dining = null; S.meeting = null;
  if (key === "normal") {
    S.entrance = "E1"; S.booths = ["B102", "C102"]; S.dining = "D1";
  } else if (key === "crossfloor") {
    S.entrance = "E2"; S.booths = ["A101", "B202", "C303"]; S.dining = "D3";
    S.meeting = "M301";
  } else if (key === "blocked") {
    S.entrance = "E1"; S.booths = ["C304"]; S.meeting = "M303";
  } else if (key === "closed") {
    S.entrance = "E3"; S.booths = ["B206", "C201"]; S.dining = "D3";
  }
  $("#entrance").value = S.entrance;
  $("#dining").value = S.dining || "";
  $("#meeting").value = S.meeting || "";
  clearRoute();
  refreshBoothUI();
  renderMap();
  planRoute();
}

// ---------------------------------------------------------------------------
// 拓扑图渲染
// ---------------------------------------------------------------------------
function pos(nid) {
  const n = state.nodes[nid];
  return { x: n.x, y: n.y + FLOOR_OFF[n.floor], floor: n.floor, rawY: n.y };
}
function crowdColor(c) {
  const lv = state.venue.crowdLevels.find(l => l.level === c);
  return lv ? lv.color : "#9ca3af";
}

function renderMap() {
  const host = $("#svgScroll");
  let svg = `<svg class="floor-map" width="${SVG_W}" height="${state.svgHeight}"
     viewBox="0 0 ${SVG_W} ${state.svgHeight}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <filter id="shadow" x="-30%" y="-30%" width="160%" height="160%">
        <feDropShadow dx="0" dy="1" stdDeviation="1.5" flood-opacity=".18"/>
      </filter>
    </defs>`;

  // 楼层底板
  for (const f of state.venue.floors) {
    const y = FLOOR_OFF[f.id];
    svg += `<rect class="floor-band" x="6" y="${y + 4}" width="${SVG_W - 12}"
       height="${FLOOR_H[f.id] - 8}" />`;
    svg += `<text class="floor-title" x="22" y="${y + 26}">${f.name}</text>`;
    svg += `<text class="floor-sub" x="${SVG_W - 24}" y="${y + 26}" text-anchor="end">
       EL 电梯 · ESC 扶梯 · ST 楼梯</text>`;
  }

  // 边：先画普通/封闭边，再画跨层垂直边
  for (const e of state.edges) {
    if (["elevator", "escalator", "stairs"].includes(e.kind)) continue;
    svg += edgeSVG(e);
  }
  for (const e of state.edges) {
    if (["elevator", "escalator", "stairs"].includes(e.kind)) {
      svg += verticalEdgeSVG(e);
    }
  }

  // 节点
  for (const n of state.venue.nodes) svg += nodeSVG(n);

  // 路线高亮
  svg += renderRoute();

  svg += `</svg>`;
  host.innerHTML = svg;

  // 点击选点
  host.querySelectorAll(".node-poi").forEach(el => {
    el.addEventListener("click", () => onMapPick(el.dataset.id));
    el.addEventListener("mouseenter", () => showNodeTip(el.dataset.id, true));
    el.addEventListener("mouseleave", () => showNodeTip(el.dataset.id, false));
  });
}

function edgeSVG(e) {
  const p1 = pos(e.a), p2 = pos(e.b);
  if (e.kind === "blocked") {
    const mx = (p1.x + p2.x) / 2, my = (p1.y + p2.y) / 2;
    return `<g>
      <line class="edge-blocked" x1="${p1.x}" y1="${p1.y}" x2="${p2.x}" y2="${p2.y}"/>
      <g transform="translate(${mx},${my - 16})">
        <rect x="-72" y="-9" width="144" height="15" rx="7" fill="#fef2f2" stroke="#fecaca"/>
        <text text-anchor="middle" font-size="9.5" fill="#b91c1c">🚧 施工封闭</text>
      </g></g>`;
  }
  return `<line class="edge-walk" data-edge="${e.id}"
    x1="${p1.x}" y1="${p1.y}" x2="${p2.x}" y2="${p2.y}"
    stroke="${crowdColor(e.crowd)}" stroke-width="${e.crowd >= 3 ? 7 : 5}"/>`;
}

function verticalEdgeSVG(e) {
  const p1 = pos(e.a), p2 = pos(e.b);
  if (p2.y < p1.y) { p1.x = [p2.x, p2.x = p1.x][0]; var t = p1.y; p1.y = p2.y; p2.y = t; }
  const label = { elevator: "电梯", escalator: "扶梯", stairs: "楼梯" }[e.kind];
  const mx = (p1.x + p2.x) / 2, my = (p1.y + p2.y) / 2;
  return `<g>
    <line class="edge-vertical" x1="${p1.x}" y1="${p1.y}" x2="${p2.x}" y2="${p2.y}"/>
    <g transform="translate(${mx + 12},${my})">
      <rect x="-2" y="-9" width="${label.length * 11 + 8}" height="16" rx="8"
        fill="#f5f3ff" stroke="#ddd6fe"/>
      <text x="${(label.length * 11 + 4) / 2}" y="3" text-anchor="middle"
        class="vertical-tag">${label} ↕</text>
    </g></g>`;
}

function nodeSVG(n) {
  const p = pos(n.id);
  const st = TYPE_STYLE[n.type] || TYPE_STYLE.booth;
  const closed = n.closed;
  if (n.type === "corridor") {
    return `<g class="node-corridor" data-id="${n.id}" transform="translate(${p.x},${p.y})">
      <circle r="${st.r}"/>
      <text class="node-label" x="7" y="3" opacity="0">${esc(n.name)}</text></g>`;
  }
  const isPoi = ["entrance", "booth", "dining", "meeting",
                 "elevator", "escalator", "stairs"].includes(n.type);
  const labelShown = n.type !== "booth" || n.closed;
  const icon = ["elevator", "escalator", "stairs"].includes(n.type) ? st.icon
    : (n.type === "entrance" ? "" : st.icon);
  let core;
  if (n.type === "entrance") {
    core = `<polygon points="0,-${st.r} ${st.r},${st.r - 2} -${st.r},${st.r - 2}"
      fill="${st.fill}" stroke="#fff" stroke-width="1.5"/>`;
  } else if (["dining", "meeting"].includes(n.type)) {
    core = `<circle r="${st.r}" fill="${closed ? "#cbd5e1" : st.fill}"
      stroke="#fff" stroke-width="1.5"/>`;
  } else {
    core = `<rect x="-${st.r}" y="-${st.r}" width="${st.r * 2}" height="${st.r * 2}"
      rx="3" fill="${closed ? "#cbd5e1" : st.fill}" stroke="#fff" stroke-width="1.5"/>`;
  }
  const labelText = (() => {
    if (["dining", "meeting", "entrance"].includes(n.type)) {
      return `<text class="node-label" text-anchor="middle" y="${st.r + 13}">${esc(n.name)}</text>`;
    }
    if (n.closed) {
      return `<text class="node-label" text-anchor="middle" y="${st.r + 13}"
        fill="#b91c1c">${esc(n.name)}（闭展）</text>`;
    }
    if (["elevator", "escalator", "stairs"].includes(n.type)) return "";
    // 普通展位：显示编号
    const code = n.id;
    return `<text class="node-label" text-anchor="middle" y="${st.r + 12}">${esc(code)}</text>`;
  })();
  const glyph = n.type === "entrance"
    ? `<text text-anchor="middle" y="4" font-size="10" fill="#fff" font-weight="700">入</text>`
    : (["dining", "meeting"].includes(n.type)
      ? `<text text-anchor="middle" y="4" font-size="10">${st.icon}</text>`
      : (["elevator", "escalator", "stairs"].includes(n.type)
        ? `<text text-anchor="middle" y="3.5" font-size="8" font-weight="700" fill="${st.color}">${st.icon}</text>`
        : ""));
  return `<g class="node-poi ${closed ? "is-closed" : ""}" data-id="${n.id}"
      transform="translate(${p.x},${p.y})" ${isPoi ? "" : ""}>
      ${core}${glyph}${labelText}
      ${closed ? `<line x1="-7" y1="-7" x2="7" y2="7" stroke="#dc2626" stroke-width="2"/>
                  <line x1="7" y1="-7" x2="-7" y2="7" stroke="#dc2626" stroke-width="2"/>` : ""}
    </g>`;
}

function showNodeTip(id, on) {
  const n = state.nodes[id];
  if (!n || n.type === "corridor") return;
  const g = document.querySelector(`.node-poi[data-id="${id}"]`);
  if (!g) return;
  let tip = g.querySelector(".hover-tip");
  if (on) {
    if (!tip) {
      const words = n.closed
        ? `⛔ ${esc(n.close_reason || "当前关闭")}`
        : { entrance: "点击设为入口", booth: "点击加入/移出目标展位",
            dining: "点击选为餐饮区", meeting: "点击选为会议室",
            elevator: "电梯井", escalator: "自动扶梯", stairs: "疏散楼梯" }[n.type] || "";
      const w = words.length * 6.6 + 16;
      tip = document.createElementNS("http://www.w3.org/2000/svg", "g");
      tip.setAttribute("class", "hover-tip");
      tip.innerHTML = `<rect x="${-w / 2}" y="-34" width="${w}" height="18" rx="9"
        fill="#0f172a" opacity=".9"/><text text-anchor="middle" y="-21"
        font-size="10.5" fill="#fff">${words}</text>`;
      g.appendChild(tip);
    }
  } else if (tip) tip.remove();
}

function onMapPick(id) {
  const n = state.nodes[id];
  if (n.closed) { planRoute(); return; }
  if (n.type === "booth") {
    const arr = state.selected.booths;
    const i = arr.indexOf(id);
    if (i >= 0) arr.splice(i, 1); else arr.push(id);
    refreshBoothUI();
  } else if (n.type === "entrance") {
    state.selected.entrance = id;
    $("#entrance").value = id;
  } else if (n.type === "dining") {
    state.selected.dining = state.selected.dining === id ? null : id;
    $("#dining").value = state.selected.dining || "";
  } else if (n.type === "meeting") {
    state.selected.meeting = state.selected.meeting === id ? null : id;
    $("#meeting").value = state.selected.meeting || "";
  }
  clearRoute();
  renderMap();
}

// ---------------------------------------------------------------------------
// 路线高亮
// ---------------------------------------------------------------------------
function renderRoute() {
  let out = "";
  const waypoints = currentWaypoints();
  const wpIndex = {};
  waypoints.forEach((id, i) => wpIndex[id] = i + 1);

  if (state.route) {
    const edgeSet = new Set();
    for (const leg of state.route.legs) {
      if (!leg.ok) continue;
      for (const eid of leg.edgeIds) edgeSet.add(eid);
    }
    // halo + colored line
    for (const eid of edgeSet) {
      const e = state.edges.find(x => x.id === eid);
      if (!e) continue;
      const p1 = pos(e.a), p2 = pos(e.b);
      out += `<line class="route-halo" x1="${p1.x}" y1="${p1.y}" x2="${p2.x}" y2="${p2.y}"/>`;
    }
    for (const eid of edgeSet) {
      const e = state.edges.find(x => x.id === eid);
      const p1 = pos(e.a), p2 = pos(e.b);
      out += `<line class="route-line ${e.kind}" x1="${p1.x}" y1="${p1.y}"
        x2="${p2.x}" y2="${p2.y}"/>`;
    }
  }

  // 途经点序号徽标
  waypoints.forEach((id, i) => {
    const p = pos(id);
    const unreachable = state.route && state.route.unreachable.some(u => u.target === id);
    if (unreachable) {
      out += `<g class="unreachable-badge pulse" transform="translate(${p.x + 13},${p.y - 12})">
        <circle r="10"/><text>!</text></g>`;
    } else {
      out += `<g class="waypoint-badge" transform="translate(${p.x + 13},${p.y - 12})">
        <circle r="10"/><text>${i + 1}</text></g>`;
    }
  });
  return out;
}

function currentWaypoints() {
  const s = state.selected;
  const wp = [s.entrance].filter(Boolean);
  s.booths.forEach(b => wp.push(b));
  if (s.dining) wp.push(s.dining);
  if (s.meeting) wp.push(s.meeting);
  return wp;
}

// ---------------------------------------------------------------------------
// 规划请求 & 步骤渲染
// ---------------------------------------------------------------------------
async function planRoute() {
  collectSelection();
  const s = state.selected;
  const body = {
    entrance: s.entrance,
    booths: s.booths,
    dining: s.dining,
    meeting: s.meeting,
    avoidCrowd: state.avoidCrowd,
  };
  if (!s.entrance || (s.booths.length === 0 && !s.dining && !s.meeting)) {
    clearRoute();
    renderMap();
    $("#steps").innerHTML = `<div class="placeholder">请至少选择入口和一个目标<br>（展位 / 餐饮区 / 会议室）</div>`;
    $("#summary").innerHTML = "";
    return;
  }
  const resp = await fetch("/api/route", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).then(r => r.json());
  if (resp.error) {
    clearRoute();
    renderMap();
    $("#steps").innerHTML = `<div class="alert-unreachable"><div class="a-head">⚠️ ${esc(resp.error)}</div></div>`;
    return;
  }
  state.route = resp;
  renderMap();
  renderSteps(resp);
}

function fmtTime(sec) {
  const m = Math.round(sec / 60);
  return m >= 1 ? `${m} 分钟` : `${sec} 秒`;
}

function renderSteps(resp) {
  const { legs, totals, unreachable, waypointNames } = resp;
  // 汇总
  const okCount = legs.filter(l => l.ok).length;
  const floorSet = new Set();
  legs.forEach(l => l.ok && l.metrics.floors.forEach(f => floorSet.add(f)));
  $("#summary").innerHTML = `
    <div class="summary-card">
      <div class="summary-title">🧭 总行程概览（${waypointNames.length} 个到访点 · 成功 ${okCount}/${legs.length} 段）</div>
      <div class="row">
        <span class="stat">🚶 步行 <b>${totals.walkMeters}</b> 米</span>
        <span class="stat">⏱️ 预计 <b>${totals.totalMinutes}</b> 分钟</span>
        <span class="stat">🔁 楼层换乘 <b>${totals.transfers}</b> 次</span>
        <span class="stat">🏢 经停楼层 <b>${[...floorSet].sort().join("、")}F</b></span>
      </div>
    </div>`;

  let html = "";
  legs.forEach((leg, idx) => {
    const fromName = state.nodes[leg.from].name;
    const toName = state.nodes[leg.target].name;
    if (!leg.ok) {
      const d = leg.diagnosis;
      html += `<div class="alert-unreachable">
        <div class="a-head">⛔ 无法到达：${esc(toName)}
          <span class="a-reason">${esc(d.reason)}</span></div>
        <p><b>原因：</b>${esc(d.detail)}</p>
        <p class="a-sugg"><b>建议：</b>${esc(d.suggestion)}</p>
        <p class="a-sugg">📍 后续目标将自动跳过此点，从您当前位置继续规划。</p></div>`;
      return;
    }
    const m = leg.metrics;
    html += `<div class="leg-card">
      <div class="leg-head lk">第 ${idx + 1} 段｜${esc(fromName)} → ${esc(toName)}</div>
      <div class="leg-body">
        ${leg.steps.map(st => {
          if (st.type === "arrive") {
            return `<div class="step-line arrive"><span class="step-no">✓</span>
              <span class="step-text">${esc(st.text)}</span></div>`;
          }
          if (st.type === "transfer") {
            return `<div class="step-line transfer"><span class="step-no">${st.no}</span>
              <span class="step-text">${esc(st.text)}</span></div>`;
          }
          return `<div class="step-line"><span class="step-no">${st.no}</span>
            <span class="step-text">${esc(st.text)}
              ${st.tip ? `<span class="step-tip">⚠️ ${esc(st.tip)}</span>` : ""}
            </span></div>`;
        }).join("")}
        <div class="leg-meta">
          <span>步行 ${m.walkMeters} 米</span>
          <span>预计 ${fmtTime(m.totalSeconds)}</span>
          <span>楼层 ${m.floors[0]}F${m.floors.length > 1 ? " → " + m.floors[m.floors.length - 1] + "F" : ""}</span>
        </div>
      </div>
    </div>`;
  });
  $("#steps").innerHTML = html || `<div class="placeholder">暂未规划路线</div>`;
}

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

init();
