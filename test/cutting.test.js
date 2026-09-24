'use strict';

// 批量裁切下料纯函数测试：数量/规格校验、记忆化直线贯通分割搜索、
// 印张旋转 90°、裁切树有效性（不重叠/不越界/每刀贯通）、推荐排序与
// 不可行原因。
const assert = require('assert');
const {
  PT_PER_MM,
  MAX_SIDE_MM,
  MAX_QUANTITY,
  normalizeQuantity,
  normalizeCuttingPapers,
  readSheetSize,
  guillotinePack,
  materialize,
  buildCuttingPlan,
} = require('../lib/cutting');

const EPS = 1e-3;

const PANEL_A4 = { width: 595.2756, height: 841.8898, orientation: 'portrait' };
const planA4 = {
  sheets: [{ sheet: 1 }, { sheet: 2 }],
  sourceCount: 8, paddedCount: 0, totalCount: 8, blanks: 0,
  panel: PANEL_A4,
  sheet: { width: 1190.5512, height: 841.8898 },
};

// ---------- 1. 入参校验 ----------

assert.strictEqual(normalizeQuantity(1), 1);
assert.strictEqual(normalizeQuantity('12'), 12);
assert.strictEqual(normalizeQuantity('  30 '), 30);
for (const bad of [0, -1, 1.5, '1.0', 'abc', '', null, undefined, NaN, Infinity, true]) {
  assert.throws(() => normalizeQuantity(bad), /所需印张数必须是大于 0 的整数/);
}
assert.throws(() => normalizeQuantity(MAX_QUANTITY + 1), /不能超过/);

// 纸张规格复用报价模块的校验规则，额外限制单边尺寸
assert.throws(
  () => normalizeCuttingPapers([{ widthMm: MAX_SIDE_MM + 1, heightMm: 100, pricePerSheet: 1, setupFee: 0 }]),
  new RegExp(`单边尺寸不能超过 ${MAX_SIDE_MM}`),
);
const okSpecs = normalizeCuttingPapers([
  { name: 'A3', widthMm: '420', heightMm: 297, pricePerSheet: 0.8, setupFee: 50 },
]);
assert.strictEqual(okSpecs[0].widthMm, 420);
assert.throws(() => normalizeCuttingPapers([]), /至少维护一种/);
assert.throws(() => normalizeCuttingPapers([{ widthMm: 0, heightMm: 1 }]), /宽必须是大于 0/);

// 印张尺寸读取：优先 plan.sheet（pt → mm 420×297）
const sheet = readSheetSize(planA4);
assert.ok(Math.abs(sheet.widthMm - 420) < 0.01);
assert.ok(Math.abs(sheet.heightMm - 297) < 0.01);

// 旧方案无 sheet 字段时回退为 2 × 面板宽 × 面板高
const legacy = readSheetSize({
  sheets: [{ sheet: 1 }],
  panel: PANEL_A4,
});
assert.ok(Math.abs(legacy.widthMm - 420) < 0.01);
assert.ok(Math.abs(legacy.heightMm - 297) < 0.01);
assert.throws(() => readSheetSize(null), /缺少拼版方案/);

// ---------- 2. 裁切搜索：产出数 ----------

function solve(w, h, pw, ph) {
  const { count, frame } = guillotinePack(w, h, pw, ph);
  return { count, layout: materialize(frame, pw, ph) };
}

// 恰好放下
assert.strictEqual(solve(420, 297, 420, 297).count, 1);

// 纯网格：1000×700 / 420×297 → 2×2 = 4，无贯通刀（leaf）
{
  const { count, layout } = solve(1000, 700, 420, 297);
  assert.strictEqual(count, 4);
  assert.strictEqual(layout.cuts.length, 0);
}

// 印张必须旋转 90° 才能放下：原纸竖版 297×420 放横印张 420×297
{
  const { count, layout } = solve(297, 420, 420, 297);
  assert.strictEqual(count, 1);
  // 印张实际摆放在竖版原纸上，宽高为 297×420（相对印张成品即旋转 90°）
  assert.strictEqual(layout.pieces[0].width, 297);
  assert.strictEqual(layout.pieces[0].height, 420);
  assert.strictEqual(layout.pieces[0].rotated, true);
}

