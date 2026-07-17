/**
 * 釋票監控（GitHub Actions 版）— 多平台
 *   1. 遠大 Ticket Plus：Vaundy ASIA ARENA TOUR 2026（抽選後零星票）
 *   2. 寬宏 KHAM：Official髭男dism 2026 台北站（票區級監控）
 *
 * 每次執行檢查一輪就結束，由 GitHub Actions 排程反覆喚醒。
 * 憑證從環境變數讀取（GitHub Secrets），狀態檔由 workflow commit 回 repo。
 */

const fs = require("fs");

// ===================== 監控目標設定 =====================

const TICKETPLUS = {
  label: "Vaundy 台北場（遠大）",
  eventId: "e000001328",
  sessionIds: ["s000002002", "s000002003"], // 10/31、11/1
  activityUrl: "https://ticketplus.com.tw/activity/6c3d8c24e0f00c9c84777615c001bebe",
  s3ConfigUrl: process.env.S3_CONFIG_URL || "",
};

const KHAM_TARGETS = [
  {
    label: "髭男dism 8/30 台北小巨蛋（寬宏）",
    url: "https://kham.com.tw/application/UTK02/UTK0204_.aspx?PERFORMANCE_ID=P18HBTRS&PRODUCT_ID=P18C4VJ0",
  },
  // 8/29 場次：拿到選位頁網址後，取消下面註解並填入
  // {
  //   label: "髭男dism 8/29 台北小巨蛋（寬宏）",
  //   url: "https://kham.com.tw/application/UTK02/UTK0204_.aspx?PERFORMANCE_ID=填這裡&PRODUCT_ID=P18C4VJ0",
  // },
];

const LINE = {
  token: process.env.LINE_TOKEN || "",
  userId: process.env.LINE_USER_ID || "",
};

const STATE_FILE = "./monitor-state.json";

const HEADERS = {
  accept: "text/html,application/json,*/*",
  "accept-language": "zh-TW,zh;q=0.9",
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36",
};

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

// ===================== LINE 通知 =====================

async function pushLine(text) {
  const res = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${LINE.token}`,
    },
    body: JSON.stringify({
      to: LINE.userId,
      messages: [{ type: "text", text: text.slice(0, 4900) }],
    }),
  });
  if (!res.ok) log(`LINE 通知失敗：HTTP ${res.status} ${await res.text()}`);
}

// ===================== 遠大 Ticket Plus =====================

const TP_EVENT_FIELDS = ["status", "saleStart", "saleEnd", "payment", "hidden", "lock", "isLottery"];
const TP_SESSION_FIELDS = ["status", "saleStart", "saleEnd", "hidden", "lock", "exposeStart", "exposeEnd", "orderLimit", "userLimit"];

function pick(obj, fields) {
  const out = {};
  for (const f of fields) out[f] = obj[f];
  return out;
}

async function fetchTicketPlus() {
  const url = `https://apis.ticketplus.com.tw/config/api/v1/get?eventId=${TICKETPLUS.eventId}&sessionId=${TICKETPLUS.sessionIds.join(",")}&_=${Date.now()}`;
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (data.errCode !== "00") throw new Error(`errCode=${data.errCode}`);

  const snap = { event: {}, sessions: {}, s3Sessions: null };
  for (const ev of data.result.event || []) snap.event = pick(ev, TP_EVENT_FIELDS);
  for (const s of data.result.session || []) snap.sessions[s.id] = pick(s, TP_SESSION_FIELDS);

  if (TICKETPLUS.s3ConfigUrl) {
    try {
      const r2 = await fetch(TICKETPLUS.s3ConfigUrl, { headers: HEADERS });
      if (r2.ok) {
        const raw = await r2.text();
        snap.s3Sessions = [...new Set(raw.match(/s\d{9}/g) || [])].sort();
      }
    } catch (e) {
      log(`S3 設定檔抓取失敗（不影響主監控）：${e.message}`);
    }
  }
  return snap;
}

