/**
 * 探照灯账本：工作区内的 JSON 持久化。
 *
 * 选文件而不是会话日志，是为了让 agent 每次开局都能用 read 直接看到完整状态
 * （会话日志对模型不可见，账本可见才是"跨轮次记忆"）。写入采用 write-temp+rename，
 * 避免并发工具调用把账本写坏。
 *
 * @module searchlight/store
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/** 账本目录名（位于工作区根下）。 */
export const LEDGER_DIRNAME = '.dsh-searchlight';

/** 从配置解析账本根目录。 */
export function ledgerRoot(config = {}) {
  const base = config.workspaceRoot && config.workspaceRoot.trim() !== '' ? config.workspaceRoot : process.cwd();
  return resolve(base, config.ledgerDir ?? LEDGER_DIRNAME);
}

/** 项目 ID 白名单校验（同时充当路径安全校验）。 */
export function assertProjectId(id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id)) {
    throw new Error(
      `projectId 非法：${JSON.stringify(id)}（只允许字母/数字/._-，长度 1-64，且不得以符号开头）`,
    );
  }
  return id;
}

/** 账本文件路径。 */
export function ledgerPath(root, projectId) {
  return join(root, `${assertProjectId(projectId)}.json`);
}

/** 空账本。 */
export function emptyLedger(projectId) {
  return {
    version: 1,
    projectId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    /** 领域判据（G2：H1 是假设，必须显式声明当前子领域结论） */
    domain: null,
    experiments: [],
    anomalies: [],
    claims: [],
    /** 候选 = 一条待验证的主张（文档 §0：假设 ≠ 结论） */
    candidates: [],
    topics: [],
    events: [],
  };
}

/** 读取账本；不存在则返回 null（由调用方决定是否报错）。 */
export async function loadLedger(root, projectId) {
  const file = ledgerPath(root, projectId);
  if (!existsSync(file)) return null;
  const raw = await readFile(file, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (cause) {
    throw new Error(`账本 JSON 损坏：${file} —— ${cause.message}`);
  }
}

/** 原子写入账本。 */
export async function saveLedger(root, ledger) {
  const file = ledgerPath(root, ledger.projectId);
  await mkdir(dirname(file), { recursive: true });
  ledger.updatedAt = new Date().toISOString();
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8');
  await rename(tmp, file);
  return file;
}

/** 读取或初始化。 */
export async function loadOrInit(root, projectId) {
  const existing = await loadLedger(root, projectId);
  if (existing) return { ledger: existing, created: false };
  return { ledger: emptyLedger(assertProjectId(projectId)), created: true };
}

/** 生成带前缀的短 ID，如 SL-A1、SL-C2、SL-F3。 */
export function nextId(ledger, prefix, collection) {
  const n = (ledger[collection]?.length ?? 0) + 1;
  return `SL-${prefix}${n}`;
}

/** 记一条账本事件（时间线，便于人审计）。 */
export function pushEvent(ledger, kind, detail) {
  ledger.events.push({ at: new Date().toISOString(), kind, detail });
}

/** 概览：给模型和人都能一眼看懂的状态摘要。 */
export function summarizeLedger(ledger) {
  const cands = ledger.candidates.map((c) => {
    const survived = (c.falsifiers ?? []).filter((f) => f.result === 'survived').length;
    const killed = (c.falsifiers ?? []).filter((f) => f.result === 'killed').length;
    return {
      id: c.id,
      claim: c.claim,
      gap: c.occupancy?.verdict ?? null,
      falsifiers: { designed: (c.falsifiers ?? []).length, survived, killed },
      budgetExceeded: c.budget?.exceeded === true,
      status: c.status,
    };
  });
  return {
    projectId: ledger.projectId,
    domain: ledger.domain,
    counts: {
      experiments: ledger.experiments.length,
      anomalies: ledger.anomalies.length,
      claims: ledger.claims.length,
      candidates: ledger.candidates.length,
      topics: ledger.topics.length,
    },
    candidates: cands,
    topics: ledger.topics.map((t) => ({ id: t.id, title: t.title, candidateId: t.candidateId })),
  };
}
