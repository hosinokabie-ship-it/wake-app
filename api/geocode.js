// GET /api/geocode?q=...
// OpenRouteService の地名検索を中継する Vercel Function。
// 詳しい住所でヒットしないときは、段階的に検索語を広げて探し直す。
// APIキーは環境変数 ORS_API_KEY からサーバー側でのみ読む。
// 出力: { results: [{ name, label, lat, lng }], broadened: bool, searchedQuery: string }

const ORS_GEOCODE_URL = "https://api.openrouteservice.org/geocode/search";
const DAILY_CAP = 1800; // ルート計算とは別カウンタ（簡易）
const FETCH_TIMEOUT_MS = 15000;
const MAX_VARIANTS = 8;

// 簡易インメモリキャッシュ（検索語をキーにする）
const cache = new Map();
const CACHE_MAX = 500;

let counterDay = "";
let counterCount = 0;

function todayJST() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo" }).format(new Date());
}

function rollCounter() {
  const today = todayJST();
  if (counterDay !== today) {
    counterDay = today;
    counterCount = 0;
  }
}

// 番地・建物名・部屋番号など「細部」を落とす
function stripDetails(s) {
  let out = s;
  out = out.replace(/(\d+丁目)\s*\d+番.*$/, "$1"); // 丁目まで残す
  out = out.replace(/\d+番地?.*$/, ""); // 番地以降を落とす
  out = out.replace(/\d+[-−ー]\d+.*$/, ""); // 2-3-7 のような番地表記以降を落とす
  out = out.replace(/\d+号室.*$/, ""); // 部屋番号以降を落とす
  out = out.replace(/\s*\d+階.*$/, ""); // 階数以降を落とす
  out = out.replace(/(ビル|マンション|タワー|ハイツ|コーポ|アパート|庁舎|会館|センター).*$/, "").trim();
  return out.trim();
}

// 先頭の行政区分を1段落とす（都道府県 → 市区町村 の順に効く）
function stripAdminOnce(s) {
  let out = s.replace(/^(東京都|北海道|大阪府|京都府|青森県|岩手県|宮城県|秋田県|山形県|福島県|茨城県|栃木県|群馬県|埼玉県|千葉県|神奈川県|新潟県|富山県|石川県|福井県|山梨県|長野県|岐阜県|静岡県|愛知県|三重県|滋賀県|兵庫県|奈良県|和歌山県|鳥取県|島根県|岡山県|広島県|山口県|徳島県|香川県|愛媛県|高知県|福岡県|佐賀県|長崎県|熊本県|大分県|宮崎県|鹿児島県|沖縄県)/, "");
  if (out !== s) return out;
  out = s.replace(/^.+?[市区町村郡]/, "");
  return out;
}

// 段階的に広げた検索語の候補を、狭い順に並べて返す
function broadenVariants(q) {
  const variants = [];
  const push = (s) => {
    s = (s || "").trim();
    if (s && !variants.includes(s)) variants.push(s);
  };

  push(q);
  const detailed = stripDetails(q);
  push(detailed);
  const noChome = detailed.replace(/\d+丁目.*$/, "").trim();
  push(noChome);

  // 丁目あり・なし両方から、行政区分を1段ずつ落とした形を足す
  for (const base of [detailed, noChome]) {
    let cur = base;
    for (let i = 0; i < 4; i++) {
      const next = stripAdminOnce(cur);
      if (next === cur || !next) break;
      push(next);
      cur = next;
    }
  }
  return variants.slice(0, MAX_VARIANTS);
}

async function fetchWithTimeout(url, options, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function searchOnce(apiKey, text) {
  const url =
    ORS_GEOCODE_URL +
    "?text=" +
    encodeURIComponent(text) +
    "&size=6&lang=ja";
  const res = await fetchWithTimeout(
    url,
    { headers: { Authorization: apiKey, Accept: "application/geo+json" } },
    FETCH_TIMEOUT_MS
  );
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    console.error("ORS geocode error:", res.status, detail.slice(0, 300));
    const err = new Error("geocode failed: " + res.status);
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  const features = (data && data.features) || [];
  return features.map((f) => {
    const p = f.properties || {};
    const coords = (f.geometry && f.geometry.coordinates) || [];
    return {
      name: p.name || (p.label || "").split(",")[0] || text,
      label: p.label || p.name || text,
      lat: coords[1],
      lng: coords[0],
      layer: p.layer || "",
    };
  }).filter((r) => typeof r.lat === "number" && typeof r.lng === "number");
}

// 自治体全体の中心点のような大ざっぱな結果は最後の手段にする
function preferSpecific(results) {
  const weakLayers = ["county", "region", "macroregion", "country"];
  const specific = results.filter((r) => !weakLayers.includes(r.layer));
  return specific.length > 0 ? specific : results;
}

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "GETで送信してください。" });
  }

  const apiKey = process.env.ORS_API_KEY;
  if (!apiKey) {
    return res
      .status(500)
      .json({ error: "サーバーの設定が完了していません（ORS_API_KEY が未設定です）。管理者にお知らせください。" });
  }

  let q = "";
  if (req.query && typeof req.query.q === "string") q = req.query.q;
  if (!q && req.url) {
    try {
      q = new URL(req.url, "http://localhost").searchParams.get("q") || "";
    } catch (e) {
      q = "";
    }
  }
  q = q.trim();
  if (!q || q.length > 100) {
    return res.status(400).json({ error: "検索する地名や住所を入力してください。" });
  }

  if (cache.has(q)) {
    return res.status(200).json(cache.get(q));
  }

  rollCounter();
  if (counterCount >= DAILY_CAP) {
    return res
      .status(429)
      .json({ error: "本日の地名検索の上限に達しました。明日またお試しください。" });
  }

  const variants = broadenVariants(q);
  try {
    for (const variant of variants) {
      counterCount += 1;
      const raw = await searchOnce(apiKey, variant);
      if (raw.length > 0) {
        const picked = preferSpecific(raw).slice(0, 6);
        const payload = {
          results: picked.map(({ name, label, lat, lng }) => ({ name, label, lat, lng })),
          broadened: variant !== q,
          searchedQuery: variant,
        };
        if (cache.size >= CACHE_MAX) cache.clear();
        cache.set(q, payload);
        return res.status(200).json(payload);
      }
    }
    const empty = { results: [], broadened: variants.length > 1, searchedQuery: variants[variants.length - 1] };
    return res.status(200).json(empty);
  } catch (e) {
    if (e && e.name === "AbortError") {
      return res.status(504).json({ error: "地名検索がタイムアウトしました。もう一度お試しください。" });
    }
    if (e && e.status === 429) {
      return res.status(429).json({ error: "地名検索サービスが混み合っています。少し時間をおいてお試しください。" });
    }
    return res.status(502).json({ error: "地名を検索できませんでした。言葉を変えてもう一度お試しください。" });
  }
};
