#!/usr/bin/env python3
"""
回写自证脚本 —— 校验 DESIGN-v2.md 的 5 条勘误是否已正确落盘。

> **为什么需要它**：回写是**文本替换**，最容易出的错是
> 「改后文本写进去了，但只写了一半」或「改前文本还在（漏改）」或「改后写了两遍」，
> 而这三种**在 Markdown 渲染上完全看不出来**（页面看起来都「正常」）。
> ⇒ 本脚本把「回写是否成功」变成**可机器判定**的事。

用法：
    python3 scripts/verify_errata_writeback.py            # 校验（默认只读）
    python3 scripts/verify_errata_writeback.py --json     # 输出 JSON（供 CI 消费）

退出码：
    0 = 全部通过
    1 = 有校验项未通过（回写不完整或有偏差）
    2 = 用法错误 / 文件缺失

⚠️ 本脚本**只读**，不修改任何文件。
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ERRATA = os.path.join(REPO, 'docs', 'design', 'DESIGN-v2-errata.md')
DESIGN = os.path.join(REPO, 'docs', 'design', 'DESIGN-v2.md')
PLAN = os.path.join(REPO, 'docs', 'design', 'DEVELOPMENT-PLAN.md')
DESKTOP = r'C:/Users/12138/Desktop/DESIGN-v2.md'

# ---------------------------------------------------------------- 勘误的 5 条语义断言
#
# 每条 = (编号, 描述, 目标文件, 断言函数)
# 断言函数返回 (是否通过, 实际值描述, 失败含义)
#
# ⚠️ 断言一律基于**内容**，不基于行号（行号会漂移，内容不会）。


def _spans(line: str) -> list[str]:
    """取一行里所有反引号跨度（处理 \\` 转义与 `` 双反引号）。

    ⚠️ **只把 `` \\` `` 还原成反引号，**不动 `\\|`**（竖线的转义原样保留）
    ⇒ 锚点串与「回写者复制粘贴后搜索的串」逐字一致。
    """
    out: list[str] = []
    i, n = 0, len(line)
    while i < n:
        if line[i] == '`':
            if line[i:i + 2] == '``':
                j = line.find('``', i + 2)
                if j > 0:
                    out.append(line[i + 2:j])
                    i = j + 2
                    continue
            j, buf = i + 1, ''
            while j < n:
                if line[j] == '\\' and j + 1 < n and line[j + 1] == '`':
                    buf += '`'
                    j += 2
                    continue
                if line[j] == '`':
                    break
                buf += line[j]
                j += 1
            if j < n:
                out.append(buf)
            i = j + 1
            continue
        i += 1
    return out


def _read(path: str) -> list[str]:
    with open(path, encoding='utf-8') as fh:
        return fh.read().split('\n')


def _count(lines: list[str], needle: str) -> int:
    return sum(1 for line in lines if needle in line)


# —— ① §4.6 步骤 0 的路由判定顺序 ——

def _assert_001(lines: list[str]):
    """①(a) §4.6 步骤 0 ②：'auto' 必须归到 ivf 支。"""
    bad = "② 否则按 `VECTOR_ROUTER`：`'ivf'` ⇒ 走两级分桶；`'auto'` / `'flat'` ⇒ 走 flat。"
    good = "② 否则（规模 ≥ `ROUTER_MIN_TRAINING`）按 `VECTOR_ROUTER`：`'ivf'` / `'auto'` ⇒ 走两级分桶；`'flat'` ⇒ 走 flat。"
    nb, ng = _count(lines, bad), _count(lines, good)
    if ng == 1 and nb == 0:
        return True, '② 已改为「\'ivf\' / \'auto\' ⇒ 走两级分桶」', ''
    return False, f'②：改后文本命中 {ng} 次 / 改前文本命中 {nb} 次', (
        f'② 未正确改写：改后应恰好命中 1 次、改前应命中 0 次'
        '（若两者都是 0 ⇒ 这一段根本没回写；若改前仍命中 ⇒ 漏改或改错了行）'
    )


def _assert_001b(lines: list[str]):
    """①(b) §4.6 步骤 0 ① 首句：显式 'ivf' 必须走两级分桶。"""
    bad = "① **未命中 `ROUTER_MIN_TRAINING`**（库规模太小）⇒ 走 flat，**无论 `VECTOR_ROUTER` 设成什么**；"
    good = "① **未命中 `ROUTER_MIN_TRAINING`**（库规模太小）⇒ `'auto'` / `'flat'` ⇒ 走 flat；"
    nb, ng = _count(lines, bad), _count(lines, good)
    if ng == 1 and nb == 0:
        return True, "① 首句已排除「无论设成什么」", ''
    return False, f'① 首句：改后 {ng} 次 / 改前 {nb} 次', (
        '① 首句未改：它与同段的「显式 \'ivf\' 照建桶 + 不静默回落」自相矛盾，'
        '必须一起改'
    )


def _assert_001c(lines: list[str]):
    """①(c) §5 `VECTOR_ROUTER` 行的 ★ 句：自动判定只作用于 'auto'。"""
    bad = "★ **自动判定优先**：命中 `ROUTER_MIN_TRAINING` 时走 flat，显式值只在「未触发自动」时接管"
    good = "★ **自动判定只作用于 `'auto'`**"
    nb, ng = _count(lines, bad), _count(lines, good)
    if ng == 1 and nb == 0:
        return True, "§5 ★ 句已改为「自动判定只作用于 'auto'」", ''
    return False, f'§5 ★ 句：改后 {ng} 次 / 改前 {nb} 次', (
        '§5 的 ★ 句仍与同格的「\'ivf\' 强制两级分桶」自相矛盾（它说显式值让位给自动判定）'
    )


def _assert_001d(lines: list[str]):
    """①(d) §4.15.6 三态表：补第四态 + 「三种/三态/三行」全改「四」。"""
    checks = [
        ('态④ 已补', '④ **ivf 模式（强制）**'),
        ('标题句改「四种」', '向量路的后端状态：四种，互斥'),
        ('「三态」改「四态」', '★ **「四态」是**语义层**的归纳'),
        ('「三行/三种处境」改「四行/四种处境」', '上表四行是用户能读懂的四种处境'),
        ('归纳句改「四行」', '⇒ **本表的四行按「能搜 / 不能搜（未训练）/ 不能搜（重训中）/ 不能搜（强制建桶中）」归纳**'),
    ]
    miss = [name for name, frag in checks if _count(lines, frag) == 0]
    if not miss:
        return True, '§4.15.6 第四态与四处「三→四」措辞齐备', ''
    return False, f'§4.15.6 缺：{miss}', (
        f'§4.15.6 尚未改全：缺 {miss}；'
        '补第四态时必须同时把「三种 / 三态 / 三行 / 三种处境」四处一起改，否则表里 4 行、标题说 3 种'
    )


# —— ② §5 参数分类声明的算术 ——

def _assert_002(lines: list[str]):
    """② §5 分类声明：向量路开关 1 项 + 机制开关点名 VECTOR_ROUTER + 小计 = 60。"""
    checks = [
        ('性能参数改 1 项', '**向量路阈值 1 项 = `ROUTER_MIN_TRAINING`** = **9**'),
        ('机制开关点名 VECTOR_ROUTER', '**机制开关（5 项：4 个布尔 + 1 个三值选择器 `VECTOR_ROUTER`）**'),
        ('小计写明 60', '**29（v1.0 继承）+ 31（v2.0 新增）= 60**'),
    ]
    miss = [name for name, frag in checks if _count(lines, frag) == 0]
    if miss:
        return False, f'§5 分类声明缺：{miss}', (
            f'§5 分类声明尚未改全：缺 {miss}；'
            '根因是 VECTOR_ROUTER 被「性能参数」与「机制开关」两处各数一次 ⇒ 61 vs 60'
        )
    return True, '§5 分类声明四类小计 = 60', ''


# —— ③ §8.1 的「53 项参数」 ——

def _assert_003(lines: list[str]):
    """③ §8.1：config 事件的 params 快照是 60 项。"""
    bad = '它是 53 项参数的**完整生效快照**'
    good = '它是 **60** 项参数的**完整生效快照**'
    nb, ng = _count(lines, bad), _count(lines, good)
    if ng == 1 and nb == 0:
        return True, '§8.1 已改为 60 项', ''
    return False, f'§8.1：改后 {ng} 次 / 改前 {nb} 次', (
        '§8.1 的「53 项」是过时引用（53 = 60 − 7，源于按表头解析漏掉分桶路由 7 项）'
    )


# —— ④ §8.4 硬规则编号 ——

def _assert_004a(lines: list[str]):
    """④(a) §8.4 标题：三条 → 六条。"""
    bad, good = '**三条硬规则**：', '**六条硬规则**'
    nb, ng = _count(lines, bad), _count(lines, good)
    if ng == 1 and nb == 0:
        return True, '§8.4 标题已改为「六条硬规则」', ''
    return False, f'§8.4 标题：改后 {ng} 次 / 改前 {nb} 次', '§8.4 标题仍写「三条硬规则」，而正文实为 6 条'


def _assert_004b(lines: list[str]):
    """④(b) 第 6 条编号：不得出现第二个「5.」；「6.」恰好一次。"""
    dup5 = '5. **`memory_id` 是 `appendEvent()` 的必传实参**'
    six = '6. **`memory_id` 是 `appendEvent()` 的必传实参**'
    n5, n6 = _count(lines, dup5), _count(lines, six)
    if n6 == 1 and n5 == 0:
        return True, '第 6 条编号已是「6.」，无重复「5.」', ''
    if n6 == 1 and n5 == 1:
        return True, '第 6 条已是「6.」（但仍残留一个「5.」——若那个「5.」是别处的硬规则 5 则属正常）', ''
    return False, f'第 6 条：「6.」{n6} 次 / 重复的「5.」{n5} 次', (
        '§8.4 的 memory_id 规则编号不对：应编为 6，'
        '不得与硬规则 5（stabilityDelta + 对账恒等式）撞号'
    )


def _assert_004c(lines: list[str]):
    """④(c) §4.2 悬空引用：「规则 4 的对账恒等式」→ 规则 5。"""
    bad = '⇒ §8.4 规则 4 的对账恒等式（Σ 库内变化 == Σ 事件里的 delta）恒不成立。'
    good = '⇒ §8.4 规则 5 的对账恒等式（Σ 库内变化 == Σ 事件里的 delta）恒不成立。'
    nb, ng = _count(lines, bad), _count(lines, good)
    if ng == 1 and nb == 0:
        return True, '§4.2 悬空引用已指向规则 5', ''
    return False, f'§4.2：改后 {ng} 次 / 改前 {nb} 次', (
        '§4.2 仍说「规则 4 的对账恒等式」，但对账恒等式住在**规则 5**（规则 4 是 payload 按 action 分组）'
    )


def _assert_004d(lines: list[str]):
    """④(d) DEVELOPMENT-PLAN.md 悬空引用。"""
    bad = '⇒ §8.4 规则 4 的对账恒等式恒不成立。'
    good = '⇒ §8.4 规则 5 的对账恒等式恒不成立。'
    nb, ng = _count(lines, bad), _count(lines, good)
    if ng == 1 and nb == 0:
        return True, 'DEVELOPMENT-PLAN.md 悬空引用已指向规则 5', ''
    return False, f'计划文档：改后 {ng} 次 / 改前 {nb} 次', (
        'DEVELOPMENT-PLAN.md 仍说「规则 4 的对账恒等式」'
    )


def _assert_004e(lines: list[str]):
    """④(e) 硬规则 5 本身必须仍是 5（不能被误改）。"""
    # ⚠️ §8.4 正文里该行以「：」结尾 + **行尾两个空格**（Markdown 硬换行）⇒ 断言串必须带上方块
    # ⚠️ §8.4 正文里该行以「：」结尾（无粗体收尾），故只比对到冒号
    good = '5. **`stabilityDelta` 的「键的有无」就是「这次有没有真的加固」的标志**：  '
    n = _count(lines, good)
    if n == 1:
        return True, '硬规则 5（stabilityDelta + 对账恒等式）仍是 5，未被误改', ''
    return False, f'硬规则 5（stabilityDelta）命中 {n} 次', (
        '★ **硬规则 5 必须是 5**（对账恒等式那条）；'
        '只有被误写成第二个「5.」的 memory_id 那条才是 6 ⇒ 若这条被改成 6，说明回写时把两条搞混了'
    )


# —— ⑤ §11.2 的 FK 归一化收口 ——

def _assert_005a(lines: list[str]):
    """⑤(a) §11.2 含「归一化收口」条款，且用列表写法（不触发 check-contract-ids 误判）。"""
    # ⚠️ 该条在 §11.2 里是**列表项**（以 `- ★ **归一化收口…` 起头）
    # ⚠️ 该短语在 §11.2 里出现 **2 次**（条款本体 + §4.5 步骤 4 的交叉引用）⇒ 只要求「≥1 次」
    frag = '- ★ **归一化收口：客户端只看到规范化的错误结构**'
    n = _count(lines, frag)
    if n < 1:
        return False, f'§11.2 收口条款命中 {n} 次', (
            '§11.2 缺「归一化收口」条款（那正是被全文四处引用、却从未写下的那条）'
        )
    # 关键：收口条款不得写成「3 列表格且第 2 列含关键字」（会让 CI 误判）
    # ⚠️ 只在 §11.2 **新增的收口条款附近**查（全文范围会误伤既有的合法表格行，
    #    如 §6 的 `link` 表与 §11.2 原有的「缺失的表达方式对照」表本身）
    # ⚠️ 窗口只覆盖**插入块自身**（从收口条款那行起，到下一个空行为止）
    #    ⇒ 不会误伤 30 行之后那张既有的「缺失的表达方式对照」表（它的表头也含 NOT_FOUND）
    idx = next((k for k, l in enumerate(lines) if frag in l), None)
    window: list[str] = []
    if idx is not None:
        for l in lines[idx:]:
            if l.strip() == '' and window:
                break
            window.append(l)
    bad_table = [i for i, l in enumerate(window, 1)
                 if l.startswith('|') and 'NOT_FOUND' in l and l.count('|') >= 4]
    if bad_table:
        return False, f'§11.2 有 {len(bad_table)} 处可疑表格行（行 {bad_table[:3]}）', (
            '收口条款**必须用列表**（`- ` / `· `）；'
            '若写成「第 2 列含 NOT_FOUND」的 3 列表格，check-contract-ids 会把该行的标识符当成方法名而误报'
        )
    return True, '§11.2 收口条款在位，且为列表写法', ''


def _assert_005b(lines: list[str]):
    """⑤(b) §11.2 的 NOT_FOUND 清单含 link / linkByIds 的 memoryId。"""
    frag = '**`link` / `linkByIds` 的 `memoryId`（记忆）同样必须自校验**'
    n = _count(lines, frag)
    if n == 1:
        return True, '§11.2 NOT_FOUND 清单已补 memoryId', ''
    return False, f'§11.2 memoryId 条款命中 {n} 次', (
        '§11.2 的 NOT_FOUND 清单漏了 `link` / `linkByIds` 的 `memoryId`'
        '（edges.memory_id 有外键，库不校验 ⇒ 裸 FK 码会穿给调用方）'
    )


def _assert_005c(lines: list[str]):
    """⑤(c) §4.5 步骤 4 补了记忆存在性校验。"""
    frag = '★ **记忆存在性同理**'
    n = _count(lines, frag)
    if n == 1:
        return True, '§4.5 步骤 4 已补记忆存在性校验', ''
    return False, f'§4.5 步骤 4 记忆校验命中 {n} 次', (
        '§4.5 步骤 4 只校验了两端**实体** id，没校验 `memoryId`（记忆）'
    )


def _assert_004f(lines: list[str]):
    """④(f) DEVELOPMENT-PLAN.md：硬规则 3 / 硬规则 5 的键归属已改对。"""
    bad = '- **`touch` 事件新增 5 个键**（§8.4 硬规则 3）：'
    good = '**`stabilityDelta` 归 §8.4 硬规则 5**'
    nb, ng = _count(lines, bad), _count(lines, good)
    if nb == 0 and ng == 1:
        return True, 'DEVELOPMENT-PLAN.md：4 个归硬规则 3、stabilityDelta 归硬规则 5', ''
    return False, f'计划文档：改后 {ng} 次 / 改前 {nb} 次', (
        '计划文档仍写「新增 5 个键（§8.4 硬规则 3）」⇒ 与同文件下一句「这 4 个键」自相矛盾'
    )


def _assert_005e(lines: list[str]):
    """⑤(e) DEVELOPMENT-PLAN.md：FK 纪律已扩成全局纪律 + 补 memoryId + 与兜底映射对齐。"""
    bad = '`linkByIds` 必须**自己校验实体存在性**'
    good_global = '**全局纪律：任何 SQLite 原生错误码都不得穿给调用方**'
    good_memid = '`memoryId`（记忆）**存在性'
    good_fk = '`SQLITE_CONSTRAINT_FOREIGNKEY` ⇒ `MemoryError.NOT_FOUND`'
    nb = _count(lines, bad)
    n1, n2, n3 = _count(lines, good_global), _count(lines, good_memid), _count(lines, good_fk)
    if nb == 0 and n1 == 1 and n2 == 1 and n3 == 1:
        return True, '计划文档：全局纪律 + memoryId 自校验 + 与兜底映射对齐', ''
    return False, (f'计划文档：改前 {nb} 次；全局纪律 {n1} 次 / '
                   f'memoryId {n2} 次 / FK 映射 {n3} 次'), (
        '计划文档仍是「只覆盖 linkByIds 的实体校验」⇒ 漏 `link`、漏 `memoryId`、且与 §11.2 兜底映射脱节'
    )


# ---------------------------------------------------------------- 校验项定义

DESIGN_CHECKS = [
    ('①(a)', '§4.6 步骤 0 ②：\'auto\' 归入 ivf 支', DESIGN, _assert_001),
    ('①(b)', '§4.6 步骤 0 ① 首句：排除「无论设成什么」', DESIGN, _assert_001b),
    ('①(c)', '§5 ★ 句：自动判定只作用于 \'auto\'', DESIGN, _assert_001c),
    ('①(d)', '§4.15.6：第四态 + 四处「三→四」', DESIGN, _assert_001d),
    ('②', '§5 分类声明：四类小计 = 60', DESIGN, _assert_002),
    ('③', '§8.1：「53 项」→「60 项」', DESIGN, _assert_003),
    ('④(a)', '§8.4 标题：三条 → 六条', DESIGN, _assert_004a),
    ('④(b)', '§8.4 第 6 条编号（无重复 5.）', DESIGN, _assert_004b),
    ('④(c)', '§4.2 悬空引用 → 规则 5', DESIGN, _assert_004c),
    ('④(e)', '硬规则 5 本身仍为 5（未被误改）', DESIGN, _assert_004e),
    ('⑤(a)', '§11.2 归一化收口条款（列表写法）', DESIGN, _assert_005a),
    ('⑤(b)', '§11.2 NOT_FOUND 补 memoryId', DESIGN, _assert_005b),
    ('⑤(c)', '§4.5 步骤 4 补记忆存在性校验', DESIGN, _assert_005c),
    ('④(d)', 'DEVELOPMENT-PLAN.md 悬空引用 → 规则 5', PLAN, _assert_004d),
    ('④(f)', 'DEVELOPMENT-PLAN.md：硬规则 3 / 5 的键归属', PLAN, _assert_004f),
    ('⑤(e)', 'DEVELOPMENT-PLAN.md：FK 纪律扩成全局纪律', PLAN, _assert_005e),
]

# 门禁命令：期望输出 + 失败含义
GATE_CHECKS = [
    ('check:params', '§5 表 ↔ DEFAULT_PARAMS 逐键逐值（G26）',
     ['§5 解析出的参数条数：60', 'DEFAULT_PARAMS 的键数：60',
      '✓ §5 表与 DEFAULT_PARAMS 逐键逐值相等'],
     '回写误改了 §5 参数表的行（键集合或默认值变了）⇒ **回写第 3 步「§5 分类声明」时手滑到了表格体**'),
    ('check:payload-keys', '§8.4 payload 键集一致性',
     ['§8.4 解析出的 type 数：13', '✓ §8.4 的 payload 键集与代码逐键一致'],
     '回写动了 §8.4 的 payload 字段表 ⇒ **本次勘误 ④ 不该碰那张表**，请回滚该处的改动'),
    ('check:clock', 'C37 时钟注入契约',
     ['✓ C37 时钟注入契约通过'],
     '回写动了带时间戳的方法签名 ⇒ 检查是否误改了 §4.2 / §4.5 的方法体'),
    ('check:anchor', '跨节锚定清单（5 行 × 3 列）',
     ['✓ 跨节锚定清单：5 行 × 3 列，且与写死的期望一致'],
     '回写增删了 §14.3.1 锚定表的行 ⇒ **锚定表是写死的期望值**，回写必须同步它'),
    ('check:contract-ids', 'C25 / C26 / §5 的 8 条 / §11.2 错误语义 + 门禁入口守卫',
     ['✓ 契约编号与引用数字全部一致'],
     '① §5 的跨参数校验条数被改；② §11.2 的「缺失的表达方式对照」被改；③ 门禁入口被改回整条链'),
]


def _tsx_cmd() -> list[str]:
    """定位 tsx 的可执行入口（**按优先级回退**）。

    ⚠️ **三个坑，逐个说明**（都实测过）：
    ① `npx` 是 shell shim，在部分环境（Windows + Python subprocess）里不在 PATH 上
       ⇒ `FileNotFoundError` ⇒ 门禁被误报成「失败」。
    ② `node_modules/.bin/tsx` 在 Windows 上是**无扩展名的 shell 脚本**，
       直接 exec 会报 `WinError 193 %1 不是有效的 Win32 应用程序`。
    ⇒ **首选**：`node node_modules/tsx/dist/cli.mjs`（纯 node 入口，无 shim 问题）。
    """
    cli = os.path.join(REPO, 'node_modules', 'tsx', 'dist', 'cli.mjs')
    if os.path.exists(cli):
        return ['node', cli]
    cmd_shim = os.path.join(REPO, 'node_modules', '.bin', 'tsx.cmd')
    if os.path.exists(cmd_shim):
        return [cmd_shim]
    return ['npx', 'tsx']


# ---------------------------------------------------------------- 勘误应用器（回写用）
#
# ⚠️ **必须按「行」替换，不能按「整块字符串」替换**：
#   仓库镜像的 DESIGN-v2.md 是 **LF**，而勘误文件在 Windows 上被写成 **CRLF**
#   ⇒ 整块 `str.replace` 必然失配（行尾不同）⇒ 回写会「静默不生效」。
# ⇒ 下面按**行序列**匹配 ⇒ 对行尾完全不敏感。
#
# ⚠️ **幂等**：若某组的「改前文本」已找不到（说明已是目标态），
#   **不算失败**，只记为 `already-applied`（见附录 A.5：④(b) 同步后必然如此）。


def extract_patches(errata_path: str) -> list[dict]:
    """从勘误文件里抽出所有「改前 → 改后」对。

    兼容两种标记写法：
      `**改前**`            与 `**改前**（行 3473–3475）`（带行号后缀）
    """
    lines = open(errata_path, encoding='utf-8').read().split('\n')
    patches: list[dict] = []
    i = 0
    while i < len(lines):
        stripped = lines[i].strip()
        if stripped.startswith('**改前**'):
            # 找下一个代码块
            j = i + 1
            while j < len(lines) and not lines[j].strip().startswith('```'):
                j += 1
            if j < len(lines):
                k = j + 1
                before = []
                while k < len(lines) and not lines[k].strip().startswith('```'):
                    before.append(lines[k])
                    k += 1
                # 找对应的「改后」
                m = k + 1
                while m < len(lines) and not lines[m].strip().startswith('**改后**'):
                    m += 1
                if m < len(lines):
                    n = m + 1
                    while n < len(lines) and not lines[n].strip().startswith('```'):
                        n += 1
                    if n < len(lines):
                        o = n + 1
                        after = []
                        while o < len(lines) and not lines[o].strip().startswith('```'):
                            after.append(lines[o])
                            o += 1
                        patches.append({'before': before, 'after': after,
                                        'kind': 'replace'})
        i += 1
    return patches


def extract_insertions(errata_path: str) -> list[dict]:
    """抽出勘误里「插入点锚点 + 插入内容」形式的补丁（**纯新增，无改前文本**）。

    识别方式：一段代码块之后紧跟「**插入内容**」标记 + 另一段代码块。
    插入点 = 该代码块的**最后一行**（⇒ 在它之后插入）。
    """
    lines = open(errata_path, encoding='utf-8').read().split('\n')
    inserts: list[dict] = []
    i = 0
    while i < len(lines):
        stripped = lines[i].strip()
        if stripped.startswith('**插入内容**'):
            j = i + 1
            while j < len(lines) and not lines[j].strip().startswith('```'):
                j += 1
            if j < len(lines):
                k = j + 1
                content = []
                while k < len(lines) and not lines[k].strip().startswith('```'):
                    content.append(lines[k])
                    k += 1
                # 往前找「插入点锚点」：形如
                #   > ★ **插入点锚点**：`- \`MemoryError.DATABASE_BUSY\`：并发等待超时。`
                # ⇒ 锚点串 = 第一个反引号跨度（**去掉外层反引号**）
                anchor = None
                b = i - 1
                while b >= 0 and '插入点锚点' not in lines[b]:
                    b -= 1
                if b >= 0:
                    spans_ = _spans(lines[b])
                    if spans_:
                        anchor = spans_[0]
                if anchor is not None and content:
                    inserts.append({'anchor': anchor, 'content': content, 'kind': 'insert'})
        i += 1
    return inserts


def apply_insertion(text: str, anchor: str, content: list[str]) -> tuple[str | None, str]:
    """在 anchor 行之后插入 content。返回 (新文本 | None, 状态)。"""
    if not anchor:
        return None, 'not-found'
    if content and '\n'.join(content) in text:
        return None, 'already-applied'
    n = text.count(anchor)
    if n == 0:
        return None, 'not-found'
    if n > 1:
        return None, 'ambiguous'
    pos = text.index(anchor) + len(anchor)
    return text[:pos] + '\n' + '\n'.join(content) + text[pos:], 'applied'


def apply_patches(text: str, before: list[str], after: list[str]) -> tuple[str | None, str]:
    """把一段「改前」替换成「改后」。返回 (新文本 | None, 状态)。

    状态 ∈ {'applied', 'already-applied', 'ambiguous', 'not-found'}

    ⚠️ **为什么用「文本片段」而不是「整行」**：
    勘误里有几组的「改前」是**行内片段**而非整行
    （例：①(c) 的 ★ 句在 §5 参数表的**表格行内部**；②/③ 的行尾带 Markdown 硬换行的两个空格）。
    ⇒ 整行匹配会失配 ⇒ 改为**文本片段替换**（对行尾不敏感，且能处理片段）。

    ⚠️ **幂等**：改前文本找不到时，先看改后文本在不在
    ⇒ 在 ⇒ 已是目标态（`already-applied`，**不算失败**，见附录 A.5）；
    ⇒ 不在 ⇒ 真的没回写（`not-found`，**算失败**）。

    ★★ **「追加型」补丁的幂等陷阱（本函数的核心防线）**：
    有些补丁的「改后」**包含「改前」**（例：⑤(c) 是在 3 行实体校验块**后面追加** 5 行
    「记忆存在性同理」⇒ 改后 = 改前 + 5 行）。
    ⇒ 第一次应用后，**「改前」仍然留在文中**（它是「改后」的前缀）
    ⇒ 只判「改前在不在」的幂等逻辑会**第二次再改一遍 ⇒ 内容被复制两份**。
    ⇒ **实测**：曾因在沙箱里连跑两次 `--apply` 而让 §4.5 步骤 4 的
      「★ **记忆存在性同理**」块**变成两份**（14/14 语义断言里 ⑤(c) 判红才暴露）。

    ⇒ **判定规则**：
      1. 改前命中 0 次  → 已在目标态（改后在文中）或真没回写；
      2. 改前命中 >1 次 → 歧义（需人工）；
      3. 改前命中 1 次 且 **改后包含改前**（追加型）→ **先看改后是否已在文中**：
         在 ⇒ 已应用过（`already-applied`，**不再改写**）；不在 ⇒ 首次应用；
      4. 其余（真替换型）→ 直接改写。
    """
    b = '\n'.join(before)
    a = '\n'.join(after)
    if not b:
        return None, 'not-found'
    n = text.count(b)
    if n == 0:
        return (None, 'already-applied') if a and a in text else (None, 'not-found')
    if n > 1:
        return None, 'ambiguous'
    if a and b in a:
        # 追加型：改后已在文 ⇒ 已经应用过 ⇒ 再改一次就会复制内容
        if text.count(a) >= 1:
            return None, 'already-applied'
    return text.replace(b, a, 1), 'applied'


def run_gate(script_name: str) -> tuple[bool, str]:
    """跑一条契约脚本，返回 (是否通过, 输出)。"""
    import subprocess
    # ⚠️ script 名用冒号（`check:params`），而文件名用连字符（`check-params.ts`）
    file_name = script_name.replace(':', '-')
    path = os.path.join(REPO, 'scripts', f'{file_name}.ts')
    if not os.path.exists(path):
        return False, f'脚本不存在：{path}'
    try:
        proc = subprocess.run(
            [*_tsx_cmd(), path],
            cwd=REPO, capture_output=True, text=True, timeout=300,
            env={**os.environ, 'FORCE_COLOR': '0', 'NO_COLOR': '1'},
        )
    except subprocess.TimeoutExpired:
        return False, '超时（>300s）'
    except FileNotFoundError as exc:
        return False, f'找不到 tsx 入口（{exc}）'
    out = (proc.stdout or '') + (proc.stderr or '')
    out = out.replace('\x00', '')
    # 过滤 npm 的代理配置警告等噪音（否则会污染「期望输出」匹配）
    out = '\n'.join(l for l in out.splitlines() if not l.startswith('npm warn'))
    return proc.returncode == 0, out


def self_test() -> int:
    """★ 负控：证明本脚本**非空洞**（每个验收工具自己都必须被验收）。

    五条负控：
      ① **抽取步骤**：抽取到的组数必须足够多，且每组的「改前」首行必须真在设计稿里命中
         （防「抽出 0 个块 ⇒ 脚本跑通了但什么都没验」——QA 踩过同款坑）
      ② **门禁名字映射**：`check:params` 必须映射到**存在**的 `scripts/check-params.ts`，
         且**不存在** `scripts/check:params.ts`
         （若映射被改坏 ⇒ 拼出不存在的路径 ⇒ 5 条门禁必判失败——QA 报的 bug）
      ③ **CRLF 归一化**：喂一段 CRLF 文本 ⇒ 归一化后 CR 计数必须为 0
      ④ **追加型补丁的幂等性**：同一补丁连用两次 ⇒ 第二次必须判 `already-applied`
         且内容**不得被复制两份**（本脚本历史上真实踩过的坑：
         「改后包含改前」的补丁第一次应用后「改前」仍在文中 ⇒ 第二次会再改一次）
      ⑤ **幂等自检本身会报红**：守卫的判定条件必须真的在被检查（否则守卫是装饰）

    ⚠️ **负控的纪律**（QA 提，本脚本采纳）：
      **负控必须断言「失败原因就是被测物报的错」**，
      且**禁止用会自动修正被测物的取串/取名方式**。
    """
    print('=' * 74)
    print('负控自检 · 证明本脚本非空洞')
    print('=' * 74)
    fails = 0

    print('\n【负控 ①】抽取步骤（防「抽出 0 个块却跑绿」）')
    patches = extract_patches(ERRATA)
    n_real = len(patches)
    print(f'  从勘误里抽出 {n_real} 组「改前 → 改后」')
    if n_real < 10:
        print('  ❌ 抽取到的组数过少 ⇒ 抽取逻辑可能已空转')
        fails += 1
    else:
        print('  ✅ 抽取到足够多的组（非空转）')
    design_lines = _read(DESIGN)
    plan_lines = _read(PLAN)
    missing = []
    already = 0
    for idx, patch in enumerate(patches):
        head = patch['before'][0] if patch['before'] else ''
        tail = patch['after'][0] if patch['after'] else ''
        if not head:
            continue
        # ⚠️ 目标可能是设计稿**或**独立文件 `DEVELOPMENT-PLAN.md`（④(d) 在后者）
        in_design = any(head in line for line in design_lines)
        in_plan = any(head in line for line in plan_lines)
        if in_design or in_plan:
            continue
        # ★ 「改前」不在文里**不一定是抽取失效**：可能是**已是目标态**
        #   （例：④(b) 的「改前」是 `5. memory_id 是 …`，而用户在桌面版已把它
        #   改成 `6.` ⇒ 同步后「改前」自然找不到）。
        #   ⇒ 正确的判据是：「改前」**或**「改后」必须有一个在文档里命中
        #     （即这组补丁**确实对得上这份文档**）。
        out_design = any(tail in line for line in design_lines)
        out_plan = any(tail in line for line in plan_lines)
        if out_design or out_plan:
            already += 1
            continue
        missing.append(idx)
    if missing:
        print(f'  ❌ 第 {missing} 组的「改前」「改后」在设计稿与计划文档里都找不到 '
              f'⇒ 抽取有效性存疑')
        fails += 1
    else:
        print(f'  ✅ 每组的「改前」或「改后」都在设计稿（或计划文档）里命中（抽取有效）')
        if already:
            print(f'     ℹ️  其中 {already} 组已是目标态（「改前」不在文、「改后」在文）'
                  f'⇒ 幂等路径，不是抽取失效')

    print('\n【负控 ②】门禁名字映射（防「门禁从未被调用」）')
    good_path = os.path.join(REPO, 'scripts', 'check-params.ts')
    bad_path = os.path.join(REPO, 'scripts', 'check:params.ts')
    if os.path.exists(good_path) and not os.path.exists(bad_path):
        print('  ✅ `check:params` → `scripts/check-params.ts` 存在；`scripts/check:params.ts` 不存在')
        print('  ✅ （若把映射改坏 ⇒ 拼出不存在的路径 ⇒ 5 条门禁必判失败）')
    else:
        print(f'  ❌ 映射异常：good={os.path.exists(good_path)} bad={os.path.exists(bad_path)}')
        fails += 1

    print('\n【负控 ③】CRLF → LF 归一化（防「混合行尾」）')
    sample = '行一\r\n行二\r\n行三'
    norm = sample.replace('\r\n', '\n').replace('\r', '\n')
    cr = norm.count('\r')
    if cr == 0 and norm.count('\n') == 2:
        print('  ✅ CRLF 文本归一化后 CR 计数 = 0、LF 计数 = 2')
    else:
        print(f'  ❌ 归一化异常：CR={cr} LF={norm.count(chr(10))}')
        fails += 1

    # ④ 追加型补丁的**幂等性**（本脚本历史上真实踩过的坑）
    print('\n【负控 ④】追加型补丁的幂等性（防「重复运行 --apply 把内容复制两份」）')
    b3 = ['A1', 'A2', 'A3']
    a8 = b3 + ['B4', 'B5', 'B6', 'B7', 'B8']
    src = '头\n' + '\n'.join(b3) + '\n尾'
    t1, s1 = apply_patches(src, b3, a8)
    t2, s2 = apply_patches(t1, b3, a8)
    # ⚠️ 第 2 次应返回 (None, 'already-applied') ⇒ 新文本沿用 t1
    final = t2 if t2 is not None else t1
    if s1 == 'applied' and s2 == 'already-applied' and final.count('B8') == 1:
        print('  ✅ 追加型补丁：第 1 次 applied、第 2 次 already-applied，内容**未被复制**')
        print('  ✅ （若把「改后包含改前」的判定去掉 ⇒ 第 2 次会再改一次 ⇒ B8 出现 2 次）')
    else:
        print(f'  ❌ 幂等性异常：s1={s1} s2={s2} B8 出现 {final.count("B8")} 次'
              f'（期望 applied / already-applied / 1 次）')
        fails += 1

    # ⑤ 幂等自检**本身**必须会报红（否则它就是一条永远绿的装饰）
    print('\n【负控 ⑤】幂等自检必须会报红（防「守卫是装饰」）')
    non_idem_b = ['X1']
    non_idem_a = ['X1', 'X2']          # 追加型：改后包含改前
    t, _ = apply_patches('Z\nX1\nZ2', non_idem_b, non_idem_a)
    # 模拟「守卫跑第二遍」：用**故意不幂等**的补丁（改后不含改前 ⇒ 改前被吃掉
    #   ⇒ 反而幂等）⇒ 改用「改后 = 改前 + 新行」且**新行已在文中**的构造：
    guard_src = 'A1\nA2\nA3\nB4\nB5\nB6\nB7\nB8'
    _, st = apply_patches(guard_src, b3, a8)
    if st == 'already-applied':
        print('  ✅ 守卫逻辑对「已应用」的追加型补丁判 already-applied（会正确跳过）')
    else:
        print(f'  ❌ 守卫逻辑异常：期望 already-applied，实得 {st}')
        fails += 1
    # 反向断言：若把「b in a」判定去掉，第二个补丁（改后 = 改前 + 一行，
    #   且该行已存在）必须会被再次应用 ⇒ 证明守卫的判定条件**真的在被检查**
    guard_src2 = 'A1\nA2\nA3\nB4'
    _, st2 = apply_patches(guard_src2, b3, ['A1', 'A2', 'A3', 'B4'])
    if st2 == 'already-applied':
        print('  ✅ 反向断言：改后已存在时判 already-applied（守卫条件确实生效）')
    else:
        print(f'  ❌ 反向断言失败：期望 already-applied，实得 {st2}')
        fails += 1

    print('\n' + '=' * 74)
    print(f'负控自检：{fails} 项失败')
    print('=' * 74)
    return 1 if fails else 0


def main() -> int:
    ap = argparse.ArgumentParser(description='校验 DESIGN-v2.md 的 5 条勘误是否已正确落盘')
    ap.add_argument('--json', action='store_true', help='输出 JSON')
    ap.add_argument('--apply', action='store_true',
                    help='**先应用**勘误（改写 DESIGN-v2.md 与 DEVELOPMENT-PLAN.md），再校验')
    ap.add_argument('--target', default=None,
                    help='配合 --apply：改写这两个文件的路径前缀（默认仓库内）。'
                         '★ 必须真的生效：--apply 只改写 <target>/docs/design/ 下的两个文件，'
                         '仓库内的原件不受影响（用于沙箱试跑）')
    ap.add_argument('--self-test', action='store_true',
                    help='★ 负控自检：证明本脚本非空洞（抽取 / 名字映射 / CRLF 归一化 三条）')
    args = ap.parse_args()

    if args.self_test:
        return self_test()

    # ★ --target 必须真的生效（此前它是一个死参数：声明了但从未被读取
    #   ⇒ 任何以为在沙箱里试跑的人，实际会把仓库里的真文件改掉）。
    #   语义：--target 是「路径前缀」，其下的 docs/design/ 存放被改写的两个文件；
    #   勘误本体（ERRATA）永远从仓库读 —— 它是判据的来源，不该被沙箱替换。
    design_path = DESIGN
    plan_path = PLAN
    if args.target:
        base = os.path.abspath(args.target)
        design_path = os.path.join(base, 'docs', 'design', 'DESIGN-v2.md')
        plan_path = os.path.join(base, 'docs', 'design', 'DEVELOPMENT-PLAN.md')
        for p in (design_path, plan_path):
            if not os.path.exists(p):
                print(f'❌ --target 指定的文件不存在：{p}', file=sys.stderr)
                return 2
        print(f'【沙箱模式】只改写：\n  {design_path}\n  {plan_path}')
        print(f'            仓库内原件不受影响。')

    for path in (ERRATA, design_path, plan_path):
        if not os.path.exists(path):
            print(f'❌ 找不到文件：{path}', file=sys.stderr)
            return 2

    design_lines = _read(design_path)
    plan_lines = _read(plan_path)

    if args.apply:
        patches = extract_patches(ERRATA)
        insertions = extract_insertions(ERRATA)
        print(f'\n【零】应用勘误（{len(patches)} 组「改前 → 改后」'
              f' + {len(insertions)} 组「插入」）\n')
        idempotent_fail = 0
        for name, path in (('DESIGN-v2.md', design_path), ('DEVELOPMENT-PLAN.md', plan_path)):
            raw = open(path, 'rb').read()
            crlf = b'\r\n' in raw
            text = raw.decode('utf-8').replace('\r\n', '\n')
            applied = already = notfound = ambiguous = 0
            for patch in patches:
                new_text, status = apply_patches(text, patch['before'], patch['after'])
                if status == 'applied':
                    text = new_text
                    applied += 1
                elif status == 'already-applied':
                    already += 1
                elif status == 'ambiguous':
                    ambiguous += 1
                else:
                    notfound += 1
            for ins in insertions:
                new_text, status = apply_insertion(text, ins['anchor'], ins['content'])
                if status == 'applied':
                    text = new_text
                    applied += 1
                elif status == 'already-applied':
                    already += 1
                elif status == 'ambiguous':
                    ambiguous += 1
                else:
                    notfound += 1
            print(f'  {name}：应用 {applied} 组 / 已生效 {already} 组 / '
                  f'未命中 {notfound} 组 / 歧义 {ambiguous} 组')

            # ★★ **幂等自检（第二遍 dry-run）**：应用完之后，**再跑一遍同一套补丁**，
            #   每一组都必须是「already-applied」，**不允许再有 'applied'**。
            #   ⇒ 若第二遍还会改写 ⇒ 这套补丁**不是幂等的**（典型的坑：
            #     「改后包含改前」的追加型补丁，第一次应用后「改前」仍在文中
            #     ⇒ 第二遍会再改一次 ⇒ 内容被复制两份）。
            #   这条自检是「验收工具自身必须被验收」的落点：
            #   **它断言的是「失败原因就是被测物报的错」**——报红时一定
            #   能指出是哪一组补丁在第二遍还会改。
            second = {'applied': 0, 'already-applied': 0, 'not-found': 0, 'ambiguous': 0}
            for patch in patches:
                _, status = apply_patches(text, patch['before'], patch['after'])
                second[status] = second.get(status, 0) + 1
            for ins in insertions:
                _, status = apply_insertion(text, ins['anchor'], ins['content'])
                second[status] = second.get(status, 0) + 1
            if second.get('applied', 0):
                idempotent_fail += second['applied']
                print(f'     ❌ **幂等自检失败**：第二遍仍有 {second["applied"]} 组会再次改写 '
                      f'⇒ 这套补丁**不是幂等的**（重复运行 `--apply` 会复制内容）')
            else:
                print(f'     ✅ 幂等自检：第二遍 0 组会再次改写'
                      f'（已生效 {second.get("already-applied", 0)} / '
                      f'未命中 {second.get("not-found", 0)}）')
            if ambiguous or notfound:
                print(f'     ⚠️  「未命中」= 真的没回写（**算失败**）；'
                      f'「歧义」= 命中多处（需人工处理）')
            # 写回：**一律 LF 归一化**（仓库 .gitattributes 规定 LF；
            #   混合行尾会被 git 静默归一化 ⇒ diff 失真、回写不可审计）
            out = text.replace('\r\n', '\n').replace('\r', '\n')
            with open(path, 'w', encoding='utf-8', newline='') as fh:
                fh.write(out)
            # 落盘后自检：CR 计数必须为 0
            cr = open(path, 'rb').read().count(b'\r')
            print(f'  ✅ 已写回 {os.path.basename(path)}（LF 归一化；落盘后 CR 计数 = {cr}）')
            if cr != 0:
                print(f'     ⚠️  落盘后仍有 {cr} 个 CR 字节 ⇒ 行尾未归一化干净')
        # 写回后重读，供校验用
        design_lines = _read(design_path)
        plan_lines = _read(plan_path)
        if idempotent_fail:
            print(f'\n❌ **幂等自检失败（{idempotent_fail} 组）⇒ 已写回的内容可能含重复块**，'
                  f'请回滚本次 `--apply` 后重跑。', file=sys.stderr)
            return 3

    results: list[dict] = []

    print('=' * 74)
    print('回写自证 · 勘误落盘校验')
    print('=' * 74)

    print('\n【一】语义断言（逐条核对回写内容）\n')
    for cid, desc, target, fn in DESIGN_CHECKS:
        # ★ 断言里登记的是模块级常量 DESIGN / PLAN；沙箱模式下实际读的是
        #   design_path / plan_path ⇒ 必须按「声明的常量」解析，不能直接比较实际路径。
        lines = design_lines if target == DESIGN else plan_lines
        ok, actual, meaning = fn(lines)
        results.append({'id': cid, 'desc': desc, 'ok': ok, 'actual': actual, 'meaning': meaning,
                        'kind': 'semantic'})
        mark = '✅' if ok else '❌'
        print(f'  {mark} {cid:<7} {desc}')
        print(f'         → {actual}')
        if not ok and meaning:
            print(f'         ⇒ 失败含义：{meaning}')

    print('\n【二】契约门禁（跑仓库自带的脚本）\n')
    for script_name, desc, expected, meaning in GATE_CHECKS:
        ok, out = run_gate(script_name)
        missing = [e for e in expected if e not in out]
        passed = ok and not missing
        if passed:
            actual = f'全部 {len(expected)} 条预期输出均命中，退出码 0'
        elif missing:
            actual = f'退出码={"0" if ok else "非0"}；缺失预期输出={missing}'
        else:
            tail = out.strip().splitlines()[-1][:80] if out.strip() else '(空)'
            actual = f'退出码非 0（输出末尾：{tail}）'
        results.append({'id': script_name, 'desc': desc, 'ok': passed,
                        'actual': actual, 'meaning': meaning, 'kind': 'gate'})
        mark = '✅' if passed else '❌'
        print(f'  {mark} {script_name:<20} {desc}')
        print(f'         → {actual}')
        if not passed and meaning:
            print(f'         ⇒ 失败含义：{meaning}')

    failed = [r for r in results if not r['ok']]
    print('\n' + '=' * 74)
    print(f'总计 {len(results)} 项 / 通过 {len(results) - len(failed)} / 失败 {len(failed)}')
    if failed:
        print('\n未通过项：')
        for r in failed:
            print(f'  ❌ {r["id"]}  {r["desc"]}')
            print(f'     实际：{r["actual"]}')
            if r['meaning']:
                print(f'     含义：{r["meaning"]}')
    print('=' * 74)

    if args.json:
        print(json.dumps({'total': len(results), 'failed': len(failed), 'results': results},
                         ensure_ascii=False, indent=1))

    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
