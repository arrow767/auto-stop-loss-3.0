// @bun
// index.ts
import crypto from "crypto";
import process from "process";
var cfg = {
  apiKey: getEnv("BINANCE_API_KEY", true),
  apiSecret: getEnv("BINANCE_API_SECRET", true),
  baseUrl: getEnv("BASE_URL") || "https://fapi.binance.com",
  intervalMs: parseInt(getEnv("INTERVAL_MS") || "1000"),
  slCheckIntervalMs: parseInt(getEnv("SL_CHECK_INTERVAL_MS") || "5000"),
  recvWindow: parseInt(getEnv("RECV_WINDOW") || "5000"),
  maxLossUsd: parseFloat(getEnv("MAX_LOSS_USD") || "100"),
  dryRun: getEnv("DRY_RUN") === "true",
  telegramBotToken: getEnv("TELEGRAM_BOT_TOKEN"),
  telegramChatId: getEnv("TELEGRAM_CHAT_ID"),
  telegramInterval: parseInt(getEnv("TELEGRAM_NOTIFICATION_INTERVAL_MS") || "30000")
};
var paused = false;
function getEnv(key, required = false) {
  const v = process.env[key];
  if (required && !v) {
    console.error(`[FATAL] Missing env: ${key}`);
    process.exit(1);
  }
  return v;
}
var sleep = (ms) => new Promise((r) => setTimeout(r, ms));
var LogLevel = { ERROR: 0, WARN: 1, INFO: 2 };
var LOG_LEVEL = LogLevel.INFO;
function log(msg) {
  if (LOG_LEVEL < LogLevel.INFO)
    return;
  console.log(`[${ts()}] ${msg}`);
}
function logError(msg) {
  console.log(`[${ts()}] ERR ${msg}`);
}
function logWarn(msg) {
  if (LOG_LEVEL < LogLevel.WARN)
    return;
  console.log(`[${ts()}] WRN ${msg}`);
}
function logSuccess(msg) {
  console.log(`[${ts()}] OK ${msg}`);
}
function ts() {
  const d = new Date;
  return `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}:${d.getSeconds().toString().padStart(2, "0")}`;
}
async function retry(fn, opts = {}) {
  const { attempts = 3, delayMs = 1000, name = "operation" } = opts;
  let lastError = null;
  for (let i = 1;i <= attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      if (i < attempts) {
        logWarn(`${name} failed (${i}/${attempts}), retry in ${delayMs}ms`);
        await sleep(delayMs);
      }
    }
  }
  throw lastError;
}