function diffTicketPlus(prev, curr) {
  const changes = [];
  let urgent = false;

  for (const f of TP_EVENT_FIELDS) {
    if (JSON.stringify(prev.event[f]) !== JSON.stringify(curr.event[f])) {
      changes.push(`活動 ${f}：${JSON.stringify(prev.event[f])} → ${JSON.stringify(curr.event[f])}`);
      if (f === "status" && curr.event.status !== "over") urgent = true;
    }
  }

  const ids = new Set([...Object.keys(prev.sessions), ...Object.keys(curr.sessions)]);
  for (const id of ids) {
    const p = prev.sessions[id];
    const c = curr.sessions[id];
    const name = id === "s000002002" ? "10/31 場" : id === "s000002003" ? "11/1 場" : id;
    if (!p) {
      changes.push(`出現新場次 ${id}！`);
      urgent = true;
      continue;
    }
    if (!c) {
      changes.push(`${name} 從回應中消失`);
      continue;
    }
    for (const f of TP_SESSION_FIELDS) {
      if (JSON.stringify(p[f]) !== JSON.stringify(c[f])) {
        changes.push(`${name} ${f}：${JSON.stringify(p[f])} → ${JSON.stringify(c[f])}`);
        if (f === "status" && c.status !== "over") urgent = true;
        if (f === "saleEnd" && new Date(c.saleEnd) > new Date()) urgent = true;
        if (f === "saleStart" && new Date(c.saleStart) > new Date(Date.now() - 86400e3)) urgent = true;
      }
    }
  }

  if (prev.s3Sessions && curr.s3Sessions) {
    const added = curr.s3Sessions.filter((x) => !prev.s3Sessions.includes(x));
    if (added.length) {
      changes.push(`設定檔出現新場次 ID：${added.join(", ")}`);
      urgent = true;
    }
  }
  return { changes, urgent };
}

// ===================== 寬宏 KHAM =====================

