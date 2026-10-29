// POST /api/route
// OpenRouteService の徒歩ルート計算を中継する Vercel Function。
// APIキーは環境変数 ORS_API_KEY からサーバー側でのみ読み、画面側には一切出さない。
// 入力: { coordinates: [[lng, lat], ...] }
// 出力: { distance_m, duration_s, geometry: [[lng, lat], ...], remaining_today }

const ORS_URL = "https://api.openrouteservice.org/v2/directions/foot-walking/geojson";
const DAILY_CAP = 1800; // ORS無料枠 2,000回/日 の内側に収める
const FETCH_TIMEOUT_MS = 30000;

// 簡易インメモリキャッシュ（座標を小数4桁に丸めたキーを単位にする）
const cache = new Map();
const CACHE_MAX = 500;

// 日次カウンタ（インメモリ。v1ではこれで十分とする）
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

function remainingToday() {
  rollCounter();
  return Math.max(0, DAILY_CAP - counterCount);
}

function cacheKey(coordinates) {
  return coordinates
    .map((c) => c[0].toFixed(4) + "," + c[1].toFixed(4))
    .join("|");
}

function isValidCoordinates(coords) {
  if (!Array.isArray(coords) || coords.length < 2 || coords.length > 25) return false;
  return coords.every(
    (c) =>
      Array.isArray(c) &&
      c.length === 2 &&
      typeof c[0] === "number" &&
      typeof c[1] === "number" &&
      isFinite(c[0]) &&
      isFinite(c[1]) &&
      c[0] >= -180 &&
      c[0] <= 180 &&
      c[1] >= -90 &&
      c[1] <= 90
  );
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

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "POSTで送信してください。" });
  }

  const apiKey = process.env.ORS_API_KEY;
  if (!apiKey) {
    return res
      .status(500)
      .json({ error: "サーバーの設定が完了していません（ORS_API_KEY が未設定です）。管理者にお知らせください。" });
  }

  let body = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch (e) {
      return res.status(400).json({ error: "リクエストの形式が正しくありません。" });
    }
  }
  const coordinates = body && body.coordinates;
  if (!isValidCoordinates(coordinates)) {
    return res
      .status(400)
      .json({ error: "座標の形式が正しくありません（[経度, 緯度] の配列で2〜25地点まで）。" });
  }

  // キャッシュヒット時はORSを叩かず、カウンタも消費しない
  const key = cacheKey(coordinates);
  if (cache.has(key)) {
    const hit = cache.get(key);
    res.setHeader("X-Quota-Remaining", String(remainingToday()));
    return res.status(200).json({ ...hit, cached: true, remaining_today: remainingToday() });
  }

  rollCounter();
  if (counterCount >= DAILY_CAP) {
    return res
      .status(429)
      .json({ error: "本日のルート計算の上限に達しました。明日またお試しください。" });
  }
  counterCount += 1;

  try {
    const orsRes = await fetchWithTimeout(
      ORS_URL,
      {
        method: "POST",
        headers: {
          Authorization: apiKey,
          "Content-Type": "application/json",
          Accept: "application/geo+json",
        },
        body: JSON.stringify({ coordinates }),
      },
      FETCH_TIMEOUT_MS
    );

    if (!orsRes.ok) {
      const detail = await orsRes.text().catch(() => "");
      console.error("ORS route error:", orsRes.status, detail.slice(0, 300));
      if (orsRes.status === 429) {
        return res
          .status(429)
          .json({ error: "ルート計算サービスが混み合っています。少し時間をおいてお試しください。" });
      }
      return res
        .status(502)
        .json({ error: "ルートを計算できませんでした。地点を少し変えてもう一度お試しください。" });
    }

    const data = await orsRes.json();
    const feature = data && data.features && data.features[0];
    if (!feature || !feature.properties || !feature.properties.summary || !feature.geometry) {
      return res.status(502).json({ error: "ルートの結果を取得できませんでした。" });
    }

    const result = {
      distance_m: feature.properties.summary.distance,
      duration_s: feature.properties.summary.duration,
      geometry: feature.geometry.coordinates,
    };

    if (cache.size >= CACHE_MAX) cache.clear();
    cache.set(key, result);

    res.setHeader("X-Quota-Remaining", String(remainingToday()));
    return res.status(200).json({ ...result, cached: false, remaining_today: remainingToday() });
  } catch (e) {
    if (e && e.name === "AbortError") {
      return res
        .status(504)
        .json({ error: "ルート計算がタイムアウトしました。もう一度お試しください。" });
    }
    console.error("route handler error:", e && e.message);
    return res.status(500).json({ error: "サーバーでエラーが発生しました。もう一度お試しください。" });
  }
};
