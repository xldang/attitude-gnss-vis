# attitude-gnss-vis — 载体姿态敏感型卫星可见性及 PDOP 仿真

单文件 Web 科研工具。导入 RINEX 3.04 广播星历与带姿态的载体轨迹，实时计算
**天线面实际可见的卫星数量**与 **PDOP**，并以双视角星空图和联动曲线呈现。

**English version: [README.en.md](README.en.md)**

---

## 特点

- **单文件、零依赖、完全离线**。`gnss_pdop_tool.html` 一个文件装下全部 HTML/CSS/JS，
  双击即可用，浏览器直接 `file://` 打开即可运行，不发起任何网络请求。页面内含
  19 项自检，用户打开就能看到算法是否自洽。
- **七系统**：GPS、北斗 BDS、GLONASS、Galileo、QZSS、SBAS、NavIC。开普勒型
  （G/E/C/J/I）走广播星历传播，状态矢量型（R/S）直接做二阶位置外推。
- **姿态敏感**：掩角定义在天线面法线上，不是地理高度角。载体一动，掩角锥跟着动。
- **数值可验证**：仓库内含一份**用 Python 独立重写的参考实现**（`reference/ref_pdop.py`）
  和两套测试，JS 与 Python 互为交叉验证；另有一份真实接收机实测基准做回归。

## 快速开始

```bash
git clone <this-repo> attitude-gnss-vis
cd attitude-gnss-vis
# 直接双击 gnss_pdop_tool.html，或：
start gnss_pdop_tool.html          # Windows
```

页面上依次选择两个样本文件：

| 输入项 | 样本路径 |
|---|---|
| 星历 | `samples/rnx/BRDM00DLR_S_20262690000_01D_MN.rnx` |
| 轨迹 | `samples/traces/flight_shanghai_xian_5000.csv` |

跑完后拖动"高度角截止（掩角）"滑块（0°–45°，默认 15°），两张曲线与两张星空图
立即重算。点击"导出科研数据"可下载带 `Visible_Count` / `PDOP` / `PRN_label`
三列的 CSV。

## 目录结构

```
attitude-gnss-vis/
├─ gnss_pdop_tool.html      主程序：单文件、零依赖、可直接双击
├─ reference/
│  └─ ref_pdop.py           Python 独立参考实现（JS 的数值基准）
├─ test/
│  ├─ test_core.js          Node 核心回归：JS vs Python 逐历元比对
│  ├─ e2e_browser.js        浏览器端到端：CDP 驱动真实 Chrome，88 项断言
│  ├─ fixtures/
│  │  ├─ train_set.csv      真实接收机实测基准（回归固件）
│  │  └─ sky-ref/           对应历元的实测星空图截图，与 train_set.csv 逐行一一对应
│  └─ tools/
│     ├─ shot.js            页面截图 + 画布诊断
│     └─ shot_tip.js        说明气泡排版检查
├─ samples/
│  ├─ rnx/                  星历样本（BKG 公开广播星历）
│  └─ traces/               轨迹样本（由 sim-trace 生成）
├─ docs/
│  └─ spec-original.md      原始需求规格（设计留档）
└─ build/                   测试产物（已 gitignore）
```

## 输入数据规范

### 星历：RINEX 3.04 导航文件

支持多系统混合电文。开普勒型（GPS / Galileo / BeiDou / QZSS / NavIC）解析
BROADCAST ORBIT 1–7 全部谐波改正项；GLONASS 与 SBAS 解析 XYZ + 速度 + 加速度。

### 轨迹：CSV

必需列（列名区分大小写）：

| 列 | 单位 | 含义 |
|---|---|---|
| `Time` | s | 相对时间戳，间隔可不等 |
| `Longitude` | deg | 经度，东经为正 |
| `Latitude` | deg | 纬度，北纬为正 |
| `Height` | m | 大地高（椭球高） |
| `Yaw` | deg | 航向角，**正北 0，北偏西为正（+），北偏东为负（−）**，取值 (−180, +180] |
| `Pitch` | deg | 俯仰角，抬头为正 |
| `Roll` | deg | 滚转角，右滚为正 |

