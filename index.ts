/**
 * Binance Futures Loss Guardian 3.0
 *
 * Функционал:
 * 1. Мониторинг позиций каждые INTERVAL_MS
 * 2. Закрытие позиции при убытке >= MAX_LOSS_USD
 * 3. Проверка наличия SL (отдельный цикл SL_CHECK_INTERVAL_MS)
 * 4. Telegram уведомления о позициях без SL
 *
 * Запуск: bun run index.ts
 */

import crypto from 'crypto';
import process from 'process';
import { serve } from 'bun';

// ===================== TYPES =====================

interface PositionRisk {
  symbol: string;
  positionAmt: string;
  unRealizedProfit: string;
}

interface AlgoOrder {
  algoId: number;
  symbol: string;
  side: 'BUY' | 'SELL';
  quantity: string;
  orderType: string;      // STOP_MARKET, etc
  algoStatus: string;     // NEW, FILLED, etc
  closePosition?: boolean;
}

interface ExchangeInfoSymbol {
  symbol: string;
  filters: Array<{ filterType: string; stepSize?: string }>;
}

// ===================== CONFIG =====================

const cfg = {
  apiKey: getEnv('BINANCE_API_KEY', true)!,
  apiSecret: getEnv('BINANCE_API_SECRET', true)!,
  baseUrl: getEnv('BASE_URL') || 'https://fapi.binance.com',
  intervalMs: parseInt(getEnv('INTERVAL_MS') || '1000'),
  slCheckIntervalMs: parseInt(getEnv('SL_CHECK_INTERVAL_MS') || '5000'),
  recvWindow: parseInt(getEnv('RECV_WINDOW') || '5000'),
  maxLossUsd: parseFloat(getEnv('MAX_LOSS_USD') || '100'),
  dryRun: getEnv('DRY_RUN') === 'true',
  healthcheckPort: parseInt(getEnv('HEALTHCHECK_PORT') || '3000'),
  telegramBotToken: getEnv('TELEGRAM_BOT_TOKEN'),
  telegramChatId: getEnv('TELEGRAM_CHAT_ID'),
  telegramInterval: parseInt(getEnv('TELEGRAM_NOTIFICATION_INTERVAL_MS') || '30000'),
};

function getEnv(key: string, required = false): string | undefined {
  const v = process.env[key];
  if (required && !v) {
    console.error(`[FATAL] Missing env: ${key}`);
    process.exit(1);
  }
  return v;
}

// ===================== UTILS =====================

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const C = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  dim: '\x1b[2m',
};

function log(msg: string) {
  const time = new Date().toLocaleTimeString('ru-RU');
  console.log(`${C.dim}[${time}]${C.reset} ${msg}`);
}

function logError(msg: string) {
  const time = new Date().toLocaleTimeString('ru-RU');
  console.log(`${C.red}[${time}] ERROR: ${msg}${C.reset}`);
}

function logWarn(msg: string) {
  const time = new Date().toLocaleTimeString('ru-RU');
  console.log(`${C.yellow}[${time}] WARN: ${msg}${C.reset}`);
}

function logSuccess(msg: string) {
  const time = new Date().toLocaleTimeString('ru-RU');
  console.log(`${C.green}[${time}] ${msg}${C.reset}`);
}

function formatPnL(pnl: number): string {
  const sign = pnl >= 0 ? '+' : '';
  const color = pnl >= 0 ? C.green : C.red;
  return `${color}${sign}${pnl.toFixed(2)}${C.reset}`;
}

// ===================== BINANCE API =====================

class BinanceAPI {
  private symbolInfo = new Map<string, number>(); // symbol -> stepSize precision

  private sign(query: string): string {
    return crypto.createHmac('sha256', cfg.apiSecret).update(query).digest('hex');
  }

