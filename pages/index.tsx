// pages/index.tsx
// Binance-themed WebSocket Candle Viewer with aligned table + exact CSV
import Head from 'next/head';
import { useEffect, useMemo, useRef, useState } from 'react';

type WSState = 'disconnected' | 'connecting' | 'connected';

interface KlineRow { time:number; open:number; high:number; low:number; close:number; volume:number; }
interface SymbolInfo { symbol:string; baseAsset:string; quoteAsset:string; status:string; }
interface Ticker24h { lastPrice:number; priceChangePercent:number; highPrice:number; lowPrice:number; volume:number; quoteVolume:number; }

const INTERVALS = ['1m','5m','15m','30m','1h'] as const;

// ✅ New ranges added
const RANGES = ['1h','4h','1d','7d','15d','30d'] as const;
const RANGE_MS: Record<typeof RANGES[number], number> = {
  '1h': 3600000,
  '4h': 14400000,
  '1d': 86400000,
  '7d': 7*86400000,
  '15d': 15*86400000,
  '30d': 30*86400000,
};

const CANDLES_FOR_RANGE = (interval: string, range: typeof RANGES[number]) => {
  const map: Record<string, number> = { '1m': 60, '5m': 12, '15m': 4, '30m': 2, '1h': 1 };
  const perHour = map[interval] ?? 60;
  const hours = RANGE_MS[range] / 3600000;
  return Math.min(1000, perHour * hours); // Binance limit
};

