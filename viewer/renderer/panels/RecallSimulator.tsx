/**
 * ★ 面板 3 · **召回模拟器** —— 阶段 5 · T03/T04（设计 §7.2 面板 3 / PLAN P5-T02）。
 *
 * 四个「不得」都落在本文件上：
 *   ① ★ **无 embedder 时必须显式标注「本次未执行向量路」**，
 *      且**不得**出现「向量索引损坏」那句（`texts.ts` 里根本没有那句话）；
 *   ② ★ **明细里 `vectorPart` 恒为 0**（无 embedder ⇒ 没算查询向量 ⇒ 语义路没跑）；
 *   ③ ★ **被抑制条目单列一栏**（id / 原始 score / `redundantWith` / `redundancySim`），
 *      **绝不混进打分柱状图** —— 混进去会让人以为「五项加起来不等于 score」；
 *   ④ **不提供任何写入口**：`reinforce` 在库线程侧写死 `false`（`runRecallSimulation`），
 *      面板里连「加固」「采纳」这类按钮都没有（按钮文案白名单会拦）。
 *
 * ★ **本文件含交互层**（阶段 5 · T04 第四批）：
 *   面板 3 存在的**全部意义**就是「跑一次模拟召回」——
 *   按钮点了没反应，这个面板就是一张海报。所以：
 *     · `<textarea>` 受控（`useState` 存 `context`），`onChange` 实时同步；
 *     · 「模拟召回」按钮 `onClick` ⇒ 把当前文本**提交**（`submitted`），
 *       依赖键随之变化 ⇒ `useReadCall` 自动重发 `port.recall`（**不手写第二个请求入口**）；
 *     · ★ `reinforce` 恒为 `false`（见 `loadRecallSim()`）——
 *       用户的**每一次点击**都只是「再算一遍」，不是「采纳」。
 *
 * ⚠️ **为什么要有「还没提交」这个空态**：`recall()` 在库侧是**几百毫秒量级**的同步调用，
 *   若用 `onChange` 每敲一个字就查一次，输入一句话会发起十几次召回（每次都占满 worker 线程）。
 *   ⇒ 只有**点击提交**才发请求；未提交时渲染输入框 + 一句提示，**不发请求**。
 *   ⚠️ 实现方式是「把 `port` 传 `null` 给 `useReadCall`」：它不会调用，
 *     而我们**不渲染**那个 `loading` 状态 —— 不是靠 `loading` 冒充「还没开始」。
 *
 * ⚠️ **只读查看器默认没有 embedder**（ADR-10：库内不接模型、不读环境变量、不发网络请求）。
 *   `RecallSimResult` 因此同时给两个字段，面板**不许**把它们混为一谈：
 *     · `hasEmbedder`  —— 「这个进程有没有能力算查询向量」（能力）；
 *     · `vectorRouteRan` —— 「本次向量路跑没跑」（事实，来自 `explain.routes.vector.ran`）。
 */

import type { ReactElement } from 'react';
import { useState } from 'react';

import type { ReadPort, RecallSimInput, RecallSimResult } from '../../shared/protocol.js';
import { ScoreBars } from '../charts/ScoreBars.js';
import { StatusBlock } from '../state/StatusBlock.js';
import type { ReadState } from '../state/useReadCall.js';
import { useReadCall } from '../state/useReadCall.js';
import {
  BUTTON_RUN_RECALL,
  LAYER_LABELS,
  NOT_AVAILABLE,
  NO_BREAKDOWN_TEXT,
  NO_EMBEDDER_TEXT,
  NO_VECTOR_ROUTE_RAN,
  PANEL_TITLES,
  RECALL_EMPTY_TEXT,
  RECALL_IDLE_HINT,
  RECALL_PLACEHOLDER,
  SUPPRESSED_COLUMNS,
  SUPPRESSED_HEADING,
  formatScore,
} from '../texts.js';

/**
 * 面板 3 的读调用。
 *
 * ⚠️ ★ **`reinforce: false` 写死在这里**（不是「跟着入参走」）：`reinforce: true` 是**采纳**
 *   （会加固 topN 并写事件），属于宿主，不属于只读观察器。
 *   `RecallSimInput.reinforce` 的类型本来就是 `false`，`ipc.ts` 还有一道运行期强制
 *   —— 这里是第三道，而且它是**唯一**能被面板代码看到的那道。
 *   ⚠️ 它**不省略该键**（不写成 `{ context }`）：省略值也是 falsy，但「显式写 false」
 *     才能被断言成「这个字段被有意识地钉住了」（见 structure 测试里的捕获断言）。
 */
