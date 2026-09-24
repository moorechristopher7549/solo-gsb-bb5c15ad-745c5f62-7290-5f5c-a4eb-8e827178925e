'use strict';

/**
 * 批量裁切下料（sheet cutting / guillotine packing）。
 *
 * 纯计算模块，不触碰 PDF 字节：输入拼版方案（lib/impose.js 产出的 plan，
 * 实际输出印张尺寸取 plan.sheet，旧方案回退 2 × 面板宽 × 面板高）、用户维护
 * 的纸张规格与所需印张数，计算每种原纸单张能裁出的印张数，并生成可执行的
 * **直线贯通（guillotine）裁切树**：
 *
 *   - 允许印张旋转 90°：每个矩形在摆放时枚举原向 / 旋转两种方向（允许同一
 *     原纸上两种方向混合摆放）；
 *   - 搜索方式为记忆化的矩形递归分割：每个矩形先尝试整版网格摆放（leaf），
 *     再枚举沿长边 / 短边的贯通切线（切线位置只取「若干个印张边长」，与
 *     真实刀路一致），递归求两个子矩形最优解之和；
 *   - 以面积上界（floor(矩形面积 ÷ 印张面积)）做提前达标剪枝，并以
 *     乐观值（两段面积上界之和）跳过不可能更优的切线；
 *   - 只接受由递归分割真实生成的摆放，所有印张矩形互不重叠、每一刀都完整
 *     贯通当前被切矩形（绝不按面积估算或重叠摆放）。
 *
 * 输出每种原纸的裁切图（印张矩形绝对坐标 + 贯通切线列表 + 嵌套裁切树）、
 * 单张产出、所需原纸张数、尾张余量与废料面积，并按「所需原纸张数升序 →
 * 单张废料面积升序 → 原纸面积升序 → 维护顺序」推荐方案。
 */

const {
  PT_PER_MM,
  MAX_PAPER_SPECS,
  normalizePaperSpecs,
  readLayout,
} = require('./quote');

/** 几何比较容差（mm），吸收 pt↔mm 换算误差 */
const EPS_MM = 1e-4;
/** 整除容差（比例）：419.99998 / 420 应判为 1 而非 0 */
const FLOOR_EPS = 1e-6;
/** 小于该厚度的残余条视为 0，不再下刀 */
const SPLIT_MIN_MM = 0.01;
/** 参与裁切计算的原纸单边最大尺寸（mm），防止异常输入导致搜索爆炸 */
const MAX_SIDE_MM = 2000;
/** 记忆化搜索的状态数上限（超出报 search_too_large，由路由层转 422） */
const MAX_SEARCH_STATES = 40000;
/** 单种原纸搜索的时间预算（ms），防止极端尺寸比例请求长时间占用服务 */
const SEARCH_TIME_BUDGET_MS = 1500;
/** 所需印张数上限 */
const MAX_QUANTITY = 100000000;