class BinanceAPI {
  symbolInfo = new Map;
  sign(query) {
    return crypto.createHmac("sha256", cfg.apiSecret).update(query).digest("hex");
  }
  async request(method, path, params = {}, signed = false) {
    const url = new URL(cfg.baseUrl + path);
    if (signed) {
      params.timestamp = Date.now();
      params.recvWindow = cfg.recvWindow;
    }
    const query = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
    if (signed) {
      const signature = this.sign(query);
      url.search = query + "&signature=" + signature;
    } else if (query) {
      url.search = query;
    }
    const res = await fetch(url.toString(), {
      method,
      headers: { "X-MBX-APIKEY": cfg.apiKey }
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    return res.json();
  }
  async getPositions() {
    const positions = await this.request("GET", "/fapi/v2/positionRisk", {}, true);
    return positions.filter((p) => parseFloat(p.positionAmt) !== 0).map((p) => ({
      symbol: p.symbol,
      amt: parseFloat(p.positionAmt),
      pnl: parseFloat(p.unRealizedProfit),
      side: parseFloat(p.positionAmt) > 0 ? "LONG" : "SHORT"
    }));
  }
  async getAlgoOrders(symbol) {
    const res = await this.request("GET", "/fapi/v1/openAlgoOrders", { symbol }, true);
    return Array.isArray(res) ? res : [];
  }
  async getOpenOrders(symbol) {
    return this.request("GET", "/fapi/v1/openOrders", { symbol }, true);
  }
  async cancelAllOrders(symbol) {
    await this.request("DELETE", "/fapi/v1/allOpenOrders", { symbol }, true);
  }
  async cancelAlgoOrder(symbol, algoId) {
    await this.request("DELETE", "/fapi/v1/algoOrder", { symbol, algoId }, true);
  }
  async marketClose(symbol, side, qty) {
    return this.request("POST", "/fapi/v1/order", {
      symbol,
      side,
      type: "MARKET",
      quantity: qty,
      reduceOnly: "true",
      newOrderRespType: "RESULT"
    }, true);
  }
  async roundQty(symbol, qty) {
    if (!this.symbolInfo.has(symbol)) {
      const info = await this.request("GET", "/fapi/v1/exchangeInfo");
      for (const s of info.symbols) {
        const lot = s.filters.find((f) => f.filterType === "LOT_SIZE");
        if (lot?.stepSize) {
          const precision2 = (lot.stepSize.split(".")[1] || "").length;
          this.symbolInfo.set(s.symbol, precision2);
        }
      }
    }
    const precision = this.symbolInfo.get(symbol) || 6;
    return parseFloat(qty.toFixed(precision));
  }
}

class TelegramBot {
  getStatus;
  lastUpdateId = 0;
  configured;
  lastNotify = new Map;
  polling = false;
  constructor(getStatus) {
    this.getStatus = getStatus;
    this.configured = !!(cfg.telegramBotToken && cfg.telegramChatId);
    if (!this.configured) {
      logWarn("Telegram \u043D\u0435 \u043D\u0430\u0441\u0442\u0440\u043E\u0435\u043D");
    }
  }
  async send(text, keyboard) {
    if (!this.configured)
      return false;
    try {
      const body = {
        chat_id: cfg.telegramChatId,
        text,
        parse_mode: "HTML"
      };
      if (keyboard) {
        body.reply_markup = JSON.stringify(keyboard);
      }
      const res = await fetch(`https://api.telegram.org/bot${cfg.telegramBotToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      return res.ok;
    } catch (e) {
      logError(`Telegram send: ${e.message}`);
      return false;
    }
  }
  shouldNotify(symbol) {
    const now = Date.now();
    const last = this.lastNotify.get(symbol) || 0;
    if (now - last >= cfg.telegramInterval) {
      this.lastNotify.set(symbol, now);
      return true;
    }
    return false;
  }
  clearSymbol(symbol) {
    this.lastNotify.delete(symbol);
  }
  startPolling() {
    if (!this.configured || this.polling)
      return;
    this.polling = true;
    log("Telegram \u0431\u043E\u0442 \u0437\u0430\u043F\u0443\u0449\u0435\u043D");
    this.poll();
  }
  async poll() {
    while (this.polling) {
      try {
        const updates = await this.getUpdates();
        for (const update of updates) {
          await this.handleUpdate(update);
        }
      } catch (e) {}
      await sleep(1000);
    }
  }
  async getUpdates() {
    try {
      const res = await fetch(`https://api.telegram.org/bot${cfg.telegramBotToken}/getUpdates?offset=${this.lastUpdateId + 1}&timeout=5`);
      const data = await res.json();
      if (data.ok && data.result) {
        for (const u of data.result) {
          if (u.update_id > this.lastUpdateId) {
            this.lastUpdateId = u.update_id;
          }
        }
        return data.result;
      }
    } catch (e) {}
    return [];
  }
  async handleUpdate(update) {
    const msg = update.message;
    const callback = update.callback_query;
    if (callback) {
      await this.handleCallback(callback);
      return;
    }
    if (!msg?.text)
      return;
    const chatId = msg.chat.id.toString();
    if (chatId !== cfg.telegramChatId)
      return;
    const text = msg.text.trim();
    const cmd = text.split(/\s+/)[0].toLowerCase();
    switch (cmd) {
      case "/start":
      case "/help":
        await this.cmdHelp();
        break;
      case "/status":
        await this.cmdStatus();
        break;
      case "/pause":
        await this.cmdPause();
        break;
      case "/resume":
        await this.cmdResume();
        break;
    }
  }
  async handleCallback(callback) {
    const data = callback.data;
    if (!data)
      return;
    try {
      await fetch(`https://api.telegram.org/bot${cfg.telegramBotToken}/answerCallbackQuery`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ callback_query_id: callback.id })
      });
    } catch (e) {}
    if (data === "status")
      await this.cmdStatus();
    else if (data === "pause")
      await this.cmdPause();
    else if (data === "resume")
      await this.cmdResume();
  }
  async cmdHelp() {
    await this.send(`<b>Loss Guardian 4.0</b>

` + `<b>\u041A\u043E\u043C\u0430\u043D\u0434\u044B:</b>
` + `/status - \u0441\u0442\u0430\u0442\u0443\u0441 \u0438 \u043F\u043E\u0437\u0438\u0446\u0438\u0438
` + `/pause - \u043F\u0440\u0438\u043E\u0441\u0442\u0430\u043D\u043E\u0432\u0438\u0442\u044C
` + `/resume - \u0432\u043E\u0437\u043E\u0431\u043D\u043E\u0432\u0438\u0442\u044C

` + `Max Loss: ${cfg.maxLossUsd} USDT`, {
      inline_keyboard: [
        [{ text: "\uD83D\uDCCA \u0421\u0442\u0430\u0442\u0443\u0441", callback_data: "status" }],
        [{ text: paused ? "\u25B6\uFE0F \u0412\u043E\u0437\u043E\u0431\u043D\u043E\u0432\u0438\u0442\u044C" : "\u23F8 \u041F\u0430\u0443\u0437\u0430", callback_data: paused ? "resume" : "pause" }]
      ]
    });
  }
  async cmdStatus() {
    const status = this.getStatus();
    const posText = status.positions.length === 0 ? "\u041D\u0435\u0442 \u043F\u043E\u0437\u0438\u0446\u0438\u0439" : status.positions.map((p) => {
      const pnl = p.pnl >= 0 ? `+${p.pnl.toFixed(2)}` : p.pnl.toFixed(2);
      const sl = p.hasSL === true ? "\u2705" : p.hasSL === false ? "\u274C" : "\u2753";
      return `${p.symbol}: ${pnl}$ ${sl}`;
    }).join(`
`);
    await this.send(`<b>\uD83D\uDCCA \u0421\u0442\u0430\u0442\u0443\u0441</b>

` + `\u0421\u043E\u0441\u0442\u043E\u044F\u043D\u0438\u0435: ${paused ? "\u23F8 \u041F\u0410\u0423\u0417\u0410" : "\u2705 \u0410\u043A\u0442\u0438\u0432\u0435\u043D"}
` + `\u041C\u0430\u043A\u0441. \u0443\u0431\u044B\u0442\u043E\u043A: <b>${cfg.maxLossUsd} USDT</b>
` + `\u041E\u0448\u0438\u0431\u043E\u043A: ${status.errors}

` + `<b>\u041F\u043E\u0437\u0438\u0446\u0438\u0438:</b>
<code>${posText}</code>`, {
      inline_keyboard: [
        [{ text: "\uD83D\uDD04 \u041E\u0431\u043D\u043E\u0432\u0438\u0442\u044C", callback_data: "status" }],
        [{ text: paused ? "\u25B6\uFE0F \u0412\u043E\u0437\u043E\u0431\u043D\u043E\u0432\u0438\u0442\u044C" : "\u23F8 \u041F\u0430\u0443\u0437\u0430", callback_data: paused ? "resume" : "pause" }]
      ]
    });
  }
  async cmdPause() {
    paused = true;
    await this.send(`\u23F8 <b>\u041C\u043E\u043D\u0438\u0442\u043E\u0440\u0438\u043D\u0433 \u043F\u0440\u0438\u043E\u0441\u0442\u0430\u043D\u043E\u0432\u043B\u0435\u043D</b>

\u041F\u043E\u0437\u0438\u0446\u0438\u0438 \u041D\u0415 \u0431\u0443\u0434\u0443\u0442 \u0437\u0430\u043A\u0440\u044B\u0432\u0430\u0442\u044C\u0441\u044F \u0430\u0432\u0442\u043E\u043C\u0430\u0442\u0438\u0447\u0435\u0441\u043A\u0438.`, {
      inline_keyboard: [[{ text: "\u25B6\uFE0F \u0412\u043E\u0437\u043E\u0431\u043D\u043E\u0432\u0438\u0442\u044C", callback_data: "resume" }]]
    });
    log("\u041C\u043E\u043D\u0438\u0442\u043E\u0440\u0438\u043D\u0433 \u043F\u0440\u0438\u043E\u0441\u0442\u0430\u043D\u043E\u0432\u043B\u0435\u043D \u0447\u0435\u0440\u0435\u0437 Telegram");
  }
  async cmdResume() {
    paused = false;
    await this.send(`\u25B6\uFE0F <b>\u041C\u043E\u043D\u0438\u0442\u043E\u0440\u0438\u043D\u0433 \u0432\u043E\u0437\u043E\u0431\u043D\u043E\u0432\u043B\u0451\u043D</b>

\u041C\u0430\u043A\u0441. \u0443\u0431\u044B\u0442\u043E\u043A: ${cfg.maxLossUsd} USDT`, {
      inline_keyboard: [[{ text: "\uD83D\uDCCA \u0421\u0442\u0430\u0442\u0443\u0441", callback_data: "status" }]]
    });
    log("\u041C\u043E\u043D\u0438\u0442\u043E\u0440\u0438\u043D\u0433 \u0432\u043E\u0437\u043E\u0431\u043D\u043E\u0432\u043B\u0451\u043D \u0447\u0435\u0440\u0435\u0437 Telegram");
  }
}