export async function loadRecallSim(port: ReadPort, context: string): Promise<RecallSimResult> {
  const input: RecallSimInput = { context, reinforce: false };
  return port.recall(input);
}

/** `RecallSimulatorView`（纯展示）的入参。 */
export interface RecallSimulatorViewProps {
  /** 本次召回的读状态（`idle` 时不渲染它）。 */
  readonly state: ReadState<RecallSimResult>;
  /** 注入的当前时刻（只用于文案）。 */
  readonly now: number;
  /** 输入框里的当前文本。 */
  readonly context: string;
  /** ★ 还没提交过（`true` ⇒ 渲染提示而不是状态块，**不发请求**）。 */
  readonly idle?: boolean | undefined;
  /** 输入框变化。 */
  readonly onContextChange?: ((context: string) => void) | undefined;
  /** 点了「模拟召回」。 */
  readonly onSubmit?: (() => void) | undefined;
}

/** 一个什么都不做的回调（只读渲染时的缺省值）。 */
function noop(): void {
  /* 逻辑在被单测的 `loadRecallSim` 与库线程侧 */
}

/**
 * 面板 3 的**纯展示层**。
 *
 * ⚠️ 柱状图与「被抑制」栏在**两个互不相交的 DOM 子树**里：
 *   柱状图的锚点是 `data-chart="score-bars"` + `data-memory-id`，
 *   被抑制的行用 `data-suppressed-id`。
 *   ⇒「柱状图里的 id 集合 ∩ suppressed 的 id 集合 == ∅」是一条**可正则提取**的断言，
 *     而不是靠人眼看 markup。
 */
