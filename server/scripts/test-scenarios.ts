// 複雑ケースの解読限界を探る複数シナリオ実験。
// S1 配賦(安分) / S2 KPIEE表現不可ロジック / S3 汚い実務シート / S4 中間シート内の手入力上書き
import ExcelJS from 'exceljs';

const API = 'http://localhost:8787';

type Scenario = { name: string; desc: string; build: () => Promise<{ kind: string; filename: string; buf: Buffer }[]> };

const buf = async (wb: ExcelJS.Workbook) => Buffer.from(await wb.xlsx.writeBuffer());

// ---- S1: 配賦(安分) — 本社共通費を部門売上比で按分 ----
const s1: Scenario = {
  name: '配賦按分', desc: '本社共通費を部門売上比で各部門へ按分',
  build: async () => {
    const wb = new ExcelJS.Workbook();
    const sales = wb.addWorksheet('部門売上');
    sales.addRow(['部門', '売上']);
    sales.addRow(['営業1部', 5000000]);
    sales.addRow(['営業2部', 3000000]);
    sales.addRow(['営業3部', 2000000]);

    const common = wb.addWorksheet('共通費');
    common.addRow(['項目', '金額']);
    common.addRow(['本社管理費', 1000000]);

    const alloc = wb.addWorksheet('配賦');
    alloc.addRow(['部門', '按分共通費', '部門損益']);
    for (let i = 0; i < 3; i++) {
      const r = i + 2;
      alloc.addRow([
        { formula: `部門売上!A${r}` },
        // 共通費 × (部門売上 / 全社売上合計) = 売上比按分
        { formula: `共通費!B2*部門売上!B${r}/SUM(部門売上!B2:B4)` },
        { formula: `部門売上!B${r}-B${i + 2}` },
      ]);
    }
    return [{ kind: 'auto', filename: '配賦計算.xlsx', buf: await buf(wb) }];
  },
};

// ---- S2: KPIEE表現不可ロジック — 入れ子IF / 文字列連結 / 条件付き歩合 ----
const s2: Scenario = {
  name: '表現不可ロジック', desc: '入れ子IF・文字列処理・条件付き単価（KPIEEカスタム数式の範囲外）',
  build: async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('歩合計算');
    ws.addRow(['営業', '売上額', 'ランク', '表示名', '歩合給']);
    const data = [['田中', 1200000], ['鈴木', 700000], ['佐藤', 300000]];
    data.forEach(([name, amt], i) => {
      const r = i + 2;
      ws.addRow([
        name, amt,
        { formula: `IF(B${r}>=1000000,"A",IF(B${r}>=500000,"B","C"))` },              // 入れ子IF
        { formula: `A${r}&"_"&TEXT(B${r},"#,##0")&"円"` },                            // 文字列連結+TEXT
        { formula: `IF(B${r}>1000000,B${r}*0.05,B${r}*0.03)` },                       // 条件付き歩合率
      ]);
    });
    return [{ kind: 'auto', filename: '歩合計算.xlsx', buf: await buf(wb) }];
  },
};

// ---- S3: 汚い実務シート — 結合セル/小計行挿入/数値が文字列/和暦 ----
const s3: Scenario = {
  name: '汚い実務シート', desc: '結合セルタイトル・小計行混在・文字列数値・和暦',
  build: async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('売上集計表');
    ws.mergeCells('A1:D1');
    ws.getCell('A1').value = '令和6年度 売上集計（社外秘）';
    ws.addRow([]);
    ws.addRow(['年月', '部門', '商品', '売上']);
    ws.addRow(['令和6年1月', '東日本', 'テレビ', '1,200,000']);   // 数値が文字列・和暦
    ws.addRow(['令和6年1月', '東日本', '冷蔵庫', '850,000']);
    ws.addRow(['', '東日本 小計', '', { formula: 'SUM(D4:D5)' }]); // 小計行をデータ間に挿入
    ws.addRow(['令和6年1月', '西日本', 'テレビ', '980,000']);
    ws.addRow(['', '西日本 小計', '', { formula: 'SUM(D7:D7)' }]);
    ws.addRow(['', '総合計', '', { formula: 'D6+D8' }]);          // 小計を足す総合計
    return [{ kind: 'auto', filename: '売上集計表.xlsx', buf: await buf(wb) }];
  },
};