class SLChecker {
  api;
  telegram;
  getPositions;
  cache = new Map;
  running = false;
  interval = null;
  constructor(api, telegram, getPositions) {
    this.api = api;
    this.telegram = telegram;
    this.getPositions = getPositions;
  }
  start() {
    if (this.running)
      return;
    this.running = true;
    log(`SL Checker started`);
    this.interval = setInterval(() => this.check(), cfg.slCheckIntervalMs);
    this.check();
  }
  stop() {
    this.running = false;
    if (this.interval)
      clearInterval(this.interval);
  }
  getStatus(symbol) {
    return this.cache.get(symbol);
  }
  async check() {
    const positions = this.getPositions();
    for (const symbol of this.cache.keys()) {
      if (!positions.find((p) => p.symbol === symbol)) {
        this.cache.delete(symbol);
        this.telegram.clearSymbol(symbol);
      }
    }
    for (const pos of positions) {
      try {
        const hasSL = await this.checkSL(pos.symbol, pos.side);
        const prev = this.cache.get(pos.symbol);
        this.cache.set(pos.symbol, { hasSL, lastCheck: Date.now() });
        if (!hasSL) {
          if (this.telegram.shouldNotify(pos.symbol)) {
            logWarn(`${pos.symbol} NO SL`);
            await this.telegram.send(`\u26A0\uFE0F <b>${pos.symbol} \u041D\u0415\u0422 SL</b>
` + `${pos.side} | ${pos.pnl.toFixed(2)}$`);
          }
        } else if (prev && !prev.hasSL) {
          logSuccess(`${pos.symbol} SL ok`);
          this.telegram.clearSymbol(pos.symbol);
        }
      } catch (e) {}
    }
  }
  async checkSL(symbol, side) {
    const expectedSide = side === "LONG" ? "SELL" : "BUY";
    let hasNetworkError = false;
    try {
      const algoOrders = await this.api.getAlgoOrders(symbol);
      for (const order of algoOrders) {
        if (order.algoStatus !== "NEW")
          continue;
        if (order.side !== expectedSide)
          continue;
        if (order.orderType !== "STOP" && order.orderType !== "STOP_MARKET")
          continue;
        if (order.closePosition === true)
          return true;
        if (parseFloat(order.quantity || "0") > 0)
          return true;
      }
    } catch (e) {
      hasNetworkError = true;
    }
    try {
      const orders = await this.api.getOpenOrders(symbol);
      for (const order of orders) {
        if (order.status !== "NEW")
          continue;
        if (order.side !== expectedSide)
          continue;
        if (order.type !== "STOP" && order.type !== "STOP_MARKET")
          continue;
        const closePos = order.closePosition === "true" || order.closePosition === true;
        const hasQty = parseFloat(order.origQty || order.quantity || "0") > 0;
        if (closePos || hasQty)
          return true;
      }
    } catch (e) {
      hasNetworkError = true;
    }
    if (hasNetworkError)
      throw new Error("Network error");
    return false;
  }
}