// 混合方向才能达到面积上界：800×500 / 300×200 → 6
// （纯原向网格 4×2=8 高不够仅 4×2？实际网格 2×2=4；必须上下分区混合）
{
  const { count, layout } = solve(800, 500, 300, 200);
  assert.strictEqual(count, 6, `混合旋转应裁出 6 个，实际 ${count}`);
  assert.ok(layout.pieces.some((p) => p.rotated));
  assert.ok(layout.pieces.some((p) => !p.rotated));
  assert.ok(layout.cuts.length >= 1, '混合方案必须包含贯通切线');
}

// A2 原纸 424×594 放 A3 展开印张 420×297 → 1×2 = 2
assert.strictEqual(solve(424, 594, 420, 297).count, 2);

// 启用定位标记的印张 436×313：A3 420×297 两个方向都放不下
assert.strictEqual(solve(420, 297, 436, 313).count, 0);
// A2 424×594 旋转印张后 1×1
assert.strictEqual(solve(424, 594, 436, 313).count, 1);

// 方形印张
assert.strictEqual(solve(250, 250, 100, 100).count, 4);

// 面积上界自检：产出绝不超过 floor(原纸面积/印张面积)
function areaBound(w, h, pw, ph) {
  return Math.floor((w * h) / (pw * ph) + 1e-9);
}
for (const [w, h, pw, ph] of [
  [1092, 787, 420, 297],
  [1092, 787, 436, 313],
  [1200, 900, 420, 297],
  [1000, 700, 200, 300],
  [2000, 2000, 420, 297],
]) {
  const { count } = solve(w, h, pw, ph);
  assert.ok(count <= areaBound(w, h, pw, ph),
    `${w}×${h}/${pw}×${ph} 产出 ${count} 超过面积上界 ${areaBound(w, h, pw, ph)}`);
  assert.ok(count >= 1, '测试用例原纸均应能裁出至少 1 个');
}

// 经典非面积估算案例：1092×787 / 420×297 面积上界 6，直线贯通实际 5
{
  const { count, layout } = solve(1092, 787, 420, 297);
  assert.strictEqual(areaBound(1092, 787, 420, 297), 6);
  assert.strictEqual(count, 5);
  assert.ok(layout.cuts.length >= 1);
}

// ---------- 3. 裁切图有效性：不越界、不重叠、每刀完整贯通当前矩形 ----------

/**
 * 递归校验裁切树：
 *   - leaf：全部印张落在节点框内、互不重叠、尺寸等于印张原向/旋转尺寸；
 *   - cut：切线贯通节点整宽/整高，两个子矩形恰好沿切线无缝拼接。
 */