export function RecallSimulatorView({
  state,
  now,
  context,
  idle = false,
  onContextChange,
  onSubmit,
}: RecallSimulatorViewProps): ReactElement {
  /** 输入区（空态与就绪态共用同一份，免得两处各写一遍走样）。 */
  const form = (
    <form className="recall__form">
      <label className="recall__label" htmlFor="recall-context">
        模拟对话文本
      </label>
      <textarea
        id="recall-context"
        className="recall__input"
        placeholder={RECALL_PLACEHOLDER}
        value={context}
        data-field="context-input"
        onChange={(event) => {
          (onContextChange ?? noop)(event.target.value);
        }}
      />
      <button
        className="panel__action"
        type="button"
        data-action="run-recall"
        onClick={() => {
          (onSubmit ?? noop)();
        }}
      >
        {BUTTON_RUN_RECALL}
      </button>
    </form>
  );

  // ★ 还没提交过 ⇒ 只画输入框 + 提示，**不画状态块、不发请求**
  if (idle) {
    return (
      <div
        className="panel panel--recall"
        data-panel-body="recallSimulator"
        data-now={now}
        data-recall-idle="true"
      >
        <h2 className="panel__title">{PANEL_TITLES.recallSimulator}</h2>
        {form}
        <p className="panel__empty" data-recall-hint="">
          {RECALL_IDLE_HINT}
        </p>
      </div>
    );
  }

  return (
    <StatusBlock state={state} what={PANEL_TITLES.recallSimulator}>
      {(result: RecallSimResult) => {
        const vectorRouteNoteShown = !result.hasEmbedder || !result.vectorRouteRan;
        return (
          <div
            className="panel panel--recall"
            data-panel-body="recallSimulator"
            data-now={now}
            data-recall-idle="false"
          >
            <h2 className="panel__title">{PANEL_TITLES.recallSimulator}</h2>
            {form}

            {vectorRouteNoteShown ? (
              <section className="recall__vector-note" data-vector-note="not-run">
                <p className="recall__vector-note-title" data-vector-ran="false">
                  {NO_VECTOR_ROUTE_RAN}
                </p>
                {result.hasEmbedder ? null : (
                  <p className="recall__vector-note-hint">{NO_EMBEDDER_TEXT}</p>
                )}
              </section>
            ) : (
              <p className="recall__vector-note-title" data-vector-ran="true">
                本次已执行向量路
              </p>
            )}

            {result.hits.length === 0 ? (
              <p className="panel__empty" data-hits="0">
                {RECALL_EMPTY_TEXT}
              </p>
            ) : (
              <ol className="recall__hits" data-hits={result.hits.length}>
                {result.hits.map((hit, index) => (
                  <li
                    key={hit.id}
                    className="recall__hit"
                    data-hit-id={hit.id}
                    data-rank={index + 1}
                    data-score={hit.score}
                  >
                    <h3 className="recall__hit-title">
                      第 {index + 1} 名 · {formatScore(hit.score)} · {LAYER_LABELS[hit.layer]}
                    </h3>
                    <p className="recall__hit-content" data-field="content">
                      {hit.content}
                    </p>
                    <p className="recall__hit-sources" data-field="sources">
                      来源：
                      {[
                        hit.fromText ? '文本' : null,
                        hit.fromVector ? '向量' : null,
                        hit.fromGraph ? '图谱' : null,
                      ]
                        .filter((label) => label !== null)
                        .join(' / ') || NOT_AVAILABLE}
                    </p>
                    {hit.breakdown === undefined ? (
                      <p className="panel__empty" data-field="no-breakdown">
                        {NO_BREAKDOWN_TEXT}
                      </p>
                    ) : (
                      <ScoreBars memoryId={hit.id} score={hit.score} breakdown={hit.breakdown} />
                    )}
                  </li>
                ))}
              </ol>
            )}

            <section
              className="suppressed"
              data-chart="suppressed"
              data-suppressed-count={result.suppressed.length}
            >
              <h3 className="suppressed__heading">{SUPPRESSED_HEADING}</h3>
              {result.suppressed.length === 0 ? (
                <p className="panel__empty" data-suppressed-empty="">
                  本次没有被抑制的候选
                </p>
              ) : (
                <table className="suppressed__table">
                  <thead>
                    <tr>
                      {SUPPRESSED_COLUMNS.map((column) => (
                        <th key={column}>{column}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {result.suppressed.map((item) => (
                      <tr key={item.id} data-suppressed-id={item.id}>
                        <td data-field="id">{item.id}</td>
                        <td data-field="score" data-value={item.score}>
                          {formatScore(item.score)}
                        </td>
                        <td data-field="redundantWith">{item.redundantWith ?? NOT_AVAILABLE}</td>
                        <td
                          data-field="redundancySim"
                          data-value={item.redundancySim ?? NOT_AVAILABLE}
                        >
                          {item.redundancySim === undefined
                            ? NOT_AVAILABLE
                            : formatScore(item.redundancySim)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
          </div>
        );
      }}
    </StatusBlock>
  );
}

/** `RecallSimulator`（取数容器）的入参。 */
export interface RecallSimulatorProps {
  /** 读端口（`null` ⇒ 停在加载中）。 */
  readonly port: ReadPort | null;
  /** 注入的当前时刻。 */
  readonly now: number;
  /** **初始**对话文本（之后的编辑由本面板自己的 `useState` 持有）。 */
  readonly context: string;
}

/**
 * 面板 3（取数 + 展示 + 交互）。
 *
 * ⚠️ ★ **重发请求靠「依赖键变化」，不手写请求**：
 *   只有**点击「模拟召回」**才把当前文本写进 `submitted` ⇒ `key` 变 ⇒ hook 重发。
 *   输入框的 `onChange` **只改 `context`**（不发请求）—— 每敲一个字就召回一次
 *   会把 worker 线程钉住（`recall()` 是几百毫秒的同步调用）。
 */
export function RecallSimulator({
  port,
  now,
  context: initialContext,
}: RecallSimulatorProps): ReactElement {
  const [context, setContext] = useState<string>(initialContext);
  /** `null` = 还没提交过（空态）；提交后一直是「上一次提交的文本」。 */
  const [submitted, setSubmitted] = useState<string | null>(
    initialContext.trim() === '' ? null : initialContext,
  );

  // ⚠️ 未提交时把 `port` 传 `null`：`useReadCall` 因此**不调用**（而不是发一次空查询）。
  //   那个 `loading` 状态不会被渲染（见 `idle` 分支）。
  const activePort = submitted === null ? null : port;
  const state = useReadCall<RecallSimResult>(
    activePort,
    `recall:${submitted ?? '__idle__'}`,
    (active) => loadRecallSim(active, submitted ?? ''),
  );

  return (
    <RecallSimulatorView
      state={state}
      now={now}
      context={context}
      idle={submitted === null}
      onContextChange={setContext}
      onSubmit={() => {
        // 空文本不提交（`recall()` 会以 INVALID_INPUT 拒绝，那是噪音不是信息）
        if (context.trim() === '') {
          return;
        }
        setSubmitted(context);
      }}
    />
  );
}
