import crypto from 'crypto';

// Игнорируем ошибки SSL
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const API_KEY = process.env.BINANCE_API_KEY!;
const API_SECRET = process.env.BINANCE_API_SECRET!;
const BASE_URL = 'https://fapi.binance.com';

function sign(query: string): string {
  return crypto.createHmac('sha256', API_SECRET).update(query).digest('hex');
}

async function request(path: string, params: Record<string, any> = {}) {
  params.timestamp = Date.now();
  const query = new URLSearchParams(params).toString();
  const signature = sign(query);
  const url = `${BASE_URL}${path}?${query}&signature=${signature}`;

  const res = await fetch(url, {
    headers: { 'X-MBX-APIKEY': API_KEY }
  });
  return res.json();
}

async function main() {
  const symbols = ['XAIUSDT', 'DUSKUSDT'];

  for (const symbol of symbols) {
    console.log('\n' + '='.repeat(60));
    console.log(`SYMBOL: ${symbol}`);
    console.log('='.repeat(60));

    // Обычные ордера
    console.log('\n--- OPEN ORDERS (/fapi/v1/openOrders) ---');
    try {
      const openOrders = await request('/fapi/v1/openOrders', { symbol });
      if (Array.isArray(openOrders) && openOrders.length > 0) {
        for (const o of openOrders) {
          console.log(JSON.stringify(o, null, 2));
        }
      } else {
        console.log('No open orders or error:', openOrders);
      }
    } catch (e: any) {
      console.log('Error:', e.message || e);
    }

    // OPEN Algo ордера (SL/TP через algo)
    console.log('\n--- OPEN ALGO ORDERS (/fapi/v1/openAlgoOrders) ---');
    try {
      const openAlgo = await request('/fapi/v1/openAlgoOrders', { symbol });
      console.log(JSON.stringify(openAlgo, null, 2));
    } catch (e: any) {
      console.log('Error:', e.message || e);
    }
  }
}

main().catch(console.error);