  private async request<T>(method: string, path: string, params: Record<string, any> = {}, signed = false): Promise<T> {
    const url = new URL(cfg.baseUrl + path);

    if (signed) {
      params.timestamp = Date.now();
      params.recvWindow = cfg.recvWindow;
    }

    const query = Object.entries(params)
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join('&');

    if (signed) {
      const signature = this.sign(query);
      url.search = query + '&signature=' + signature;
    } else if (query) {
      url.search = query;
    }

    const res = await fetch(url.toString(), {
      method,
      headers: { 'X-MBX-APIKEY': cfg.apiKey },
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    }

    return res.json();
  }

  async getPositions(): Promise<Array<{ symbol: string; amt: number; pnl: number; side: 'LONG' | 'SHORT' }>> {
    const positions = await this.request<PositionRisk[]>('GET', '/fapi/v2/positionRisk', {}, true);
    return positions
      .filter(p => parseFloat(p.positionAmt) !== 0)
      .map(p => ({
        symbol: p.symbol,
        amt: parseFloat(p.positionAmt),
        pnl: parseFloat(p.unRealizedProfit),
        side: parseFloat(p.positionAmt) > 0 ? 'LONG' as const : 'SHORT' as const,
      }));
  }

  async getAlgoOrders(symbol: string): Promise<AlgoOrder[]> {
    const res = await this.request<AlgoOrder[]>('GET', '/fapi/v1/openAlgoOrders', { symbol }, true);
    // API возвращает массив напрямую, не объект с orders
    return Array.isArray(res) ? res : [];
  }

  async getOpenOrders(symbol: string): Promise<any[]> {
    return this.request<any[]>('GET', '/fapi/v1/openOrders', { symbol }, true);
  }

  async cancelAllOrders(symbol: string): Promise<void> {
    await this.request('DELETE', '/fapi/v1/allOpenOrders', { symbol }, true);
  }

  async cancelAlgoOrder(symbol: string, algoId: number): Promise<void> {
    await this.request('DELETE', '/fapi/v1/algoOrder', { symbol, algoId }, true);
  }

  async marketClose(symbol: string, side: 'BUY' | 'SELL', qty: string): Promise<{ orderId: number; status: string }> {
    return this.request('POST', '/fapi/v1/order', {
      symbol,
      side,
      type: 'MARKET',
      quantity: qty,
      reduceOnly: 'true',
      newOrderRespType: 'RESULT',
    }, true);
  }

  async roundQty(symbol: string, qty: number): Promise<number> {
    if (!this.symbolInfo.has(symbol)) {
      const info = await this.request<{ symbols: ExchangeInfoSymbol[] }>('GET', '/fapi/v1/exchangeInfo');
      for (const s of info.symbols) {
        const lot = s.filters.find(f => f.filterType === 'LOT_SIZE');
        if (lot?.stepSize) {
          const precision = (lot.stepSize.split('.')[1] || '').length;
          this.symbolInfo.set(s.symbol, precision);
        }
      }
    }
    const precision = this.symbolInfo.get(symbol) || 6;
    return parseFloat(qty.toFixed(precision));
  }
}

// ===================== TELEGRAM =====================

class Telegram {
  private lastNotify = new Map<string, number>();
  private configured: boolean;

  constructor() {
    this.configured = !!(cfg.telegramBotToken && cfg.telegramChatId);
    if (!this.configured) {
      logWarn('Telegram не настроен (TELEGRAM_BOT_TOKEN или TELEGRAM_CHAT_ID отсутствуют)');
    }
  }

