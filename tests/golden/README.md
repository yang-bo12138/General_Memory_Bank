# golden 集（JSONL · D-08）

> 决策出处：DEVELOPMENT-PLAN.md D-08 ——「**JSONL**（每行一条 query→id 序列，便于 diff 与增量追加）」。

## 为什么是 JSONL

整份 JSON 重新序列化后键序可能变化 ⇒ diff 全红 ⇒ 噪声淹没信号。
一行一条 ⇒ 两次运行之间只改动的那一行，在 diff 里一眼可见。

## 文件结构

```
{"kind":"meta","label":"<本次运行的标识>","flags":{…},"params":{…}}
{"kind":"record","op":"write","args":{…},"output":{…}}
{"kind":"record","op":"recall","args":{…},"output":{…}}
…
```

| 行类型      | 含义                                                                 | 是否参与比对 |
| ----------- | -------------------------------------------------------------------- | ------------ |
| `meta`      | 本次运行用的**机制开关**与**全量参数**（固定排在第一行）              | **否**        |
| `record`    | 一次可观测操作的 `op` / `args` / `output`                              | **是**        |

⚠️ **`meta` 行不参与比对**——两次运行的 `meta` 行**本来就该不同**
（这正是「四开关全关 + `VECTOR_ROUTER='flat'`」与「单开一个开关」的差别所在）。
把它一起比对，会让「开关不同」这件事掩盖「输出是否逐位相同」这个真问题。

⚠️ 记录一律用**规范化 JSON**（键排序、无空白）⇒ 比对是**逐位**的，
且与对象字面量的书写顺序无关（否则「逐位一致」会假失败）。

## 采集

```bash
pnpm exec tsx scripts/capture-golden.ts \
  --out tests/golden/__captured__/baseline.jsonl \
  --adapter tests/fixtures/adapters/deterministic.ts \
  --flags baseline
```

| 参数       | 说明                                                                        |
| ---------- | --------------------------------------------------------------------------- |
| `--out`    | 输出路径（JSONL）                                                           |
| `--adapter` | 适配器模块路径；该模块必须导出 `createAdapter(): RefV1Adapter`               |
| `--flags`  | `baseline`（四个布尔开关全关 + `VECTOR_ROUTER='flat'`）\| `default`          |
| `--on`     | 在 `--flags` 基础上**额外打开**某一个布尔开关（可重复）                      |
| `--label`  | 本次运行的标识（写进 meta 行）                                              |

## 比对

`tests/baseline/compare.ts` 提供：

| 函数                       | 作用                                             |
| -------------------------- | ------------------------------------------------ |
| `compareGoldenRecords()`   | 逐位比对，返回 `{ identical, firstDiff }`        |
| `assertGoldenIdentical()`  | 逐位比对，不同时抛错并指出第一处差异            |
| `recordsWithOp()`          | 只取某个操作的记录（窄口径断言）                |

⚠️ 比对只做**硬断言**（逐位相同 = 算错）；「漏了多少」属**软阈值**，不在比对器里（C30）。

## 阶段 0 的定位

⚠️ **本阶段只建立骨架**：真正的「与 v1.0 逐位一致」需要 v1.0 参考实现或 golden 基线，
而 **v1.0 代码不在本仓库**（D-10）⇒ **本阶段的验收是「比对机制可用」，不是「基线已达成」**。

真正的基线达成点在 **P1-T09 末**（记忆本体十方法齐备后），并在 **P3-T06、P4-T07** 再验两次。

依据：DESIGN-v2.md §5 / §12 / ADR-21；DEVELOPMENT-PLAN.md D-08、D-10、P0-T03。
