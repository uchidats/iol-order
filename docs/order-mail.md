# 注文メールの送信(Google フォーム・GAS に依存しない)

IOL Order だけで、注文受付 → ディーラーへの注文メール → 注文控え → 注文履歴での送信状態の確認までを行う。
現在は **送信停止中**(`MAIL_SENDING_ENABLED=false`、`ORDER_INTAKE_ENABLED=false`)。実際の送信は、下の「人が行う設定」と承認の後。

## 配信サービス: Resend を推奨
| | Resend | SendGrid | Amazon SES | Firebase の Trigger Email 拡張 |
|---|---|---|---|---|
| 実装 | REST 1本(`POST /emails`)。SDK 不要 | API が多機能で設定項目が多い | AWS の認証(署名v4)・SDK が必要 | SMTP の提供元が別に必要 |
| 二重送信の防止 | `Idempotency-Key` ヘッダー(同じキーの再送は1通) | なし(自前で管理) | なし(自前で管理) | なし |
| 配信結果 | Webhook(配信済み・遅延・不達・苦情。署名つき) | Event Webhook | SNS 経由(設定が多い) | 状態の詳細は取りにくい |
| 運用開始 | ドメインの DNS 設定(SPF・DKIM)と API キーだけ | 同程度 + 送信者認証 | 送信制限の解除申請(サンドボックス)が必要 | 拡張のインストール + SMTP |

送信量は1日あたり数十通程度の想定で、どれでも足りる。実装と運用が最も簡単で、冪等キーにより二重送信を配信サービス側でも防げる Resend を推奨する。料金・送信上限は契約時に最新を確認する。
配信サービスへの依存は `functions/src/order-mail-outbox.js` の `createResendSender` と Webhook の検証だけで、他のサービスに替える場合もこの2つを差し替える。

## 仕組み(アウトボックス方式)
1. **注文の保存と同時に、送るメールを保存する**(`createOrder` のトランザクション)。`facilities/{fid}/orders/{orderId}/mails/{mailId}`:
   - `d_{ディーラーID}`: ディーラー宛て。宛先 = その時点の発注用メール、件名・本文 = 既存の形式(旧 GAS と同じ「【施設名】IOL注文：…」「〇〇御中」「質問名: 回答」・定型文・署名)。
   - `copy`: 注文控え(施設設定で ON のときだけ)。ディーラー宛ての結果が出るまで `waiting`。
   - 宛先・件名・本文は注文時点のスナップショット。後から施設設定が変わっても、過去の注文のメールは変わらない。
   - 発注用メールがない・発注先未設定の明細は、メールにせず `not_sent`(理由つき)として記録する。注文は受け付ける。
2. **送信は別の処理**(`sendOrderMail`: 作成のトリガー、`retryOrderMails`: 10分ごと)。送信に失敗しても注文は残る。
3. **状態**: `pending` → `sending` → `accepted`(配信サービスが受け付けた) / `retry`(一時的なエラー。5分・15分・1時間・3時間後に再送、最大5回) / `failed`。
   - `held`: 送信停止中で送らなかった。**自動では送らない**(後から有効にしても、過去の注文を突然送らない)。
   - `skipped_test`: 開発用受付のテスト注文(`testOrder`)。`MAIL_TEST_RECIPIENT` があればその宛先だけに「【テスト】」として送り、ディーラーには送らない。
4. **受付と配信の区別**: `accepted` は「配信サービスが受け付けた」だけ。実際の配信結果(`delivered` / `delayed` / `bounced` / `complained` / `failed`)は Webhook(`resendWebhook`。署名を検証)で `delivery` に記録する。弱い結果で強い結果を上書きしない(不達の後の遅延などは無視)。
5. **二重送信の防止**: ①送信前にトランザクションで `sending` に切り替える(同時に2つの処理が送らない)。②配信サービスにメールごとに固定の冪等キーを付ける(処理が途中で止まって送り直しても1通にまとまる)。`sending` のまま5分過ぎたものは、同じキーで送り直す。
6. **注文控え**: ディーラー宛てがすべて決着(受付・失敗・停止中・テスト)してから、結果を書いて送る。受付は「配信の完了は注文履歴で確認」、失敗は「ディーラーには届いていません」と明記し、送信成功と誤認させない。件名は問題があれば「【注文控え・未送信あり】」。
7. **注文履歴**: 注文ドキュメントの `notifications`(発注先ごと + 注文控え。状態・時刻・エラー。アドレス・本文は含めない)と `status` を更新する。履歴の詳細で、発注先・送信状態・配信結果・入力者・備考を確認できる。
8. **データ分離**: `mails`(宛先・本文を含む)は、その施設の管理者・副管理者と運営者だけが読める。書き込みは Cloud Functions のみ。`mailIndex`(配信サービスのID → メール)はクライアントから読み書きできない。

