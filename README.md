# 強化版K-LMS

Canvas APIとSupabaseを利用した、ユーザー別の学習情報ダッシュボードです。利用者はメールアドレスでログインし、自分で発行したCanvas APIトークンを登録します。Keio IDやCanvasのログインパスワードは保存しません。

## 1. Supabaseの準備

1. Supabaseで新しいプロジェクトを作成する。
2. Supabaseの「SQL Editor」を開く。
3. [supabase/schema.sql](supabase/schema.sql) の内容を実行する。
4. 「Project Settings > API」からProject URL、anon key、service_role keyを確認する。
5. 「Authentication > URL Configuration」で、公開時のSite URLを本アプリのURLに設定する。
6. 本番利用では「Authentication > Providers > Email」のメール確認を有効にする。

SQLには、ユーザー情報、暗号化済みCanvas設定、1時間キャッシュ、時間割、レポートテンプレート、学内リンク、教科書投稿のテーブルとRLSポリシーが含まれます。

## 2. 環境変数

`.env.example`を`.env`へコピーし、次を設定します。

```env
SUPABASE_URL=https://YOUR_PROJECT.supabase.co
SUPABASE_ANON_KEY=YOUR_SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY=YOUR_SUPABASE_SERVICE_ROLE_KEY
TOKEN_ENCRYPTION_KEY=YOUR_32_BYTE_BASE64_KEY
CANVAS_ALLOWED_HOSTS=lms.keio.jp
```

暗号鍵はPowerShellで次のように生成できます。

```powershell
$bytes = New-Object byte[] 32
[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
[Convert]::ToBase64String($bytes)
```

生成結果を`TOKEN_ENCRYPTION_KEY`へ設定します。この鍵を変更すると、既存のCanvasトークンを復号できなくなります。変更する場合は、利用者にAPIトークンを再登録してもらうか、事前に再暗号化処理を行ってください。

`SUPABASE_SERVICE_ROLE_KEY`と`TOKEN_ENCRYPTION_KEY`はサーバー専用です。公開リポジトリ、ブラウザ側JavaScript、画面、ログへ出してはいけません。

## 3. 起動

```powershell
npm.cmd run dev
```

起動後に次を開きます。

```text
http://localhost:3000
```

## 利用者の操作

1. メールアドレスと、英字・数字を各1文字以上含む8文字以上のパスワードでアカウントを作成する。
2. 必要な場合は確認メールのリンクを開き、ログインする。
3. 「Canvas API設定」に`https://lms.keio.jp`と自分のCanvas APIトークンを入力する。
4. 接続確認に成功すると、時間割、課題、学内リンク、教科書投稿を利用できる。

Canvas APIトークンは、保存前にCanvasのプロフィールAPIで有効性を確認します。平文トークンはDBへ保存せず、サーバーでAES-256-GCM暗号化した値だけを`canvas_credentials`へ保存します。

## 保存内容

- `profiles`: 表示名、所属、学籍番号
- `canvas_credentials`: Canvas URL、暗号化済みトークン、確認日時
- `canvas_cache`: コース・課題・To Doをまとめたレスポンス、有効期限
- `timetable_entries`: 曜日、時限、授業名、教室、担当教員、CanvasコースID、メモ
- `report_templates`: 表紙項目、提出形式など
- `campus_links`: 共通リンクと本人だけのリンク
- `textbook_posts`: 売買種別、教科書、授業、価格、状態、連絡先、公開状態

ブラウザのローカルストレージに残っている旧時間割と旧個人リンクは、最初のログイン時に本人のDB領域へ一度だけ移行します。旧教科書投稿は、意図せず他の利用者へ公開されることを避けるため、自動移行しません。

## セキュリティ上の境界

- 認証セッションは`HttpOnly`かつ`SameSite=Lax`のCookieで保持する。
- 更新APIは同一サイト確認用ヘッダーを必須にする。
- Canvas URLは`CANVAS_ALLOWED_HOSTS`に指定したHTTPSホストだけを許可する。
- Canvasのページ送りURLも同じホストだけを許可し、外部へトークンを送信しない。
- DBは全対象テーブルでRLSを有効にする。
- 秘密情報テーブルは`anon`と`authenticated`から直接操作できない。
- サーバーが`service_role`を使う処理でも、ユーザーIDを必ず検索条件に含める。
- Canvasキャッシュは1時間で期限切れにする。
- 公開時はHTTPSを使用し、`NODE_ENV=production`を設定してCookieに`Secure`を付ける。

## Canvas API単体の疎通確認

管理者がローカルでCanvas APIだけを確認する場合は、`.env`へ`CANVAS_BASE_URL`と`CANVAS_API_TOKEN`を設定し、次を実行します。

```powershell
npm.cmd run canvas:probe
```

この2項目は疎通確認スクリプト専用です。Webアプリで利用者が入力したトークンには使用しません。
