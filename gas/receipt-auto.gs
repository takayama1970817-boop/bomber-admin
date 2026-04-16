/**
 * Bカート受注メール自動読み取り → 公開領収書データ自動登録
 *
 * Gmail に届く Bカートの受注通知メールを自動で解析し、
 * Firestore の publicReceipts コレクションに書き込む。
 * これにより、配送完了メールの領収書リンクが自動で有効になる。
 *
 * トリガー: 5分おきに実行（時間主導型）
 */

// ===== 設定 =====
var CONFIG = {
  FIREBASE_PROJECT_ID: 'bomber-admin',
  COLLECTION: 'publicReceipts',
  // 処理済みメールに付けるラベル名（自動で作成される）
  PROCESSED_LABEL: 'Bカート済',
  // Gmailの検索条件（Bカートからの受注通知メール）
  GMAIL_QUERY: 'subject:"ご注文を受け付けました" -label:Bカート済',
  // 領収書の有効日数
  RECEIPT_EXPIRY_DAYS: 60,
};

// ===== メイン処理 =====
function processNewOrders() {
  var threads = GmailApp.search(CONFIG.GMAIL_QUERY, 0, 20);
  if (threads.length === 0) {
    Logger.log('新しい受注メールはありません');
    return;
  }

  // 処理済みラベルを取得 or 作成
  var label = GmailApp.getUserLabelByName(CONFIG.PROCESSED_LABEL);
  if (!label) {
    label = GmailApp.createLabel(CONFIG.PROCESSED_LABEL);
  }

  var created = 0;
  var skipped = 0;
  var errors = 0;

  for (var t = 0; t < threads.length; t++) {
    var messages = threads[t].getMessages();
    for (var m = 0; m < messages.length; m++) {
      var body = messages[m].getPlainBody();
      try {
        var parsed = parseBcartEmail(body);
        if (!parsed) {
          skipped++;
          continue;
        }

        // 重複チェック（同じ注文番号が既に登録されていないか）
        if (receiptExists(parsed.orderNumber)) {
          Logger.log('スキップ（登録済み）: ' + parsed.orderNumber);
          skipped++;
          continue;
        }

        // Firestore に書き込み
        writePublicReceipt(parsed);
        created++;
        Logger.log('登録完了: ' + parsed.orderNumber + ' / ' + parsed.companyName);
      } catch (e) {
        Logger.log('エラー: ' + e.message + '\n' + body.substring(0, 200));
        errors++;
      }
    }
    // 処理済みラベルを付ける
    threads[t].addLabel(label);
  }

  Logger.log('処理完了: ' + created + '件登録 / ' + skipped + '件スキップ / ' + errors + '件エラー');
}

// ===== メール解析 =====
function parseBcartEmail(text) {
  if (!text) return null;
  text = text.replace(/\r\n/g, '\n');

  var company = pick(text, '会社名');
  if (!company) return null; // Bカートメールではない

  var orderNumber = pick(text, '注文番号');
  if (!orderNumber) return null;

  var contact = pick(text, '担当者').replace(/\s*様\s*$/, '').trim();
  var email = pick(text, 'メールアドレス');
  var orderDateStr = pick(text, '注文日時');
  var paymentMethod = pick(text, '決済方法');
  var subtotal = yen(pick(text, '商品総額'));
  var shipping = yen(pick(text, '送料'));
  var total = yen(pick(text, '注文総額'));

  // 消費税
  var tax = 0;
  var taxMatch = text.match(/うち消費税\s*([\d,]+)\s*円/);
  if (taxMatch) tax = yen(taxMatch[1]);

  // 注文日時パース
  var orderDate = null;
  if (orderDateStr) {
    var dm = orderDateStr.match(/(\d{4})-(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{1,2}):(\d{1,2})/);
    if (dm) {
      orderDate = new Date(
        parseInt(dm[1]), parseInt(dm[2]) - 1, parseInt(dm[3]),
        parseInt(dm[4]), parseInt(dm[5]), parseInt(dm[6])
      );
    }
  }
  if (!orderDate) orderDate = new Date();

  return {
    orderNumber: orderNumber,
    email: (email || '').trim().toLowerCase(),
    companyName: company,
    contact: contact,
    orderDate: orderDate,
    paymentMethod: paymentMethod,
    subtotal: subtotal,
    shipping: shipping,
    tax: tax,
    total: total,
  };
}