// ---- S4: 中間シート内の手入力上書き — 数式列の一部セルだけ手打ち値 ----
const s4: Scenario = {
  name: '数式列の手入力混入', desc: '値引後価格列は本来 単価×0.9 の数式だが、2行だけ手で値を上書き',
  build: async () => {
    const wb = new ExcelJS.Workbook();
    const src = wb.addWorksheet('単価表');
    src.addRow(['商品', '単価']);
    [['A001', 1000], ['A002', 2000], ['A003', 1500], ['A004', 3000], ['A005', 800]]
      .forEach(r => src.addRow(r));

    const calc = wb.addWorksheet('値引計算');
    calc.addRow(['商品', '値引後価格']);
    // 1,2,5行目は数式、3・4行目は手入力（特別値引きで数式を消して直接入力した想定）
    const rows = [
      { f: true, v: null }, { f: true, v: null },
      { f: false, v: 1200 },  // A003: 本来1350のはずが手で1200に
      { f: false, v: 2500 },  // A004: 本来2700のはずが手で2500に
      { f: true, v: null },
    ];
    rows.forEach((row, i) => {
      const r = i + 2;
      calc.addRow([{ formula: `単価表!A${r}` }, row.f ? { formula: `単価表!B${r}*0.9` } : row.v]);
    });
    return [{ kind: 'auto', filename: '値引計算.xlsx', buf: await buf(wb) }];
  },
};

const SCENARIOS = [s1, s2, s3, s4];

// ---- ドライバ ----
async function uploadFile(pid: number, kind: string, filename: string, b: Buffer) {
  const fd = new FormData();
  fd.append('kind', kind);
  fd.append('file', new Blob([b]), filename);
  return (await fetch(`${API}/api/projects/${pid}/artifacts`, { method: 'POST', body: fd })).json();
}
async function poll(pid: number, stage: string) {
  for (let i = 0; i < 120; i++) {
    const p = await (await fetch(`${API}/api/projects/${pid}`)).json();
    const run = (p.runs as any[]).find(r => r.stage === stage);
    if (run && run.status !== 'running') return run;
    await new Promise(r => setTimeout(r, 3000));
  }
  throw new Error('timeout');
}

async function run(s: Scenario) {
  console.log(`\n${'='.repeat(70)}\n■ ${s.name} — ${s.desc}\n${'='.repeat(70)}`);
  const project = await (await fetch(`${API}/api/projects`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ customer_name: `実験_${s.name}`, description: s.desc }),
  })).json();

  const files = await s.build();
  for (const f of files) {
    const up = await uploadFile(project.id, f.kind, f.filename, f.buf);
    if (up.sheet_roles) {
      const roles = Object.fromEntries(Object.entries(JSON.parse(up.sheet_roles)).map(([k, v]: any) => [k, v.role]));
      console.log(`役割自動分類: ${JSON.stringify(roles)}`);
    }
  }

  await fetch(`${API}/api/projects/${project.id}/pipeline/decode`, { method: 'POST' });
  const r = await poll(project.id, 'decode');
  console.log(`decode: ${r.status}  in=${r.input_tokens} out=${r.output_tokens}  ${r.error ?? ''}`);

  const findings = await (await fetch(`${API}/api/projects/${project.id}/findings`)).json();
  for (const f of findings) {
    const flag = f.kpiee_target === 'needs_customer_confirmation' ? ' ⚠要確認' : '';
    console.log(`\n[${f.source_ref}] ${f.logic_type} → ${f.kpiee_target}${flag} (${f.confidence})`);
    if (f.formula_raw) console.log(`  式: ${f.formula_raw}`);
    console.log(`  ${f.explanation}`);
  }
  const qs = await (await fetch(`${API}/api/projects/${project.id}/questions`)).json();
  if (qs.length) { console.log(`\n顧客確認 ${qs.length}件:`); qs.forEach((q: any) => console.log(`  - ${q.question}`)); }
  console.log(`\n(id=${project.id})`);
}

async function main() {
  const h = await (await fetch(`${API}/api/health`)).json();
  console.log('AI mode:', h.aiMode);
  for (const s of SCENARIOS) await run(s);
}
main().catch(e => { console.error(e); process.exit(1); });
