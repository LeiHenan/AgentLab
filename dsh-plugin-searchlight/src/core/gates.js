/**
 * 探照灯工作法 · 纯逻辑核心
 *
 * 本模块是方法论的可执行形式：每个 gate 返回违规列表，空数组 = 通过。
 * 不依赖 DSH / cordis / 任何第三方包，因此可以被逐条单测。
 *
 * 设计原则（对应文档）：
 *   G1  假设 ≠ 结论      → 只有活过预注册证伪的候选才能升级为课题卡
 *   G2  H1 是假设        → 领域判据必须显式声明，不预设
 *   G3  噪声底线         → 异常必须有多点重复 + 3× 效应量
 *   M2  先证伪自己       → 自证伪四问未过，不得称为"发现"
 *   M3  占位核查两阶段   → 三态输出；可见范围内才说"未被占"
 *   M6  禁止自封课题     → 超预算只能升级给人，不能自行 kill
 *
 * @module searchlight/gates
 */

/** 异常类型（文档 §1.1） */
export const ANOMALY_KINDS = ['failure', 'anomaly', 'metric-broken', 'unmeasurable'];

/** 度量不可靠的两轴（文档 §1.1） */
export const METRIC_AXES = ['definition', 'implementation'];

/** 占位核查阶段一三态（文档 §1.4） */
export const OCCUPANCY_STATES = ['none', 'partial', 'quantitative'];

/** 空位判定（文档 §1.4 / §2） */
export const GAP_VERDICTS = ['occupied-but-unsolved', 'unoccupied-in-visible-range', 'solved'];

/** 空位判据（文档 §2.1） */
export const GAP_CRITERIA = ['a-old-problem-unsolved', 'b-angle-neglected'];

/** 证伪结论（文档 §1.5） */
export const FALSIFIER_RESULTS = ['survived', 'killed', 'inconclusive'];

/** 探照灯内置策略默认值（文档 §6） */
export const DEFAULT_POLICY = Object.freeze({
  /** §1.2 重复下限 */
  minReplications: 3,
  /** §1.2 效应量下限（标准化效应量 d） */
  minEffectSize: 3,
  /** §6 单候选证伪实验次数上限 */
  maxFalsifiers: 3,
  /** §6 连续 K 个候选全灭 → 报告环境不产空位 */
  consecutiveKillsToStop: 3,
  /** 证伪设计的最低区分度：需说明"什么观测会与主张不一致" */
  minKillPowerChars: 40,
});

/* ------------------------------------------------------------------ *
 * 数值工具
 * ------------------------------------------------------------------ */

