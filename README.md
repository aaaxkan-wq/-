# 🌙 ねむりログ — 睡眠サイクル最適化アプリ

就床・起床時刻を記録すると、**次にいつ寝ればよいか・いつ眠くなるか・どう過ごせばよいか**を
エビデンスに基づいて教えてくれる、iPhone のホーム画面に置けるアプリ（PWA）です。

- ✅ サーバー不要・**完全オフライン動作**・データは**端末内のみ**（外部送信なし）
- ✅ ビルド不要の静的サイト。GitHub Pages にそのまま公開できる
- ✅ iPhone / Android のホーム画面にアイコンとして追加可能

## なぜ「90分サイクルで起こす」アプリではないのか

巷の睡眠計算アプリの「就床＋90分×Nでスッキリ起きられる」というロジックは、
科学的根拠が弱いため**採用していません**。理由:

- 睡眠周期は90分固定ではなく個人差・夜間変動が大きい（実測中央値は約96分）
- 入眠までの時間がばらつき、計算の起点がずれて誤差が累積する
- 腕時計型の睡眠段階推定（深い/浅い/REM）は精度が低い

代わりに、**エビデンスの強い指標**を中心に据えています:

| 指標 | 何を見るか | 主な根拠 |
|------|-----------|----------|
| **睡眠の規則性 (SRI近似)** | 毎日同じ時刻に寝起きできているか | 規則性は睡眠時間より死亡率を強く予測（UK Biobank: [Windred 2024 SLEEP](https://academic.oup.com/sleep/article/47/1/zsad253/7280269) / [eLife 88359](https://elifesciences.org/articles/88359)） |
| **睡眠負債** | 直近14日の睡眠不足の累積 | 自覚なく蓄積、週末では返せない（[Van Dongen 2003](https://pubmed.ncbi.nlm.nih.gov/12683469/) / [Depner 2019](https://www.cell.com/current-biology/fulltext/S0960-9822(19)30098-3)） |
| **眠気予測カーブ** | いつ眠くなるか（午後の谷・夜の寝つきにくい時間帯） | 二プロセスモデル（[Borbély 2022](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC9540767/)） |
| **ソーシャル時差ぼけ** | 平日と休日の睡眠中央時刻のズレ | [Roenneberg 2012](https://www.cell.com/current-biology/fulltext/S0960-9822(12)00325-9) |
| **推奨行動タイムライン** | 飲食・運動・光・カフェインの最適タイミング | AASM/CDC ほか（各項目にリンク） |

推奨睡眠は成人で7時間以上（[AASM/CDC](https://aasm.org/seven-or-more-hours-of-sleep-per-night-a-health-necessity-for-adults/)）。
睡眠段階の内訳は精度が低く、過度に追うと逆効果（orthosomnia）になりうるため表示しません。

> ⚠️ 本アプリは健康情報の参考用であり、医療診断・治療を目的としたものではありません。

## 機能

- **ホーム**: 今夜の推奨就床時刻、規則性スコア、睡眠負債、昨夜の睡眠、ソーシャル時差ぼけ、眠気予測カーブ、睡眠時間の推移グラフ
- **記録**: 「今から寝る／今起きた」のワンタップ記録、手入力、一覧・削除
- **行動**: 就床時刻を基準にした推奨行動タイムライン（根拠リンク付き）
- **設定**: 目標起床時刻・睡眠時間・入眠時間、バックアップ書き出し／読み込み、全削除

スマートウォッチを使っている場合は、**就床・起床時刻だけ**手入力すればOK（段階データは使いません）。

## iPhone のホーム画面に追加する

1. 下記の手順でアプリを Web に公開する（GitHub Pages）
2. iPhone の **Safari** で公開URLを開く
3. 共有ボタン（□に↑）→「**ホーム画面に追加**」
4. 追加すると、アイコンから全画面アプリとして起動します（オフラインでも動作）

> ※iOS の PWA はアプリを閉じている間のローカル通知が制限されるため、就寝リマインダー等の
> プッシュ通知は搭載していません（アプリ内表示のみ）。

## GitHub Pages で公開する手順

このリポジトリをそのまま公開できます（ビルド不要）。

1. GitHub のリポジトリ → **Settings** → **Pages**
2. **Build and deployment** の Source を「**Deploy from a branch**」に
3. Branch を `main`（または公開したいブランチ）、フォルダを `/ (root)` にして **Save**
4. 数分後、`https://<ユーザー名>.github.io/<リポジトリ名>/` で公開されます

すべて相対パスで作られているため、サブパス公開でもそのまま動きます。

## ローカルで試す

静的サーバーで配信するだけです（Service Worker のため `file://` ではなく http で開いてください）:

```bash
python3 -m http.server 8000
# ブラウザで http://localhost:8000 を開く
```

## ファイル構成

```
index.html              アプリ本体（UI）
styles.css              スタイル（ダーク・モバイル最適化）
manifest.webmanifest    PWA マニフェスト
sw.js                   Service Worker（オフライン動作）
js/
  storage.js            端末内データ保存（localStorage）
  science.js            睡眠科学エンジン（規則性/睡眠負債/二プロセスモデル）
  timeline.js           推奨行動タイムライン（根拠付き）
  charts.js             依存ゼロのキャンバス描画
  app.js                UIコントローラ
icons/                  アプリアイコン（PNG）
tools/generate_icons.py アイコン生成スクリプト（Python標準ライブラリのみ）
```

## 開発メモ

科学エンジンの単体テスト（Node）:

```bash
node -e 'global.window={}; require("./js/science.js"); const S=window.Science;
console.log("推奨就床:", S.fmtHM(S.recommendBedtime({targetWake:"06:30",targetMin:450,onsetMin:15})));'
```