function stripTags(html) {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

// 從選位頁 HTML 解析出 { "票區名稱|票價": 狀態 } 的對照表
function parseKhamAreas(html) {
  const areas = {};
  const rows = html.match(/<tr[\s\S]*?<\/tr>/gi) || [];
  for (const row of rows) {
    const cells = (row.match(/<t[dh][\s\S]*?<\/t[dh]>/gi) || []).map(stripTags);
    if (cells.length < 3) continue;
    // 資料列特徵：其中一格是票區名稱（含「區」「包廂」「排」），最後一格是空位狀態
    const areaCell = cells.find((c) => /(區|包廂|樓|排)/.test(c) && c.length <= 40);
    const status = cells[cells.length - 1];
    if (!areaCell) continue;
    if (!/(已售完|熱賣|剩餘|\d)/.test(status)) continue;
    // 票價格式像 4,880 或 800
    const priceCell = cells.find((c) => /^\d{1,2},?\d{3}$|^\d{3,4}$/.test(c.replace(/\s/g, "")));
    const key = priceCell ? `${areaCell}` : areaCell;
    areas[key] = status;
  }
  return areas;
}

async function fetchKham(target) {
  const res = await fetch(target.url, { headers: HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  const areas = parseKhamAreas(html);
  if (Object.keys(areas).length === 0) {
    throw new Error("解析不到任何票區（頁面結構可能改版）");
  }
  return areas;
}

function diffKham(prev, curr) {
  const changes = [];
  let urgent = false;
  const keys = new Set([...Object.keys(prev), ...Object.keys(curr)]);
  for (const k of keys) {
    const p = prev[k];
    const c = curr[k];
    if (p === c) continue;
    if (p === undefined) {
      changes.push(`新票區出現：${k}（${c}）`);
      if (c !== "已售完") urgent = true;
    } else if (c === undefined) {
      changes.push(`票區消失：${k}（原為 ${p}）`);
    } else {
      changes.push(`${k}：${p} → ${c}`);
      if (c !== "已售完") urgent = true; // 從售完變成任何其他狀態都視為釋票
    }
  }
  return { changes, urgent };
}

// ===================== 主流程 =====================

async function main() {
  if (!LINE.token || !LINE.userId) {
    console.error("缺少 LINE_TOKEN 或 LINE_USER_ID 環境變數（請設定 GitHub Secrets）");
    process.exit(1);
  }

  let state = null;
  try {
    state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {}
  const firstRun = !state;
  state = state || {};
  // 相容舊版狀態檔：缺少的欄位補上預設值，避免升級後崩潰
  if (state.ticketplus === undefined) state.ticketplus = null;
  if (!state.kham || typeof state.kham !== "object") state.kham = {};
  if (!state.lastHeartbeat) state.lastHeartbeat = 0;
  // 舊版把遠大資料存在最外層（event/sessions），搬進 ticketplus 底下
  if (!state.ticketplus && state.event && state.sessions) {
    state.ticketplus = { event: state.event, sessions: state.sessions, s3Sessions: state.s3Sessions || null };
    delete state.event;
    delete state.sessions;
    delete state.s3Sessions;
  }

  const notifications = [];
  let anyUrgent = false;
  let stateChanged = false;

  // --- 遠大 ---
  try {
    const snap = await fetchTicketPlus();
    if (!state.ticketplus) {
      state.ticketplus = snap;
      stateChanged = true;
      log(`[遠大] 已建立基準（status: ${Object.values(snap.sessions).map((s) => s.status).join(", ")}）`);
    } else {
      const { changes, urgent } = diffTicketPlus(state.ticketplus, snap);
      if (changes.length) {
        notifications.push(`【${TICKETPLUS.label}】\n${changes.join("\n")}\n${TICKETPLUS.activityUrl}`);
        if (urgent) anyUrgent = true;
        state.ticketplus = snap;
        stateChanged = true;
      } else {
        log(`[遠大] 無變化（status: ${Object.values(snap.sessions).map((s) => s.status).join(", ")}）`);
      }
    }
  } catch (e) {
    log(`[遠大] 檢查失敗：${e.message}`);
  }

  // --- 寬宏 ---
  for (const target of KHAM_TARGETS) {
    try {
      const areas = await fetchKham(target);
      const prev = state.kham[target.url];
      if (!prev) {
        state.kham[target.url] = areas;
        stateChanged = true;
        log(`[寬宏] ${target.label} 已建立基準（${Object.keys(areas).length} 個票區）`);
      } else {
        const { changes, urgent } = diffKham(prev, areas);
        if (changes.length) {
          notifications.push(`【${target.label}】\n${changes.join("\n")}\n${target.url}`);
          if (urgent) anyUrgent = true;
          state.kham[target.url] = areas;
          stateChanged = true;
        } else {
          log(`[寬宏] ${target.label} 無變化（${Object.keys(areas).length} 個票區）`);
        }
      }
    } catch (e) {
      log(`[寬宏] ${target.label} 檢查失敗：${e.message}`);
    }
  }

  // --- 發通知 ---
  if (notifications.length) {
    const prefix = anyUrgent ? "🚨🚨 疑似釋票 🚨🚨\n\n" : "🔔 狀態變化\n\n";
    await pushLine(prefix + notifications.join("\n\n"));
    state.lastHeartbeat = Date.now();
  } else if (firstRun) {
    await pushLine("💚 多平台監控已啟動（遠大 Vaundy + 寬宏 髭男dism），這是測試通知。之後每週會收到一次存活回報。");
    state.lastHeartbeat = Date.now();
    stateChanged = true;
  } else if (Date.now() - (state.lastHeartbeat || 0) > 7 * 24 * 60 * 60 * 1000) {
    // 每週心跳，兼作 repo 保活
    const tpStatus = state.ticketplus
      ? Object.values(state.ticketplus.sessions).map((s) => s.status).join(", ")
      : "未知";
    const khamCount = Object.values(state.kham).reduce((n, a) => n + Object.keys(a).length, 0);
    await pushLine(
      `💚 監控正常運作中（每週回報）\n遠大 Vaundy：${tpStatus}\n寬宏 髭男dism：追蹤中 ${khamCount} 個票區，全數售完\n沒收到這則週報時，請到 GitHub Actions 檢查排程是否被停用。`
    );
    state.lastHeartbeat = Date.now();
    stateChanged = true;
    log("已發送每週心跳通知。");
  }

  if (stateChanged) {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  }
}

main().catch((e) => {
  console.error(`執行失敗：${e.message}`);
  process.exit(1);
});