function pick(text, key) {
  var escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  var re = new RegExp(escaped + '[：:]\\s*(.*)');
  var m = text.match(re);
  return m ? m[1].trim() : '';
}

function yen(s) {
  if (!s) return 0;
  var n = String(s).replace(/[^\d]/g, '');
  return n ? parseInt(n, 10) : 0;
}

// ===== Firestore 読み書き =====
function getFirestoreUrl(path) {
  return 'https://firestore.googleapis.com/v1/projects/'
    + CONFIG.FIREBASE_PROJECT_ID
    + '/databases/(default)/documents/'
    + path;
}

function getAuthHeaders() {
  return {
    'Authorization': 'Bearer ' + ScriptApp.getOAuthToken(),
    'Content-Type': 'application/json',
  };
}

// 重複チェック: 同じ orderNumber のドキュメントがあるか
function receiptExists(orderNumber) {
  var url = 'https://firestore.googleapis.com/v1/projects/'
    + CONFIG.FIREBASE_PROJECT_ID
    + '/databases/(default)/documents:runQuery';

  var query = {
    structuredQuery: {
      from: [{ collectionId: CONFIG.COLLECTION }],
      where: {
        fieldFilter: {
          field: { fieldPath: 'orderNumber' },
          op: 'EQUAL',
          value: { stringValue: orderNumber },
        },
      },
      limit: 1,
    },
  };

  var res = UrlFetchApp.fetch(url, {
    method: 'post',
    headers: getAuthHeaders(),
    payload: JSON.stringify(query),
    muteHttpExceptions: true,
  });

  var data = JSON.parse(res.getContentText());
  // クエリ結果がドキュメントを含むかチェック
  return data && data.length > 0 && data[0].document;
}

// publicReceipts にドキュメントを作成
function writePublicReceipt(parsed) {
  var expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + CONFIG.RECEIPT_EXPIRY_DAYS);

  var payload = {
    fields: {
      orderNumber:   { stringValue: parsed.orderNumber },
      email:         { stringValue: parsed.email },
      companyName:   { stringValue: parsed.companyName },
      contact:       { stringValue: parsed.contact },
      orderDate:     { timestampValue: parsed.orderDate.toISOString() },
      paymentMethod: { stringValue: parsed.paymentMethod },
      subtotal:      { integerValue: String(parsed.subtotal) },
      shipping:      { integerValue: String(parsed.shipping) },
      tax:           { integerValue: String(parsed.tax) },
      total:         { integerValue: String(parsed.total) },
      expiresAt:     { timestampValue: expiresAt.toISOString() },
      createdAt:     { timestampValue: new Date().toISOString() },
    },
  };

  var url = getFirestoreUrl(CONFIG.COLLECTION);
  var res = UrlFetchApp.fetch(url, {
    method: 'post',
    headers: getAuthHeaders(),
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });

  if (res.getResponseCode() !== 200) {
    throw new Error('Firestore書き込みエラー: ' + res.getContentText());
  }

  return JSON.parse(res.getContentText());
}

// ===== 初期セットアップ（1回だけ実行） =====
function setupTrigger() {
  // 既存のトリガーを削除
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'processNewOrders') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
  // 5分おきに実行するトリガーを設定
  ScriptApp.newTrigger('processNewOrders')
    .timeBased()
    .everyMinutes(5)
    .create();

  Logger.log('トリガー設定完了: 5分おきに processNewOrders を実行します');
}

// ===== テスト用 =====
function testRun() {
  Logger.log('=== テスト実行開始 ===');
  processNewOrders();
  Logger.log('=== テスト実行完了 ===');
}
