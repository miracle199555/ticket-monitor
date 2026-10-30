/**
 * 遠大 Ticket Plus 釋票監控 — 票區層級
 *   活動：Vaundy ASIA ARENA TOUR 2026 "HORO" IN TAIPEI
 *   場次：11/1 場（s000002007）
 *
 * 監控全部 79 個票區，任一票區從 soldout 變成可購買即通知，
 * 通知內容包含票區名稱與票價。
 *
 * 注意：遠大的 API 不提供「剩餘張數」，只有票區狀態，
 * 因此通知只能告知哪個票區有票，無法告知剩幾張。
 *
 * 本機執行：node monitor.js
 * GitHub Actions：憑證改由 LINE_TOKEN / LINE_USER_ID 環境變數提供
 */

const fs = require("fs");

// ===================== 設定 =====================

const INTERVAL_MS = 10000;          // 本機模式的檢查間隔（毫秒）
const LOOP_MODE = !process.env.CI;  // 本機持續跑；GitHub Actions 只跑一次

const SESSION_LABEL = "11/1 場";
const ORDER_URL =
  "https://ticketplus.com.tw/order/a56fce0af2da4d41e26b2dfa34b7babc/debf14611c86559f4c28d8005b063ccf";

// LINE 憑證（環境變數優先，否則用下方寫死的值）
const LINE = {
  token:
    process.env.LINE_TOKEN ||
    "rPE4l61mS5hla6ARLE4MihMuBQkQzrCW50g7poPQzFbvikt0WfZ8MT+cHiJwvSBAbB8UVS7L9etFPCit6B9P8OPX87QiAclvSeD5fdqL75vOmhCzi2C/qZjqVycRtcP1GyAaLdfTFLlMQI46gNN8SQdB04t89/1O/w1cDnyilFU=",
  userId: process.env.LINE_USER_ID || "U6620ed6708644aacdd8e44bc84f074b0",
};

const STATE_FILE = "./area-state.json";

// 這些狀態代表買不到，離開清單即視為可購買
const CLOSED_STATUSES = ["over", "soldout", "end", "notstart", "unavailable"];

// 不要加 origin / referer，實測會觸發防護回 403
const HEADERS = {
  accept: "text/html,application/json,*/*",
  "accept-language": "zh-TW,zh;q=0.9",
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36",
};

// ===================== 組出查詢網址 =====================

const pad = (prefix, n, width) => prefix + String(n).padStart(width, "0");

// 票區 a000007975 ~ a000008053（連號，共 79 個）
const TICKET_AREA_IDS = [];
for (let i = 7975; i <= 8053; i++) TICKET_AREA_IDS.push(pad("a", i, 9));

// 商品 p000014364~p000014433、p000014445、p000014449~p000014456
const PRODUCT_IDS = [];
for (let i = 14364; i <= 14433; i++) PRODUCT_IDS.push(pad("p", i, 9));
PRODUCT_IDS.push(pad("p", 14445, 9));
for (let i = 14449; i <= 14456; i++) PRODUCT_IDS.push(pad("p", i, 9));

function buildUrl() {
  return (
    "https://apis.ticketplus.com.tw/config/api/v1/get" +
    `?ticketAreaId=${TICKET_AREA_IDS.join("%2C")}` +
    `&productId=${PRODUCT_IDS.join("%2C")}` +
    `&&_=${Date.now()}`
  );
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(msg) {
  console.log(`[${new Date().toLocaleTimeString("zh-TW", { hour12: false })}] ${msg}`);
}

// ===================== LINE 通知 =====================

async function pushLine(text) {
  try {
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
  } catch (e) {
    log(`LINE 通知失敗：${e.message}`);
  }
}

// ===================== 抓取票區狀態 =====================

/**
 * 回傳 { 票區ID: { name, price, status } }
 */
async function fetchAreas() {
  const res = await fetch(buildUrl(), { headers: HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (data.errCode !== "00") throw new Error(`errCode=${data.errCode}`);

  const areas = {};
  for (const a of data.result.ticketArea || []) {
    areas[a.id] = {
      name: (a.ticketAreaName || "").trim(),
      price: a.price,
      status: a.status,
    };
  }
  if (Object.keys(areas).length === 0) throw new Error("回應中沒有票區資料");
  return areas;
}

function available(areas) {
  return Object.entries(areas)
    .filter(([, a]) => !CLOSED_STATUSES.includes(a.status))
    .map(([id, a]) => ({ id, ...a }));
}

function formatAreas(list) {
  return list
    .sort((a, b) => b.price - a.price)
    .map((a) => `${a.name}　$${a.price.toLocaleString()}（${a.status}）`)
    .join("\n");
}

// ===================== 主流程 =====================

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return null;
  }
}

function saveState(s) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

async function checkOnce(prev) {
  const areas = await fetchAreas();
  const open = available(areas);

  // 與上次比對，找出「新變成可買」的票區
  const newlyOpen = prev
    ? open.filter((a) => !prev[a.id] || CLOSED_STATUSES.includes(prev[a.id].status))
    : open;

  if (newlyOpen.length) {
    await pushLine(
      `🚨🚨 ${SESSION_LABEL} 有票了 🚨🚨\n\n${formatAreas(newlyOpen)}\n\n立即前往：\n${ORDER_URL}`
    );
    log(`偵測到 ${newlyOpen.length} 個票區開放：${newlyOpen.map((a) => a.name).join(", ")}`);
  }

  return { areas, openCount: open.length };
}

async function main() {
  log(`票區監控啟動：${SESSION_LABEL}，共追蹤 ${TICKET_AREA_IDS.length} 個票區`);

  let state = loadState();
  let consecutiveFails = 0;
  let failAlerted = false;
  let round = 0;

  if (LOOP_MODE && !state) {
    await pushLine(
      `🎫 票區監控已啟動\n場次：${SESSION_LABEL}\n追蹤 ${TICKET_AREA_IDS.length} 個票區\n檢查頻率：每 ${INTERVAL_MS / 1000} 秒\n有票會立刻通知你哪個區、多少錢。`
    );
  }

  do {
    round++;
    try {
      const { areas, openCount } = await checkOnce(state);
      state = areas;
      saveState(state);

      if (consecutiveFails > 0) {
        if (failAlerted) {
          await pushLine("✅ 監控連線已恢復。");
          failAlerted = false;
        }
        consecutiveFails = 0;
      }

      if (round === 1 || round % 30 === 0) {
        log(`第 ${round} 輪：可購買票區 ${openCount} 個 / 共 ${Object.keys(areas).length} 個`);
      }
    } catch (e) {
      consecutiveFails++;
      log(`第 ${round} 輪失敗（連續 ${consecutiveFails} 次）：${e.message}`);
      if (consecutiveFails === 15 && !failAlerted) {
        await pushLine(`⚠️ 票區監控異常\n連續 ${consecutiveFails} 次取得失敗\n錯誤：${e.message}`);
        failAlerted = true;
      }
      if (consecutiveFails > 5) await sleep(Math.min(consecutiveFails * 2000, 60000));
    }

    if (LOOP_MODE) await sleep(INTERVAL_MS);
  } while (LOOP_MODE);
}

main();