class PositionMonitor {
  api;
  telegram;
  slChecker;
  positions = [];
  running = false;
  errors = 0;
  lastPrint = 0;
  constructor(api, telegram, slChecker) {
    this.api = api;
    this.telegram = telegram;
    this.slChecker = slChecker;
  }
  getPositions() {
    return this.positions;
  }
  getStatusInfo() {
    return {
      positions: this.positions.map((p) => ({
        symbol: p.symbol,
        pnl: p.pnl,
        hasSL: this.slChecker.getStatus(p.symbol)?.hasSL ?? null
      })),
      errors: this.errors
    };
  }
  async start() {
    this.running = true;
    log(`Monitor started (max loss: ${cfg.maxLossUsd}$)`);
    while (this.running) {
      try {
        await this.tick();
        this.errors = 0;
      } catch (e) {
        this.errors++;
        logError(`Tick: ${e.message.slice(0, 50)}`);
        if (this.errors >= 10) {
          logWarn(`${this.errors} errors, sleep 30s`);
          await sleep(30000);
        }
      }
      await sleep(cfg.intervalMs);
    }
  }
  stop() {
    this.running = false;
  }
  async tick() {
    this.positions = await this.api.getPositions();
    this.printPositions();
    if (paused)
      return;
    for (const pos of this.positions) {
      if (pos.pnl < 0) {
        const loss = Math.abs(pos.pnl);
        if (loss >= cfg.maxLossUsd) {
          logError(`${pos.symbol} -${loss.toFixed(0)}$ >= ${cfg.maxLossUsd}$ CLOSING`);
          await this.closePosition(pos);
        }
      }
    }
  }
  printPositions() {
    const now = Date.now();
    if (now - this.lastPrint < 60000)
      return;
    this.lastPrint = now;
    if (this.positions.length === 0) {
      log("\u041D\u0435\u0442 \u043E\u0442\u043A\u0440\u044B\u0442\u044B\u0445 \u043F\u043E\u0437\u0438\u0446\u0438\u0439");
      return;
    }
    for (const pos of this.positions) {
      const slState = this.slChecker.getStatus(pos.symbol);
      const slStr = slState ? slState.hasSL ? "[SL]" : "[NO SL]" : "[?]";
      const pnlStr = pos.pnl >= 0 ? `+${pos.pnl.toFixed(2)}` : pos.pnl.toFixed(2);
      log(`${pos.symbol} ${pos.side} | PnL: ${pnlStr} | ${slStr}`);
    }
  }
  async closePosition(pos) {
    const side = pos.amt > 0 ? "SELL" : "BUY";
    const qty = await this.api.roundQty(pos.symbol, Math.abs(pos.amt));
    if (cfg.dryRun) {
      logWarn(`[DRY] ${pos.symbol} ${side} ${qty}`);
      return;
    }
    try {
      await this.api.cancelAllOrders(pos.symbol);
    } catch {}
    try {
      const algoOrders = await this.api.getAlgoOrders(pos.symbol);
      for (const order of algoOrders) {
        if (order.algoStatus === "NEW") {
          await this.api.cancelAlgoOrder(pos.symbol, order.algoId);
        }
      }
    } catch {}
    try {
      const result = await retry(() => this.api.marketClose(pos.symbol, side, qty.toString()), { attempts: 3, delayMs: 500, name: `close ${pos.symbol}` });
      if (result.status === "FILLED") {
        logSuccess(`${pos.symbol} closed #${result.orderId}`);
        await this.telegram.send(`\uD83D\uDEA8 <b>\u0417\u0410\u041A\u0420\u042B\u0422\u041E: ${pos.symbol}</b>
` + `PnL: ${pos.pnl.toFixed(2)}$ | #${result.orderId}`);
      } else if (result.status === "PARTIALLY_FILLED" || result.status === "NEW") {
        logWarn(`${pos.symbol} order ${result.status} #${result.orderId}`);
        await this.telegram.send(`\u26A0\uFE0F <b>${pos.symbol} \u043D\u0435 \u043F\u043E\u043B\u043D\u043E\u0441\u0442\u044C\u044E \u0437\u0430\u043A\u0440\u044B\u0442</b>
` + `Status: ${result.status} | #${result.orderId}`);
      } else {
        logError(`${pos.symbol} unexpected status: ${result.status}`);
        await this.telegram.send(`\u274C <b>${pos.symbol} \u0441\u0442\u0430\u0442\u0443\u0441: ${result.status}</b>
#${result.orderId}`);
      }
    } catch (e) {
      logError(`FAILED ${pos.symbol}: ${e.message}`);
      await this.telegram.send(`\u274C <b>\u041E\u0428\u0418\u0411\u041A\u0410 ${pos.symbol}</b>
${e.message.slice(0, 100)}`);
    }
  }
}