function validateTree(tree, pieceW, pieceH) {
  if (tree.type === 'empty') return 0;
  if (tree.type === 'leaf') {
    assert.strictEqual(tree.pieces.length, tree.count);
    for (const p of tree.pieces) {
      assert.ok(p.x >= tree.x - EPS && p.y >= tree.y - EPS, '印张越出节点左下边界');
      assert.ok(p.x + p.width <= tree.x + tree.width + EPS, '印张越出节点右边界');
      assert.ok(p.y + p.height <= tree.y + tree.height + EPS, '印张越出节点上边界');
      const asIs = Math.abs(p.width - pieceW) < EPS && Math.abs(p.height - pieceH) < EPS;
      const rotatedDims = Math.abs(p.width - pieceH) < EPS && Math.abs(p.height - pieceW) < EPS;
      assert.ok(asIs || rotatedDims, '印张尺寸不是原向或旋转 90° 尺寸');
      // 非方形印张：实际宽高与原向一致时 rotated 必须为 false，否则必须为 true
      if (Math.abs(pieceW - pieceH) > EPS) {
        assert.strictEqual(p.rotated, !asIs, 'rotated 标记与实际尺寸一致');
      }
    }
    return tree.count;
  }

  assert.ok(tree.children.length === 2);
  const [a, b] = tree.children;
  let total = 0;
  if (tree.orientation === 'vertical') {
    // 切线纵向贯通：子矩形左右相邻、同高
    assert.ok(Math.abs(a.y - tree.y) < EPS && Math.abs(b.y - tree.y) < EPS);
    assert.ok(Math.abs(a.height - tree.height) < EPS);
    assert.ok(Math.abs(b.height - tree.height) < EPS);
    assert.ok(Math.abs(a.x - tree.x) < EPS);
    assert.ok(Math.abs((a.x + a.width) - tree.positionMm) < EPS, '左子矩形未贴齐切线');
    assert.ok(Math.abs(b.x - tree.positionMm) < EPS, '右子矩形未从切线开始');
    assert.ok(Math.abs((b.x + b.width) - (tree.x + tree.width)) < EPS);
  } else {
    assert.ok(Math.abs(a.x - tree.x) < EPS && Math.abs(b.x - tree.x) < EPS);
    assert.ok(Math.abs(a.width - tree.width) < EPS);
    assert.ok(Math.abs(b.width - tree.width) < EPS);
    assert.ok(Math.abs(a.y - tree.y) < EPS);
    assert.ok(Math.abs((a.y + a.height) - tree.positionMm) < EPS, '下子矩形未贴齐切线');
    assert.ok(Math.abs(b.y - tree.positionMm) < EPS, '上子矩形未从切线开始');
    assert.ok(Math.abs((b.y + b.height) - (tree.y + tree.height)) < EPS);
  }
  total += validateTree(a, pieceW, pieceH);
  total += validateTree(b, pieceW, pieceH);
  assert.strictEqual(total, tree.count, '裁切树 count 与叶子产出之和不一致');
  return total;
}

function validateLayout(w, h, pw, ph) {
  const { count, frame } = guillotinePack(w, h, pw, ph);
  const layout = materialize(frame, pw, ph);
  assert.strictEqual(layout.pieces.length, count);
  assert.strictEqual(validateTree(layout.tree, pw, ph), count);

  // 全局：不越界、不重叠
  for (const p of layout.pieces) {
    assert.ok(p.x >= -EPS && p.y >= -EPS, '印张越出原纸左下边界');
    assert.ok(p.x + p.width <= w + EPS, `印张越出原纸右边界：${JSON.stringify(p)}`);
    assert.ok(p.y + p.height <= h + EPS, '印张越出原纸上边界');
  }
  for (let i = 0; i < layout.pieces.length; i += 1) {
    for (let j = i + 1; j < layout.pieces.length; j += 1) {
      const a = layout.pieces[i];
      const b = layout.pieces[j];
      const ox = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
      const oy = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
      assert.ok(!(ox > EPS && oy > EPS), `印张重叠：${JSON.stringify(a)} / ${JSON.stringify(b)}`);
    }
  }

  // 每条切线必须是直线（竖线或横线）；是否贯通由上方裁切树递归校验保证
  // （后续刀只贯通其所在子矩形，不必横跨整张原纸）
  for (const c of layout.cuts) {
    if (c.orientation === 'vertical') {
      assert.ok(Math.abs(c.from.x - c.to.x) < EPS);
      assert.ok(c.to.y > c.from.y, '竖切线应有正长度');
    } else {
      assert.ok(Math.abs(c.from.y - c.to.y) < EPS);
      assert.ok(c.to.x > c.from.x, '横切线应有正长度');
    }
  }
  return { count, layout };
}

for (const [w, h, pw, ph] of [
  [420, 297, 420, 297],
  [424, 594, 420, 297],
  [800, 500, 300, 200],
  [1092, 787, 420, 297],
  [1092, 787, 436, 313],
  [1000, 700, 200, 300],
  [297, 420, 420, 297],
  [2000, 2000, 420, 297],
]) {
  validateLayout(w, h, pw, ph);
}

// 大尺寸搜索性能：上限内原纸应在毫秒级完成且状态受控
{
  const t0 = Date.now();
  validateLayout(2000, 2000, 210.3, 297.7);
  assert.ok(Date.now() - t0 < 1000, '大尺寸搜索耗时超过 1s');
}

// ---------- 4. buildCuttingPlan：数量指标、排序与推荐 ----------

