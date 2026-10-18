# attitude-gnss-vis — Attitude-Aware GNSS Satellite Visibility & PDOP Simulator

A single-file web research tool. Load a RINEX 3.04 broadcast ephemeris and an
attitude-tagged vehicle trajectory, and it computes — in real time — the number of
satellites actually visible to the **antenna panel** and the corresponding **PDOP**,
rendered as dual-perspective sky plots plus two linked time-series charts.

**中文版：[README.md](README.md)**

---

## Highlights

- **Single file, zero dependencies, fully offline.** Everything — HTML, CSS, JS — lives in
  `gnss_pdop_tool.html`. Double-click it and it runs; no build step, no server, and the page
  issues **zero network requests**. It ships with 20 built-in self-tests, so you can see
  whether the algorithm is self-consistent the moment you open it.
- **Seven constellations**: GPS, BeiDou (BDS), GLONASS, Galileo, QZSS, SBAS, NavIC.
  Kepler-type systems (G/E/C/J/I) go through broadcast ephemeris propagation; state-vector
  types (R/S) use second-order position extrapolation.
- **Attitude-aware.** The mask angle is defined relative to the antenna panel normal, not to
  the local horizontal. Tilt the vehicle and the mask cone tilts with it.
- **Batch runs.** Fix one input, multi-select the other kind, and anchor every task to the
  same absolute instant by an explicit rule — answering "how much does this change if I swap
  yesterday's ephemeris" or "…if I swap the flight path". The single-run interface is left
  exactly as it was.
- **Numerically verifiable.** The repo carries an *independently rewritten Python
  implementation* (`reference/ref_pdop.py`) plus two test suites. The JS and Python
  implementations cross-check each other; a real receiver's field measurements serve as a
  regression fixture.

## Quick start

```bash
git clone https://github.com/xldang/attitude-gnss-vis.git
cd attitude-gnss-vis
# just double-click gnss_pdop_tool.html, or:
xdg-open gnss_pdop_tool.html        # Linux
open gnss_pdop_tool.html            # macOS
```

Then select the two sample inputs in the page:

| Input | Sample path |
|---|---|
| Ephemeris | `samples/rnx/BRDM00DLR_S_20262690000_01D_MN.rnx` |
| Trajectory | `samples/traces/flight_shanghai_xian_5000.csv` |

Drag the elevation mask slider (0°–45°, default 15°) — both charts and both sky plots
recompute immediately. "Export research data" downloads a per-epoch CSV whose header is
fixed at the 7 canonical names (`Time`/`Longitude`/`Latitude`/`Height`/`Yaw`/`Pitch`/`Roll`)
plus `Visible_Count`, `PDOP` and `PRN_label` — whatever the input file looked like.

## Repository layout

```
attitude-gnss-vis/
├─ gnss_pdop_tool.html      Main program: single file, zero deps, double-click to run
├─ reference/
│  └─ ref_pdop.py           Independent Python implementation (numerical baseline for the JS)
├─ test/
│  ├─ test_core.js          Node core regression: JS vs Python, epoch by epoch
│  ├─ e2e_browser.js        Browser end-to-end: drives real Chrome over CDP (self-reports its assertion count)
│  ├─ fixtures/
│  │  ├─ train_set.csv      Real receiver measurements (regression fixture)
│  │  ├─ trace_cn_shuffled.csv   Chinese headers, shuffled, extra columns (a mapping workout)
│  │  ├─ trace_opaque.csv   Headers matching no alias: manual mapping is the only way
│  │  ├─ trace_space.dat    Space-delimited, fixed-width aligned, Chinese headers
│  │  └─ sky-ref/           Measured sky-plot screenshots, one per epoch of train_set.csv
│  └─ tools/
│     ├─ shot.js            Page screenshot + canvas diagnostics
│     └─ shot_tip.js        Tooltip layout checker
├─ samples/
│  ├─ rnx/                  Ephemeris sample (BKG public broadcast ephemeris)
│  └─ traces/               Trajectory samples (produced by sim-trace; a csv and two .dat)
└─ build/                   Test artifacts (gitignored)
```

## Input specification