export default function HomePage() {
  const [symbols, setSymbols] = useState<SymbolInfo[]>([]);
  const [search, setSearch] = useState('');
  const [onlyUsdt, setOnlyUsdt] = useState(true);
  const [favorites, setFavorites] = useState<string[]>([]);

  const [symbol, setSymbol] = useState('ETHUSDT');
  const [interval, setIntervalV] = useState<typeof INTERVALS[number]>('1m');
  const [range, setRange] = useState<typeof RANGES[number]>('1h');

  const [rows, setRows] = useState<KlineRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [wsStatus, setWsStatus] = useState<WSState>('disconnected');
  const [ticker, setTicker] = useState<Ticker24h | null>(null);

  const wsRef = useRef<WebSocket | null>(null);

  // favorites
  useEffect(() => { try { const raw = localStorage.getItem('fav_symbols'); if (raw) setFavorites(JSON.parse(raw)); } catch {} }, []);
  const toggleFav = (sym: string) => {
    setFavorites(prev => {
      const next = prev.includes(sym) ? prev.filter(s=>s!==sym) : [...prev, sym];
      try { localStorage.setItem('fav_symbols', JSON.stringify(next)); } catch {}
      return next;
    });
  };

  // symbols
  useEffect(() => {
    let off = false;
    (async () => {
      try {
        const res = await fetch('https://api.binance.com/api/v3/exchangeInfo');
        const data = await res.json();
        if (off) return;
        const list: SymbolInfo[] = (data?.symbols || [])
          .filter((s:any)=>s?.status==='TRADING')
          .map((s:any)=>({ symbol:s.symbol, baseAsset:s.baseAsset, quoteAsset:s.quoteAsset, status:s.status }));
        setSymbols(list);
      } catch {}
    })();
    return () => { off = true; };
  }, []);

  const filteredSymbols = useMemo(() => {
    const q = search.trim().toLowerCase();
    let list = symbols.filter(s => (onlyUsdt ? s.quoteAsset==='USDT' : true));
    if (q) list = list.filter(s => s.symbol.toLowerCase().includes(q) || s.baseAsset.toLowerCase().includes(q));
    return list.slice(0, 1200);
  }, [symbols, search, onlyUsdt]);

  // klines
  const fetchInitial = async (sym: string, intv: string, rng: typeof RANGES[number]) => {
    setLoading(true); setError(null);
    try {
      const now = Date.now();
      const startTime = now - RANGE_MS[rng];
      const limit = CANDLES_FOR_RANGE(intv, rng);
      const url = new URL('https://api.binance.com/api/v3/klines');
      url.searchParams.set('symbol', sym);
      url.searchParams.set('interval', intv);
      url.searchParams.set('startTime', String(startTime));
      url.searchParams.set('endTime', String(now));
      url.searchParams.set('limit', String(limit));
      const res = await fetch(url.toString());
      const data = await res.json();
      if (!Array.isArray(data)) throw new Error('Unexpected response');
      const mapped: KlineRow[] = data.map((k:any[])=>({ time:k[0], open:+k[1], high:+k[2], low:+k[3], close:+k[4], volume:+k[5] }));
      setRows(mapped.filter(r=>r.time >= startTime));
    } catch (e:any) { setError(e?.message || 'Failed to load klines'); setRows([]); }
    finally { setLoading(false); }
  };

  const loadTicker = async (sym: string) => {
    try {
      const res = await fetch(`https://api.binance.com/api/v3/ticker/24hr?symbol=${sym}`);
      const d = await res.json();
      setTicker({ lastPrice:+d.lastPrice, priceChangePercent:+d.priceChangePercent, highPrice:+d.highPrice, lowPrice:+d.lowPrice, volume:+d.volume, quoteVolume:+d.quoteVolume });
    } catch { setTicker(null); }
  };

  const connectWs = (sym: string, intv: string) => {
    if (wsRef.current) { try { wsRef.current.close(); } catch {} wsRef.current = null; }
    const ws = new WebSocket(`wss://stream.binance.com:9443/ws/${sym.toLowerCase()}@kline_${intv}`);
    wsRef.current = ws; setWsStatus('connecting');
    ws.onopen = () => setWsStatus('connected');
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg?.e !== 'kline') return;
        const k = msg.k;
        const openTime = k.t as number;
        const upd: KlineRow = { time: openTime, open:+k.o, high:+k.h, low:+k.l, close:+k.c, volume:+k.v };
        setRows(prev => {
          const startTime = Date.now() - RANGE_MS[range];
          let next = prev.filter(r => r.time >= startTime);
          const i = next.findIndex(r => r.time === openTime);
          if (i >= 0) { next = [...next]; next[i] = upd; } else { next = [...next, upd]; }
          next.sort((a,b)=>a.time-b.time);
          const max = CANDLES_FOR_RANGE(intv, range);
          if (next.length > max) next = next.slice(next.length - max);
          return next;
        });
      } catch {}
    };
    ws.onclose = () => setWsStatus('disconnected');
    ws.onerror = () => setWsStatus('disconnected');
  };

  useEffect(() => {
    fetchInitial(symbol, interval, range);
    loadTicker(symbol);
    connectWs(symbol, interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol, interval, range]);

  // formatting (shared by table + CSV)
  const fmtNum = (n:number, d=6) => Number.isFinite(n) ? n.toLocaleString(undefined, { maximumFractionDigits: d }) : '-';
  const fmtVol = (n:number) => fmtNum(n, 4);
  const fmtTime = (ms:number) => new Date(ms).toLocaleString();

  // CSV that mirrors the table exactly (same order + same formatted strings)
  const downloadCsv = () => {
    const headers = ['Time','Open','High','Low','Close','Volume'];
    const formatRow = (r:KlineRow) => [fmtTime(r.time), fmtNum(r.open), fmtNum(r.high), fmtNum(r.low), fmtNum(r.close), fmtVol(r.volume)];
    const lines = [headers, ...rows.map(formatRow)]
      .map(cols => cols.map(v => `"${String(v).replace(/"/g,'""')}"`).join(','))
      .join('\n');
    const blob = new Blob([lines], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `${symbol}_${interval}_${range}.csv`; a.click();
    URL.revokeObjectURL(url);
  };

  const changeClass = (ticker?.priceChangePercent ?? 0) >= 0 ? 'up' : 'down';
  const isFav = favorites.includes(symbol);

  return (
    <>
      <Head>
        <title>{symbol} • Binance Candles</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />

        {/* Basic SEO */}
        <meta
          name="description"
          content={`Realtime Binance OHLCV candlestick data viewer for ${symbol}. Interval: ${interval}, Range: ${range}.`}
        />
        <meta
          name="keywords"
          content="Binance, crypto, candlestick, websocket, OHLCV, trading, ETH, BTC, USDT"
        />
        <meta name="author" content="Ashraful Islam" />

        {/* Open Graph for social share */}
        <meta property="og:title" content={`${symbol} • Binance Candles`} />
        <meta
          property="og:description"
          content={`Realtime crypto candlestick data from Binance API. View ${symbol} charts in ${interval} intervals for last ${range}.`}
        />
        <meta property="og:type" content="website" />
        <meta property="og:url" content="https://candles.omlol.com/" />
        <meta property="og:image" content="https://candles.omlol.com/preview.png" />

        {/* Twitter Card */}
        <meta name="twitter:card" content="summary_large_image" />
        <meta name="twitter:title" content={`${symbol} • Binance Candles`} />
        <meta
          name="twitter:description"
          content={`Realtime crypto data powered by Binance WebSocket.`}
        />
        <meta name="twitter:image" content="https://candles.omlol.com/preview.png" />

        {/* Theme color */}
        <meta name="theme-color" content="#F0B90B" />
      </Head>
      <div className="app">
        <header className="topbar">
          <div className="brand"><span className="logo-dot" /> Binance Candles</div>
          <div className="status"><span className={`badge ${wsStatus}`}>{wsStatus}</span></div>
        </header>

        <section className="filters">
          <div className="row">
            <div className="control">
              <label>Search</label>
              <input value={search} onChange={(e)=>setSearch(e.target.value)} placeholder="BTC, ETH, SOL..." />
            </div>
            <div className="control chk">
              <label className="inline"><input type="checkbox" checked={onlyUsdt} onChange={(e)=>setOnlyUsdt(e.target.checked)} /><span>USDT only</span></label>
            </div>
            <div className="control">
              <label>Symbol</label>
              <select value={symbol} onChange={(e)=>setSymbol(e.target.value)}>
                {filteredSymbols.map(s => <option key={s.symbol} value={s.symbol}>{s.symbol}</option>)}
              </select>
            </div>
            <div className="control">
              <label>Interval</label>
              <div className="seg">{INTERVALS.map(iv => <button key={iv} className={`segbtn ${interval===iv?'active':''}`} onClick={()=>setIntervalV(iv)}>{iv}</button>)}</div>
            </div>
            <div className="control">
              <label>Range</label>
              <div className="seg">{RANGES.map(r => <button key={r} className={`segbtn ${range===r?'active':''}`} onClick={()=>setRange(r)}>{r}</button>)}</div>
            </div>
            <div className="spacer" />
            <div className="actions">
              <button className="btn ghost" onClick={()=>toggleFav(symbol)}>{isFav?'★ Fav':'☆ Fav'}</button>
              <button className="btn" onClick={downloadCsv}>Download CSV</button>
            </div>
          </div>
        </section>

        <section className="ticker">
          <div className="tile"><div className="t-title">{symbol}</div><div className={`t-last ${changeClass}`}>{ticker?fmtNum(ticker.lastPrice,8):'-'}</div><div className={`t-pct ${changeClass}`}>{ticker?`${fmtNum(ticker.priceChangePercent,2)}%`:''}</div></div>
          <div className="tile"><div className="t-label">24h High</div><div className="t-value">{ticker?fmtNum(ticker.highPrice,8):'-'}</div></div>
          <div className="tile"><div className="t-label">24h Low</div><div className="t-value">{ticker?fmtNum(ticker.lowPrice,8):'-'}</div></div>
          <div className="tile"><div className="t-label">24h Volume</div><div className="t-value">{ticker?fmtVol(ticker.volume):'-'}</div></div>
          <div className="tile"><div className="t-label">24h Quote Vol</div><div className="t-value">{ticker?fmtNum(ticker.quoteVolume,2):'-'}</div></div>
        </section>

        <section className="tablewrap">
          <div className="tabletitle">OHLCV — {symbol} • {interval} • last {range}</div>
          {error && <div className="error">⚠ {error}</div>}
          <div className="scroll">
            <table className="datatable">
              <colgroup>
                <col className="col-time" />
                <col className="col-num" /><col className="col-num" /><col className="col-num" /><col className="col-num" /><col className="col-num" />
              </colgroup>
              <thead>
                <tr>
                  <th className="th-time">Time</th>
                  <th className="th-num">Open</th>
                  <th className="th-num">High</th>
                  <th className="th-num">Low</th>
                  <th className="th-num">Close</th>
                  <th className="th-num">Volume</th>
                </tr>
              </thead>
              <tbody>
                {rows.length===0 && !loading ? <tr><td colSpan={6} className="empty">No data</td></tr> : rows.map((r,i)=>{
                  const prev = rows[i-1]; const up = prev ? r.close >= prev.close : true;
                  return (
                    <tr key={r.time} className={up?'up':'down'}>
                      <td className="td-time">{fmtTime(r.time)}</td>
                      <td className="num">{fmtNum(r.open)}</td>
                      <td className="num">{fmtNum(r.high)}</td>
                      <td className="num">{fmtNum(r.low)}</td>
                      <td className="num bold">{fmtNum(r.close)}</td>
                      <td className="num">{fmtVol(r.volume)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>

        <footer className="foot">Data: Binance Public API • Realtime via WebSocket</footer>
      </div>

      <style jsx>{`
        :root{
          --bg:#0B0E11; --panel:#0E1116; --border:#1F2329; --text:#EAECEF; --muted:#B7BDC6;
          --accent:#F0B90B; --accent-2:#F8D33A; --up:#0ECB81; --down:#F6465D;
        }
        *{box-sizing:border-box}
        html,body,#__next{height:100%}
        body{margin:0; background:var(--bg); color:var(--text); font-family: system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial;}
        .app{min-height:100%; padding:16px;}
        .topbar{display:flex; align-items:center; justify-content:space-between; margin-bottom:12px;}
        .brand{font-weight:800; letter-spacing:.2px; display:flex; align-items:center; gap:10px;}
        .logo-dot{width:12px; height:12px; border-radius:2px; background:linear-gradient(180deg,var(--accent),var(--accent-2)); box-shadow:0 0 18px rgba(240,185,11,.35); display:inline-block}
        .badge{padding:6px 10px; border-radius:999px; font-size:12px; text-transform:capitalize; border:1px solid var(--border); background:#12161C;}
        .badge.connected{border-color:rgba(14,203,129,.4); color:var(--up); box-shadow:0 0 20px rgba(14,203,129,.15);}
        .badge.connecting{border-color:rgba(248,211,58,.4); color:var(--accent-2);}
        .badge.disconnected{border-color:rgba(246,70,93,.4); color:var(--down);}
        .filters{background:var(--panel); border:1px solid var(--border); border-radius:14px; padding:12px; margin-bottom:12px;}
        .row{display:flex; gap:12px; align-items:end; flex-wrap:wrap;}
        .control{display:flex; flex-direction:column; gap:6px; min-width:160px}
        .control label{font-size:12px; color:var(--muted)}
        .control input,.control select{background:#131A21; color:var(--text); border:1px solid #242A31; padding:10px 12px; border-radius:10px; outline:none}
        .control input:focus,.control select:focus{border-color:var(--accent)}
        .control.chk .inline{display:flex; align-items:center; gap:8px}
        .seg{display:flex; gap:8px; flex-wrap:wrap}
        .segbtn{background:#131A21; border:1px solid #242A31; border-radius:10px; padding:8px 10px; color:var(--text); cursor:pointer}
        .segbtn.active{border-color:var(--accent); background:#1A2430}
        .spacer{flex:1}
        .actions{display:flex; gap:8px}
        .btn{background:linear-gradient(180deg,var(--accent),#D09D09); color:#1E2329; font-weight:800; border:none; border-radius:10px; padding:10px 12px; cursor:pointer}
        .btn.ghost{background:#131A21; color:var(--text); border:1px solid #242A31}
        .btn:hover{filter:brightness(1.05)}

        .ticker{display:grid; grid-template-columns:repeat(5, 1fr); gap:10px; margin-bottom:12px}
        .tile{background:var(--panel); border:1px solid var(--border); border-radius:14px; padding:12px}
        .t-title{font-size:13px; color:var(--muted)}
        .t-last{font-size:22px; font-weight:900}
        .t-pct{font-weight:800}
        .t-pct.up,.t-last.up{color:var(--up)}
        .t-pct.down,.t-last.down{color:var(--down)}
        .t-label{font-size:12px; color:var(--muted)}
        .t-value{font-weight:700}

        .tablewrap{background:var(--panel); border:1px solid var(--border); border-radius:14px; overflow:hidden}
        .tabletitle{padding:12px 14px; font-weight:800; background:#12161C; border-bottom:1px solid var(--border)}
        .scroll{overflow:auto}
        table{width:100%; border-collapse:separate; border-spacing:0; table-layout: fixed;}
        .col-time{width: 180px;}
        .col-num{width: 1fr;}
        thead th, tbody td{padding:12px 14px; font-size:13px; border-bottom:1px dashed rgba(255,255,255,.06);}
        thead th{position:sticky; top:0; background:#0E1116; color:#AEB4BF; text-align:right; border-bottom:1px solid var(--border); z-index:1}
        thead th.th-time{ text-align:left; }
        tbody td{ font-variant-numeric: tabular-nums; text-align:right }
        td.td-time{ text-align:left }
        tbody tr:hover{background:#0F141A}
        tbody tr.up td:nth-last-child(2){color:var(--up); font-weight:800} /* Close column */
        tbody tr.down td:nth-last-child(2){color:var(--down); font-weight:800}
        .bold{font-weight:800}
        .empty{text-align:center; padding:22px; color:var(--muted)}
        .error{margin:10px 14px; padding:10px 12px; border:1px solid #5a1f1f; background:#2b1414; color:#ffdede; border-radius:10px}
        .foot{margin:12px auto 0; text-align:center; color:var(--muted); font-size:12px}

        @media (max-width: 1024px){ .ticker{grid-template-columns:repeat(3, 1fr);} .col-time{width:150px;} }
        @media (max-width: 640px){ .row{flex-direction:column; align-items:stretch} .ticker{grid-template-columns:1fr;} .col-time{width:140px;} }
      `}</style>
    </>
  );
}
