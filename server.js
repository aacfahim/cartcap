// CartCap server: serves the app and proxies product/price lookups.
// Zero dependencies. Requires Node 18+ (built-in fetch).
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const CACHE_MS = 10 * 60 * 1000;
const cache = new Map();

async function tfetch(url, opts = {}, ms = 7000) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try { return await fetch(url, { ...opts, signal: c.signal }); }
  finally { clearTimeout(t); }
}

// ---- Provider: Open Food Facts (free, open product database; no prices) ----
async function openFoodFacts(code) {
  const r = await tfetch(`https://world.openfoodfacts.org/api/v2/product/${code}.json?fields=product_name,brands,quantity,image_front_small_url`, { headers: { 'User-Agent': 'CartCap/1.0' } });
  if (!r.ok) return null;
  const j = await r.json();
  if (j.status !== 1 || !j.product?.product_name) return null;
  const p = j.product;
  return { name: p.product_name, brand: (p.brands || '').split(',')[0].trim(), size: p.quantity || '', image: p.image_front_small_url || '' };
}

// ---- Provider: Woolworths (unofficial site API, best effort) ----
let wowCookie = { value: '', at: 0 };
async function wowSession() {
  if (wowCookie.value && Date.now() - wowCookie.at < 20 * 60 * 1000) return wowCookie.value;
  const r = await tfetch('https://www.woolworths.com.au/', { headers: { 'User-Agent': UA, Accept: 'text/html' } });
  const value = (r.headers.getSetCookie?.() || []).map(c => c.split(';')[0]).join('; ');
  wowCookie = { value, at: Date.now() };
  return value;
}
async function woolworths(code) {
  const cookie = await wowSession();
  const r = await tfetch('https://www.woolworths.com.au/apis/ui/Search/products', {
    method: 'POST',
    headers: { 'User-Agent': UA, 'Content-Type': 'application/json', Accept: 'application/json', Cookie: cookie, Origin: 'https://www.woolworths.com.au', Referer: 'https://www.woolworths.com.au/' },
    body: JSON.stringify({ SearchTerm: code.padStart(13, '0'), PageSize: 5, PageNumber: 1, SortType: 'TraderRelevance', IsSpecial: false, Location: '/shop/search/products?searchTerm=' + code })
  });
  if (!r.ok) throw new Error('woolworths ' + r.status);
  const j = await r.json();
  const all = (j.Products || []).flatMap(g => g.Products || []);
  const hit = all.find(p => (p.Barcode || '').replace(/^0+/, '') === code.replace(/^0+/, '')) || (all.length === 1 ? all[0] : null);
  if (!hit || hit.Price == null) return null;
  return {
    name: hit.Name, brand: hit.Brand || '', size: hit.PackageSize || '', image: hit.MediumImageFile || hit.SmallImageFile || '',
    price: { store: 'Woolworths', price: hit.Price, cup: hit.CupString || '', url: 'https://www.woolworths.com.au/shop/productdetails/' + hit.Stockcode }
  };
}

// ---- Add more stores here ----
// Coles has no public API and its site is bot-protected. To add it, plug in a licensed
// price-data API (or your own scraper) and return { name, brand, size, image, price:{store,price,cup,url} }.
const PRICE_PROVIDERS = [woolworths];

async function lookup(code) {
  const hit = cache.get(code);
  if (hit && Date.now() - hit.t < CACHE_MS) return hit.data;

  const [info, ...priced] = await Promise.allSettled([openFoodFacts(code), ...PRICE_PROVIDERS.map(p => p(code))]);
  const errors = [];
  const prices = [];
  let meta = info.status === 'fulfilled' ? info.value : null;
  for (const r of priced) {
    if (r.status === 'rejected') { errors.push(String(r.reason?.message || r.reason)); continue; }
    if (!r.value) continue;
    prices.push(r.value.price);
    meta = { ...(meta || {}), name: r.value.name, brand: r.value.brand || meta?.brand || '', size: r.value.size || meta?.size || '', image: r.value.image || meta?.image || '' };
  }
  const data = { barcode: code, found: !!meta, name: meta?.name || '', brand: meta?.brand || '', size: meta?.size || '', image: meta?.image || '', prices, errors };
  if (data.found) cache.set(code, { t: Date.now(), data });
  return data;
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const m = url.pathname.match(/^\/api\/lookup\/(\d{6,14})$/);
  if (m) {
    try {
      const data = await lookup(m[1]);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(e.message || e) }));
    }
    return;
  }
  let file = path.normalize(path.join(PUBLIC, url.pathname === '/' ? 'index.html' : url.pathname));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
}).listen(PORT, () => console.log(`CartCap running on http://localhost:${PORT}`));