## 施設ごとの設定(施設設定画面)
- **注文メール**(新しいセクション、管理者・副管理者): 「注文控えメールを送信する」(初期 OFF。ON のときだけ送信先1件)、署名(住所・施設名。10行・500文字まで)。`facilities/{fid}/settings/mail`。変更は操作履歴(`auditLogs`、送信先は伏せ字)に記録する。
- **ディーラー**: 「注文メールの宛名」(正式表記・任意。未入力ならディーラー名)。登録名は変えずに宛名だけ正式表記にできる。
- 以前コードにあった立川病院の署名・ディーラーの正式表記は削除した。**各施設で設定画面から入力する**(下の「人が行う設定」)。

## 設定値(functions/.env.<project> と Secret Manager)
| 名前 | 種類 | 内容 |
|---|---|---|
| `MAIL_SENDING_ENABLED` | .env | 送信のキルスイッチ(既定 false)。false の間は送らず `held` |
| `MAIL_FROM` | .env | 送信元(例 `IOL Order <order@mail.example.jp>`)。配信サービスで認証済みのドメイン。空なら送らない。実際の From は、このアドレスに表示名「施設名（IOL Order）」を付ける(施設名は注文時点) |
| `MAIL_TEST_RECIPIENT` | .env | テスト注文の送信先(空ならテスト注文は送らない) |
| `RESEND_API_KEY` | Secret Manager | 送信用の API キー(送信のみの権限・ドメイン限定で作る)。コード・.env に書かない |
| `RESEND_WEBHOOK_SECRET` | Secret Manager | Webhook の署名の秘密鍵(`whsec_…`) |

## 人が行う設定(契約・DNS・キー)
1. **Resend のアカウント作成**(組織のアカウント。契約プランの確認)。
2. **送信ドメインの認証**: 送信専用のサブドメイン(例 `mail.medconf.jp`。決定が必要)を Resend に追加し、表示される DNS レコード(SPF・DKIM・バウンス用の MX/TXT)を、そのドメインの DNS に登録する。DMARC(`_dmarc` の TXT)の設定も推奨。
3. **API キーの作成**(送信のみ・上のドメイン限定)→ `firebase functions:secrets:set RESEND_API_KEY --project medconf-iol-dev`。
4. **送信元・テスト用の宛先の決定** → `functions/.env.medconf-iol-dev` の `MAIL_FROM`・`MAIL_TEST_RECIPIENT`。
5. Functions のデプロイ後、**Webhook の登録**: `resendWebhook` の URL を Resend に登録し(イベント: delivered・delivery_delayed・bounced・complained・failed)、表示された署名の秘密鍵を `firebase functions:secrets:set RESEND_WEBHOOK_SECRET`。
6. **施設設定の入力**(各施設の管理者・副管理者が画面から): 立川病院の署名と、ディーラーの宛名(正式表記)。せんじゅ眼科の注文控え(ON・`info@senju-eye-clinic.jp`)。
7. 動作確認(テスト注文 + `MAIL_TEST_RECIPIENT`)の後に `MAIL_SENDING_ENABLED=true`。実際のディーラーへの送信は `ORDER_INTAKE_ENABLED`・本番の判断とあわせて行う。

## デプロイ(承認後。この順で)
1. Rules・インデックス(`firebase deploy --only firestore --project medconf-iol-dev`)。インデックスは `mails` の `status` のコレクショングループ(定期実行の検索に必要)。
2. Secret の登録(上の3)。Secret がないと、Secret を使う関数のデプロイが失敗する。
3. Functions: `createOrder`(更新)、`sendOrderMail`・`retryOrderMails`・`resendWebhook`・`auditFacilitySettings`(新規)。`--force` が必要な場合がある。
   - 実行サービスアカウントに Secret の参照権限(`roles/secretmanager.secretAccessor`。CLI が Secret ごとに付与する)、定期実行のための Cloud Scheduler API の有効化、`resendWebhook` の公開(未認証の呼び出しを許可。署名で検証する)が伴う。
4. 画面(push)。施設設定の「注文メール」は、Rules のデプロイ前は保存できない(読み込みは失敗しても他の設定は表示する)。

## 現在の制限
- 注文控えの送信先は1件。ディーラー宛ての CC・BCC はない。発注者(入力者)には送らない(旧 GAS は回答者にも送っていた)。ディーラー宛ての返信先(Reply-To)は入力者本人。注文控えが ON なら施設共通アドレス(控えの宛先)も加える(同じアドレスは1件。Resend は Reply-To を配列で複数受け付ける)。注文控えには Reply-To を付けない。
- 失敗したメールの手動の再送(画面の操作)はない。失敗は注文履歴と注文控えで分かる。
- 配信結果は Webhook の登録後から記録される。