class LossGuardian {
  api = new BinanceAPI;
  telegram;
  slChecker;
  monitor;
  constructor() {
    this.telegram = new TelegramBot(() => this.monitor.getStatusInfo());
    this.slChecker = new SLChecker(this.api, this.telegram, () => this.monitor.getPositions());
    this.monitor = new PositionMonitor(this.api, this.telegram, this.slChecker);
  }
  async start() {
    log("\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550");
    log("  Binance Loss Guardian 4.0");
    log("\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550");
    log(`Max Loss: ${cfg.maxLossUsd} USDT`);
    await this.telegram.send(`\uD83D\uDE80 <b>Loss Guardian 4.0 \u0437\u0430\u043F\u0443\u0449\u0435\u043D</b>

` + `Max Loss: ${cfg.maxLossUsd} USDT
` + `\u0421\u043E\u0441\u0442\u043E\u044F\u043D\u0438\u0435: \u0410\u043A\u0442\u0438\u0432\u0435\u043D`);
    this.telegram.startPolling();
    this.slChecker.start();
    await this.monitor.start();
  }
  stop() {
    this.slChecker.stop();
    this.monitor.stop();
  }
}
async function main() {
  const guardian = new LossGuardian;
  process.on("SIGINT", () => {
    log("\u0417\u0430\u0432\u0435\u0440\u0448\u0435\u043D\u0438\u0435...");
    guardian.stop();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    log("\u0417\u0430\u0432\u0435\u0440\u0448\u0435\u043D\u0438\u0435...");
    guardian.stop();
    process.exit(0);
  });
  await guardian.start();
}
async function runForever() {
  while (true) {
    try {
      await main();
    } catch (e) {
      logError(`Fatal: ${e.message.slice(0, 80)}`);
      logWarn("Restart in 10s");
      await sleep(1e4);
    }
  }
}
runForever();
