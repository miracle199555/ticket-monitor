/**
 * 遠大售票（Ticket Plus）釋票監控 — GitHub Actions 版
 * 目標活動：Vaundy ASIA ARENA TOUR 2026 "HORO" IN TAIPEI
 *
 * 與本機版差異：每次執行只檢查一次就結束，由 GitHub Actions 排程反覆喚醒。
 * 憑證從環境變數讀取（GitHub Secrets），狀態檔由 workflow commit 回 repo。
 */

const CONFIG = {
  EVENT_ID: "e000001328",
  SESSION_IDS: ["s000002002", "s000002003"], // 10/31、11/1 兩場
  S3_CONFIG_URL: process.env.S3_CONFIG_URL || "",
  LINE_CHANNEL_ACCESS_TOKEN: process.env.LINE_TOKEN || "",
  LINE_USER_ID: process.env.LINE_USER_ID || "",
  STATE_FILE: "./monitor-state.json",
};

const API_BASE = "https://apis.ticketplus.com.tw/config/api/v1/get";
const HEADERS = {
  accept: "application/json, text/plain, */*",
  origin: "https://ticketplus.com.tw",
  referer: "https://ticketplus.com.tw/",
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36",
};

const WATCH_EVENT_FIELDS = ["status", "saleStart", "saleEnd", "payment", "hidden", "lock", "isLottery"];
const WATCH_SESSION_FIELDS = ["status", "saleStart", "saleEnd", "hidden", "lock", "exposeStart", "exposeEnd", "orderLimit", "userLimit"];

const fs = require("fs");

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

async function notify(text, urgent = false) {
  const prefix = urgent ? "🚨🚨 疑似開賣 🚨🚨\n" : "🔔 狀態變化\n";
  const message =
    prefix + text + "\n\nhttps://ticketplus.com.tw/activity/6c3d8c24e0f00c9c84777615c001bebe";
  const res = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${CONFIG.LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({
      to: CONFIG.LINE_USER_ID,
      messages: [{ type: "text", text: message }],
    }),
  });
  if (!res.ok) log(`LINE 通知失敗：HTTP ${res.status} ${await res.text()}`);
}

function pick(obj, fields) {
  const out = {};
  for (const f of fields) out[f] = obj[f];
  return out;
}

async function fetchSnapshot() {
  const url = `${API_BASE}?eventId=${CONFIG.EVENT_ID}&sessionId=${CONFIG.SESSION_IDS.join(",")}&_=${Date.now()}`;
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (data.errCode !== "00") throw new Error(`API errCode=${data.errCode} ${data.errMsg}`);

  const snapshot = { event: {}, sessions: {}, s3Sessions: null };
  for (const ev of data.result.event || []) {
    snapshot.event = pick(ev, WATCH_EVENT_FIELDS);
  }
  for (const s of data.result.session || []) {
    snapshot.sessions[s.id] = pick(s, WATCH_SESSION_FIELDS);
  }

  if (CONFIG.S3_CONFIG_URL) {
    try {
      const res2 = await fetch(CONFIG.S3_CONFIG_URL, { headers: HEADERS });
      if (res2.ok) {
        const raw = await res2.text();
        const ids = [...new Set(raw.match(/s\d{9}/g) || [])].sort();
        snapshot.s3Sessions = ids;
      }
    } catch (e) {
      log(`S3 設定檔抓取失敗（不影響主監控）：${e.message}`);
    }
  }
  return snapshot;
}

function diff(prev, curr) {
  const changes = [];
  let urgent = false;

  for (const f of WATCH_EVENT_FIELDS) {
    const a = JSON.stringify(prev.event[f]);
    const b = JSON.stringify(curr.event[f]);
    if (a !== b) {
      changes.push(`活動 ${f}：${a} → ${b}`);
      if (f === "status" && curr.event.status !== "over") urgent = true;
    }
  }

  const allIds = new Set([...Object.keys(prev.sessions), ...Object.keys(curr.sessions)]);
  for (const id of allIds) {
    const p = prev.sessions[id];
    const c = curr.sessions[id];
    if (!p) {
      changes.push(`出現新場次 ${id}！`);
      urgent = true;
      continue;
    }
    if (!c) {
      changes.push(`場次 ${id} 從回應中消失`);
      continue;
    }
    for (const f of WATCH_SESSION_FIELDS) {
      const a = JSON.stringify(p[f]);
      const b = JSON.stringify(c[f]);
      if (a !== b) {
        changes.push(`場次 ${id} ${f}：${a} → ${b}`);
        if (f === "status" && c.status !== "over") urgent = true;
        if (f === "saleEnd" && new Date(c.saleEnd) > new Date()) urgent = true;
        if (f === "saleStart" && new Date(c.saleStart) > new Date(Date.now() - 86400e3)) urgent = true;
      }
    }
  }

  if (prev.s3Sessions && curr.s3Sessions) {
    const added = curr.s3Sessions.filter((id) => !prev.s3Sessions.includes(id));
    if (added.length) {
      changes.push(`設定檔出現新場次 ID：${added.join(", ")}`);
      urgent = true;
    }
  }

  return { changes, urgent };
}

async function main() {
  if (!CONFIG.LINE_CHANNEL_ACCESS_TOKEN || !CONFIG.LINE_USER_ID) {
    console.error("缺少 LINE_TOKEN 或 LINE_USER_ID 環境變數（請設定 GitHub Secrets）");
    process.exit(1);
  }

  const snapshot = await fetchSnapshot();

  let prev = null;
  try {
    prev = JSON.parse(fs.readFileSync(CONFIG.STATE_FILE, "utf8"));
  } catch {}

  if (!prev) {
    fs.writeFileSync(CONFIG.STATE_FILE, JSON.stringify(snapshot, null, 2));
    log("已建立初始狀態基準。");
    await notify("監控已在 GitHub Actions 上啟動，這是測試通知。");
    return;
  }

  const { changes, urgent } = diff(prev, snapshot);
  if (changes.length) {
    log(`偵測到變化：\n  ${changes.join("\n  ")}`);
    await notify(changes.join("\n"), urgent);
    fs.writeFileSync(CONFIG.STATE_FILE, JSON.stringify(snapshot, null, 2));
  } else {
    log(`無變化（status: ${Object.values(snapshot.sessions).map((s) => s.status).join(", ")}）`);
  }
}

main().catch((e) => {
  console.error(`執行失敗：${e.message}`);
  process.exit(1);
});
