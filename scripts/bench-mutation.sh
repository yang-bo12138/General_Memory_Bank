#!/usr/bin/env bash
# ★ **变异实测脚本**（P2-T08 的硬要求：至少 2 处变异 ⇒ 断言必须变红 ⇒ 逐字节还原）。
#
# ⚠️ **为什么用 `cp` + `cmp` 还原**（**不用** `git stash` / `git restore` / `git checkout --`）：
#   · `git checkout --` 会把**工作区**里与本次变异无关的改动一起丢掉
#     ⇒ 一旦有人在同一 worktree 里并行改文件 ⇒ 改动会被静默吞掉；
#   · `git stash` 会把**暂存区**一起卷进去 ⇒ 提交边界变得不可预期；
#   · `cp` + `cmp` 只碰**那一个文件** ⇒ 影响面最小 ⇒ 且 `cmp` 给的是
#     **逐字节**的还原证据（不是「看起来一样」）。
#
# ⚠️ **每个变异点都必须让断言真的变红**（退出码非 0）⇒ 否则断言是「假绿」。
#
# 用法：bash scripts/bench-mutation.sh
set -uo pipefail

cd "$(dirname "$0")/.."

BACKUP_DIR=".tmp/mutation-backup"
MUTATION_DIR="${BACKUP_DIR}/cases"
TEST_FILE="tests/bench/bench-smoke.test.ts"
PYTHON="${PYTHON:-python}"
mkdir -p "$MUTATION_DIR"

RESULTS_FILE="${BACKUP_DIR}/results.tsv"
: > "$RESULTS_FILE"

# 施加一个变异点：备份 ⇒ 变异 ⇒ 跑门禁 ⇒ 还原 ⇒ 逐字节核对。
run_case() {
  local name="$1" target="$2" mutation="$3"
  local backup="${BACKUP_DIR}/$(basename "$target").bak"

  echo ""
  echo "================================================================"
  echo "变异点：${name}"
  echo "目标文件：${target}"
  echo "================================================================"

  # ── ① 备份（逐字节）──
  cp "$target" "$backup"

  # ── ② 施加变异 ──
  "$PYTHON" "$mutation" "$target"
  if [ $? -ne 0 ]; then
    echo "✗ 变异脚本执行失败"
    cp "$backup" "$target"
    return 1
  fi

  # ── ③ 确认文件确实被改了（否则不算变异点）──
  if cmp -s "$target" "$backup"; then
    echo "✗ 变异没有生效（文件与备份相同）⇒ 这一处不算变异点"
    cp "$backup" "$target"
    return 1
  fi

  # ── ④ 跑门禁 ⇒ 必须变红 ──
  local out
  out="$(pnpm exec vitest run "$TEST_FILE" 2>&1)"
  local code=$?
  echo "$out" | grep -E "×|✓ |AssertionError|Test Files|Tests " | head -20
  echo "---- 门禁退出码 = ${code} ----"

  # ── ⑤ 还原（`cp` ⇒ 逐字节）──
  cp "$backup" "$target"

  # ── ⑥ 逐字节核对还原 ──
  local restore
  if cmp -s "$target" "$backup"; then
    echo "✓ 还原核对：cmp 逐字节相同（退出码 0）"
    restore="OK"
  else
    echo "✗ 还原核对失败：cmp 报告字节不同"
    restore="MISMATCH"
  fi

  local red
  if [ "$code" -ne 0 ]; then red="RED"; else red="GREEN(未变红)"; fi
  printf '%s\t%s\t%s\t%s\t%s\n' "$name" "$target" "$red" "$code" "$restore" >> "$RESULTS_FILE"
}

# ═══════════ 变异点 M1：吻合率的分母（flat 的 top-20 ⇒ flat 的 top-5） ═══════════
cat > "$MUTATION_DIR/m1.py" <<'PY'
import pathlib, sys
path = pathlib.Path(sys.argv[1])
text = path.read_text(encoding='utf-8')
old = "const flatHits = flatTopK(db, query.embedding, TOP_N);"
new = "const flatHits = flatTopK(db, query.embedding, 5);"
assert old in text, 'M1: 没找到突变点'
path.write_text(text.replace(old, new, 1), encoding='utf-8')
PY
run_case "M1 吻合率分母：flat top-20 ⇒ flat top-5" "bench/agreement.ts" "$MUTATION_DIR/m1.py"

# ═══════════ 变异点 M2：语料种子不再固定 ═══════════
cat > "$MUTATION_DIR/m2.py" <<'PY'
import pathlib, sys
path = pathlib.Path(sys.argv[1])
text = path.read_text(encoding='utf-8')
old = "const rng = createRng(options.seed);"
new = "const rng = createRng(options.seed ^ Math.floor(Math.random() * 0xffffffff));"
assert old in text, 'M2: 没找到突变点'
path.write_text(text.replace(old, new, 1), encoding='utf-8')
PY
run_case "M2 语料种子：固定 ⇒ 非固定（掺入 Math.random）" "bench/corpus.ts" "$MUTATION_DIR/m2.py"

# ═══════════ 变异点 M3：embedder 的确定性被破坏 ═══════════
cat > "$MUTATION_DIR/m3.py" <<'PY'
import pathlib, sys
path = pathlib.Path(sys.argv[1])
text = path.read_text(encoding='utf-8')
old = "  SCRATCH.fill(0);\n  let touched = false;"
new = "  SCRATCH.fill(0);\n  SCRATCH[0] = (SCRATCH[0] ?? 0) + Math.random() * 1e-3;\n  let touched = false;"
assert old in text, 'M3: 没找到突变点'
path.write_text(text.replace(old, new, 1), encoding='utf-8')
PY
run_case "M3 embedder 确定性：同输入两次不再逐位相同" "bench/embedder.ts" "$MUTATION_DIR/m3.py"

# ═══════════ 变异点 M4：C29 的分母纪律（候选全集 ⇒ flat 的 top-20） ═══════════
cat > "$MUTATION_DIR/m4.py" <<'PY'
import pathlib, sys
path = pathlib.Path(sys.argv[1])
text = path.read_text(encoding='utf-8')
old = "  const universe = flatCandidateUniverse(db);"
new = ("  const probe = queries[0];\n"
       "  const universe = new Set(\n"
       "    flatTopK(db, probe?.embedding ?? new Float32Array(DEFAULT_PARAMS.EMBED_DIM), TOP_N).map(\n"
       "      (hit) => hit.id,\n"
       "    ),\n"
       "  );")
assert old in text, 'M4: 没找到突变点'
path.write_text(text.replace(old, new, 1), encoding='utf-8')
PY
run_case "M4 C29 分母：flat 候选全集 ⇒ flat 的 top-20" "bench/agreement.ts" "$MUTATION_DIR/m4.py"

echo ""
echo "================================================================"
echo "变异实测结果表"
echo "================================================================"
printf '%-44s %-22s %-16s %-6s %-10s\n' "变异点" "文件" "断言" "退出码" "还原核对"
while IFS=$'\t' read -r name file red code restore; do
  printf '%-44s %-22s %-16s %-6s %-10s\n' "$name" "$file" "$red" "$code" "$restore"
done < "$RESULTS_FILE"
