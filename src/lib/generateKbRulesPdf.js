// KB計算ルール PDF ダウンロード
import html2canvas from 'html2canvas'
import jsPDF from 'jspdf'

export async function downloadKbRulesPdf() {
  const html = `
  <div style="width:794px;padding:40px;font-family:'Hiragino Sans','Noto Sans JP','Meiryo',sans-serif;color:#111;background:#fff;">
    <h1 style="font-size:22px;font-weight:bold;text-align:center;margin-bottom:4px;letter-spacing:4px;">KB計算ルール</h1>
    <div style="text-align:center;font-size:11px;color:#666;margin-bottom:24px;">VAVITTE キックバック計算 最終確定版</div>

    <!-- 基本計算式 -->
    <div style="background:#4f46e5;color:#fff;border-radius:10px;padding:16px 24px;margin-bottom:20px;text-align:center;">
      <div style="font-size:11px;opacity:0.8;margin-bottom:4px;">基本計算式</div>
      <div style="font-size:20px;font-weight:bold;">KB = 定価 ×（サロン価格率 − 代理店原価率）× 数量</div>
      <div style="font-size:11px;opacity:0.8;margin-top:8px;">定価 = BカートAPI最高単価 ÷ 0.65</div>
    </div>

    <!-- サロン価格率 -->
    <div style="margin-bottom:20px;">
      <div style="font-size:13px;font-weight:bold;margin-bottom:8px;padding-left:4px;border-left:4px solid #4f46e5;">サロン価格率（商品タイプ別）</div>
      <table style="width:100%;border-collapse:collapse;border:1px solid #e5e7eb;">
        <thead>
          <tr style="background:#1e1b4b;color:#fff;">
            <th style="padding:8px 12px;text-align:left;font-size:11px;">商品タイプ</th>
            <th style="padding:8px 12px;text-align:left;font-size:11px;">判定条件</th>
            <th style="padding:8px 12px;text-align:center;font-size:11px;">サロン価格率</th>
          </tr>
        </thead>
        <tbody>
          <tr style="border-bottom:1px solid #e5e7eb;" data-row>
            <td style="padding:6px 12px;font-size:11px;">店販用単品 1〜5個</td>
            <td style="padding:6px 12px;font-size:11px;">「店販用」含む＆数量1〜5</td>
            <td style="padding:6px 12px;text-align:center;font-size:13px;font-weight:bold;color:#4f46e5;">65%</td>
          </tr>
          <tr style="border-bottom:1px solid #e5e7eb;background:#fafafa;" data-row>
            <td style="padding:6px 12px;font-size:11px;">店販用単品 6個以上</td>
            <td style="padding:6px 12px;font-size:11px;">「店販用」含む＆数量6以上</td>
            <td style="padding:6px 12px;text-align:center;font-size:13px;font-weight:bold;color:#ea580c;">60%</td>
          </tr>
          <tr style="border-bottom:1px solid #e5e7eb;" data-row>
            <td style="padding:6px 12px;font-size:11px;">業務用単品</td>
            <td style="padding:6px 12px;font-size:11px;">「業務用」を含む</td>
            <td style="padding:6px 12px;text-align:center;font-size:13px;font-weight:bold;color:#4f46e5;">65%（何個でも）</td>
          </tr>
          <tr style="border-bottom:1px solid #e5e7eb;background:#fafafa;" data-row>
            <td style="padding:6px 12px;font-size:11px;">エンジェル</td>
            <td style="padding:6px 12px;font-size:11px;">セット名に「エンジェル」含む</td>
            <td style="padding:6px 12px;text-align:center;font-size:13px;font-weight:bold;color:#4f46e5;">65%（何個でも）</td>
          </tr>
          <tr data-row>
            <td style="padding:6px 12px;font-size:11px;">ミカエル/6+1セット</td>
            <td style="padding:6px 12px;font-size:11px;">「ミカエル」or「6+1」含む</td>
            <td style="padding:6px 12px;text-align:center;font-size:13px;font-weight:bold;color:#ea580c;">60%（6個計算）</td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- 代理店原価率 -->
    <div style="margin-bottom:20px;">
      <div style="font-size:13px;font-weight:bold;margin-bottom:8px;padding-left:4px;border-left:4px solid #ea580c;">代理店原価率（一律・代理店ごと設定）</div>
      <table style="width:100%;border-collapse:collapse;border:1px solid #e5e7eb;">
        <tr style="background:#1e1b4b;color:#fff;">
          <th style="padding:8px 12px;text-align:left;font-size:11px;">タイプ</th>
          <th style="padding:8px 12px;text-align:center;font-size:11px;">原価率</th>
          <th style="padding:8px 12px;text-align:left;font-size:11px;">備考</th>
        </tr>
        <tr style="border-bottom:1px solid #e5e7eb;" data-row>
          <td style="padding:6px 12px;font-size:11px;">タイプA</td>
          <td style="padding:6px 12px;text-align:center;font-size:13px;font-weight:bold;">45%</td>
          <td style="padding:6px 12px;font-size:11px;">数量に関係なく一律</td>
        </tr>
        <tr data-row>
          <td style="padding:6px 12px;font-size:11px;">タイプB</td>
          <td style="padding:6px 12px;text-align:center;font-size:13px;font-weight:bold;">40%</td>
          <td style="padding:6px 12px;font-size:11px;">数量に関係なく一律</td>
        </tr>
      </table>
    </div>

    <!-- KB早見表 -->
    <div style="margin-bottom:20px;">
      <div style="font-size:13px;font-weight:bold;margin-bottom:8px;padding-left:4px;border-left:4px solid #16a34a;">KB早見表（定価¥10,000の商品）</div>
      <div style="display:flex;gap:12px;">
        <table style="flex:1;border-collapse:collapse;border:1px solid #e5e7eb;">
          <tr style="background:#4f46e5;color:#fff;">
            <th colspan="2" style="padding:6px 10px;font-size:11px;">代理店率 45%</th>
          </tr>
          <tr style="border-bottom:1px solid #e5e7eb;" data-row>
            <td style="padding:5px 10px;font-size:10px;">店販 1〜5個</td>
            <td style="padding:5px 10px;text-align:right;font-size:12px;font-weight:bold;">¥2,000</td>
          </tr>
          <tr style="border-bottom:1px solid #e5e7eb;background:#fafafa;" data-row>
            <td style="padding:5px 10px;font-size:10px;">店販 6個以上</td>
            <td style="padding:5px 10px;text-align:right;font-size:12px;font-weight:bold;">¥1,500</td>
          </tr>
          <tr style="border-bottom:1px solid #e5e7eb;" data-row>
            <td style="padding:5px 10px;font-size:10px;">業務用/エンジェル</td>
            <td style="padding:5px 10px;text-align:right;font-size:12px;font-weight:bold;">¥2,000</td>
          </tr>
          <tr data-row>
            <td style="padding:5px 10px;font-size:10px;">ミカエル1セット</td>
            <td style="padding:5px 10px;text-align:right;font-size:12px;font-weight:bold;color:#4f46e5;">¥9,000</td>
          </tr>
        </table>
        <table style="flex:1;border-collapse:collapse;border:1px solid #e5e7eb;">
          <tr style="background:#ea580c;color:#fff;">
            <th colspan="2" style="padding:6px 10px;font-size:11px;">代理店率 40%</th>
          </tr>
          <tr style="border-bottom:1px solid #e5e7eb;" data-row>
            <td style="padding:5px 10px;font-size:10px;">店販 1〜5個</td>
            <td style="padding:5px 10px;text-align:right;font-size:12px;font-weight:bold;">¥2,500</td>
          </tr>
          <tr style="border-bottom:1px solid #e5e7eb;background:#fafafa;" data-row>
            <td style="padding:5px 10px;font-size:10px;">店販 6個以上</td>
            <td style="padding:5px 10px;text-align:right;font-size:12px;font-weight:bold;">¥2,000</td>
          </tr>
          <tr style="border-bottom:1px solid #e5e7eb;" data-row>
            <td style="padding:5px 10px;font-size:10px;">業務用/エンジェル</td>
            <td style="padding:5px 10px;text-align:right;font-size:12px;font-weight:bold;">¥2,500</td>
          </tr>
          <tr data-row>
            <td style="padding:5px 10px;font-size:10px;">ミカエル1セット</td>
            <td style="padding:5px 10px;text-align:right;font-size:12px;font-weight:bold;color:#ea580c;">¥12,000</td>
          </tr>
        </table>
      </div>
    </div>

    <!-- 計算例 -->
    <div style="margin-bottom:20px;">
      <div style="font-size:13px;font-weight:bold;margin-bottom:8px;padding-left:4px;border-left:4px solid #dc2626;">計算例（代理店原価率 45%）</div>
      <table style="width:100%;border-collapse:collapse;border:1px solid #e5e7eb;">
        <tr style="background:#1e1b4b;color:#fff;">
          <th style="padding:6px 8px;text-align:left;font-size:10px;">商品</th>
          <th style="padding:6px 8px;text-align:right;font-size:10px;">単価</th>
          <th style="padding:6px 8px;text-align:right;font-size:10px;">数量</th>
          <th style="padding:6px 8px;text-align:right;font-size:10px;">定価</th>
          <th style="padding:6px 8px;text-align:center;font-size:10px;">率</th>
          <th style="padding:6px 8px;text-align:right;font-size:10px;">KB金額</th>
        </tr>
        <tr style="border-bottom:1px solid #e5e7eb;" data-row>
          <td style="padding:5px 8px;font-size:10px;">店販単品</td>
          <td style="padding:5px 8px;text-align:right;font-size:10px;">¥6,500</td>
          <td style="padding:5px 8px;text-align:right;font-size:10px;">3個</td>
          <td style="padding:5px 8px;text-align:right;font-size:10px;">¥10,000</td>
          <td style="padding:5px 8px;text-align:center;font-size:10px;">65%</td>
          <td style="padding:5px 8px;text-align:right;font-size:11px;font-weight:bold;color:#4f46e5;">¥6,000</td>
        </tr>
        <tr style="border-bottom:1px solid #e5e7eb;background:#fafafa;" data-row>
          <td style="padding:5px 8px;font-size:10px;">店販単品(6個以上)</td>
          <td style="padding:5px 8px;text-align:right;font-size:10px;">¥6,000</td>
          <td style="padding:5px 8px;text-align:right;font-size:10px;">6個</td>
          <td style="padding:5px 8px;text-align:right;font-size:10px;">¥10,000</td>
          <td style="padding:5px 8px;text-align:center;font-size:10px;">60%</td>
          <td style="padding:5px 8px;text-align:right;font-size:11px;font-weight:bold;color:#4f46e5;">¥9,000</td>
        </tr>
        <tr style="border-bottom:1px solid #e5e7eb;" data-row>
          <td style="padding:5px 8px;font-size:10px;">業務用単品</td>
          <td style="padding:5px 8px;text-align:right;font-size:10px;">¥6,500</td>
          <td style="padding:5px 8px;text-align:right;font-size:10px;">8個</td>
          <td style="padding:5px 8px;text-align:right;font-size:10px;">¥10,000</td>
          <td style="padding:5px 8px;text-align:center;font-size:10px;">65%</td>
          <td style="padding:5px 8px;text-align:right;font-size:11px;font-weight:bold;color:#4f46e5;">¥16,000</td>
        </tr>
        <tr style="border-bottom:1px solid #e5e7eb;background:#fafafa;" data-row>
          <td style="padding:5px 8px;font-size:10px;">ミカエル1セット</td>
          <td style="padding:5px 8px;text-align:right;font-size:10px;">¥36,000</td>
          <td style="padding:5px 8px;text-align:right;font-size:10px;">1セット</td>
          <td style="padding:5px 8px;text-align:right;font-size:10px;">¥10,000</td>
          <td style="padding:5px 8px;text-align:center;font-size:10px;">60%</td>
          <td style="padding:5px 8px;text-align:right;font-size:11px;font-weight:bold;color:#4f46e5;">¥9,000</td>
        </tr>
        <tr data-row>
          <td style="padding:5px 8px;font-size:10px;">エンジェル(6個)</td>
          <td style="padding:5px 8px;text-align:right;font-size:10px;">¥6,500</td>
          <td style="padding:5px 8px;text-align:right;font-size:10px;">6個</td>
          <td style="padding:5px 8px;text-align:right;font-size:10px;">¥10,000</td>
          <td style="padding:5px 8px;text-align:center;font-size:10px;">65%</td>
          <td style="padding:5px 8px;text-align:right;font-size:11px;font-weight:bold;color:#4f46e5;">¥12,000</td>
        </tr>
      </table>
    </div>

    <!-- 判定フロー -->
    <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:12px 16px;font-size:10px;color:#444;">
      <div style="font-weight:bold;margin-bottom:6px;font-size:11px;">判定フロー</div>
      <div>1. KB掛け率が設定済? → 未設定なら従来方式(5/13, 1/3)</div>
      <div>2. ミカエル or 6+1? → セット価格÷6÷0.60で単品定価逆算</div>
      <div>3. エンジェル or 業務用? → 常にサロン率65%</div>
      <div>4. 上記以外(店販単品) → 1〜5個:65% / 6個以上:60%</div>
    </div>
  </div>`

  const container = document.createElement('div')
  container.style.position = 'fixed'
  container.style.left = '-9999px'
  container.innerHTML = html
  document.body.appendChild(container)

  try {
    const target = container.firstElementChild
    const canvas = await html2canvas(target, { scale: 2, width: 794, backgroundColor: '#fff', useCORS: true, logging: false })
    const imgData = canvas.toDataURL('image/png')
    const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' })
    const pageWidth = pdf.internal.pageSize.getWidth()
    const margin = 10
    const printableWidth = pageWidth - margin * 2
    const imgHeight = (canvas.height * printableWidth) / canvas.width
    pdf.addImage(imgData, 'PNG', margin, margin, printableWidth, imgHeight)
    pdf.save('KB計算ルール.pdf')
  } finally {
    document.body.removeChild(container)
  }
}