const result = buildCuttingPlan(planA4, [
  { name: 'A3', widthMm: 420, heightMm: 297, pricePerSheet: 1, setupFee: 50 },
  { name: 'A2', widthMm: 424, heightMm: 594, pricePerSheet: 2, setupFee: 0 },
  { name: 'A4 小纸', widthMm: 297, heightMm: 210, pricePerSheet: 0.3, setupFee: 10 },
], 10);

assert.strictEqual(result.kind, 'sheet-cutting');
assert.strictEqual(result.schemaVersion, 1);
assert.strictEqual(result.quantity, 10);
assert.strictEqual(result.feasible, true);
assert.ok(Math.abs(result.sheet.widthMm - 420) < 0.01);

const [a3, a2, a4] = result.options;
assert.strictEqual(a3.feasible, true);
assert.strictEqual(a3.piecesPerSheet, 1);
assert.strictEqual(a3.sheetsNeeded, 10);
assert.strictEqual(a3.surplusPieces, 0);
assert.strictEqual(a3.lastSheetNeededPieces, 1);
assert.strictEqual(a3.lastSheetRemainderPieces, 0);
assert.ok(Math.abs(a3.wasteAreaPerSheetMm2) < 0.01);

assert.strictEqual(a2.feasible, true);
assert.strictEqual(a2.piecesPerSheet, 2);
assert.strictEqual(a2.sheetsNeeded, 5);
assert.strictEqual(a2.producedPieces, 10);
assert.strictEqual(a2.surplusPieces, 0);
assert.strictEqual(a2.lastSheetNeededPieces, 2);
assert.strictEqual(a2.lastSheetRemainderPieces, 0);
// A2 废料 = 424×594 - 2×420×297 = 251856 - 249480 = 2376
assert.ok(Math.abs(a2.wasteAreaPerSheetMm2 - 2376) < 1, `A2 废料 ${a2.wasteAreaPerSheetMm2}`);
assert.ok(Math.abs(a2.utilizationPercent - 99.06) < 0.05);

assert.strictEqual(a4.feasible, false);
assert.strictEqual(a4.reasons.length, 2);
assert.match(a4.reasons[0].message, /宽度不足/);

// 推荐：所需原纸张数最少 → A2（5 张）优于 A3（10 张），与单价无关
assert.strictEqual(result.recommendedIndex, 1);
assert.strictEqual(result.recommended.name, 'A2');

// 尾张余量：11 个印张 / 每张 2 → 6 张，尾张只需 1 个、余 1 个
{
  const r11 = buildCuttingPlan(planA4, [
    { name: 'A2', widthMm: 424, heightMm: 594, pricePerSheet: 2, setupFee: 0 },
  ], 11);
  const opt = r11.options[0];
  assert.strictEqual(opt.sheetsNeeded, 6);
  assert.strictEqual(opt.producedPieces, 12);
  assert.strictEqual(opt.surplusPieces, 1);
  assert.strictEqual(opt.lastSheetNeededPieces, 1);
  assert.strictEqual(opt.lastSheetRemainderPieces, 1);
  // 本批总废料 = 6 张原纸面积 - 11 个印张面积
  const expectedTotalWaste = 6 * 424 * 594 - 11 * 420 * 297;
  assert.ok(Math.abs(opt.totalWasteAreaMm2 - expectedTotalWaste) < 1);
}

// 推荐排序：所需张数相同时，单张废料更少者优先
{
  const tie = buildCuttingPlan(planA4, [
    // 600×600：420×297 可裁 2 个，废料 110520
    { name: '大纸', widthMm: 600, heightMm: 600, pricePerSheet: 5, setupFee: 0 },
    // 840×300：420×297 恰好 2 个，废料 2520
    { name: '窄纸', widthMm: 840, heightMm: 300, pricePerSheet: 5, setupFee: 0 },
  ], 10);
  assert.strictEqual(tie.options[0].piecesPerSheet, 2);
  assert.strictEqual(tie.options[1].piecesPerSheet, 2);
  assert.strictEqual(tie.recommended.name, '窄纸');
}