/** 均值；空数组返回 undefined。 */
export function mean(xs) {
  if (!Array.isArray(xs) || xs.length === 0) return undefined;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** 样本标准差（n-1）；少于 2 个点返回 undefined。 */
export function stdev(xs) {
  if (!Array.isArray(xs) || xs.length < 2) return undefined;
  const m = mean(xs);
  const v = xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(v);
}

/** 合并两组重复观测的统计量。 */
export function summarize(replicates) {
  const m = mean(replicates);
  const sd = stdev(replicates);
  return {
    n: replicates.length,
    mean: m,
    sd: sd ?? 0,
    min: Math.min(...replicates),
    max: Math.max(...replicates),
  };
}

/**
 * 效应量。同时给出两种口径，因为"3×"在两种口径下含义不同：
 *  - ratio: 观测差 / 噪声底（噪声底 = 两组重复观测的合并标准差；若显式给了 noiseFloor 则用它）
 *  - d:     Cohen's d（观测差 / 合并标准差）—— 当噪声底就是合并标准差时，两者相等
 * 缺标准差时退化为"无法判定"，宁可判不可判定，也不要假通过。
 */
export function effectSize({ observed, reference, observedSd, referenceSd, noiseFloor }) {
  const diff = observed - reference;
  const absDiff = Math.abs(diff);
  const pooled = (() => {
    if (typeof noiseFloor === 'number' && noiseFloor > 0) return noiseFloor;
    const parts = [observedSd, referenceSd].filter((v) => typeof v === 'number' && v >= 0);
    if (parts.length === 0) return undefined;
    return Math.max(...parts);
  })();
  if (typeof pooled !== 'number' || pooled === 0) {
    return { diff, absDiff, pooled: pooled ?? null, ratio: null, d: null, resolvable: false };
  }
  return {
    diff,
    absDiff,
    pooled,
    ratio: absDiff / pooled,
    d: absDiff / pooled,
    resolvable: true,
  };
}

/* ------------------------------------------------------------------ *
 * 门 1：噪声底线（文档 §1.2 + G3）
 * ------------------------------------------------------------------ */

/**
 * 噪声底线门。任何要做成陈述的异常都必须过此门，否则只能记为"噪声待查"。
 * @param candidate - 形如 { replicates, phenomenon, ... } 的异常草稿
 * @param policy - 策略（默认 DEFAULT_POLICY）
 * @returns {{violations: string[], noise: object|null, effect: object|null, verdict: string}}
 */
export function gateNoise(candidate, policy = DEFAULT_POLICY) {
  const violations = [];
  const reps = candidate.replicates;

  if (!Array.isArray(reps) || reps.length === 0) {
    violations.push(
      'replicates：缺少重复观测（文档 §1.2 要求同配置下重复采样并报分布，不允许单点值）',
    );
    return { violations, noise: null, effect: null, verdict: 'noise-unchecked' };
  }
  if (reps.some((v) => typeof v !== 'number' || !Number.isFinite(v))) {
    violations.push('replicates：存在非有限数值');
  }
  if (reps.length < policy.minReplications) {
    violations.push(
      `replicates：至少 ${policy.minReplications} 次重复，当前 ${reps.length} 次（文档 §1.2）`,
    );
  }

  const noise = summarize(reps);

  const isAnomaly = candidate.kind === 'anomaly';
  if (!isAnomaly) {
    // 非"反常"类不需要参照系，但仍须报分布
    return { violations, noise, effect: null, verdict: violations.length ? 'noise-unchecked' : 'ok' };
  }

  if (typeof candidate.reference !== 'number' || !Number.isFinite(candidate.reference)) {
    violations.push(
      'reference：反常必须给出参照系（随机水平 / 前人结果 / 对照组均值），否则无法判断量级（文档 §1.3）',
    );
    return { violations, noise, effect: null, verdict: 'noise-unchecked' };
  }

  const effect = effectSize({
    observed: noise.mean,
    reference: candidate.reference,
    observedSd: noise.sd,
    referenceSd: typeof candidate.referenceSd === 'number' ? candidate.referenceSd : undefined,
    noiseFloor: typeof candidate.noiseFloor === 'number' ? candidate.noiseFloor : undefined,
  });

  if (!effect.resolvable) {
    violations.push(
      'noiseFloor：无法解析噪声底（需要重复观测的离散度，或显式给出 noiseFloor），效应量不可判定',
    );
    return { violations, noise, effect, verdict: 'noise-unchecked' };
  }
  if (effect.ratio < policy.minEffectSize) {
    violations.push(
      `效应量：${effect.ratio.toFixed(2)}× < ${policy.minEffectSize}×（文档 §1.2：不足者不得称为"反常"，只能记为"噪声待查"）`,
    );
    return { violations, noise, effect, verdict: 'noise-pending' };
  }

  return {
    violations,
    noise,
    effect,
    verdict: violations.length ? 'noise-unchecked' : 'ok',
  };
}

/* ------------------------------------------------------------------ *
 * 门 2：自证伪四问（文档 §4.3）
 * ------------------------------------------------------------------ */

export const SELF_FALSIFICATION_QUESTIONS = [
  { key: 'noStub', ask: '度量路径里是否存在空桩/占位实现（返回 None、默认值、常量、未通电分支）被当成真实值？' },
  { key: 'singleVariable', ask: '对照组是否真的只差一个变量？' },
  { key: 'environmentExplained', ask: '异常能否由环境差异解释（版本、驱动、并行度、缓存状态、负载）？' },
  { key: 'recomputable', ask: '报告数字能否从原始日志独立重算出来？' },
];

/**
 * 自证伪门。四问必须逐条回答；任何一条为 false 即降级为"待查缺陷"，不得称"发现"。
 */
export function gateSelfFalsification(answers) {
  const violations = [];
  if (answers === null || typeof answers !== 'object') {
    violations.push('selfFalsification：必须先回答自证伪四问（文档 §4.3）');
    return { violations, verdict: 'not-a-finding' };
  }
  for (const q of SELF_FALSIFICATION_QUESTIONS) {
    const v = answers[q.key];
    if (typeof v !== 'boolean') {
      violations.push(`selfFalsification.${q.key}：必须明确回答 true/false（${q.ask}）`);
    }
  }
  if (violations.length) return { violations, verdict: 'not-a-finding' };
  const failed = SELF_FALSIFICATION_QUESTIONS.filter((q) => answers[q.key] === false);
  if (failed.length) {
    violations.push(
      `自证伪未通过：${failed.map((q) => q.key).join('、')} —— 降级为"待查缺陷"，不得称为"发现"（文档 §4.3：先证伪自己，再证伪别人）`,
    );
    return { violations, verdict: 'defect' };
  }
  return { violations, verdict: 'finding' };
}

/* ------------------------------------------------------------------ *
 * 门 3：占位核查（文档 §1.4 / §2 / M3）
 * ------------------------------------------------------------------ */

/**
 * 占位核查门 —— 本框架最核心的一条诚实规则：
 * 检索盲区不是空位。只要覆盖不到在审/闭源层，结论只能是"在可见范围内未被占"。
 */
export function gateOccupancy(check) {
  const violations = [];
  if (!check || typeof check !== 'object') {
    violations.push('occupancy：缺少占位核查记录');
    return { violations, verdict: null };
  }

  const { state, visibility = {}, occupyingWork, criterion, solved } = check;

  if (!OCCUPANCY_STATES.includes(state)) {
    violations.push(`occupancy.state：必须是 ${OCCUPANCY_STATES.join(' / ')} 之一（文档 §1.4 阶段一三态）`);
  }
  if (!check.searchedAt) {
    violations.push('occupancy.searchedAt：必须记录检索时间戳（结论只在某个时间点有效）');
  }
  if (!Array.isArray(check.channels) || check.channels.length === 0) {
    violations.push('occupancy.channels：必须记录检索通道（引用图谱 / 预印本按日期 / 在审库）');
  }
  if (!GAP_CRITERIA.includes(criterion)) {
    violations.push(`occupancy.criterion：必须声明判据 ${GAP_CRITERIA.join(' / ')}（文档 §2.1）`);
  }

  const coversInReview = visibility.inReview === true;
  const coversClosed = visibility.closedSource === true;

  // 三态决定是否需要阶段二
  if (state === 'quantitative' || state === 'partial') {
    if (typeof occupyingWork !== 'string' || occupyingWork.trim().length === 0) {
      violations.push('occupancy.occupyingWork：占据方做了什么必须写明（阶段二输入）');
    } else if (occupyingWork.trim().length < 20) {
      violations.push('occupancy.occupyingWork：过短，至少写清占据方做了什么（阶段二要求读其方法与评测）');
    }
    if (typeof solved !== 'boolean') {
      violations.push('occupancy.solved：必须回答"占据了框架的人解决了问题吗"（文档 §1.4 阶段二）');
    }
  }

  // 判据 (a) 必须真读过占据文献；判据 (b) 不得冒领 (a) 的结论
  if (criterion === 'a-old-problem-unsolved' && state === 'none') {
    violations.push(
      'occupancy：声明判据 (a)"旧问题未被解决"却检索结果为"无人做" —— 判据 (a) 必须读过占据文献（文档 §2.1）',
    );
  }

  let verdict = null;
  if (violations.length === 0) {
    if (state === 'quantitative' && solved === true) verdict = 'solved';
    else if (state === 'quantitative' && solved === false) verdict = 'occupied-but-unsolved';
    else if (state === 'partial' && solved === true) verdict = 'solved';
    else if (state === 'partial') verdict = 'occupied-but-unsolved';
    else if (coversInReview && coversClosed) verdict = 'unoccupied-in-visible-range';
    else verdict = 'unoccupied-in-visible-range';
  }

  // 关键诚实规则：可见范围受限时，必须降级措辞
  const limitedVisibility = !(coversInReview && coversClosed);
  const mustQualify = limitedVisibility && verdict === 'unoccupied-in-visible-range';

  return {
    violations,
    verdict,
    /** 是否必须把结论写成"在本 agent 可见范围内未被占" */
    mustQualify,
    requiredWording: mustQualify
      ? '在本 agent 可见范围内未被占（覆盖不到在审/闭源层，检索盲区不是空位）'
      : null,
  };
}

/* ------------------------------------------------------------------ *
 * 门 4：证伪实验（文档 §1.5 / §5 / §6 —— 预注册）
 * ------------------------------------------------------------------ */

/** 只登记"设计与判据"：此阶段不允许出现任何结果字段，这就是预注册的强制点。 */
export function gateFalsifierDesign(design) {
  const violations = [];
  if (!design || typeof design !== 'object') {
    violations.push('falsifier：缺少证伪实验设计');
    return { violations };
  }
  const forbidden = ['result', 'outcome', 'observed', 'conclusion', 'verdict'];
  const leaked = forbidden.filter((k) => design[k] !== undefined);
  if (leaked.length) {
    violations.push(
      `falsifier：注册阶段不得包含结果字段（${leaked.join('、')}）—— 判据必须先于数据写死（文档 §1.5）`,
    );
  }
  if (typeof design.method !== 'string' || design.method.trim().length === 0) {
    violations.push('falsifier.method：必须描述"能杀死候选的最便宜实验"');
  }
  if (typeof design.successCriterion !== 'string' || design.successCriterion.trim().length === 0) {
    violations.push('falsifier.successCriterion：继续判据必须预先写死');
  }
  if (typeof design.stopCriterion !== 'string' || design.stopCriterion.trim().length === 0) {
    violations.push('falsifier.stopCriterion：停止判据必须预先写死');
  }
  if (typeof design.costBudget !== 'string' || design.costBudget.trim().length === 0) {
    violations.push('falsifier.costBudget：必须给出成本上界（文档 §0 要求"验证计划 + 成本上界 + 停止判据"）');
  }
  if (typeof design.killPower !== 'string' || design.killPower.trim().length < DEFAULT_POLICY.minKillPowerChars) {
    violations.push(
      `falsifier.killPower：必须说明什么样的观测会与主张不一致（至少 ${DEFAULT_POLICY.minKillPowerChars} 字）—— 否则这是表演性证伪`,
    );
  }
  return { violations };
}

/** 登记结果：必须带证据数字。 */
export function gateFalsifierResult(record) {
  const violations = [];
  if (!FALSIFIER_RESULTS.includes(record?.result)) {
    violations.push(`falsifier.result：必须是 ${FALSIFIER_RESULTS.join(' / ')} 之一`);
  }
  if (typeof record?.evidence !== 'string' || record.evidence.trim().length === 0) {
    violations.push('falsifier.evidence：必须给出带数字的证据（印象/感觉不算）');
  } else if (!/\d/.test(record.evidence)) {
    violations.push('falsifier.evidence：未包含任何数字 —— 证据必须带数字');
  }
  if (!record?.registeredAt) {
    violations.push('falsifier：结果必须在设计登记之后填写（缺失注册时间戳，无法证明预注册）');
  }
  return { violations };
}

/* ------------------------------------------------------------------ *
 * 门 5：课题升级（文档 §2 / G1 —— 假设 ≠ 结论）
 * ------------------------------------------------------------------ */

/**
 * 课题升级门。这是"禁止把假设当结论"的落地点：
 * 只有 [空位成立] ∧ [证伪存活] ∧ [预算未超] 三者同时满足，才允许产出课题卡。
 */
export function gateTopicPromotion({ occupancy, falsifiers = [], budget = {}, policy = DEFAULT_POLICY }) {
  const violations = [];
  const occ = gateOccupancy(occupancy);
  if (occ.violations.length) violations.push(...occ.violations.map((v) => `[占位] ${v}`));

  if (occ.verdict === 'solved') {
    violations.push('[占位] 空位判定为"已被解决（放弃）"—— 不得升级为课题（文档 §1.4）');
  }
  const survived = falsifiers.filter((f) => f.status === 'resolved' && f.result === 'survived');
  if (survived.length === 0) {
    violations.push('[证伪] 没有任何"预注册且存活"的证伪实验 —— 未过证伪的候选只是假设，不是课题（文档 §0 G1）');
  }
  if (budget.exceeded === true) {
    violations.push('[预算] 该候选已超预算 —— 只能升级给人类决策，不得自行产出课题（文档 §6）');
  }

  return {
    violations,
    ok: violations.length === 0,
    evidence: {
      gapVerdict: occ.verdict,
      requiredWording: occ.requiredWording,
      survivedFalsifiers: survived.map((f) => f.id),
    },
  };
}

/* ------------------------------------------------------------------ *
 * 预算账本与停止规则（文档 §5 / §6）
 * ------------------------------------------------------------------ */

/**
 * 记账 + 升级判定。消耗一律计入；超限只能升级，不能自行封存。
 */
export function account({ candidate, policy = DEFAULT_POLICY }) {
  const falsifiers = (candidate.falsifiers ?? []).filter((f) => f.status === 'resolved');
  const designCount = (candidate.falsifiers ?? []).length;
  const events = [];

  const exceeded = designCount >= policy.maxFalsifiers && !falsifiers.some((f) => f.result === 'survived');
  if (exceeded) {
    events.push({
      kind: 'escalate',
      reason: `证伪实验已达上限 ${policy.maxFalsifiers} 次且未存活 —— 强制升级给人类，禁止自行封存（文档 §6）`,
    });
  }
  return {
    falsifiersRun: falsifiers.length,
    falsifiersDesigned: designCount,
    budget: { maxFalsifiers: policy.maxFalsifiers, exceeded },
    events,
  };
}

/**
 * 停止规则判定（文档 §5）。四类必须分开，不得合并成"停"一个动作。
 */
export function classifyStop(situation) {
  if (situation?.measurementUnreliable === true) {
    return {
      kind: 'rerun',
      sealing: false,
      guidance: '② 重跑型：测量不可靠 —— 不得封存，必须换度量或修测量路径后重跑（文档 §5）',
    };
  }
  if (situation?.needsNewVariables === true && situation?.variablesAbsentFromData !== false) {
    return {
      kind: 'expand',
      sealing: false,
      guidance:
        '③ 扩容型：当前数据容量已尽但已明确下一步需要什么新变量/新规模 —— 转入资源申请，不得当作问题已死（文档 §5）',
    };
  }
  if (situation?.noDecisionChanges === true || situation?.onlyFinerVersion === true) {
    return {
      kind: 'seal',
      sealing: true,
      guidance: '① 封存型：数据容量耗尽 —— 整理为可公开产物，写明能回答什么/不能回答什么（文档 §5）',
    };
  }
  if (situation?.zeroAnomaliesRounds >= 1) {
    return {
      kind: 'resolution-check',
      sealing: false,
      guidance:
        '④ 零异常出口：先检查度量分辨率是否足以看见差异，再判定"没问题" —— 看不见不等于不存在（文档 §5）',
    };
  }
  return { kind: 'continue', sealing: false, guidance: '未触发停止规则，继续循环。' };
}

/**
 * 连续 K 个候选全灭 → 报告环境不产空位，而不是继续换方向硬找（文档 §6）。
 */
export function environmentVerdict(ledger, policy = DEFAULT_POLICY) {
  const tail = (ledger?.candidates ?? []).slice(-policy.consecutiveKillsToStop);
  const allKilled =
    tail.length === policy.consecutiveKillsToStop &&
    tail.every((c) => (c.falsifiers ?? []).some((f) => f.result === 'killed'));
  return allKilled
    ? {
        stop: true,
        message: `连续 ${policy.consecutiveKillsToStop} 个候选全部被证伪杀死 —— 报告「本环境在当前条件下不产出空位」，停止换方向硬找（文档 §6）`,
      }
    : { stop: false, message: null };
}