  async send(text: string): Promise<boolean> {
    if (!this.configured) return false;
    try {
      const res = await fetch(`https://api.telegram.org/bot${cfg.telegramBotToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: cfg.telegramChatId, text, parse_mode: 'HTML' }),
      });
      return res.ok;
    } catch (e: any) {
      logError(`Telegram: ${e.message}`);
      return false;
    }
  }

  shouldNotify(symbol: string): boolean {
    const now = Date.now();
    const last = this.lastNotify.get(symbol) || 0;
    if (now - last >= cfg.telegramInterval) {
      this.lastNotify.set(symbol, now);
      return true;
    }
    return false;
  }

  clearSymbol(symbol: string) {
    this.lastNotify.delete(symbol);
  }
}

// ===================== SL CHECKER =====================

interface SLState {
  hasSL: boolean;
  lastCheck: number;
}

class SLChecker {
  private cache = new Map<string, SLState>();
  private running = false;
  private interval: ReturnType<typeof setInterval> | null = null;

  constructor(private api: BinanceAPI, private telegram: Telegram, private getPositions: () => Position[]) {}

  start() {
    if (this.running) return;
    this.running = true;
    log(`SL Checker запущен (интервал: ${cfg.slCheckIntervalMs}ms)`);
    this.interval = setInterval(() => this.check(), cfg.slCheckIntervalMs);
    this.check();
  }

  stop() {
    this.running = false;
    if (this.interval) clearInterval(this.interval);
  }

  getStatus(symbol: string): SLState | undefined {
    return this.cache.get(symbol);
  }

  private async check() {
    const positions = this.getPositions();

    // Очищаем кеш для закрытых позиций
    for (const symbol of this.cache.keys()) {
      if (!positions.find(p => p.symbol === symbol)) {
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
          logWarn(`${pos.symbol} - НЕТ SL! PnL: ${formatPnL(pos.pnl)}`);

          if (this.telegram.shouldNotify(pos.symbol)) {
            await this.telegram.send(
              `⚠️ <b>${pos.symbol} БЕЗ СТОП-ЛОССА!</b>\n\n` +
              `Сторона: ${pos.side}\n` +
              `Размер: ${Math.abs(pos.amt)}\n` +
              `PnL: ${pos.pnl.toFixed(2)} USDT\n\n` +
              `Установите SL!`
            );
          }
        } else if (prev && !prev.hasSL) {
          logSuccess(`${pos.symbol} - SL установлен`);
          this.telegram.clearSymbol(pos.symbol);
        }
      } catch (e: any) {
        logError(`Проверка SL ${pos.symbol}: ${e.message}`);
      }
    }
  }

  private async checkSL(symbol: string, side: 'LONG' | 'SHORT'): Promise<boolean> {
    const expectedSide = side === 'LONG' ? 'SELL' : 'BUY';
    let hasNetworkError = false;

    // Проверяем algo orders (openAlgoOrders)
    try {
      const algoOrders = await this.api.getAlgoOrders(symbol);
      for (const order of algoOrders) {
        if (order.algoStatus !== 'NEW') continue;
        if (order.side !== expectedSide) continue;
        if (order.orderType !== 'STOP' && order.orderType !== 'STOP_MARKET') continue;

        // SL найден если closePosition=true или есть quantity
        if (order.closePosition === true) {
          return true;
        }
        const hasQty = parseFloat(order.quantity || '0') > 0;
        if (hasQty) {
          return true;
        }
      }
    } catch (e: any) {
      // Ошибка сети - не можем проверить, пробрасываем ошибку
      hasNetworkError = true;
    }

    // Проверяем обычные orders
    try {
      const orders = await this.api.getOpenOrders(symbol);
      for (const order of orders) {
        if (order.status !== 'NEW') continue;
        if (order.side !== expectedSide) continue;
        if (order.type !== 'STOP' && order.type !== 'STOP_MARKET') continue;

        const closePos = order.closePosition === 'true' || order.closePosition === true;
        const hasQty = parseFloat(order.origQty || order.quantity || '0') > 0;
        if (closePos || hasQty) {
          return true;
        }
      }
    } catch (e: any) {
      hasNetworkError = true;
    }

    // Если были ошибки сети и не нашли SL - бросаем ошибку чтобы показать [?]
    if (hasNetworkError) {
      throw new Error('Network error during SL check');
    }

    return false;
  }
}

// ===================== POSITION MONITOR =====================

interface Position {
  symbol: string;
  amt: number;
  pnl: number;
  side: 'LONG' | 'SHORT';
}

class PositionMonitor {
  private positions: Position[] = [];
  private running = false;
  private lastTick = 0;
  private errors = 0;

  constructor(
    private api: BinanceAPI,
    private telegram: Telegram,
    private slChecker: SLChecker
  ) {}

  getPositions(): Position[] {
    return this.positions;
  }

  async start() {
    this.running = true;
    log(`Position Monitor запущен (интервал: ${cfg.intervalMs}ms, max loss: ${cfg.maxLossUsd} USDT)`);

    while (this.running) {
      try {
        await this.tick();
        this.lastTick = Date.now();
        this.errors = 0;
      } catch (e: any) {
        this.errors++;
        logError(`Tick: ${e.message}`);
        // При множественных ошибках ждём дольше, но НЕ падаем
        if (this.errors >= 10) {
          logWarn(`${this.errors} ошибок подряд, ждём 30 секунд...`);
          await sleep(30000);
        }
      }
      await sleep(cfg.intervalMs);
    }
  }

  stop() {
    this.running = false;
  }

  getHealth() {
    return {
      healthy: this.running && this.errors < 10,
      lastTick: this.lastTick,
      errors: this.errors,
    };
  }

  private async tick() {
    this.positions = await this.api.getPositions();
    this.printPositions();

    for (const pos of this.positions) {
      // КРИТИЧНО: закрываем ТОЛЬКО если pnl отрицательный И убыток >= maxLoss
      // pnl < 0 = убыток, pnl > 0 = прибыль
      if (pos.pnl < 0) {
        const loss = Math.abs(pos.pnl);  // убыток как положительное число
        if (loss >= cfg.maxLossUsd) {
          logError(`${pos.symbol} УБЫТОК ${loss.toFixed(2)} >= ${cfg.maxLossUsd} USDT - ЗАКРЫВАЕМ!`);
          await this.closePosition(pos);
        }
      }
    }
  }

  private printPositions() {
    if (this.positions.length === 0) {
      log('Нет открытых позиций');
      return;
    }

    console.log('');
    for (const pos of this.positions) {
      const slState = this.slChecker.getStatus(pos.symbol);
      const slStr = slState
        ? (slState.hasSL ? `${C.green}[SL]${C.reset}` : `${C.red}[NO SL]${C.reset}`)
        : `${C.yellow}[?]${C.reset}`;

      const dir = pos.side === 'LONG' ? '▲' : '▼';
      log(`${pos.symbol.padEnd(12)} ${dir} ${pos.side.padEnd(5)} | amt: ${pos.amt.toFixed(4).padStart(12)} | PnL: ${formatPnL(pos.pnl).padStart(20)} | ${slStr}`);
    }
    console.log('');
  }

  private async closePosition(pos: Position) {
    const side = pos.amt > 0 ? 'SELL' : 'BUY';
    const qty = await this.api.roundQty(pos.symbol, Math.abs(pos.amt));

    if (cfg.dryRun) {
      logWarn(`[DRY RUN] Закрыли бы ${pos.symbol}: ${side} ${qty}`);
      return;
    }

    try {
      // Отменяем все ордера
      try {
        await this.api.cancelAllOrders(pos.symbol);
        log(`${pos.symbol} - ордера отменены`);
      } catch (e) {}

      // Отменяем algo ордера
      try {
        const algoOrders = await this.api.getAlgoOrders(pos.symbol);
        for (const order of algoOrders) {
          if (order.algoStatus === 'NEW') {
            await this.api.cancelAlgoOrder(pos.symbol, order.algoId);
          }
        }
      } catch (e) {}

      // Закрываем позицию
      const result = await this.api.marketClose(pos.symbol, side, qty.toString());
      logSuccess(`${pos.symbol} ЗАКРЫТ! OrderId: ${result.orderId}, Status: ${result.status}`);

      // Telegram
      await this.telegram.send(
        `🚨 <b>ПОЗИЦИЯ ЗАКРЫТА: ${pos.symbol}</b>\n\n` +
        `Причина: Убыток >= ${cfg.maxLossUsd} USDT\n` +
        `PnL: ${pos.pnl.toFixed(2)} USDT\n` +
        `Сторона: ${side}\n` +
        `Количество: ${qty}\n` +
        `Order ID: ${result.orderId}`
      );

      this.slChecker.getStatus(pos.symbol) && this.telegram.clearSymbol(pos.symbol);
    } catch (e: any) {
      logError(`Не удалось закрыть ${pos.symbol}: ${e.message}`);
      await this.telegram.send(`❌ <b>ОШИБКА закрытия ${pos.symbol}</b>\n\n${e.message}`);
    }
  }
}

// ===================== MAIN =====================

class LossGuardian {
  private api = new BinanceAPI();
  private telegram = new Telegram();
  private slChecker: SLChecker;
  private monitor: PositionMonitor;

  constructor() {
    this.slChecker = new SLChecker(this.api, this.telegram, () => this.monitor.getPositions());
    this.monitor = new PositionMonitor(this.api, this.telegram, this.slChecker);
  }

  async start() {
    console.log(`\n${C.cyan}═══════════════════════════════════════════════════════════${C.reset}`);
    console.log(`${C.cyan}  Binance Loss Guardian 3.0${C.reset}`);
    console.log(`${C.cyan}═══════════════════════════════════════════════════════════${C.reset}\n`);

    log(`Max Loss: ${cfg.maxLossUsd} USDT`);
    log(`Interval: ${cfg.intervalMs}ms`);
    log(`SL Check: ${cfg.slCheckIntervalMs}ms`);
    log(`Dry Run: ${cfg.dryRun ? 'YES' : 'NO'}`);
    console.log('');

    await this.telegram.send(
      `🚀 <b>Loss Guardian 3.0 запущен</b>\n\n` +
      `Max Loss: ${cfg.maxLossUsd} USDT\n` +
      `Interval: ${cfg.intervalMs}ms\n` +
      `Dry Run: ${cfg.dryRun ? 'Да' : 'Нет'}`
    );

    this.slChecker.start();
    await this.monitor.start();
  }

  stop() {
    this.slChecker.stop();
    this.monitor.stop();
  }

  getHealth() {
    return this.monitor.getHealth();
  }
}

// ===================== HEALTHCHECK SERVER =====================

let guardian: LossGuardian;

serve({
  port: cfg.healthcheckPort,
  fetch(req) {
    const health = guardian?.getHealth() || { healthy: false };
    return new Response(JSON.stringify(health), {
      status: health.healthy ? 200 : 503,
      headers: { 'Content-Type': 'application/json' },
    });
  },
});

// ===================== BOOTSTRAP =====================

async function main() {
  guardian = new LossGuardian();

  process.on('SIGINT', () => {
    log('Завершение...');
    guardian.stop();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    log('Завершение...');
    guardian.stop();
    process.exit(0);
  });

  await guardian.start();
}

main().catch(e => {
  logError(`Fatal: ${e.message}`);
  process.exit(1);
});