同一份格式由 **[sim-trace](https://github.com/your-id/sim-trace)** 生成。

## 坐标与姿态约定

- 机体轴：**X-右 / Y-前 / Z-上**（Z 即天线面法线）。
- 姿态 DCM：`C_enu^b = Ry(−roll) · Rx(−pitch) · Rz(−yaw)`，行向量为机体系轴在 ENU 中的表示。
- 可见判据**两条同时满足**才算计入：
  1. `z_b > sin(掩角)` —— 相对天线面法线的高度角高于掩角；
  2. `up > 0` —— 未被地球本体遮挡（地平线以下）。
- PDOP 由 `G = (HᵀH)⁻¹` 求得，可视星 < 4 时为 `NaN`。

## 验证

```bash
python reference/ref_pdop.py          # 打印 Python 基准统计
python reference/ref_pdop.py --dump   # 导出逐历元 JSON 到 build/
node test/test_core.js                # 核心回归（无需浏览器）
node test/e2e_browser.js              # 浏览器端到端（需本机 Chrome）
```

两条命令都**必须全绿**。这不是形式检查——它们各自能抓到一类真实缺陷：

### 交叉验证（Python 参考实现）

`reference/ref_pdop.py` 是用不同语言、不同写法独立重写的一套实现，
`test_core.js` 把 JS 输出与它逐历元比对，并断言六组统计量的硬编码基准值：

| 场景 | 平均星数 | 平均 PDOP |
|---|---|---|
| 全部 7 系统，掩角 15° | 53.413 | 0.6224 |
| 仅 GPS | 7.347 | 1.8805 |
| 仅北斗 | 16.564 | 1.2263 |
| GPS + 北斗 | 23.911 | 0.9594 |

外加 7 组掩角扫描与 4 个抽样历元的逐值比对。

### 实测基准回归（`test/fixtures/train_set.csv`）

2026-09-26 全天逐小时，在上海一点位（121.479216°E, 31.236807°N, h = 4 m, 姿态 0/0/0）
采集的真实接收机定位解算数据。仅 GPS、掩角 15°：

| 指标 | 结果 |
|---|---|
| 9 个历元中星数与实测完全相同 | **8 / 9** |
| 平均 \|ΔN\| | **0.111** |
| PRN 命中 | **74 / 75**（Jaccard 0.988） |
| 平均 \|ΔPDOP\| | **0.466** |

唯一未命中的 G10 仿真仰角 14.87°，恰好差 0.13° 落在 15° 掩角之下——掩角边缘的
正常抖动。仿真 PDOP 系统性略低于实测（9/9 个历元），这是合理的：接收机参与解算的
是被 C/N0 与 HDOP 门限筛过的子集，几何必然略差于"全部几何可见星"。

该数据集由项目作者于 2026-09-26 实地采集。每个历元的实测星空图截图与 CSV 逐行
一一对应，放在同一目录下：第 `Time` = 3600·k 秒的行对应 `fixtures/sky-ref/UTC-kh.png`
（k = 0…8），对照排查时可直接看图核星。

### 已修复的算法缺陷

项目早期版本存在四处**互相独立**的算法错误，均由数据自身的不变式证伪，无需外部基准。
它们已被逐条修复，并各自补上了能抓住它们的物理判据：

| # | 缺陷 | 判定依据 | 修复前 → 修复后 |
|---|---|---|---|
| 1 | 开普勒传播的纬度幅角漏掉真近点角 `ν` | 相邻两条电文推到同一时刻应位置一致 | 残差中位数 **8380 m** → **2.86 m** |
| 2 | ECEF→ENU 只做经度旋转，缺纬度旋转 | 合成天顶 LOS 应得仰角 90° | **31.2°** → **90.0°** |
| 3 | 地球自转改正（Sagnac）误用绝对 GPS 秒 | 应对合成正北方位无偏转 | 偏 **259.55°** → 0.0003° |
| 4 | `Crs` 从历元行的 IODE 槽位读取 | 丢失最大 ~150 m 径向谐波 | `Crs ≡ 0` → 正确值域 ±95 m |

缺陷 1 尤其隐蔽：它让卫星被冻结在各自轨道上的同一点，星空图全天不转，而当时
全部 16 项自检**照样全绿**（`|lat| ≤ |i0|`、轨道半径在标称带内等判据在冻结状态下
都成立）。因此自检面板新增了三条**时间相关**的物理判据——这类判据是唯一能抓住
它的：

1. **相邻电文自洽性**：同一卫星相邻两条广播电文推到同一时刻，位置差中位数须 < 50 m；
2. **纬度必须随时间变化**：`|Δlat(t, t+600 s)| > 0.05°`；
3. **ENU 合成向量**：天顶 → 仰角 90°，正北/正东 → 仰角 0°、方位 0°/90°。

## 已知限制

- 广播星历精度约 1–3 m，**本工具不建模电离层、对流层、卫星钟差与 relativistic 改正**，
  也不做单点定位解算。输出的是**几何精度因子**，不是实际定位误差。
- 轨迹的 `Time` 是相对时间戳，不含绝对日期。星历的绝对时刻通过"轨迹首历元对齐
  样本星历首条电文"隐式确定。换用不同日期的星历时需自行确认这一对应关系。
- `Height` 按椭球高直接使用，不做大地水准面改正。
- 仅支持广播星历，不支持精密/快速星历。

## 数据来源

- `samples/rnx/BRDM00DLR_S_20262690000_01D_MN.rnx` — 德国联邦测绘与地理信息局
  (BKG) 公开的 BRDC 混合广播星历，2026 年第 269 天。
- `samples/traces/flight_shanghai_xian_5000.csv` — 由 [sim-trace](https://github.com/your-id/sim-trace)
  生成的上海→西安民航航班仿真轨迹（5000 个 1 Hz 采样点）。
- `test/fixtures/train_set.csv`、`test/fixtures/sky-ref/*.png` — 项目作者实地采集的实测数据。

## 许可

[MIT](LICENSE)