### Ephemeris: RINEX 3.04 navigation file

Mixed-system broadcast messages are supported. Kepler-type systems (GPS / Galileo /
BeiDou / QZSS / NavIC) get full harmonic corrections from BROADCAST ORBIT 1–7;
GLONASS and SBAS get XYZ + velocity + acceleration.

### Trajectory: CSV / DAT

Required columns (**the names do not have to be these**):

| Column | Unit | Meaning |
|---|---|---|
| `Time` | s | Relative timestamp; sampling interval need not be uniform |
| `Longitude` | deg | East positive |
| `Latitude` | deg | North positive |
| `Height` | m | Ellipsoidal (geodetic) height |
| `Yaw` | deg | Heading, **north = 0, west of north positive (+), east of north negative (−)**, in (−180, +180] |
| `Pitch` | deg | Nose-up positive |
| `Roll` | deg | Right-wing-down positive |

**On column names, order and count**: the tool detects the columns first and only asks you to
point at them once when detection fails.
- Names may be Chinese (`时间` / `经度` / `纬度` / `高程` / `航向角` / `俯仰角` / `横滚角`)
  or carry a unit suffix (`Height (m)`) — units in brackets and any separators are stripped
  before comparison.
- **Column order is irrelevant**: internally this is a "canonical field → real column index"
  mapping, so any ordering works.
- **Extra columns are kept as-is**: they take no part in the computation and never reach the
  export (whose columns are fixed — see "Export").
- Anything it cannot identify is a hard failure naming the missing columns — it never
  silently substitutes 0.

**On file formats**: `.csv` / `.dat` / `.txt` go through the text parser, which sniffs the
delimiter — comma, tab, semicolon, pipe, and **space as a last resort** (so fixed-width
`.dat` works too; runs of spaces collapse into one). The decision is made by the column
count of the header line, so a comma file whose *field names contain spaces*
(`GPS Time, Longitude, …`) is not stolen by the space rule. The text layer also honours
RFC-4180 quoting (sample `train_set.csv` has a `"G01,G02"`-style `PRN_label` column).

**Batch import resolves the mapping once**: the first trajectory in a batch is detected
automatically and the resulting mapping is applied to every file after it. So for a hundred
trajectories that share one column scheme, you point at the first one and never touch the
rest. Each file's header is compared against the first; any that differ are flagged
separately (`N 份表头不一致`) rather than being parsed with a mapping that may not fit.
Changing the mapping clears the parsed objects, task table and run results, because those
results were computed from the old columns and are worse than no results at all.

