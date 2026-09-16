/**
 * 探照灯插件离线验证：在 Node 里直接跑工具层（不启动 DSH）。
 *
 * 覆盖两类：**正常路径必须走得通**，以及**违规路径必须被门禁拦住**——
 * 后者才是这个插件的存在意义（方法论从"建议"变成"工具报错"）。
 *
 * 运行：node test/probe.mjs
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../src/tools.js';
import * as gates from '../src/core/gates.js';

let pass = 0;
let fail = 0;
const failures = [];

function check(label, condition, detail = '') {
  if (condition) {
    pass += 1;
    console.log(`  ✅ ${label}`);
  } else {
    fail += 1;
    failures.push(label);
    console.log(`  ❌ ${label}${detail ? `\n       ${detail}` : ''}`);
  }
}

/** 假 ctx：只实现 tools.register，够用来驱动工具。 */
function harness(config = {}) {
  const registry = new Map();
  const ctx = { tools: { register: (def) => { registry.set(def.name, def); return () => registry.delete(def.name); } } };
  apply(ctx, config);
  return registry;
}

const exec = { callId: 'c1', signal: new AbortController().signal };

/** 调工具：返回 { ok, value, error }。 */
async function call(registry, name, args) {
  const tool = registry.get(name);
  if (!tool) throw new Error(`工具未注册：${name}`);
  try {
    return { ok: true, value: await tool.execute(args, exec) };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

/** 期望被拦：返回错误信息。 */
async function expectBlocked(registry, name, args, label, mustMention) {
  const r = await call(registry, name, args);
  const mentioned = !mustMention || (r.ok === false && r.error.includes(mustMention));
  check(`${label}${mustMention ? `（提到"${mustMention}"）` : ''}`, r.ok === false && mentioned, r.ok ? '未被拦截！' : `错误信息未提及关键词：${r.error.slice(0, 160)}`);
  return r;
}

/** 期望通过。 */
async function expectOk(registry, name, args, label) {
  const r = await call(registry, name, args);
  check(label, r.ok === true, r.ok ? '' : `被拦截：${r.error.slice(0, 240)}`);
  return r;
}

const root = await mkdtemp(join(tmpdir(), 'searchlight-'));
const P = 'demo';
const base = { projectId: P };
const MINIMAL_KILL_POWER =
  '若在相同配置下重复 5 次仍有 ≥3 次观测到该差异，则与"差异由噪声造成"的主张不一致，本候选应被杀死。';

console.log('\n== 第 0 部分：纯逻辑门禁（gates.js）==');
{
  const g = gates.gateNoise({ kind: 'anomaly', replicates: [1, 2], reference: 3 });
  check('重复不足 3 次被拦', g.violations.some((v) => v.includes('至少 3 次')), JSON.stringify(g.violations));

  const g2 = gates.gateNoise({ kind: 'anomaly', replicates: [100, 101, 102], reference: 100 });
  check('效应量不足被判 noise-pending', g2.verdict === 'noise-pending', `verdict=${g2.verdict}`);

  const g3 = gates.gateNoise({ kind: 'anomaly', replicates: [100, 102, 104, 106], reference: 10 });
  check('效应量充足判 ok', g3.verdict === 'ok' && g3.effect.ratio > 3, `ratio=${g3.effect?.ratio}`);

  check('缺参照系被拦', gates.gateNoise({ kind: 'anomaly', replicates: [1, 2, 3] }).violations.some((v) => v.includes('参照系')));

  const sf = gates.gateSelfFalsification({ noStub: true, singleVariable: true, environmentExplained: true, recomputable: false });
  check('自证伪任一 false → 降级 defect', sf.verdict === 'defect' && sf.violations.length === 1);

  const occLimited = gates.gateOccupancy({
    searchedAt: 'x', channels: ['引用图谱'], state: 'none', criterion: 'b-angle-neglected', visibility: {},
  });
  check('覆盖不到在审/闭源 → 必须限定措辞', occLimited.mustQualify === true && occLimited.verdict === 'unoccupied-in-visible-range');
  check('限定措辞文案正确', /可见范围内未被占/.test(occLimited.requiredWording ?? ''));

  const occFull = gates.gateOccupancy({
    searchedAt: 'x', channels: ['引用图谱'], state: 'none', criterion: 'b-angle-neglected',
    visibility: { inReview: true, closedSource: true },
  });
  check('全覆盖时无需限定措辞', occFull.mustQualify === false);

  check('判据 (a) + 无人做 → 被拦', gates.gateOccupancy({ searchedAt: 'x', channels: ['c'], state: 'none', criterion: 'a-old-problem-unsolved' }).violations.some((v) => v.includes('判据 (a)')));
  check('partial 缺 solved → 被拦', gates.gateOccupancy({ searchedAt: 'x', channels: ['c'], state: 'partial', criterion: 'b-angle-neglected', occupyingWork: '有人做了一个框架但只报了吞吐' }).violations.some((v) => v.includes('solved')));

  check('预注册阶段出现结果字段 → 被拦', gates.gateFalsifierDesign({ method: 'm', successCriterion: 's', stopCriterion: 't', costBudget: 'c', killPower: MINIMAL_KILL_POWER, result: 'survived' }).violations.some((v) => v.includes('结果字段')));
  check('killPower 过短 → 被拦', gates.gateFalsifierDesign({ method: 'm', successCriterion: 's', stopCriterion: 't', costBudget: 'c', killPower: '短' }).violations.some((v) => v.includes('killPower')));
  check('结果证据无数字 → 被拦', gates.gateFalsifierResult({ result: 'survived', evidence: '看起来没问题', registeredAt: 'x' }).violations.some((v) => v.includes('数字')));

  check('停止规则：测量不可靠 → 不得封存', gates.classifyStop({ measurementUnreliable: true }).sealing === false);
  check('停止规则：数据容量耗尽 → 可封存', gates.classifyStop({ noDecisionChanges: true }).sealing === true);
  check('停止规则：需新变量 → 扩容型', gates.classifyStop({ needsNewVariables: true, variablesAbsentFromData: true }).kind === 'expand');
  check('停止规则：零异常 → 先查分辨率', gates.classifyStop({ zeroAnomaliesRounds: 3 }).kind === 'resolution-check');
}

console.log('\n== 第 1 部分：正常路径 ==');
const registry = harness({ workspaceRoot: root, minReplications: 3, minEffectSize: 3, maxFalsifiers: 3 });
{
  await expectBlocked(registry, 'searchlight_run', { ...base, experimentId: 'e0', command: 'x', anomalyKind: 'none' }, '未 init 就写账本', '账本');

  const init = await expectOk(registry, 'searchlight_init', {
    ...base, subfield: 'vLLM 推测解码', representativePapers: ['p1', 'p2', 'p3', 'p4'], speedOnlyCount: 4,
    domainVerified: true, h1Verdict: 'holds',
  }, 'init 记录域判据');
  check('H1 holds 时无警告', init.ok && !/未验证/.test(init.value.reminder));

  await expectOk(registry, 'searchlight_run', { ...base, experimentId: 'e1', command: './bench --n 1024', anomalyKind: 'none' }, '记录"本回合无异常"');

  const noise = await expectOk(registry, 'searchlight_run', {
    ...base, experimentId: 'e2', command: './bench --n 2048', anomalyKind: 'anomaly',
    phenomenon: '补丁在 1024 修好、在 2048 弄坏：2048 下精度从 0.91 掉到 0.62',
    metricName: 'accuracy', unit: 'ratio', window: '256 请求，含预热',
    replicates: [0.61, 0.62, 0.63, 0.62], reference: 0.91, referenceSd: 0.004,
    selfFalsification: { noStub: true, singleVariable: true, environmentExplained: true, recomputable: true },
    claimAsFinding: true,
  }, '反常过噪声底线 + 自证伪四问');
  check('反常登记为发现', noise.ok && noise.value.verdict === 'finding', JSON.stringify(noise.value));
  const anomalyId = noise.value.anomalyId;

  const pending = await expectOk(registry, 'searchlight_run', {
    ...base, experimentId: 'e3', command: './bench --n 512', anomalyKind: 'anomaly',
    phenomenon: '512 下延迟从 10ms 变成 10.2ms', metricName: 'p50', replicates: [10.0, 10.1, 10.2, 10.1], reference: 10.0,
  }, '效应量不足 → 退化为"噪声待查"而非硬通过');
  check('标为 noise-pending', pending.ok && pending.value.verdict === 'noise-pending');
  const pendingId = pending.value.anomalyId;

  await expectBlocked(registry, 'searchlight_claim', { ...base, anomalyIds: [pendingId], statement: '1 条陈述 10.2', baseline: 'b', designImplication: 'd', noiseFloorText: 'n' }, '噪声待查不得进入量化陈述', '噪声待查');

  const claim = await expectOk(registry, 'searchlight_claim', {
    ...base, anomalyIds: [anomalyId], statement: '在 2048 上下文下精度相对基线下降 0.29（0.91→0.62）',
    baseline: '同配置 1024 上下文 = 0.91', designImplication: '若为参数相关效应，应在 1024/2048 之间单调', noiseFloorText: 'run-to-run sd=0.008',
  }, '量化陈述三要求齐备');
  const candidateId = 'CAND-1';

  const occ = await expectOk(registry, 'searchlight_occupancy', {
    ...base, candidateId, channels: ['引用图谱', '预印本按日期'], state: 'partial',
    occupyingWork: '第一代工作给出了 1024 下的修复补丁并以吞吐为唯一主结果，未报 2048 的行为',
    solved: false, solvedEvidence: '其评测只覆盖到 1024，未见长上下文数字', criterion: 'a-old-problem-unsolved',
    visibility: { inReview: false, closedSource: false },
  }, '占位核查阶段二：框架已占但问题未解决');
  check('判定 occupied-but-unsolved', occ.ok && occ.value.verdict === 'occupied-but-unsolved');
  // 注意：限定措辞只管"未被占"这一类。已占但未解决是更强的结论，不该被降级。
  check('已占但未解决无需限定措辞', occ.ok && occ.value.mustQualify === false, JSON.stringify(occ.value));
  check('框架已占的结论不得被降级为"可见范围内"', occ.ok && !/可见范围/.test(occ.value.message), occ.ok ? occ.value.message.slice(0, 120) : '');

  // "无人做" + 覆盖不到在审/闭源层 → 必须降级措辞（M3 的关键诚实规则）
  await expectOk(registry, 'searchlight_claim', {
    ...base, anomalyIds: [anomalyId], statement: '第二候选：2048 下接受率相对基线下降 0.18（0.72→0.54）',
    baseline: '同配置 1024 上下文 = 0.72', designImplication: '若与上下文长度相关则应单调', noiseFloorText: 'sd=0.006',
  }, '第二个候选的量化陈述');
  const occNone = await expectOk(registry, 'searchlight_occupancy', {
    ...base, candidateId: 'CAND-2', channels: ['引用图谱'], state: 'none', criterion: 'b-angle-neglected',
    visibility: { inReview: false, closedSource: false },
  }, '阶段一：无人做（但覆盖不到在审/闭源）');
  check('"无人做"必须降级为"可见范围内未被占"', occNone.ok && occNone.value.mustQualify === true);
  check('降级措辞出现在结论里', occNone.ok && /可见范围内未被占/.test(occNone.value.message), occNone.ok ? occNone.value.message.slice(0, 160) : '');

  await expectBlocked(registry, 'searchlight_topic', { ...base, candidateId, title: '提前升级', knownRisks: 'r', budgetRequest: 'b' }, '未证伪就升级课题（G1 铁律）', '证伪');

  const design = await expectOk(registry, 'searchlight_falsifier', {
    ...base, candidateId, action: 'design', method: '同配置下在 1024/2048 各重复 5 次并交叉换补丁',
    successCriterion: '若 2048 的下降在交叉后随补丁走 → 效应真实，继续',
    stopCriterion: '若下降随机器/顺序走 → 归因错误，停止', costBudget: '≤1 天，8 次运行',
    killPower: MINIMAL_KILL_POWER,
  }, '预注册证伪设计与判据');
  const falsifierId = design.value.falsifierId;

  await expectBlocked(registry, 'searchlight_falsifier', {
    ...base, candidateId, action: 'design', method: 'm2', successCriterion: 's', stopCriterion: 't', costBudget: 'c', killPower: MINIMAL_KILL_POWER,
    result: 'survived', evidence: '事后补的数字 0.61',
  }, '把结果/证据塞进设计阶段（预注册门）', '结果字段');

  await expectOk(registry, 'searchlight_falsifier', {
    ...base, candidateId, action: 'resolve', falsifierId, result: 'survived',
    evidence: '2048 下降复现 5/5 次（0.62±0.008），交叉换补丁后随补丁迁移，机器与顺序无影响',
  }, '登记证伪结果（带数字证据）');

  await expectBlocked(registry, 'searchlight_falsifier', {
    ...base, candidateId, action: 'resolve', falsifierId, result: 'killed', evidence: '再跑一次 0.61',
  }, '同一证伪不得覆盖结果', '不得覆盖');

  const topic = await expectOk(registry, 'searchlight_topic', {
    ...base, candidateId, title: '长上下文下推测解码的静默精度漂移：测量与归因', knownRisks: '依赖具体补丁实现', budgetRequest: '2 天 GPU',
  }, '存活后产出课题卡');
  check('课题卡含证据链', topic.ok && topic.value.card.anomaly.length === 1 && topic.value.card.falsifiers.length === 1);
  // CAND-1 的判定是"框架已占但问题未解决"——这是更强的结论，不该被降级措辞覆盖
  check('已占未解决的课题卡不带"可见范围"降级措辞', topic.ok && topic.value.card.gapWording === null, JSON.stringify(topic.value.card.gapWording));

  // CAND-2 走完整条链：验证"可见范围内未被占"这类**受限结论的措辞必须被带进课题卡**
  const d2 = await expectOk(registry, 'searchlight_falsifier', {
    ...base, candidateId: 'CAND-2', action: 'design', method: '交叉换补丁并重复采样',
    successCriterion: '若下降随补丁迁移 → 继续', stopCriterion: '若与补丁无关 → 停止', costBudget: '≤1 天',
    killPower: MINIMAL_KILL_POWER,
  }, 'CAND-2 预注册');
  await expectOk(registry, 'searchlight_falsifier', {
    ...base, candidateId: 'CAND-2', action: 'resolve', falsifierId: d2.value.falsifierId, result: 'survived',
    evidence: '接受率下降复现 5/5 次（0.54±0.004），换机器不变，交叉后随补丁迁移',
  }, 'CAND-2 证伪存活');
  const topic2 = await expectOk(registry, 'searchlight_topic', {
    ...base, candidateId: 'CAND-2', title: '接受率作为判据的失明区：长上下文下的静默退化', knownRisks: '依赖实现', budgetRequest: '3 天',
  }, '受限结论也能产出课题卡');
  check('课题卡保留"可见范围内未被占"的限定措辞', topic2.ok && /可见范围内未被占/.test(topic2.value.card.gapWording ?? ''), JSON.stringify(topic2.value.card.gapWording));
  check('产出时正文也带限定措辞', topic2.ok && /必须原样使用/.test(topic2.value.message));

  const overview = await expectOk(registry, 'searchlight_stop', { ...base, action: 'overview' }, 'overview 恢复上下文');
  check('overview 显示课题', overview.ok && overview.value.summary.topics.length === 2);

  const stop = await expectOk(registry, 'searchlight_stop', { ...base, action: 'classify', measurementUnreliable: true }, '停止规则：测量不可靠');
  check('重跑型不得封存', stop.ok && stop.value.sealing === false);

  const seal = await expectOk(registry, 'searchlight_stop', { ...base, action: 'classify', noDecisionChanges: true }, '停止规则：容量耗尽');
  check('封存型需人类确认', seal.ok && seal.value.sealing === true && /不得自行封存/.test(seal.value.message));

  const esc = await expectOk(registry, 'searchlight_stop', { ...base, action: 'escalate', candidateId, reason: '需要人类决定是否扩容到 A100' }, '升级报告');
  check('升级不改变候选状态', esc.ok && esc.value.kind === 'escalated');
}

console.log('\n== 第 2 部分：预算与升级（maxFalsifiers=1）==');
{
  const r2 = harness({ workspaceRoot: root, maxFalsifiers: 1 });
  const P2 = 'budget';
  await call(r2, 'searchlight_init', { projectId: P2, subfield: 's', representativePapers: [], speedOnlyCount: 0, domainVerified: true, h1Verdict: 'holds' });
  await call(r2, 'searchlight_run', {
    projectId: P2, experimentId: 'e1', anomalyKind: 'anomaly', command: 'c',
    phenomenon: '精度从 0.90 掉到 0.50', replicates: [0.5, 0.5, 0.5], reference: 0.9, referenceSd: 0.001,
  });
  await call(r2, 'searchlight_claim', { projectId: P2, anomalyIds: ['SL-A1'], statement: '下降 0.4（0.90→0.50）', baseline: '0.90', designImplication: 'd', noiseFloorText: 'sd=0' });
  await call(r2, 'searchlight_occupancy', {
    projectId: P2, candidateId: 'CAND-1', channels: ['c'], state: 'none', criterion: 'b-angle-neglected', visibility: { inReview: true, closedSource: true },
  });
  const d1 = await expectOk(r2, 'searchlight_falsifier', {
    projectId: P2, candidateId: 'CAND-1', action: 'design', method: 'm', successCriterion: 's', stopCriterion: 't', costBudget: 'c', killPower: MINIMAL_KILL_POWER,
  }, '第 1 次证伪设计放行');
  await expectOk(r2, 'searchlight_falsifier', { projectId: P2, candidateId: 'CAND-1', action: 'resolve', falsifierId: d1.value.falsifierId, result: 'killed', evidence: '复现 0/5 次，效应消失（0.90±0.002）' }, '结果：被杀死');

  await expectBlocked(r2, 'searchlight_falsifier', {
    projectId: P2, candidateId: 'CAND-1', action: 'design', method: 'm', successCriterion: 's', stopCriterion: 't', costBudget: 'c', killPower: MINIMAL_KILL_POWER,
  }, '超预算 → 强制升级，不得继续重跑', '升级给人类');

  await expectBlocked(r2, 'searchlight_topic', { projectId: P2, candidateId: 'CAND-1', title: 't', knownRisks: 'r', budgetRequest: 'b' }, '被杀死/超预算的候选不得升级');

  const ov = await call(r2, 'searchlight_stop', { projectId: P2, action: 'overview' });
  check('overview 标记预算超限', ov.ok && ov.value.summary.candidates.some((c) => c.budgetExceeded === true));

  // 连续 K 个候选全灭 → 环境判定
  const ledgerLike = { candidates: [{ falsifiers: [{ result: 'killed' }] }, { falsifiers: [{ result: 'killed' }] }, { falsifiers: [{ result: 'killed' }] }] };
  const env = gates.environmentVerdict(ledgerLike, gates.DEFAULT_POLICY);
  check('连续 3 个候选全灭 → 报告环境不产空位', env.stop === true && /不产出空位/.test(env.message));
}

console.log('\n== 第 3 部分：H1 域判据门（G2）==');
{
  const r3 = harness({ workspaceRoot: root });
  const bad = await call(r3, 'searchlight_init', {
    projectId: 'h1fail', subfield: '数据库事务', representativePapers: ['p1', 'p2', 'p3', 'p4'], speedOnlyCount: 0,
    domainVerified: true, h1Verdict: 'fails',
  });
  check('H1 不成立时警告"另找缝隙"', bad.ok && /不成立/.test(bad.value.reminder), bad.ok ? bad.value.reminder : bad.error);

  const unverified = await call(r3, 'searchlight_init', {
    projectId: 'h1unk', subfield: 'x', representativePapers: [], speedOnlyCount: 0, domainVerified: false, h1Verdict: 'unknown',
  });
  check('H1 未验证时要求先做检验步骤', unverified.ok && /未验证/.test(unverified.value.reminder));
}

await rm(root, { recursive: true, force: true });

console.log(`\n${'='.repeat(60)}`);
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
if (fail > 0) {
  console.log('失败清单：');
  for (const f of failures) console.log(`  · ${f}`);
  process.exit(1);
}
console.log('全部门禁按预期工作。');
