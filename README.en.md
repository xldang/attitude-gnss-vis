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
  issues **zero network requests**. It ships with 19 built-in self-tests, so you can see
  whether the algorithm is self-consistent the moment you open it.
- **Seven constellations**: GPS, BeiDou (BDS), GLONASS, Galileo, QZSS, SBAS, NavIC.
  Kepler-type systems (G/E/C/J/I) go through broadcast ephemeris propagation; state-vector
  types (R/S) use second-order position extrapolation.
- **Attitude-aware.** The mask angle is defined relative to the antenna panel normal, not to
  the local horizontal. Tilt the vehicle and the mask cone tilts with it.
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
recompute immediately. "Export research data" downloads a CSV with three appended columns:
`Visible_Count`, `PDOP`, `PRN_label`.

## Repository layout

```
attitude-gnss-vis/
├─ gnss_pdop_tool.html      Main program: single file, zero deps, double-click to run
├─ reference/
│  └─ ref_pdop.py           Independent Python implementation (numerical baseline for the JS)
├─ test/
│  ├─ test_core.js          Node core regression: JS vs Python, epoch by epoch
│  ├─ e2e_browser.js        Browser end-to-end: drives real Chrome over CDP, 88 assertions
│  ├─ fixtures/
│  │  ├─ train_set.csv      Real receiver measurements (regression fixture)
│  │  └─ sky-ref/           Measured sky-plot screenshots, one per epoch of train_set.csv
│  └─ tools/
│     ├─ shot.js            Page screenshot + canvas diagnostics
│     └─ shot_tip.js        Tooltip layout checker
├─ samples/
│  ├─ rnx/                  Ephemeris sample (BKG public broadcast ephemeris)
│  └─ traces/               Trajectory sample (produced by sim-trace)
├─ docs/
│  └─ spec-original.md      Original specification (kept for design provenance)
└─ build/                   Test artifacts (gitignored)
```

## Input specification

### Ephemeris: RINEX 3.04 navigation file

Mixed-system broadcast messages are supported. Kepler-type systems (GPS / Galileo /
BeiDou / QZSS / NavIC) get full harmonic corrections from BROADCAST ORBIT 1–7;
GLONASS and SBAS get XYZ + velocity + acceleration.

### Trajectory: CSV

Required columns (case-sensitive):

| Column | Unit | Meaning |
|---|---|---|
| `Time` | s | Relative timestamp; sampling interval need not be uniform |
| `Longitude` | deg | East positive |
| `Latitude` | deg | North positive |
| `Height` | m | Ellipsoidal (geodetic) height |
| `Yaw` | deg | Heading, **north = 0, west of north positive (+), east of north negative (−)**, in (−180, +180] |
| `Pitch` | deg | Nose-up positive |
| `Roll` | deg | Right-wing-down positive |

The same format is produced by **[sim-trace](https://github.com/your-id/sim-trace)**.

## Frame and attitude conventions

- Body axes: **X-right / Y-forward / Z-up** (Z is the antenna panel normal).
- Attitude DCM: `C_enu^b = Ry(−roll) · Rx(−pitch) · Rz(−yaw)`; rows express body-frame axes in ENU.
- A satellite is counted only when **both** criteria hold:
  1. `z_b > sin(mask)` — elevation relative to the panel normal exceeds the mask;
  2. `up > 0` — not blocked by the Earth itself (above the local horizon).
- PDOP comes from `G = (HᵀH)⁻¹`; it is `NaN` when fewer than 4 satellites are counted.

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
- `Time` in the trajectory is a relative timestamp with no absolute date. The absolute epoch
  is established implicitly by aligning the trajectory's first epoch with the first broadcast
  record in the ephemeris file. Confirm this correspondence yourself when using ephemeris
  from a different day.
- `Height` is used directly as ellipsoidal height; no geoid correction is applied.
- Broadcast ephemeris only — precise and rapid products are not supported.

## Data sources

- `samples/rnx/BRDM00DLR_S_20262690000_01D_MN.rnx` — BKG (German Federal Agency for
  Cartography and Geodesy) public BRDC mixed broadcast ephemeris, day 269 of 2026.
- `samples/traces/flight_shanghai_xian_5000.csv` — Shanghai→Xi'an airliner flight profile
  (5000 samples at 1 Hz) generated by
  [sim-trace](https://github.com/your-id/sim-trace).
- `test/fixtures/train_set.csv`, `test/fixtures/sky-ref/*.png` — field measurements collected by the
  project author.

## License

[MIT](LICENSE)
