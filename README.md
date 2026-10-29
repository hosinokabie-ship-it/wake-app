# ランダム散歩ルート（単独版）デプロイ手順

歩きたい距離を決めると、OpenRouteService の実道路ルートでランダムな散歩コースを作るWebアプリの、単独ホスティング版です。Muse内の表示では位置情報が通らない問題を確かめるための検証用デプロイを想定しています。

## 構成

- `index.html`：画面すべて（地図は Leaflet + OpenStreetMap、履歴はブラウザの localStorage）
- `api/route.js`：ルート計算の中継（OpenRouteService Directions）。1日1,800回までの簡易上限とキャッシュ付き
- `api/geocode.js`：地名検索の中継（OpenRouteService Geocode）。詳しい住所は自動で広げて探し直します
- `vercel.json`：Vercel Functions の設定（ビルド不要）

APIキー（HeiGIT / OpenRouteService）は、サーバー側の環境変数 `ORS_API_KEY` からのみ読みます。画面側のコードには一切含まれません。

## デプロイ手順（所有者向け）

1. **Vercel アカウントを作成**します（https://vercel.com 、GitHubアカウント等でサインアップ）。
2. **このフォルダをプロジェクトとして Import** します。
   - Vercel ダッシュボードの「Add New → Project」から、このフォルダを含むリポジトリを選ぶか、
   - 手元のPCで Vercel CLI を使う場合は、このフォルダで `vercel` コマンドを実行して案内に従います。
   - フレームワーク設定は不要（Preset: Other のままでOK）です。
3. **環境変数を設定**します：Project Settings → Environment Variables で、
   - 名前：`ORS_API_KEY`
   - 値：自分の HeiGIT（OpenRouteService）APIキー
   - 対象：Production（Previewにも使う場合はあわせてチェック）
   - ※ キーをチャットやコード、スクリーンショットに貼らないでください。入力はこの画面で本人が行います。
4. **Deploy** を実行し、発行された `*.vercel.app` のURLを開きます。
5. **Microsoft Edge で動作確認**をします：
   - そのサイトに対して位置情報を「許可」にする（アドレスバー横のアイコン → このサイトのアクセス許可 → 場所）
   - 「現在地を出発地点にする」が成功すること
   - ルートが引けること（距離の近い実道路ルートが出ること）
   - 住所・駅名の検索で候補が出て、出発地点に設定できること

## 注意

- Vercel の無料プラン（Hobby）は**個人・非商用のみ**です。このデプロイは検証用と位置づけ、広告は付けないでください。収益化する段階では、Cloudflare Pages（無料枠でも商用可）へ移すか、Vercel Pro（有料）に上げる必要があります。
- OpenRouteService 無料枠は Directions 2,000回/日です。この中継では上限を1,800回/日に抑え、キャッシュで消費を減らしていますが、公開してアクセスが増えた場合は不足する可能性があります。
- 履歴は各訪問者のブラウザ内にのみ保存され、サーバーには保存されません。