The same format is produced by **[sim-trace](https://github.com/your-id/sim-trace)**.

## Frame and attitude conventions

- Body axes: **X-right / Y-forward / Z-up** (Z is the antenna panel normal).
- Attitude DCM: `C_enu^b = Ry(−roll) · Rx(−pitch) · Rz(−yaw)`; rows express body-frame axes in ENU.
- A satellite is counted only when **both** criteria hold:
  1. `z_b > sin(mask)` — elevation relative to the panel normal exceeds the mask;
  2. `up > 0` — not blocked by the Earth itself (above the local horizon).
- PDOP comes from `G = (HᵀH)⁻¹`; it is `NaN` when fewer than 4 satellites are counted.
- **Ephemeris selection**: the newest record with `t_abs ≤ t`; if the satellite's first
  record is later than `t`, that first record is used to extrapolate backwards. Both paths
  must fall inside a `±2 h` window (`EPH_MAX_AGE`); anything outside is treated as an
  unavailable (epoch, satellite) pair. The resulting fraction is reported in the log and
  the status bar as “ephemeris expired x%”. The sample ephemeris deviates by at most
  +1.39 h / −2.00 h, so the default window drops nothing for this dataset.

## Batch runs

The single-run interface is **untouched** apart from one new “批量任务” button at the top.
The batch overlay has its own inputs, its own mask and constellation selection, and its own
result views, fully isolated from single-run state (one e2e assertion guards that boundary).
The core pipeline `parseRinex → buildLOSChunk → solveAll` is reused verbatim, so batch and
single-run results share one numeric definition — measured: the same input yields 53.413
mean satellites in both.

| Mode | Fixed file | Multi-select | Source of the difference |
|---|---|---|---|
| ① | Trajectory CSV | several ephemeris files | day-to-day ephemeris variation |
| ② | Ephemeris RINEX | several trajectory CSVs | flight-path / attitude variation |

**Each mode keeps its own workspace, and switching loses nothing.** Switching modes just
swaps slots: file selections, parsed results, the preview table, the plotted curves and the
baseline choice all stay where they are and come back bit-identical — you don't even have to
re-pick the files. The mask angle and start instant are *shared* controls, so the results
panel stamps which mode, mask and start instant produced the curves you are looking at; change
a parameter, switch back, and it is obvious whether a re-run is due.

(Mode selection is locked while a batch is running — otherwise in-flight results would be
written into the other mode's workspace.)

### How file names are shown

The browser's own "no file chosen / N files" line cannot be updated programmatically
(`input.files` is read-only), and after a mode switch it refers to the *other* mode's
selection rather than the one in use. So the native input is hidden and the file name is
rendered by the page itself — **fixed file and multi-select file use the same path**:

| State | Shown |
|---|---|
| Nothing picked | `未选择` |
| Parsing | `解析中 3/8 份：<current file>` |
| Ready | `xxx.rnx · 96 sats` / `xxx.csv · 5000 rows` |
| Failed | `xxx.rnx · parse failed: trajectory CSV is missing columns: …` |

Multi-select is abbreviated by count so the count is never cut off by the ellipsis: **1
file** shows the full name, **2 files** are joined with `、`, **≥3 files** become
`first 等 N 份`. The complete list plus "N files total, M parsed successfully" goes into
the tooltip, and the number of failures follows directly (`… 等 8 份（2 份解析失败）`) —
reporting "8 files chosen" without saying 2 of them never made it in is the display most
likely to be misread.

### How the start instant is anchored

`Time` in a trajectory is a relative second offset and carries no absolute date. Batch mode
anchors it to UTC with an explicit “start instant” field:

- **Mode ①** uses the **day holding the most broadcast records** in each ephemeris file,
  plus the given time of day. “Most records” rather than “first covered day” is deliberate:
  a nominally one-day file often starts covering on the previous evening. The sample
  `BRDM00DLR_S_20262690000` covers 2026-09-25 23:59:42 → 09-26 23:59:44, with 15060 records
  on 09-26 and only 89 on 09-25 — anchoring at the coverage start would shift everything by
  12 hours and mark every task expired.
- **Mode ②** gives every trajectory the same absolute instant, all counted from the
  identical moment.

Before running, a preview table reports **coverage** per file: `ok` (the whole trajectory lies
inside the ephemeris span), `edge` (partly inside the ±2 h window), `out` (essentially no
coverage — numbers from such a task are untrustworthy and are flagged red).

### Grid consistency (mode ②)

Trajectories may differ in epoch count, step and span (the `train_set.csv` sample is 9 points
at 3600 s; the flight profile is 5000 at 1 s). This does not affect the aggregate statistics,
but it does make the x values of the per-epoch CSV unalignable, so the preview table flags
grid consistency separately and tells you to read the aggregate when it fails.

### The four result views

| View | Content |
|---|---|
| Comparison curves | Per-epoch curves of all tasks. The y-axis toggles between **Δ baseline** and **absolute** — under Δ the baseline itself is identically 0 (a line on the floor), so only the absolute view tells you what it dropped *from*. Click a legend entry to change the baseline |
| Date trend | Mode ①: one point per ephemeris file, x ordered by anchored date |
| Trajectory spread | Mode ②: one point per trajectory, x = mean altitude |
| Summary table | Per task: epochs, visible count mean/extremes, PDOP mean/peak, NaN ratio, drop rate, elapsed ms |

### Export

Every filename carries the mask angle (re-exporting at a different mask saves a separate copy
rather than overwriting):

| Button | Output |
|---|---|
| **Export research data CSV** (single task) | per-epoch, header fixed at 10 columns (below) |
| **Per-task ZIP** | one zip, **one csv per task**, in exactly the same shape as the single-task export, members named `A_on_B_mask<mask>_<NN>.csv` |
| Per-epoch CSV (combined) | one long table (`task,t0_utc,epoch,t_rel_s,visible_count,pdop,drop_rate`) with every task concatenated |
| Summary CSV | one row per task (`task,t0_utc,epochs,mean_visible,...,drop_rate,cover,ms`) |

**The per-epoch csv has a fixed set of 10 columns**, produced by one shared routine for the
single-task export and for every member of the zip:

```
Time,Longitude,Latitude,Height,Yaw,Pitch,Roll,Visible_Count,PDOP,PRN_label
```

The first seven are the **canonical names the mapping resolved to**; the last three are the
products. Every other column in the source file is left behind — vendor note columns, spare
experiment columns, odd ordering, Chinese headers — all stay on the input side. Having already
paid for column detection and mapping, the output should be normalised rather than hand the
uncontrolled shape of the input downstream. The combined table and the summary table are a
*different* product (task-to-task comparison), which is why they keep a `task` column on purpose.

**Why a zip rather than one download per task**: a batch of a hundred tasks is a hundred
programmatic downloads, and the browser blocks them from the second one onward ("this site
attempted to download multiple files"), so it amounts to being unable to export at all. One zip
triggers one download; unpacked, it is exactly the one-csv-per-task you wanted. Compression uses
the browser's native `CompressionStream` — no dependency is added.

The **naming rule** is one rule for both modes: `A_on_B_mask<mask>_<NN>.csv`, where **A is the
fixed-side input and B is this task's input** (mode ① A=trace, B=ephemeris; mode ② the reverse).
`NN` is the task index, zero-padded to a common width (a hundred tasks give `_001`…`_100`), so a
file manager sorting by name sorts numerically. Chinese, parentheses and spaces in filenames are
kept verbatim; only the characters Windows actually forbids (`\ / : * ? " < > |`) are replaced,
and each stem is truncated to 64 characters.

Task name, fixed-side name, mask and start instant take no column: the filename already carries
A, B and the mask, and every task in a batch is anchored to one instant, so all of it is constant
inside a single csv. The mask in the filename comes from the value actually used for that run,
not the current slider position: the batch mask slider only changes the parameter and does not
invalidate results, so naming from the slider would produce files labelled "23°" over 0° data.

## Verification

```bash
python reference/ref_pdop.py          # print Python baseline statistics
python reference/ref_pdop.py --dump   # export per-epoch JSON to build/
node test/test_core.js                # core regression (no browser needed)
node test/e2e_browser.js              # browser end-to-end (requires local Chrome)
```

Both Node suites must be fully green. This is not ceremony — each catches a distinct class
of real defect.

### Cross-validation (Python reference implementation)

`reference/ref_pdop.py` is a from-scratch second implementation in a different language and
style. `test_core.js` compares the JS output against it epoch by epoch and asserts hardcoded
baselines for six aggregate scenarios:

| Scenario | Mean satellite count | Mean PDOP |
|---|---|---|
| All 7 systems, 15° mask | 53.413 | 0.6224 |
| GPS only | 7.347 | 1.8805 |
| BeiDou only | 16.564 | 1.2263 |
| GPS + BeiDou | 23.911 | 0.9594 |

Plus a 7-point mask-angle sweep and 4 sampled epochs compared value by value.

### Measured-data regression (`test/fixtures/train_set.csv`)

Collected hourly through 2026-09-26 from a real receiver at a fixed Shanghai site
(121.479216°E, 31.236807°N, h = 4 m, attitude 0/0/0). GPS only, 15° mask:

| Metric | Result |
|---|---|
| Epochs whose satellite count matches measurement exactly | **8 / 9** |
| Mean \|ΔN\| | **0.111** |
| PRN hits | **74 / 75** (Jaccard 0.988) |
| Mean \|ΔPDOP\| | **0.466** |

The single miss is G10 at simulated elevation 14.87° — just 0.13° below the 15° mask, i.e.
ordinary jitter at the mask boundary. Simulated PDOP is systematically slightly *lower* than
measured (9/9 epochs), which is expected: a real receiver solves with a subset already
filtered by C/N0 and HDOP gates, so its geometry is necessarily slightly worse than
"all geometrically visible satellites".

The dataset was collected in the field by the project author on 2026-09-26. Each epoch's
measured sky plot sits next to the CSV in the same directory and corresponds to it row by
row: the row with `Time` = 3600·k seconds pairs with `fixtures/sky-ref/UTC-kh.png`
(k = 0…8), so you can check a discrepancy by eye against the photograph.

### Algorithm defects that were found and fixed

Early versions contained four **mutually independent** algorithmic errors, each falsifiable
from invariants internal to the data itself — no external benchmark required. All four are
fixed, and each fix is now guarded by a physical criterion that actually catches it:

| # | Defect | Criterion used to prove it | Before → after |
|---|---|---|---|
| 1 | Latitude argument in Kepler propagation omitted the true anomaly `ν` | Two adjacent broadcast records of one satellite propagated to the same epoch must agree | median residual **8380 m** → **2.86 m** |
| 2 | ECEF→ENU applied only the longitude rotation, no latitude rotation | A synthetic zenith LOS must yield 90° elevation | **31.2°** → **90.0°** |
| 3 | Sagnac correction used absolute GPS seconds instead of signal flight time | A synthetic due-north LOS must have zero azimuth error | **259.55°** off → 0.0003° |
| 4 | `Crs` was read from the IODE slot of the epoch line | — | `Crs ≡ 0` → correct range ±95 m |

Defect 1 was the most insidious: it froze every satellite at a fixed point on its orbit, so
the sky plot never moved — yet all 16 self-tests passed anyway (criteria such as
`|lat| ≤ |i0|` and "orbital radius within nominal band" all hold for a frozen orbit).
Three **time-dependent** physical criteria were therefore added to the self-test panel, since
only those can catch it:

1. **Adjacent-ephemeris self-consistency** — consecutive records propagated to the same epoch
   must agree to a median < 50 m;
2. **Latitude must vary with time** — `|Δlat(t, t+600 s)| > 0.05°`;
3. **Synthetic ENU vectors** — zenith → 90° elevation; north/east → 0° elevation at azimuth
   0°/90°.

## Known limitations

- Broadcast ephemeris is good to roughly 1–3 m, and this tool models **no** ionospheric,
  tropospheric, satellite-clock or relativistic correction, and performs no point-positioning
  solution. What it outputs is the **geometric dilution of precision**, not actual positioning
  error.
- `Time` in the trajectory is a relative timestamp with no absolute date. In single-run mode
  the absolute epoch is established implicitly by aligning the trajectory's first epoch with
  the first broadcast record in the ephemeris file. Confirm this correspondence yourself when
  using ephemeris from a different day — the “ephemeris expired” figure on the status bar is
  the direct indicator when it does not hold. Batch mode makes the correspondence explicit
  (start-instant field plus a coverage verdict), but the anchored *date* is still an
  **inference**: if a file's records are too evenly spread to identify one dominant day, check
  the anchored date in the preview table by hand.
- `Height` is used directly as ellipsoidal height; no geoid correction is applied.
- Broadcast ephemeris only — precise and rapid products are not supported.

## Data sources

- `samples/rnx/BRDM00DLR_S_20262690000_01D_MN.rnx` — BKG (German Federal Agency for
  Cartography and Geodesy) public BRDC mixed broadcast ephemeris, day 269 of 2026.
- `samples/traces/flight_shanghai_xian_5000.csv` — Shanghai→Xi'an airliner flight profile
  (5000 samples at 1 Hz) generated by
  [sim-trace](https://github.com/your-id/sim-trace).
- `samples/traces/trace-type1.dat` / `trace-type2.dat` — the demo pair for batch mode:
  one flight profile written two ways (comma- vs space-delimited, canonical vs abbreviated
  and Chinese headers), 5000 epochs each, to show that column mapping plus a common start
  instant makes the two inputs comparable.
- `test/fixtures/train_set.csv`, `test/fixtures/sky-ref/*.png` — field measurements collected by the
  project author.

## License

[MIT](LICENSE)