function round2(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function round3(value) {
  return Math.round((value + Number.EPSILON) * 1000) / 1000;
}

function round4(value) {
  return Math.round((value + Number.EPSILON) * 10000) / 10000;
}

function floorDiv(value, divisor) {
  return Math.floor(value / divisor + FLOOR_EPS);
}

/**
 * 校验「所需印张数」：接受正整数字符串；0、负数、小数、非数字、空值一律拒绝。
 * @param {*} value
 * @returns {number}
 */
function normalizeQuantity(value) {
  const message = '所需印张数必须是大于 0 的整数';
  if (typeof value === 'string') {
    if (!/^\s*\d+\s*$/.test(value)) throw new Error(message);
    value = Number(value.trim());
  }
  if (typeof value !== 'number' || !Number.isFinite(value)
    || !Number.isInteger(value) || value <= 0) {
    throw new Error(message);
  }
  if (value > MAX_QUANTITY) {
    throw new Error(`所需印张数不能超过 ${MAX_QUANTITY.toLocaleString('en-US')}`);
  }
  return value;
}

/**
 * 从拼版方案读取裁切用印张尺寸（mm，保留 3 位小数；pt 原值一并返回）。
 * @param {object} plan X-Imposition-Plan 解码后的方案
 * @returns {{ widthMm:number, heightMm:number, widthPt:number, heightPt:number }}
 */
function readSheetSize(plan) {
  const layout = readLayout(plan);
  return {
    widthMm: round3(layout.sheetWidthPt / PT_PER_MM),
    heightMm: round3(layout.sheetHeightPt / PT_PER_MM),
    widthPt: round4(layout.sheetWidthPt),
    heightPt: round4(layout.sheetHeightPt),
  };
}

/**
 * 纸张规格二次校验：复用报价模块的规范化（1～8 种、宽高为正、费用非负），
 * 额外限制单边尺寸不超过 MAX_SIDE_MM（裁切搜索的输入边界）。
 * @param {*} rawList
 */
function normalizeCuttingPapers(rawList) {
  const specs = normalizePaperSpecs(rawList);
  for (const spec of specs) {
    if (spec.widthMm > MAX_SIDE_MM || spec.heightMm > MAX_SIDE_MM) {
      throw new Error(
        `纸张「${spec.name}」的单边尺寸不能超过 ${MAX_SIDE_MM} mm`
        + `（当前 ${spec.widthMm} × ${spec.heightMm} mm）`,
      );
    }
  }
  return specs;
}

/**
 * 直线贯通裁切搜索器（针对一种原纸 + 一种印张尺寸）。
 *
 * 内部用「长边 × 短边」规范化矩形后做记忆化：同一尺寸的子矩形只搜索一次，
 * 几何坐标按各节点自己的坐标轴方向在 materialize 阶段映射回原纸绝对坐标。
 *
 * @param {number} paperW 原纸宽 mm
 * @param {number} paperH 原纸高 mm
 * @param {number} pieceW 印张宽 mm（plan.sheet）
 * @param {number} pieceH 印张高 mm
 * @returns {{ count:number, frame:object }} 单张产出数与根帧（供 materialize）
 */
function guillotinePack(paperW, paperH, pieceW, pieceH) {
  // 入参与切线位置统一规整到 0.001 mm，保证记忆化键与几何坐标同精度
  // （plan.sheet 的 pt→mm 换算值已在 readSheetSize 中做过同样的 round3）
  paperW = round3(paperW);
  paperH = round3(paperH);
  pieceW = round3(pieceW);
  pieceH = round3(pieceH);

  const memo = new Map();
  let states = 0;
  const startedAt = Date.now();

  function failTooLarge() {
    const err = new Error(
      '裁切方案搜索规模过大（原纸与印张尺寸比例过于悬殊），已停止计算；'
      + '请确认纸张与印张尺寸无误后重试，或改用尺寸更接近的原纸',
    );
    err.code = 'search_too_large';
    throw err;
  }

  /**
   * 求解规范化矩形 L × S（L ≥ S，x 轴沿长边）。
   * 返回「裸节点」（坐标相对自身左下角），裸节点会被记忆化共享。
   */
  function g(L, S) {
    const key = `${L.toFixed(3)}/${S.toFixed(3)}`;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    states += 1;
    if (states > MAX_SEARCH_STATES || Date.now() - startedAt > SEARCH_TIME_BUDGET_MS) {
      failTooLarge();
    }

    const pieceArea = pieceW * pieceH;
    const areaBound = floorDiv(L * S, pieceArea);

    // 候选 1：整版网格（leaf），分别尝试印张原向与旋转 90°。
    // 网格摆放后右侧 / 上侧的残余条记为废料，不再下刀。
    let best = { type: 'empty', L, S, count: 0, numCuts: 0 };
    const considerLeaf = (px, py, rotated) => {
      const cols = floorDiv(L, px);
      const rows = floorDiv(S, py);
      if (cols >= 1 && rows >= 1) {
        const count = cols * rows;
        const node = {
          type: 'leaf', L, S, count, numCuts: 0,
          cols, rows, px, py, rotated,
        };
        if (better(node, best)) best = node;
      }
    };
    considerLeaf(pieceW, pieceH, false);
    considerLeaf(pieceH, pieceW, true);

    if (best.count >= areaBound) {
      memo.set(key, best);
      return best;
    }

    // 候选 2：沿长边下垂直贯通刀（canonical x 方向），切线位置只取
    // 「若干个印张边长」——刀路之外的摆法不可能产生更优分割。
    const xPositions = splitPositions(L);
    for (const p of xPositions) {
      // 乐观剪枝：两段面积上界之和都不优于当前解时直接跳过
      const optimistic = floorDiv(p * S, pieceArea)
        + floorDiv((L - p) * S, pieceArea);
      if (optimistic <= best.count) continue;
      const a = f(p, S);
      const b = f(L - p, S);
      const node = makeCut('x', L, S, p, a, b);
      if (better(node, best)) best = node;
      if (best.count >= areaBound) break;
    }

    // 候选 3：沿短边下水平贯通刀（canonical y 方向）
    if (best.count < areaBound) {
      const yPositions = splitPositions(S);
      for (const q of yPositions) {
        const optimistic = floorDiv(L * q, pieceArea)
          + floorDiv(L * (S - q), pieceArea);
        if (optimistic <= best.count) continue;
        const a = f(L, q);
        const b = f(L, S - q);
        const node = makeCut('y', L, S, q, a, b);
        if (better(node, best)) best = node;
        if (best.count >= areaBound) break;
      }
    }

    memo.set(key, best);
    return best;
  }

  /**
   * 求解任意方向矩形 w × h：规范化为长边 × 短边后调用 g，并记录该帧是否
   * 需要交换坐标轴（实际矩形为竖向时，几何映射阶段把 x/y 互换）。
   */
  function f(w, h) {
    const swapped = w + EPS_MM < h;
    const node = swapped ? g(h, w) : g(w, h);
    return { node, swapped, w, h };
  }

  /** 收集某一边长方向上所有合法切线位置（i × 印张边长，去重升序）。 */
  function splitPositions(side) {
    const positions = new Set();
    for (const d of [pieceW, pieceH]) {
      const n = floorDiv(side, d);
      for (let i = 1; i <= n; i += 1) {
        const p = round3(i * d);
        // 贴边刀（任一侧厚度为 0）没有意义
        if (p > SPLIT_MIN_MM && side - p > SPLIT_MIN_MM) positions.add(p);
      }
    }
    return Array.from(positions).sort((a, b) => a - b);
  }

  function makeCut(axis, L, S, pos, a, b) {
    return {
      type: 'cut', L, S, axis, pos, a, b,
      count: a.node.count + b.node.count,
      numCuts: 1 + a.node.numCuts + b.node.numCuts,
    };
  }

  /**
   * 解相同时优先：产出更多 → 整版网格（刀数更少）→ 总刀数更少。
   * 刀数相同时保持枚举顺序（确定性输出）。
   */
  function better(node, current) {
    if (node.count !== current.count) return node.count > current.count;
    if (node.numCuts !== current.numCuts) return node.numCuts < current.numCuts;
    return false;
  }

  const frame = f(paperW, paperH);
  return { count: frame.node.count, frame };
}

/**
 * 把记忆化裸节点展开为原纸绝对坐标数据：印张矩形列表、贯通切线列表与
 * 嵌套裁切树。坐标原点为原纸左下角（mm），SVG 渲染时再翻转 y 轴。
 *
 * @param {object} rootFrame guillotinePack 返回的根帧
 * @param {number} pieceW 印张成品宽 mm（用于旋转方向判定）
 * @param {number} pieceH 印张成品高 mm
 * @returns {{ pieces:Array, cuts:Array, tree:object }}
 */
function materialize(rootFrame, pieceW, pieceH) {
  const pieces = [];
  const cuts = [];

  function walk(frame, toAbs, depth) {
    const { node, swapped } = frame;
    // 帧内规范化坐标 -> 父帧坐标：交换轴的矩形把 (x,y) 映射为 (y,x)
    const local = swapped ? ((x, y) => toAbs(y, x)) : toAbs;
    const [x0, y0] = local(0, 0);
    const [x1, y1] = local(node.L, node.S);
    const bounds = {
      x: round2(Math.min(x0, x1)),
      y: round2(Math.min(y0, y1)),
      width: round2(Math.abs(x1 - x0)),
      height: round2(Math.abs(y1 - y0)),
    };

    if (node.type === 'empty') {
      return { type: 'empty', ...bounds, count: 0 };
    }

    if (node.type === 'leaf') {
      const leafPieces = [];
      for (let row = 0; row < node.rows; row += 1) {
        for (let col = 0; col < node.cols; col += 1) {
          const [ax, ay] = local(col * node.px, row * node.py);
          const [bx, by] = local((col + 1) * node.px, (row + 1) * node.py);
          const absWidth = Math.abs(bx - ax);
          const absHeight = Math.abs(by - ay);
          // 旋转与否按映射回原纸坐标后的实际宽高判定：实际宽高等于印张
          // (pieceH, pieceW) 即旋转了 90°；方形印张两个方向等价，恒记原向
          const isRotatedDims = Math.abs(absWidth - pieceH) <= EPS_MM
            && Math.abs(absHeight - pieceW) <= EPS_MM;
          const effectiveRotated = isRotatedDims
            && Math.abs(pieceW - pieceH) > EPS_MM;
          const piece = {
            x: round2(Math.min(ax, bx)),
            y: round2(Math.min(ay, by)),
            width: round2(absWidth),
            height: round2(absHeight),
            rotated: effectiveRotated,
          };
          pieces.push(piece);
          leafPieces.push(piece);
        }
      }
      return {
        type: 'leaf',
        ...bounds,
        count: node.count,
        cols: node.cols,
        rows: node.rows,
        pieceWidthMm: round2(node.px),
        pieceHeightMm: round2(node.py),
        piecesRotated: leafPieces.length > 0 && leafPieces.every((p) => p.rotated),
        pieces: leafPieces,
      };
    }

    // 先递归展开两个子矩形（沿轴的坐标映射经过多层交换帧后可能累计偶数次
    // 轴交换，故切线方向/端点一律以子矩形映射回原纸的真实边界为准推导，
    // 不能只凭当前帧的 swapped 奇偶判断）。
    let mapA;
    let mapB;
    if (node.axis === 'x') {
      mapA = (x, y) => local(x, y);
      mapB = (x, y) => local(node.pos + x, y);
    } else {
      mapA = (x, y) => local(x, y);
      mapB = (x, y) => local(x, node.pos + y);
    }

    const childA = walk(node.a, mapA, depth + 1);
    const childB = walk(node.b, mapB, depth + 1);

    const aRight = childA.x + childA.width;
    const aTop = childA.y + childA.height;
    let vertical;
    let from;
    let to;
    if (Math.abs(aRight - childB.x) < EPS_MM
      && Math.abs(childA.y - childB.y) < EPS_MM
      && Math.abs(aTop - (childB.y + childB.height)) < EPS_MM) {
      // 子矩形左右相邻 → 纵向贯通切线
      vertical = true;
      from = { x: round2(aRight), y: round2(childA.y) };
      to = { x: round2(aRight), y: round2(aTop) };
    } else {
      // 否则上下相邻（映射保持轴对齐，只有这两种可能）→ 横向贯通切线
      vertical = false;
      from = { x: round2(childA.x), y: round2(aTop) };
      to = { x: round2(childA.x + childA.width), y: round2(aTop) };
    }

    cuts.push({ orientation: vertical ? 'vertical' : 'horizontal', from, to, depth });

    return {
      type: 'cut',
      ...bounds,
      orientation: vertical ? 'vertical' : 'horizontal',
      positionMm: vertical ? from.x : from.y,
      depth,
      count: node.count,
      children: [childA, childB],
    };
  }

  const tree = walk(rootFrame, (x, y) => [x, y], 1);
  return { pieces, cuts, tree };
}

/**
 * 不可行方向的结构化原因：只列出真正不足（正值）的维度。
 * @param {number} shortageW 该方向摆放后宽度缺口 mm
 * @param {number} shortageH 高度缺口 mm
 */
function infeasibleReason(rotated, shortageW, shortageH) {
  const parts = [];
  if (shortageW > EPS_MM) parts.push(`宽度不足 ${round2(shortageW)} mm`);
  if (shortageH > EPS_MM) parts.push(`高度不足 ${round2(shortageH)} mm`);
  return {
    orientation: rotated ? 'rotated_90' : 'as_is',
    fits: false,
    shortageWidthMm: round2(shortageW),
    shortageHeightMm: round2(shortageH),
    message: parts.length
      ? `印张${rotated ? '旋转 90° 后' : '原向'}${parts.join('、')}`
      : `印张${rotated ? '旋转 90° 后' : '原向'}可容纳`,
  };
}

/**
 * 评估一种原纸：运行裁切搜索，返回含裁切图与数量指标的可行选项，
 * 或两个方向都放不下的不可行选项（带缺口原因）。
 */
function evaluatePaper(spec, sheet, quantity) {
  const paperInfo = {
    name: spec.name,
    widthMm: spec.widthMm,
    heightMm: spec.heightMm,
    widthPt: round4(spec.widthMm * PT_PER_MM),
    heightPt: round4(spec.heightMm * PT_PER_MM),
    pricePerSheet: spec.pricePerSheet,
    setupFee: spec.setupFee,
  };

  const { count, frame } = guillotinePack(
    spec.widthMm,
    spec.heightMm,
    sheet.widthMm,
    sheet.heightMm,
  );

  if (count === 0) {
    const asIs = infeasibleReason(
      false,
      Math.max(0, sheet.widthMm - spec.widthMm),
      Math.max(0, sheet.heightMm - spec.heightMm),
    );
    const rotated = infeasibleReason(
      true,
      Math.max(0, sheet.heightMm - spec.widthMm),
      Math.max(0, sheet.widthMm - spec.heightMm),
    );
    return {
      index: spec.index,
      name: spec.name,
      paper: paperInfo,
      feasible: false,
      reasons: [asIs, rotated],
    };
  }

  const { pieces, cuts, tree } = materialize(frame, sheet.widthMm, sheet.heightMm);
  const asIsPieces = pieces.filter((p) => !p.rotated).length;
  const rotatedPieces = pieces.length - asIsPieces;

  const pieceArea = sheet.widthMm * sheet.heightMm;
  const paperArea = spec.widthMm * spec.heightMm;
  const sheetsNeeded = Math.ceil(quantity / count);
  const producedPieces = sheetsNeeded * count;
  const surplusPieces = producedPieces - quantity;
  // 尾张：最后一张原纸实际只需要的印张数与其剩余可裁位数
  const lastSheetNeededPieces = quantity - (sheetsNeeded - 1) * count;
  const lastSheetRemainderPieces = count - lastSheetNeededPieces;

  const wasteAreaPerSheet = paperArea - count * pieceArea;
  const totalWasteArea = sheetsNeeded * paperArea - quantity * pieceArea;
  const utilization = (count * pieceArea) / paperArea;

  return {
    index: spec.index,
    name: spec.name,
    paper: paperInfo,
    feasible: true,
    piecesPerSheet: count,
    asIsPieces,
    rotatedPieces,
    sheetsNeeded,
    producedPieces,
    surplusPieces,
    lastSheetNeededPieces,
    lastSheetRemainderPieces,
    pieceAreaMm2: round2(pieceArea),
    paperAreaMm2: round2(paperArea),
    wasteAreaPerSheetMm2: round2(Math.max(0, wasteAreaPerSheet)),
    totalWasteAreaMm2: round2(Math.max(0, totalWasteArea)),
    utilization: round4(utilization),
    utilizationPercent: round2(utilization * 100),
    diagram: {
      paperWidthMm: spec.widthMm,
      paperHeightMm: spec.heightMm,
      pieces,
      cuts,
    },
    cutTree: tree,
  };
}

/**
 * 计算批量裁切下料方案。
 *
 * @param {object} plan 拼版方案（X-Imposition-Plan 解码对象）
 * @param {Array} rawPaperSpecs 用户维护的纸张规格（1～8 种）
 * @param {*} rawQuantity 所需印张数（正整数或整数字符串）
 * @returns {object} 裁切方案 JSON（无可行原纸时 feasible=false 并给出原因）
 */
function buildCuttingPlan(plan, rawPaperSpecs, rawQuantity) {
  const quantity = normalizeQuantity(rawQuantity);
  const sheet = readSheetSize(plan);
  const specs = normalizeCuttingPapers(rawPaperSpecs);

  const options = specs.map((spec) => evaluatePaper(spec, sheet, quantity));
  const feasibleOptions = options
    .filter((o) => o.feasible)
    .sort((a, b) => {
      // 推荐次序：所需原纸张数升序 → 单张废料面积升序 →
      // 原纸面积升序 → 维护顺序
      if (a.sheetsNeeded !== b.sheetsNeeded) return a.sheetsNeeded - b.sheetsNeeded;
      if (a.wasteAreaPerSheetMm2 !== b.wasteAreaPerSheetMm2) {
        return a.wasteAreaPerSheetMm2 - b.wasteAreaPerSheetMm2;
      }
      const areaA = a.paper.widthMm * a.paper.heightMm;
      const areaB = b.paper.widthMm * b.paper.heightMm;
      if (areaA !== areaB) return areaA - areaB;
      return a.index - b.index;
    });

  const result = {
    schemaVersion: 1,
    kind: 'sheet-cutting',
    tool: 'booklet-imposer',
    generatedAt: new Date().toISOString(),
    feasible: feasibleOptions.length > 0,
    quantity,
    sheet: {
      widthMm: sheet.widthMm,
      heightMm: sheet.heightMm,
      widthPt: sheet.widthPt,
      heightPt: sheet.heightPt,
    },
    options,
    recommended: feasibleOptions.length > 0 ? feasibleOptions[0] : null,
    recommendedIndex: feasibleOptions.length > 0 ? feasibleOptions[0].index : null,
  };

  if (!result.feasible) {
    result.reasonCode = 'no_cuttable_paper';
    result.reason = `印张成品尺寸为 ${sheet.widthMm} × ${sheet.heightMm} mm，维护的 `
      + `${options.length} 种原纸均无法裁出（已允许印张旋转 90°）：`
      + options
        .map((o) => {
          const asIs = o.reasons.find((r) => r.orientation === 'as_is');
          const rotated = o.reasons.find((r) => r.orientation === 'rotated_90');
          const shortText = (r) => {
            const dims = [];
            if (r.shortageWidthMm > 0) dims.push(`宽度不足 ${r.shortageWidthMm} mm`);
            if (r.shortageHeightMm > 0) dims.push(`高度不足 ${r.shortageHeightMm} mm`);
            return dims.length ? dims.join('、') : '可容纳';
          };
          return `「${o.name}」（${o.paper.widthMm} × ${o.paper.heightMm} mm）原向${shortText(asIs)}`
            + `，印张旋转 90° 后${shortText(rotated)}`;
        })
        .join('；');
  }

  return result;
}

module.exports = {
  PT_PER_MM,
  MAX_PAPER_SPECS,
  MAX_SIDE_MM,
  MAX_QUANTITY,
  MAX_SEARCH_STATES,
  normalizeQuantity,
  normalizeCuttingPapers,
  readSheetSize,
  guillotinePack,
  materialize,
  buildCuttingPlan,
};
