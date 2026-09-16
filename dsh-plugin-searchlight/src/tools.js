/**
 * 探照灯工具层：把方法论的门禁变成模型无法绕过的工具前置条件。
 *
 * 关键设计：**每个 gate 都在写入账本之前执行**。违规不是"建议"，是工具调用失败，
 * 错误信息里带回文档条目与修复路径。模型想跳过 → 工具报错；想事后补写判据 →
 * 注册阶段没有结果字段可填。
 *
 * 模型面工具（7 个，构成一条不可跳步的流水线）：
 *   1 searchlight_init      开局：声明子领域 + H1 判据（G2）
 *   2 searchlight_run       跑实验，记录异常；反常类必须过噪声底线（G3/§1.2）
 *   3 searchlight_claim     收敛成带基线的量化陈述（§1.3）
 *   4 searchlight_occupancy 占位核查两阶段、三态输出（M3/§1.4）
 *   5 searchlight_falsifier 预注册证伪设计与判据 → 再登记结果（§1.5）
 *   6 searchlight_topic     仅当"空位成立 ∧ 证伪存活"才产出课题卡（G1/§2）
 *   7 searchlight_stop      停止规则与升级（§5/§6）
 *
 * @module @agentlab/dsh-plugin-searchlight
 */

import { defineTool } from '@deepseek-ai/dsh-tools';
import {
  ANOMALY_KINDS,
  DEFAULT_POLICY,
  GAP_CRITERIA,
  METRIC_AXES,
  OCCUPANCY_STATES,
  SELF_FALSIFICATION_QUESTIONS,
  account,
  classifyStop,
  environmentVerdict,
  gateFalsifierDesign,
  gateFalsifierResult,
  gateNoise,
  gateOccupancy,
  gateSelfFalsification,
  gateTopicPromotion,
} from './core/gates.js';
import {
  assertProjectId,
  emptyLedger,
  ledgerRoot,
  loadLedger,
  loadOrInit,
  nextId,
  pushEvent,
  saveLedger,
  summarizeLedger,
} from './core/store.js';

export const name = 'searchlight';
export const inject = ['tools'];

/** 可选配置（无默认值要求，全部有内置默认，避免加载期硬失败）。 */
export const DEFAULT_CONFIG = Object.freeze({
  workspaceRoot: null,
  ledgerDir: '.dsh-searchlight',
  ...DEFAULT_POLICY,
});

const text = (s) => [{ type: 'text', text: s }];
/**
 * 对象根 schema。注意 DSH 的 value-schema DSL **不支持** `required` 数组：
 * 必填性是每个属性上的 `required: true` 注解，这里把 required 名单翻译成注解。
 */
const obj = (properties, required = []) => {
  const withRequired = {};
  for (const [key, spec] of Object.entries(properties)) {
    withRequired[key] = required.includes(key) ? { ...spec, required: true } : spec;
  }
  return { type: 'object', properties: withRequired, additionalProperties: true };
};
const str = (description) => ({ type: 'string', description });
const num = (description) => ({ type: 'number', description });
const bool = (description) => ({ type: 'boolean', description });
const arr = (description, items = { type: 'json' }) => ({ type: 'array', description, items });

/** 统一的违规失败：带上修复路径，让模型能自我纠正而不是放弃。 */
function fail(title, violations, hint) {
  const lines = violations.map((v, i) => `  ${i + 1}. ${v}`).join('\n');
  return new Error(`${title} 被门禁拦截（${violations.length} 项）：\n${lines}\n${hint ? `\n修复路径：${hint}` : ''}`);
}

const HINT_NOISE =
  '补足同配置重复观测（至少 minReplications 次）并给出参照系；若效应量不足阈值，只能记为「噪声待查」并继续采样——不要修改阈值为通过服务。';

/**
 * 注册探照灯工具箱。
 * @param ctx - 携带 tools 注册表的 cordis 上下文
 * @param rawConfig - 部署配置（缺省即用内置策略）
 */