// 混合旋转案例：800×500 / 300×200 → 6，原向/旋转计数都大于 0
{
  const mixPlan = {
    sheets: [{ sheet: 1 }],
    panel: { width: 300 * PT_PER_MM, height: 200 * PT_PER_MM, orientation: 'landscape' },
  };
  // 印张 300×200mm：panel 不能直接表达，构造 sheet 字段
  mixPlan.sheet = { width: 300 * PT_PER_MM, height: 200 * PT_PER_MM };
  const mix = buildCuttingPlan(mixPlan, [
    { name: '混合纸', widthMm: 800, heightMm: 500, pricePerSheet: 1, setupFee: 0 },
  ], 13);
  const opt = mix.options[0];
  assert.strictEqual(opt.piecesPerSheet, 6);
  assert.ok(opt.asIsPieces > 0 && opt.rotatedPieces > 0,
    `应混合两种方向：原向 ${opt.asIsPieces} / 旋转 ${opt.rotatedPieces}`);
  assert.strictEqual(opt.sheetsNeeded, 3);
  assert.strictEqual(opt.lastSheetNeededPieces, 1);
  assert.strictEqual(opt.lastSheetRemainderPieces, 5);
  assert.ok(opt.diagram.pieces.length === 6);
  assert.ok(opt.cutTree.type === 'cut');
}

// ---------- 5. 无可行方案 ----------

{
  const none = buildCuttingPlan(planA4, [
    { name: 'A5', widthMm: 210, heightMm: 148, pricePerSheet: 0.2, setupFee: 0 },
  ], 5);
  assert.strictEqual(none.feasible, false);
  assert.strictEqual(none.recommended, null);
  assert.strictEqual(none.recommendedIndex, null);
  assert.strictEqual(none.reasonCode, 'no_cuttable_paper');
  assert.match(none.reason, /420/);
  assert.match(none.reason, /A5/);
  assert.match(none.reason, /旋转/);
  assert.strictEqual(none.options[0].feasible, false);
  const asIs = none.options[0].reasons.find((r) => r.orientation === 'as_is');
  const rotated = none.options[0].reasons.find((r) => r.orientation === 'rotated_90');
  // 原向 210×148：宽差 210、高差 149；旋转后印张 297×420：宽差 87、高差 272
  assert.ok(Math.abs(asIs.shortageWidthMm - 210) < 0.01);
  assert.ok(Math.abs(asIs.shortageHeightMm - 149) < 0.01);
  assert.ok(Math.abs(rotated.shortageWidthMm - 87) < 0.01);
  assert.ok(Math.abs(rotated.shortageHeightMm - 272) < 0.01);
}

// ---------- 6. 非法输入 ----------

assert.throws(() => buildCuttingPlan(planA4, [{ widthMm: 420, heightMm: 297 }], 0), /大于 0/);
assert.throws(() => buildCuttingPlan(planA4, [{ widthMm: 420, heightMm: 297 }], '2.5'), /整数/);
assert.throws(() => buildCuttingPlan(planA4, [{ widthMm: 420, heightMm: 297 }], 'x'), /整数/);
assert.throws(() => buildCuttingPlan(null, [{ widthMm: 420, heightMm: 297 }], 1), /plan/);
assert.throws(() => buildCuttingPlan(planA4, [], 1), /至少维护一种/);
assert.throws(
  () => buildCuttingPlan(planA4, [{ widthMm: -1, heightMm: 297 }], 1),
  /宽必须是大于 0/,
);

// ---------- 7. 结构稳定性（JSON 可序列化字段） ----------

{
  const json = JSON.parse(JSON.stringify(result));
  assert.strictEqual(json.kind, 'sheet-cutting');
  for (const opt of json.options) {
    if (opt.feasible) {
      assert.ok(Number.isInteger(opt.piecesPerSheet));
      assert.ok(Number.isInteger(opt.sheetsNeeded));
      assert.ok(Array.isArray(opt.diagram.pieces));
      assert.ok(Array.isArray(opt.diagram.cuts));
      assert.ok(opt.cutTree && typeof opt.cutTree.type === 'string');
    }
  }
}

console.log('✅ 批量裁切下料纯函数测试通过：数量/规格校验、记忆化直线贯通分割、');
console.log('   印张旋转 90°（含混合方向）、裁切树不重叠不越界且每刀贯通、');
console.log('   单张产出/原纸张数/尾张余量/废料计算、推荐排序与不可行原因');