export function apply(ctx, rawConfig = {}) {
  const policy = { ...DEFAULT_POLICY, ...rawConfig };
  const root = ledgerRoot({ workspaceRoot: rawConfig.workspaceRoot, ledgerDir: rawConfig.ledgerDir });

  /** 读取账本：**不自动新建**。首条铁律是"实验前先声明域判据"，静默建账本会让 §2.2 的门失去落点。 */
  async function use(projectId) {
    assertProjectId(projectId);
    const existing = await loadLedger(root, projectId);
    if (!existing) {
      throw fail(
        `账本不存在：${assertProjectId(projectId)}`,
        [`尚未初始化项目「${projectId}」（查找路径 ${root}）`],
        '先调用 searchlight_init 声明子领域与 H1 判据（§2.2）——不允许未声明域判据就开始记录实验。',
      );
    }
    return { ledger: existing, created: false };
  }

  /* ---------------- 1. init ---------------- */

  ctx.tools.register(
    defineTool({
      name: 'searchlight_init',
      description:
        '初始化/读取一个探照灯项目账本，并声明当前子领域的判据。必须在任何实验记录之前调用。' +
        '按方法论 §2.2，文档中"第一代只优化速度、三个判据集体失明"是**假设 H1**，不是定律：' +
        '必须为当前子领域显式给出判据，不得沿用。domainVerified=false 时，工具会要求你先抽 N 篇代表作统计主指标分布。',
      parameters: {
        projectId: str('项目标识（字母/数字/._-，1-64 字符）'),
        subfield: str('当前子领域 S 的精确描述，例如 "vLLM 上的推测解码"'),
        representativePapers: arr('抽样的代表作（标题或链接），用于统计主指标分布'),
        speedOnlyCount: num('其中"以吞吐/延迟/加速比为唯一主结果"的篇数'),
        domainVerified: bool('是否已按 §2.2 检验步骤完成 H1 在当前子领域的检验'),
        h1Verdict: {
          type: 'string',
      enum: ['holds', 'fails', 'unknown'],
          description: 'H1 结论：holds=第一代确实对正确性/可复现性失明；fails=必须另找缝隙；unknown=尚未检验',
        },
      },
      output: {
        schema: obj({ reminder: str('域判据提醒'), summary: { type: 'json', description: '账本概览' } }, ['reminder', 'summary']),
        render: (_a, v) => text(v.reminder),
      },
      async execute(args) {
        // init 是唯一允许**新建**账本的入口；其余工具走严格 use()。
        const { ledger, created } = await loadOrInit(root, assertProjectId(args.projectId));
        const papers = args.representativePapers ?? [];
        const speedOnly = args.speedOnlyCount;

        ledger.domain = {
          subfield: args.subfield,
          representativePapers: papers,
          sampled: papers.length,
          speedOnlyCount: speedOnly,
          speedOnlyRatio: papers.length ? speedOnly / papers.length : null,
          h1Verdict: args.h1Verdict ?? 'unknown',
          verifiedAt: args.domainVerified ? new Date().toISOString() : null,
        };
        pushEvent(ledger, created ? 'project/created' : 'domain/recorded', {
          subfield: args.subfield,
          speedOnly,
          sampled: papers.length,
        });

        const reminders = [];
        if (!args.domainVerified || (args.h1Verdict ?? 'unknown') === 'unknown') {
          reminders.push(
            '⚠️ 域判据未验证：H1 是待检验假设（§2.2）。先抽该子领域最近 N 篇代表作，统计"以吞吐/延迟/加速比为唯一主结果"的比例，' +
              '再决定是否走"测量/正确性/可复现性"这条缝。未验证时不得沿用文档结论。',
          );
        }
        if (papers.length > 0 && speedOnly / papers.length < 0.5) {
          reminders.push(
            `⚠️ 抽样显示 speed-only 仅 ${speedOnly}/${papers.length}：H1 在本子领域**不成立**，` +
              '说明"正确性/可复现性"这条缝可能已被占。按 §2.1，不得用判据 (b) 冒领判据 (a) 的结论，必须另找缝隙。',
          );
        }

        await saveLedger(root, ledger);
        return {
          reminder: reminders.length ? reminders.join('\n') : '域判据已记录。',
          summary: summarizeLedger(ledger),
        };
      },
    }),
  );

  /* ---------------- 2. run ---------------- */

  ctx.tools.register(
    defineTool({
      name: 'searchlight_run',
      description:
        '记录一次实验，并登记其中的异常（§1.1 四类逐类判定，无则写"本回合无"）。' +
        '反常类（kind=anomaly）会被强制过噪声底线（§1.2）：必须给同配置重复观测，工具自行算分布与效应量；' +
        '不足阈值时**拒绝登记为反常**，只能记为「噪声待查」。任何声称的"发现"还要过自证伪四问（§4.3）。',
      parameters: {
        projectId: str('项目标识'),
        experimentId: str('实验标识'),
        command: str('可复现的命令行'),
        configPoint: str('相关配置点与取值'),
        environment: str('版本/驱动/硬件/负载'),
        rawLogPath: str('原始日志路径（报告数字必须能从中独立重算）'),
        anomalyKind: { type: 'string', enum: ['none', ...ANOMALY_KINDS], required: true, description: '本回合异常类型；none=本回合无异常' },
        phenomenon: str('现象描述，必须带数字'),
        metricName: str('指标名（精确）'),
        metricAxis: { type: 'string', enum: METRIC_AXES, description: '度量不可靠时区分：definition=定义问题；implementation=实现空桩' },
        replicates: arr('同配置下的重复观测原始值（至少 minReplications 个）', { type: 'number' }),
        unit: str('单位'),
        window: str('统计窗口与样本量（含是否含预热）'),
        reference: num('参照系：随机水平 / 前人结果 / 对照组均值'),
        referenceSd: num('参照系的离散度'),
        noiseFloor: num('显式噪声底（不给则由重复观测的离散度推出）'),
        selfFalsification: {
          type: 'object',
          additionalProperties: true,
          properties: {
            noStub: bool(SELF_FALSIFICATION_QUESTIONS[0].ask),
            singleVariable: bool(SELF_FALSIFICATION_QUESTIONS[1].ask),
            environmentExplained: bool(SELF_FALSIFICATION_QUESTIONS[2].ask),
            recomputable: bool(SELF_FALSIFICATION_QUESTIONS[3].ask),
          },
          description: '自证伪四问（§4.3）：全部为 true 才算"发现"；任一 false 降级为"待查缺陷"',
        },
        claimAsFinding: bool('是否声称这是"发现"（会强制校验自证伪四问）'),
      },
      output: {
        schema: obj(
          {
            anomalyId: str('异常编号；本回合无异常则为 null'),
            verdict: str('ok | noise-pending | noise-unchecked | defect | finding | none'),
            noise: { type: 'json', description: '分布统计' },
            effect: { type: 'json', description: '效应量' },
            message: str('处理结论与下一步'),
          },
          ['verdict', 'message'],
        ),
        render: (_a, v) => text(v.message),
      },
      async execute(args) {
        const { ledger } = await use(args.projectId);
        const expId = `EXP-${ledger.experiments.length + 1}`;
        ledger.experiments.push({
          id: expId,
          label: args.experimentId,
          at: new Date().toISOString(),
          command: args.command,
          configPoint: args.configPoint,
          environment: args.environment,
          rawLogPath: args.rawLogPath,
        });

        if (args.anomalyKind === 'none') {
          pushEvent(ledger, 'run/no-anomaly', { experiment: expId });
          await saveLedger(root, ledger);
          const zero = ledger.events.filter((e) => e.kind === 'run/no-anomaly').length;
          const extra =
            zero >= 3
              ? `\n\n⚠️ 已连续 ${zero} 次零异常（§5 出口④）：先检查**度量分辨率**是否足以看见差异，再判定"没问题"——看不见不等于不存在。`
              : '';
          return { anomalyId: null, verdict: 'none', message: `已记录实验 ${expId}：本回合四类异常逐类判定为"无"。${extra}` };
        }

        if (!args.phenomenon || !/\d/.test(args.phenomenon)) {
          throw fail('searchlight_run', ['phenomenon：现象必须带数字（印象/感觉不算，§1.1）'], '把现象改写成"X 从 A 变成 B"这类带量级的一句话。');
        }

        const draft = {
          kind: args.anomalyKind,
          replicates: args.replicates ?? [],
          reference: args.reference,
          referenceSd: args.referenceSd,
          noiseFloor: args.noiseFloor,
        };
        const noiseGate = gateNoise(draft, policy);
        const selfGate = args.claimAsFinding ? gateSelfFalsification(args.selfFalsification) : { violations: [], verdict: null };

        const violations = [...noiseGate.violations];
        if (args.claimAsFinding && selfGate.violations.length) violations.push(...selfGate.violations);

        // 反常类过不了噪声底线：拒绝登记为"反常"，给模型一条合法退路（记为噪声待查）
        if (args.anomalyKind === 'anomaly' && noiseGate.violations.length > 0) {
          const pending = {
            id: nextId(ledger, 'N', 'anomalies'),
            at: new Date().toISOString(),
            experimentId: expId,
            kind: args.anomalyKind,
            phenomenon: args.phenomenon,
            metricName: args.metricName,
            unit: args.unit,
            window: args.window,
            replicates: draft.replicates,
            noise: noiseGate.noise,
            effect: noiseGate.effect,
            status: 'noise-pending',
            gateViolations: violations,
            verdict: 'noise-pending',
          };
          ledger.anomalies.push(pending);
          pushEvent(ledger, 'anomaly/noise-pending', { id: pending.id, violations });
          await saveLedger(root, ledger);
          return {
            anomalyId: pending.id,
            verdict: 'noise-pending',
            noise: pending.noise,
            effect: pending.effect,
            message:
              `已记为「噪声待查」(${pending.id})，**不得进入占位核查**：\n` +
              violations.map((v) => `  · ${v}`).join('\n') +
              `\n\n${HINT_NOISE}`,
          };
        }

        if (violations.length) throw fail('searchlight_run', violations, HINT_NOISE);

        const gateVerdict = args.claimAsFinding ? selfGate.verdict : 'ok';
        const record = {
          id: nextId(ledger, 'A', 'anomalies'),
          at: new Date().toISOString(),
          experimentId: expId,
          kind: args.anomalyKind,
          phenomenon: args.phenomenon,
          metricName: args.metricName,
          metricAxis: args.metricAxis,
          unit: args.unit,
          window: args.window,
          replicates: draft.replicates,
          reference: args.reference,
          noise: noiseGate.noise,
          effect: noiseGate.effect,
          selfFalsification: args.selfFalsification ?? null,
          verdict: gateVerdict,
          status: gateVerdict === 'defect' ? 'defect' : 'ok',
        };
        ledger.anomalies.push(record);
        pushEvent(ledger, 'anomaly/recorded', { id: record.id, verdict: gateVerdict });
        await saveLedger(root, ledger);

        const eff = noiseGate.effect
          ? `效应量 ${noiseGate.effect.ratio.toFixed(2)}×（观测差 ${noiseGate.effect.diff.toFixed(4)}，噪声底 ${noiseGate.effect.pooled.toFixed(4)}）`
          : '非反常类，无需效应量';
        const tail =
          gateVerdict === 'defect'
            ? '\n\n⚠️ 自证伪未通过 → 记为"待查缺陷"，**不得称为发现**（§4.3：先证伪自己，再证伪别人）。'
            : args.claimAsFinding
              ? '\n\n✅ 四问通过。下一步用 searchlight_claim 收敛成带基线的量化陈述（§1.3）。'
              : '\n\n下一步用 searchlight_claim 收敛成带基线的量化陈述（§1.3）。';
        return { anomalyId: record.id, verdict: gateVerdict, noise: noiseGate.noise, effect: noiseGate.effect, message: `已登记异常 ${record.id}：${eff}${tail}` };
      },
    }),
  );

  /* ---------------- 3. claim ---------------- */

  ctx.tools.register(
    defineTool({
      name: 'searchlight_claim',
      description:
        '把异常收敛成一条**带基线与噪声底**的量化陈述（§1.3）。收敛三要求：有数字、有参照系、能推出可检验的设计含义。' +
        '缺任一项即被拒。',
      parameters: {
        projectId: str('项目标识'),
        anomalyIds: arr('引用的异常编号'),
        statement: str('一条量化陈述（一句话，含数字）'),
        baseline: str('参照系：随机水平 / 前人结果 / 对照组'),
        designImplication: str('可检验的设计含义（能推出什么实验）'),
        noiseFloorText: str('噪声底（直接引用 searchlight_run 返回的分布）'),
      },
      output: {
        schema: obj({ claimId: str('陈述编号'), message: str('结论') }, ['claimId', 'message']),
        render: (_a, v) => text(v.message),
      },
      async execute(args) {
        const { ledger } = await use(args.projectId);
        const violations = [];
        if (!/\d/.test(args.statement ?? '')) violations.push('statement：量化陈述必须含数字（§1.3）');
        if (!args.baseline?.trim()) violations.push('baseline：必须有参照系，否则无法判断量级（§1.3）');
        if (!args.designImplication?.trim()) violations.push('designImplication：必须能推出可检验的设计含义，否则只是描述（§1.3）');
        if (!args.noiseFloorText?.trim()) violations.push('noiseFloorText：必须附噪声底（§1.2）');

        const cited = (args.anomalyIds ?? []).map((id) => ledger.anomalies.find((a) => a.id === id));
        const missing = (args.anomalyIds ?? []).filter((id, i) => !cited[i]);
        if (missing.length) violations.push(`anomalyIds：账本中不存在 ${missing.join('、')}`);
        const pending = cited.filter((a) => a?.status === 'noise-pending');
        if (pending.length) {
          violations.push(
            `anomalyIds：${pending.map((a) => a.id).join('、')} 仍是「噪声待查」——未过噪声底线者不得进入量化陈述（§1.2）`,
          );
        }
        if (violations.length) throw fail('searchlight_claim', violations, '先补采样/参照系，或用 searchlight_run 继续记录异常。');

        const claim = {
          id: nextId(ledger, 'C', 'claims'),
          at: new Date().toISOString(),
          anomalyIds: args.anomalyIds,
          statement: args.statement,
          baseline: args.baseline,
          noiseFloorText: args.noiseFloorText,
          designImplication: args.designImplication,
        };
        ledger.claims.push(claim);
        pushEvent(ledger, 'claim/recorded', { id: claim.id });

        // 同一批异常自动开一个候选，进入占位核查
        const candidate = {
          id: `CAND-${ledger.candidates.length + 1}`,
          createdAt: new Date().toISOString(),
          claimId: claim.id,
          claim: args.statement,
          baseline: args.baseline,
          occupancy: null,
          falsifiers: [],
          budget: { falsifiersDesigned: 0, exceeded: false },
          status: 'occupancy-pending',
        };
        ledger.candidates.push(candidate);
        pushEvent(ledger, 'candidate/created', { id: candidate.id, claimId: claim.id });
        await saveLedger(root, ledger);

        return {
          claimId: claim.id,
          message:
            `已记录量化陈述 ${claim.id}，并自动开候选 ${candidate.id}。\n` +
            '下一步：searchlight_occupancy 做阶段一存在性检索（≤1h，三通道），只允许输出三态（§1.4）。',
        };
      },
    }),
  );

  /* ---------------- 4. occupancy ---------------- */

  ctx.tools.register(
    defineTool({
      name: 'searchlight_occupancy',
      description:
        '占位核查（§1.4 两阶段 / §2.1 两套判据）。阶段一存在性检索输出三态：none / partial / quantitative；' +
        '状态为 partial/quantitative 时必须做阶段二，回答"占据了框架的人解决了问题吗"。' +
        '**覆盖不到在审/闭源层时，空位结论只能是"在本 agent 可见范围内未被占"**——检索盲区不是空位。',
      parameters: {
        projectId: str('项目标识'),
        candidateId: str('候选编号（如 CAND-1）'),
        channels: arr('检索通道：引用图谱 / 预印本按日期 / 在审库'),
        state: { type: 'string', enum: OCCUPANCY_STATES, required: true, description: '阶段一三态' },
        occupyingWork: str('占据方做了什么（状态为 partial/quantitative 时必填，阶段二要读其方法与评测）'),
        solved: bool('占据了框架的人解决了问题吗（阶段二必答）'),
        solvedEvidence: str('该判断的依据'),
        criterion: { type: 'string', enum: GAP_CRITERIA, required: true, description: '(a) 旧问题未被解决=上位判据，须真读过占据文献；(b) 角度被忽视=下位启发式' },
        visibility: {
          type: 'object',
          additionalProperties: true,
          properties: {
            inReview: bool('是否可检索在审稿件库'),
            closedSource: bool('是否可见闭源/工业内部工作'),
          },
          description: '检索覆盖范围（决定结论措辞强度）',
        },
      },
      output: {
        schema: obj({ verdict: str('空位判定'), message: str('结论与下一步'), mustQualify: bool('结论是否必须限定为"可见范围内"') }, ['verdict', 'message']),
        render: (_a, v) => text(v.message),
      },
      async execute(args) {
        const { ledger } = await use(args.projectId);
        const candidate = ledger.candidates.find((c) => c.id === args.candidateId);
        if (!candidate) throw fail('searchlight_occupancy', [`candidateId：账本中不存在 ${args.candidateId}`], '先用 searchlight_claim 建立候选。');

        const check = {
          searchedAt: new Date().toISOString(),
          channels: args.channels,
          state: args.state,
          occupyingWork: args.occupyingWork,
          solved: args.solved,
          solvedEvidence: args.solvedEvidence,
          criterion: args.criterion,
          visibility: args.visibility ?? {},
        };
        const gate = gateOccupancy(check);
        if (gate.violations.length) {
          throw fail(
            'searchlight_occupancy',
            gate.violations,
            '状态为 partial/quantitative 时必须补 occupyingWork 与 solved（阶段二）；判据 (a) 必须读过占据文献。',
          );
        }

        candidate.occupancy = { ...check, verdict: gate.verdict, mustQualify: gate.mustQualify };
        candidate.status = gate.verdict === 'solved' ? 'closed-solved' : 'falsifier-pending';
        pushEvent(ledger, 'occupancy/recorded', { candidateId: candidate.id, verdict: gate.verdict });
        await saveLedger(root, ledger);

        const lines = [`候选 ${candidate.id} 空位判定：**${gate.verdict}**`];
        if (gate.mustQualify) {
          lines.push(
            `\n⚠️ 检索覆盖不到 ${[
              args.visibility?.inReview ? null : '在审库',
              args.visibility?.closedSource ? null : '闭源层',
            ]
              .filter(Boolean)
              .join(' / ')}：结论必须写成「${gate.requiredWording}」`,
          );
        }
        if (gate.verdict === 'solved') {
          lines.push('\n结论：问题已被解决 → 放弃该候选，不得升级为课题（§1.4）。');
        } else if (gate.verdict === 'occupied-but-unsolved') {
          lines.push(
            '\n✅ 这是最有价值的原料："第一代已被做，但问题没被解决"（§2）。下一步：searchlight_falsifier 设计**最便宜的、能杀死它的**证伪实验，并先写死判据。',
          );
        } else {
          lines.push(
            '\n下一步：searchlight_falsifier。注意判据 (b) 的便宜标准不得冒领判据 (a) 的结论（§2.1）。',
          );
        }
        return { verdict: gate.verdict, mustQualify: gate.mustQualify, message: lines.join('\n') };
      },
    }),
  );

  /* ---------------- 5. falsifier ---------------- */

  ctx.tools.register(
    defineTool({
      name: 'searchlight_falsifier',
      description:
        '两段式：先 action=design 预注册"能杀死候选的最便宜实验 + 继续/停止判据 + 成本上界 + 可证伪性说明"，' +
        '**此阶段不允许出现任何结果字段**；实验跑完后 action=resolve 登记结果（必须带数字证据）。' +
        '这是 §1.5 的预注册强制点：判据必须先于数据写死。',
      parameters: {
        projectId: str('项目标识'),
        candidateId: str('候选编号'),
        action: { type: 'string', enum: ['design', 'resolve'], required: true, description: 'design=登记设计与判据；resolve=登记结果' },
        method: str('(design) 能杀死该候选的最便宜实验'),
        successCriterion: str('(design) 继续判据（预先写死）'),
        stopCriterion: str('(design) 停止判据（预先写死）'),
        costBudget: str('(design) 成本上界（算力/时间）'),
        killPower: str('(design) 什么样的观测会与主张不一致——没有这一条就是表演性证伪'),
        falsifierId: str('(resolve) 目标证伪编号，如 SL-F1'),
        result: { type: 'string', enum: ['survived', 'killed', 'inconclusive'], description: '(resolve) 结论' },
        evidence: str('(resolve) 带数字的证据'),
      },
      output: {
        schema: obj({ falsifierId: str('证伪编号'), message: str('结论与下一步') }, ['falsifierId', 'message']),
        render: (_a, v) => text(v.message),
      },
      async execute(args) {
        const { ledger } = await use(args.projectId);
        const candidate = ledger.candidates.find((c) => c.id === args.candidateId);
        if (!candidate) throw fail('searchlight_falsifier', [`candidateId：账本中不存在 ${args.candidateId}`], '先建立候选并完成占位核查。');
        if (!candidate.occupancy) {
          throw fail('searchlight_falsifier', ['该候选尚未做占位核查（§1.4）——不得跳过占位直接证伪'], '先调用 searchlight_occupancy。');
        }

        if (args.action === 'design') {
          // 门禁必须看**模型原样提交的全部字段**：曾经在这里只挑 5 个字段构造 design，
          // 结果 result/evidence 等结果字段在被门禁看到之前就被丢掉了，预注册门形同虚设。
          const design = { ...args };
          const gate = gateFalsifierDesign(design);
          if (gate.violations.length) {
            throw fail(
              'searchlight_falsifier(design)',
              gate.violations,
              '判据与成本上界必须现在写死；killPower 要说明"什么观测会与主张不一致"。',
            );
          }
          // 预算门：超限只能升级，不能继续设计（§6）
          const acc = account({ candidate, policy });
          if (acc.budget.exceeded) {
            candidate.budget.exceeded = true;
            pushEvent(ledger, 'candidate/escalated', { candidateId: candidate.id, reason: acc.events[0]?.reason });
            await saveLedger(root, ledger);
            throw fail(
              'searchlight_falsifier(design)',
              [`该候选已用满 ${policy.maxFalsifiers} 次证伪实验且未存活 —— 已标记 escalated`],
              '按 §6：不得自行封存或继续重跑，必须升级给人类决策。用 searchlight_stop 生成升级报告。',
            );
          }

          const record = {
            id: `SL-F${candidate.falsifiers.length + 1}`,
            candidateId: candidate.id,
            status: 'designed',
            registeredAt: new Date().toISOString(),
            // 写入账本时只保留设计字段（门禁已在上面看过原样 args）
            design: {
              method: args.method,
              successCriterion: args.successCriterion,
              stopCriterion: args.stopCriterion,
              costBudget: args.costBudget,
              killPower: args.killPower,
            },
          };
          candidate.falsifiers.push(record);
          candidate.budget.falsifiersDesigned = candidate.falsifiers.length;
          candidate.status = 'falsifier-running';
          pushEvent(ledger, 'falsifier/designed', { id: record.id, candidateId: candidate.id });
          await saveLedger(root, ledger);
          return {
            falsifierId: record.id,
            message:
              `已**先于数据**注册 ${record.id}（预注册时间戳 ${record.registeredAt}）：\n` +
              `  继续判据：${record.design.successCriterion}\n  停止判据：${record.design.stopCriterion}\n  成本上界：${record.design.costBudget}\n\n` +
              '现在去跑这个实验。跑完用 action=resolve 登记结果——**不得回头修改上述判据**。',
          };
        }

        // resolve
        const target = candidate.falsifiers.find((f) => f.id === args.falsifierId);
        if (!target) {
          const known = candidate.falsifiers.map((f) => f.id).join('、') || '（无）';
          throw fail('searchlight_falsifier(resolve)', [`falsifierId：候选内不存在 ${args.falsifierId}（已有：${known}）`], '先 action=design 注册。');
        }
        if (target.status === 'resolved') {
          throw fail('searchlight_falsifier(resolve)', [`${target.id} 已登记过结果（${target.result}）——不得覆盖，需要新证据请新开一次证伪实验`], '用 action=design 注册新的证伪实验。');
        }
        const gate = gateFalsifierResult({ result: args.result, evidence: args.evidence, registeredAt: target.registeredAt });
        if (gate.violations.length) throw fail('searchlight_falsifier(resolve)', gate.violations, '结果必须带数字证据。');

        target.status = 'resolved';
        target.result = args.result;
        target.evidence = args.evidence;
        target.resolvedAt = new Date().toISOString();
        candidate.budget.falsifiersRun = candidate.falsifiers.filter((f) => f.status === 'resolved').length;

        const acc = account({ candidate, policy });
        candidate.budget.exceeded = acc.budget.exceeded;
        candidate.status =
          args.result === 'survived' ? 'survived' : args.result === 'killed' ? 'killed' : candidate.status;
        pushEvent(ledger, 'falsifier/resolved', { id: target.id, result: args.result });

        // 连续 K 个候选全灭 → 环境判定（§6）
        const env = environmentVerdict(ledger, policy);

        await saveLedger(root, ledger);

        const lines = [`${target.id} 结果：**${args.result}**`];
        if (args.result === 'survived') {
          lines.push('\n✅ 活过预注册证伪。下一步：searchlight_topic 产出课题卡（§2）。');
        } else if (args.result === 'killed') {
          lines.push('\n候选被杀死 —— 归档负结果，不是失败（§1.5）。');
          if (acc.budget.exceeded) lines.push(acc.events.map((e) => `⚠️ ${e.reason}`).join('\n'));
        } else {
          lines.push('\n结论不确定：按 §5 分类——若是"测量不可靠"，属重跑型，**不得封存**。');
        }
        if (env.stop) lines.push(`\n🛑 ${env.message}`);
        return { falsifierId: target.id, message: lines.join('\n') };
      },
    }),
  );

  /* ---------------- 6. topic ---------------- */

  ctx.tools.register(
    defineTool({
      name: 'searchlight_topic',
      description:
        '产出课题卡（§2 / §7.3）。这是"假设 ≠ 结论"的落地点：**只有 [空位成立] ∧ [预注册证伪存活] ∧ [预算未超] 三者同时满足**才允许产出。' +
        '任一不满足即被拒——未被证伪的候选只是假设。',
      parameters: {
        projectId: str('项目标识'),
        candidateId: str('候选编号'),
        title: str('课题标题'),
        knownRisks: str('已知风险 / 未知变量'),
        budgetRequest: str('预算申请（算力 / 时间 / 次数）'),
      },
      output: {
        schema: obj({ topicId: str('课题编号'), card: { type: 'json', description: '课题卡' }, message: str('结论') }, ['message']),
        render: (_a, v) => text(v.message),
      },
      async execute(args) {
        const { ledger } = await use(args.projectId);
        const candidate = ledger.candidates.find((c) => c.id === args.candidateId);
        if (!candidate) throw fail('searchlight_topic', [`candidateId：账本中不存在 ${args.candidateId}`], '先走完前置流水线。');

        const gate = gateTopicPromotion({ occupancy: candidate.occupancy, falsifiers: candidate.falsifiers, budget: candidate.budget, policy });
        if (!gate.ok) {
          throw fail(
            'searchlight_topic',
            gate.violations,
            '按顺序补齐：searchlight_occupancy（三态）→ searchlight_falsifier(design) → 跑实验 → searchlight_falsifier(resolve)。' +
              '禁止把未经证伪的假设写成课题（§0 铁律 1）。',
          );
        }

        const anomalies = (ledger.claims.find((c) => c.id === candidate.claimId)?.anomalyIds ?? [])
          .map((id) => ledger.anomalies.find((a) => a.id === id))
          .filter(Boolean)
          .map((a) => ({ id: a.id, kind: a.kind, phenomenon: a.phenomenon, effect: a.effect?.ratio ?? null, noise: a.noise }));
        const survived = candidate.falsifiers.filter((f) => f.result === 'survived');

        const card = {
          topicId: `TOPIC-${ledger.topics.length + 1}`,
          title: args.title,
          anomaly: anomalies,
          quantifiedClaim: candidate.claim,
          baseline: candidate.baseline,
          gapVerdict: gate.evidence.gapVerdict,
          gapWording: gate.evidence.requiredWording,
          occupancy: candidate.occupancy,
          falsifiers: survived.map((f) => ({ id: f.id, design: f.design, evidence: f.evidence, registeredAt: f.registeredAt })),
          knownRisks: args.knownRisks,
          budgetRequest: args.budgetRequest,
          createdAt: new Date().toISOString(),
        };
        card.topicId = card.topicId;
        ledger.topics.push(card);
        candidate.status = 'promoted';
        pushEvent(ledger, 'topic/promoted', { topicId: card.topicId, candidateId: candidate.id });
        await saveLedger(root, ledger);

        const wording = card.gapWording ? `\n空位措辞（必须原样使用）：${card.gapWording}` : '';
        return {
          topicId: card.topicId,
          card,
          message:
            `✅ 课题卡 ${card.topicId}「${card.title}」已产出。\n` +
            `证据链：异常 ${anomalies.map((a) => a.id).join('、')} → 陈述 ${candidate.claimId} → 空位 ${card.gapVerdict} → 证伪存活 ${survived.map((f) => f.id).join('、')}${wording}\n\n` +
            '按 §6：申请下一步预算，**不得自行扩大规模**。',
        };
      },
    }),
  );

  /* ---------------- 7. stop ---------------- */

  ctx.tools.register(
    defineTool({
      name: 'searchlight_stop',
      description:
        '停止规则与升级（§5 / §6）。**四类必须分开**：① 封存型（数据容量耗尽）② 重跑型（测量不可靠，不得封存）' +
        '③ 扩容型（需新变量/新规模，转资源申请）④ 零异常出口（先查度量分辨率）。' +
        '禁止自行封存候选：封存是不可逆决定。action=overview 只读，用于开局恢复上下文。',
      parameters: {
        projectId: str('项目标识'),
        action: { type: 'string', enum: ['overview', 'classify', 'escalate'], required: true, description: 'overview=只读概览；classify=判定停止类型；escalate=生成升级报告' },
        measurementUnreliable: bool('(classify) 测量是否不可靠'),
        needsNewVariables: bool('(classify) 是否需要数据中不存在的新变量'),
        variablesAbsentFromData: bool('(classify) 该变量确实不在现有数据中'),
        noDecisionChanges: bool('(classify) 下一次分析不会改变任何决定'),
        onlyFinerVersion: bool('(classify) 只能得到同一结论的更细版本'),
        zeroAnomaliesRounds: num('(classify) 连续零异常轮数'),
        candidateId: str('(escalate) 目标候选'),
        reason: str('(escalate) 升级原因'),
      },
      output: {
        schema: obj({ kind: str('判定类型'), sealing: bool('是否可封存'), guidance: str('指引'), summary: { type: 'json', description: '账本概览' } }, ['kind', 'guidance']),
        render: (_a, v) => text(`${v.guidance}${v.message ? `\n\n${v.message}` : ''}`),
      },
      async execute(args) {
        const { ledger } = await use(args.projectId);

        if (args.action === 'overview') {
          const env = environmentVerdict(ledger, policy);
          const open = ledger.candidates
            .filter((c) => c.status !== 'promoted' && c.status !== 'closed-solved')
            .map((c) => {
              const next = !c.occupancy
                ? 'searchlight_occupancy'
                : !c.falsifiers.length
                  ? 'searchlight_falsifier(design)'
                  : c.falsifiers.some((f) => f.status === 'designed')
                    ? '跑实验 → searchlight_falsifier(resolve)'
                    : c.falsifiers.some((f) => f.result === 'survived')
                      ? 'searchlight_topic'
                      : 'searchlight_falsifier(design)（或按 §6 升级）';
              return `  · ${c.id}｜${c.claim}\n    空位=${c.occupancy?.verdict ?? '未做'}｜证伪=${c.falsifiers.length} 次｜预算超限=${c.budget?.exceeded ? '是' : '否'}\n    下一步：${next}`;
            })
            .join('\n');
          return {
            kind: 'overview',
            sealing: false,
            guidance: `项目 ${ledger.projectId}｜子领域：${ledger.domain?.subfield ?? '未声明'}｜H1 判据：${ledger.domain?.h1Verdict ?? 'unknown'}`,
            summary: summarizeLedger(ledger),
            message: open ? `\n未结候选：\n${open}${env.stop ? `\n\n🛑 ${env.message}` : ''}` : '\n无未结候选。',
          };
        }

        if (args.action === 'classify') {
          const verdict = classifyStop({
            measurementUnreliable: args.measurementUnreliable,
            needsNewVariables: args.needsNewVariables,
            variablesAbsentFromData: args.variablesAbsentFromData,
            noDecisionChanges: args.noDecisionChanges,
            onlyFinerVersion: args.onlyFinerVersion,
            zeroAnomaliesRounds: args.zeroAnomaliesRounds ?? 0,
          });
          pushEvent(ledger, 'stop/classified', verdict);
          await saveLedger(root, ledger);
          const guard =
            verdict.sealing === true
              ? '\n\n⚠️ 封存型命中，但按 §6 **agent 不得自行封存候选**：请生成升级报告，由人类确认。'
              : '';
          return { ...verdict, summary: summarizeLedger(ledger), message: guard };
        }

        // escalate：生成给人看的报告，不改变候选状态（人类才可封存）
        const candidate = ledger.candidates.find((c) => c.id === args.candidateId);
        const report = {
          at: new Date().toISOString(),
          candidateId: args.candidateId ?? null,
          reason: args.reason ?? '未说明',
          candidate: candidate
            ? {
                id: candidate.id,
                claim: candidate.claim,
                occupancy: candidate.occupancy?.verdict ?? null,
                falsifiers: candidate.falsifiers.map((f) => ({ id: f.id, status: f.status, result: f.result ?? null })),
                budget: candidate.budget,
              }
            : null,
          ledgerSummary: summarizeLedger(ledger),
        };
        pushEvent(ledger, 'escalation/raised', { candidateId: args.candidateId, reason: args.reason });
        await saveLedger(root, ledger);
        return {
          kind: 'escalated',
          sealing: false,
          guidance:
            '已生成升级报告（写入账本 events，未改变候选状态）。\n' +
            '**封存/放弃/扩容的决定由人类做出**——agent 不得自行封存不可逆的候选（§6）。',
          summary: summarizeLedger(ledger),
          message: `\n升级原因：${report.reason}\n候选：${args.candidateId ?? '（未指定）'}`,
        };
      },
    }),
  );
}
