# Phase 3 · 4 구현 노트 — 무엇을 어떻게 왜 만들었고, 어떻게 동작하며, 스펙과 무엇이 다른가

> 구현일 2026-09-03 · 기준 브랜치 `my-changes` (재설계 스펙 머지 커밋 `953e783` 위)
> **2026-09-04 라이브 검증 완료** — 실제 Strategy Tester에 붙여 보니 §7의 결함들 때문에 전부 동작하지 않았다. 수정 후 종단 재검증.
> 스펙: [phase-3-backtest.md](./phase-3-backtest.md) · [phase-4-optimize.md](./phase-4-optimize.md) · 재설계 사유: [phase-3-4-redesign-notes.ko.md](./phase-3-4-redesign-notes.ko.md) ·
> 출처: [functional-spec-implementation.ko.md](./functional-spec-implementation.ko.md)

## 0. 요약

| 항목 | 값 |
|---|---|
| 커밋 | `c64f82f` P3 코어 · `086f606` P3 브리지 · `692b723` P3 뷰어 · `6fa737f` P4 코어 · `777521a` 스윕 잡 · `389e4ae` P4 뷰어 · `ff282e0` 결정 해소 |
| 새 파일 | `src/core/validate.js` `src/core/backtest.js` `src/core/paramspace.js` `src/core/objectives.js` `src/core/sweep.js` `src/tools/backtest.js` `src/cli/commands/backtest.js` `scripts/sweep-job.js` · 테스트 5개 |
| 바뀐 파일 | `src/wait.js` `scripts/http-bridge.js` `scripts/viewer/gate-audit.html` `profiles/pf3g-vp.json` `src/server.js` `src/core/index.js` `src/cli/index.js` `package.json` `tests/http_bridge.test.js` `tests/fixtures/stub-mcp-server.js` |
| MCP 도구 | +2 (`strategy_run_backtest`, `strategy_sweep_plan`) → 등록 86개 |
| 브리지 라우트 | +8 (`POST /reports`, `POST /sweep`, `GET /sweep/status`, `POST /sweep/cancel`, `POST /sweep/resume`, `POST /sweep/apply`, `GET /sweep/objectives`; `POST /call`에 `timeoutMs`) |
| 단위 테스트 | 90 → **136** 전부 통과 (`npm run test:unit`) |
| 뷰어 크기 | 68,484 B → 100,417 B (상한 70 → 84 → 100 KB, 의도적 상향 2회) |
| 미구현 | Phase 3.5 바이어스 점검(선택), 4b What-if 패널, 4c 멀티심볼 비교, `resolve decision` 에이전트 프리셋, `tv sweep` CLI |

원칙은 지켰다: **TradingView 라이브 Strategy Tester가 유일한 엔진**이고 시뮬레이터는 없다. 코드가 하는 일은 실행을 기록·정규화·검증하고, 스윕을 잡으로 돌리고, 승자를 깎아내리는 것이다.

## 1. Phase 3 — 백테스트 한 번

### 1.1 `src/core/validate.js` — 신뢰 레이어(순수 함수)
- **무엇**: `computeMetrics`(트레이드 리스트 → 지표 20여 개), `splitByDate`(IS/OOS), `monteCarloPermutation`, `bootstrapSharpeCI`, `walkForwardWindows`, `tradeCountPenalty`, `verdictOf`, `validate`(합성). `mulberry32` 시드 PRNG로 결정적.
- **왜**: 모든 TV 실행은 로드된 히스토리 전체를 덮으므로 IS/OOS·walk-forward는 트레이드 시각으로 **사후** 계산한다 — Deep Backtesting UI 자동화 없이 OOS를 얻는다. TradingView 없이 테스트되는 유일한 층이라 가장 촘촘히 테스트했다(11개).
- **동작**: `validate(trades, {splitDate, initialCapital, settled})` → `{split, monteCarlo, bootstrap, walkForward, tradeCountPenalty, verdict, reasons}`. 판정 규칙은 스펙 그대로: `n<30 ∨ ¬settled → insufficient`, `pSharpe<0.05 ∧ OOS PF>1 ∧ n≥30 → edge`, 그 외 `noise`.
- **스펙과 다른 점(중요)**: Monte-Carlo의 `pSharpe`·`pProfitFactor`는 **순서 섞기가 아니라 부호 뒤집기(sign-flip)** 순열 검정이다. 트레이드별 수익률의 Sharpe와 PF는 순서를 바꿔도 변하지 않으므로 순서 섞기로는 p-value가 나오지 않는다. "엣지 없음 = 각 트레이드의 부호가 반반"이라는 귀무가설 아래 관측치 이상이 나올 비율을 p로 쓴다(add-one 평활). `pMaxDD`만 순서 섞기이며 의미는 "무작위 순서에서 관측 이상의 낙폭이 나올 비율" — **높을수록 실제 순서가 운 좋게 순했다는 뜻**이다. Vibe-Trading은 equity 곡선의 기간 수익률에 순열을 걸어 이 문제가 없었다; 우리는 트레이드 단위라 검정을 바꿨다.

### 1.2 `src/wait.js` — `testerSignature()` · `waitForTesterSettle()`
- **무엇**: 서명 `{tradeCount, lastKey(마지막 주문의 원시값 요약), netProfit, totalTrades}`를 250 ms마다 읽어 **적용 전 값에서 바뀐 뒤 3회 연속 동일**하면 settled. 기본 15 s, 1–60 s 클램프, 타임아웃은 예외가 아니라 `{settled:false}`.
- **왜**: `setInputValues()`는 즉시 반환하고 테스터는 주문 → 리포트 순으로 단계 갱신된다(스펙 §Run algorithm 5). 원안 Open question 2의 답.
- **동작**: `signature/sleep/now`를 주입해 가짜 시퀀스로 테스트한다(변경 후 3회 안정 = 4 폴 = 1000 ms; 무변화 타임아웃).

### 1.3 `src/core/backtest.js` — `runBacktest(config, deps)`
- **무엇**: `normalizeConfig`(JSON/객체, 클램프) → `configHash`(canonical JSON sha1, `entityId` 제외) → 스터디 해석(`chart_get_state`, 기본 `/PineForge|PF 3G/i`) → 원본 입력 스냅샷(`getIndicator`) → **바뀌는 id만** `setInputs` → settle → `readStrategySnapshot()`(evaluate **1회**로 `reportData`·주문 ≤5000(뒤에서부터)·equity ≤2000 다운샘플) → `mapTrades`(관용적 키 매핑, 초/밀리초 자동, 방향 단어 인식, 정렬, `cumPnl`) → `normalizeMetrics` → `validate` → `renderRunCardMd` → `finally` 복원.
- **왜**: 뷰어의 `call()` 네 번을 서버측 한 호출로 내려 CLI·스킬·에이전트가 같은 구현을 쓰고, 세 판독이 같은 순간에서 나오게 한다(스펙 §Why server-side).
- **`normalizeMetrics`**: TV 키 맵(`TV_KEYS`, `{all,long,short}` 언랩, 승률 소수→%, `avgLoss` 부호)과 트레이드 재계산을 키별로 대조해 `metricSources`를 `tv|computed|both|none`으로 기록. 불일치(상대 1 % 또는 절대 0.5, 낙폭 5 %)는 `metrics_mismatch:<key>` 경고, 값은 TV 유지.
- **스펙과 다른 점**: `sharpe`·`sortino`·`calmar`·`expectancyRatio`는 **대조하지 않는다**(TV는 월간 수익률 연환산, 우리는 트레이드 기반 — 관례가 달라 불일치가 정상). TV 값이 있으면 `tv`, 없으면 `computed`. 계산값은 `card.computedMetrics`에 따로 남긴다.
- **경고 목록**: `unsettled`, `inputs_not_applied:<id>`, `no_change`, `trades_truncated`, `no_equity`, `metrics_mismatch:<key>`, `trades_unmapped`, `few_trades`.
- **복원**: 단일 실행 기본 `restore:false`(차트에서 결과를 보려는 목적), 요청 시 `finally`에서 바뀐 id만 원복, `card.restore = {requested, restored, changed, error}`. 스냅샷이 예외를 던져도 복원은 실행된다(테스트로 고정).

### 1.4 도구 · CLI
- `strategy_run_backtest {config | inputs, study_filter, split_date, restore, settle_timeout_ms, initial_capital}` (`src/tools/backtest.js`), `tv backtest run -i '{...}' -s 2026-08-15 -r -t 20000 -c 10000 [--md]`.

### 1.5 브리지(`scripts/http-bridge.js`)
- **`POST /reports`**: `{type: backtest|sweep|decision, title, summary?, body_md, data?, context?}` → `{id, type}`. 5 MB 캡(413), 허용목록 외 타입 400, 기존 `newId`/`SAFE_ID`. 목록 API는 `data`를 노출하지 않는다.
- **`POST /call {timeoutMs}`**: `send(method, params, timeoutMs)` — 기본 30 s, 1–120 s 클램프. 스윕 잡은 in-process `callTool`로 120 s.
- **`/health`**: `postReports:true`, `sweep:true` — CDP가 꺼진 503 응답에도 실어 뷰어가 기능 감지한다(테스트에서 발견한 누락).

### 1.6 뷰어 Backtest 탭(`scripts/viewer/gate-audit.html`)
- 아트보드 흐름(configure → run → results → save). 오버라이드는 `META_JS`(확장: `min/max/step/options`, `pineVersion`) + `data_get_indicator` 조인으로 라벨 선택 → 타입별 입력. `call(tool, params, timeoutMs)` 세 번째 인자 추가. 결과: settle pill, verdict pill(첫 이유), warnings, equity 캔버스(TV 곡선 또는 `cumPnl`), 지표 표(출처 태그), 검증 블록, 트레이드 표(최근 200), Save → `POST /reports` → `#reports/<id>`. 프리셋 `last backtest`(js)·`review backtest`(agent, sonnet). GLOSSARY 3항.

## 2. Phase 4 — 스윕

### 2.1 `src/core/paramspace.js`
- **무엇**: `int|decimal|categorical|bool` 축을 `values[]`로 **선열거**(소수 ≤3자리, step 미지정 시 (max−min)/10), `seedFromMeta`(metaInfo의 options/min/max), `resolveLabels`(프로파일 shortlist 라벨 → `in_N`, 대소문자 무시·부분일치), `normalizeSpace`(grid 64 초과 시 개수와 함께 거부), `expandGrid`, `sampleRandom`(시드, 중복 없음), `neighbors`(±1 index), `coords`, `halvingPlan`(16 → top 4 → 이웃), `planSpace`(추정).
- **왜**: freqtrade의 파라미터 타입과 "`Real`보다 `SKDecimal`" 정책 — 무한한 실수축은 가짜 정밀도 승자를 만든다.

### 2.2 `src/core/objectives.js`
- 8종 smaller-is-better(`only_profit · profit_factor · sharpe · sortino · calmar · max_drawdown_ratio · profit_drawdown · multi_metric`), 기본 `multi_metric`(TARGET_TRADES 30, DRAWDOWN_MULT 0.075). PF가 없으면 총이익/총손실로 복원, 손실 없음은 10으로 캡.

### 2.3 `src/core/sweep.js`
- `summarizeRun`(저널 크기 결과: compact 지표, IS 지표(split 시 트레이드에서 재계산), OOS `{n, netProfit, profitFactor, sharpe}`, objective, `pSharpe`, ≤60점 `curve`), `rank`(null 마지막), `stabilityOf`(**격자 이웃** 평균, 없으면 최근접 3점), `selectAndVerdict`(top-k 중 `(objective+stability)/2` 최소 = plateau 중심; `verdictOf` + settled 실행 ≥8 가드; 피크 대신 plateau를 골랐으면 이유에 명시), `decisionResolvedBy`/`realizedFor`, `matrixOf`(파라미터 2개일 때).
- **스펙과 다른 점**: 안정성은 "격자 이웃 → 없으면 최근접 k" 순서로 확정했다(랜덤 공간에서는 격자 이웃이 평가되지 않았을 수 있음). 저널 결과에 `curve`를 추가해 오버레이가 트레이드 리스트 없이 그려진다.

### 2.4 `profiles/pf3g-vp.json` `optimize.shortlist` · `strategy_sweep_plan`
- shortlist 16개(스펙 표 그대로; 그룹 TRD/RGM/MAC/PRX/ROOM/DSHP/EXIT). `strategy_sweep_plan {space | meta_inputs(+shortlist_labels)}` → 정규화된 공간·개수·추정·첫 점들·목적함수 목록. 실행은 하지 않는다.

### 2.5 `scripts/sweep-job.js` + 브리지 라우트
- **동작**: `POST /sweep {space, objective?, splitDate?, title?, costs?}` → `chart_get_state`로 스터디 → `data_get_indicator`로 원본 입력 → 저널 `header` → **baseline 실행**(현재 입력 그대로) → 저널 `baseline` → 계획(grid/random/halving; halving 2단계는 1단계 완료 후 계획) → 점마다 in-process `strategy_run_backtest`(120 s) → `summarizeRun` → 저널 `run` → 페이싱(`pace_ms`, 기본 1000) → cancel/early-stop(patience 10) 확인 → `finally`: `indicator_set_inputs`로 원복 → **읽어 되돌아온 값과 비교해 `restore.verified`** → 선택·판정·매트릭스 → `sweep` 리포트 저장(`reportId = 잡 id`) → 저널 `end`.
- **락**: `/agent`와 `/sweep`는 서로 409(차트 변경 잡 1개). **재개**: `POST /sweep/resume {id}`가 저널(header·baseline·run…)에서 상태를 복원해 남은 점을 계속 돈다(`done` 상태면 409). **적용**: `POST /sweep/apply {id, index}`가 입력을 설정하고 `decision` 리포트(`pending`)를 쓴다. **해소**: `POST /call`로 `strategy_run_backtest`가 성공하면 같은 `configHash`의 pending 결정 중 새 실행의 창이 더 긴 것을 `resolved`로 바꾸고 실현 수치(`realized`)와 `held` 판정을 기록, 응답에 `resolvedDecisions`를 실어 준다.
- **스펙과 다른 점**: `restore.verified`는 **baseline 재실행이 아니라 입력 읽기 비교**다(스윕당 실행 1건을 아낌; 재실행 검증은 후속 옵션). 스윕 리포트는 잡이 완료 시 자동 저장하므로 뷰어의 "Save as report"는 "open report"가 됐다. 타임아웃(60 min)은 `timeout` 상태로 남고 저널로 재개된다. 실패한 개별 실행은 `run_failed` 경고와 `objective:null`로 기록되고 스윕은 계속된다.

### 2.6 뷰어 Optimize 탭
- `opInit`: Backtest 탭의 메타를 재사용 → `GET /sweep/objectives` → `strategy_sweep_plan {meta_inputs}`로 shortlist 공간을 받아 파라미터 선택기를 채움. 파라미터 행 = 라벨 + 현재값 + **쉼표 구분 값 목록**(편집 가능). 목적함수·샘플러·split date·capital. `runs N · est ~M min`(마지막 백테스트의 settle 시간 사용, grid 64 초과 시 실행 버튼 비활성). Run → `POST /sweep` → 2 s 폴링(`GET /sweep/status`), 새로고침 시 재접속, cancel. 완료 → 리포트 로드 → verdict pill+이유, 선택 실행, equity 오버레이(baseline 회색 점선, 계열색 `#3987e5 #d95926 #199e70`, 행 클릭 토글), 순위 표(파라미터…, net %, PF, DD %, trades, objective, OOS PF, stability, Δ base, baseline 행), 2-파라미터 매트릭스(net %, 음영 = objective 순위, 선택 outline), Apply(→ decision 링크), open report. 프리셋 `last sweep`(js)·`sweep debate`(agent, opus, Bull/Bear 2라운드 + Judge Adopt/Hold/Reject). GLOSSARY `objective`·`stability`·`decision log`.

## 3. 스펙 대비 편차 요약

| # | 스펙 | 구현 | 이유 |
|---|---|---|---|
| 1 | Monte-Carlo = 순서 섞기로 Sharpe·DD·PF p-value | Sharpe·PF는 부호 뒤집기, DD만 순서 섞기 | 트레이드별 Sharpe/PF는 순서 불변 — 순서 섞기로는 검정이 성립하지 않음 |
| 2 | 모든 지표 TV↔재계산 대조 | 비율 4종(sharpe·sortino·calmar·expectancyRatio) 제외 | 관례가 달라 불일치가 정상; TV 값 우선, 계산값은 `computedMetrics` |
| 3 | `restore.verified` = baseline 재실행 비교 | 입력 읽기 비교 | 스윕당 실행 1건 절약; 재실행 검증은 후속 옵션 |
| 4 | 저널 결과 = 지표 부분집합 | + `curve`(≤60점) | 오버레이를 트레이드 리스트 없이 그리기 위해 |
| 5 | 뷰어 Save as report(스윕) | 잡이 완료 시 자동 저장, 버튼은 open report | 저널·리포트가 브리지에 있으므로 뷰어 저장 불필요 |
| 6 | 결정 해소는 "후속 `strategy_run_backtest`" | 브리지 `POST /call` 경로에서 `resolvePending` | 리포트 저장소가 브리지에 있음(MCP 서버는 파일을 모름) |
| 7 | 안정성 = 격자 이웃(grid) / 최근접 3(random) | 격자 이웃 우선, 없으면 최근접 3 | 랜덤 공간에서도 평가된 격자 이웃이 있으면 더 정직 |
| 8 | Phase 3.5, 4b, 4c, `resolve decision` 프리셋, `tv sweep` CLI | 미구현 | 선택 항목·라이브 검증 필요·범위 관리 |
| 9 | 뷰어 상한 84/100 KB | 83,825 B / 100,417 B | 두 탭이 예상보다 컸다(약 15 KB씩); 다음 기능은 다음 상향 필요 |

## 4. 검증 내역

| 파일 | 테스트 | 무엇을 증명하나 |
|---|---|---|
| `tests/validate.test.js` | 11 | 손계산 지표(순이익 70, 승률 58.33 %, PF 2.556, DD 25, 연속 손실 2), split, 패널티 표, walk-forward 분할, 시드 결정성, all-positive → `pSharpe<0.05`, 대칭 → 0.2–0.8, bootstrap CI가 관측치를 포함, verdict 분기 |
| `tests/backtest.test.js` | 12 | 설정 정규화·클램프, 해시 불변(entityId·키 순서), 트레이드 매핑(초/밀리초·방향), TV `{all,long,short}` 언랩, both/mismatch/단일 출처, 실행 순서(스냅샷→적용→settle→판독→복원), `no_change`·`inputs_not_applied`·`unsettled`, 예외 시 복원, settle 대기의 성공/타임아웃, 도구 등록 |
| `tests/paramspace.test.js` `objectives.test.js` `sweep.test.js` | 16 | 열거·시드·라벨 해석·캡·격자·랜덤·이웃·halving·추정; 공식 8종·패널티·단조성; 요약·순위·안정성·plateau 선택·verdict 가드·결정 해소·매트릭스 |
| `tests/http_bridge.test.js` | 20 (+7) | `POST /reports` 왕복·검증·413, `timeoutMs` 클램프와 실제 타임아웃, 스윕 생명주기(저널 7행·리포트·selection·복원 검증), cancel 복원, journal 재개, apply → decision → 후속 실행이 resolved, 에이전트↔스윕 락 |

증명하지 못한 것: TradingView 내부 API 형태. `reportData()` 키, `ordersData()` 필드·시간 단위, `metaInfo` 범위 노출, 패널 닫힘 시 재계산, `equityData` 형태, 문자열 input setter 값 형식은 스텁의 가정이다.

## 5. 라이브 검증 체크리스트(첫 30분)

1. `ui_evaluate`로 `TESTER_SIGNATURE_JS`·`snapshotJS()`를 직접 실행해 `found:true`, 주문 배열, `reportData` 키 확인 → `TV_KEYS`·`mapTrades` 후보 키 보정.
2. `strategy_run_backtest {inputs:{}}` → `metricSources`가 대부분 `both`인지, `metrics_mismatch` 경고 목록.
3. 오버라이드 1개로 실행 → settle 시간(15 s 충분한지), `inputs_not_applied` 없음, `restore:true`로 원복 확인.
4. `ui_evaluate META_JS` → `min/max/step/options` 노출 여부(없으면 shortlist만 사용).
5. 2×2 grid 스윕 → 저널·리포트·복원 검증·매트릭스; 브리지 재시작 후 `resume`.
6. 문자열 input의 setter 값(라벨 vs 인덱스) — 스윕 값 목록 형식 확정.

## 6. 구현값(고정 숫자)

settle 250 ms / 3회 / 15 s(≤60 s) · `/call timeoutMs` 30 s(1–120 s) · 주문 캡 5000 · equity ≤2000 · MC n=1000 seed=42 · bootstrap 95 % · walk-forward 5창 ≥3/5 · TARGET_TRADES 30 · verdict edge/noise/insufficient(스윕: settled ≥8) · 소수 ≤3 · grid ≤64 · random 16 · halving 16→4→±1 · patience 10 · 페이싱 1000 ms · 스윕 타임아웃 60 min · 실행 타임아웃 120 s · 기본 목적함수 `multi_metric` · 뷰어 상한 100 KB · 저널 `reports/sweeps/<id>.jsonl` · 곡선 ≤60점.

## 7. 라이브 검증(2026-09-04) — 무엇이 깨졌고 무엇을 고쳤나

TradingView Desktop 3.4.0 · COINBASE:SOLUSD·15 · 내장 **Supertrend Strategy**로 검증했다.
사용자의 PF 3G VP는 `indicator()`라 Strategy Tester 자체가 없어 Phase 3/4의 대상이 될 수 없다.

### 7.1 전면 차단 결함 3건 (스텁으로는 절대 잡히지 않는다)

| # | 증상 | 원인 | 수정 |
|---|---|---|---|
| 1 | `data_get_strategy_results` metric_count 0, `data_get_trades` "ordersData() returned non-array", 백테스트 trades 0 | 전략 탐색 관용구 `s.metaInfo && (s.ordersData \|\| s.reportData \|\| s.performance)`가 **모든 스터디**에 매칭된다 — Desktop 3.4에서는 Volume 지표에도 `performance`가 있고, 그것이 `dataSources()` 첫 항목이다 | `model.activeStrategySource()` → 없으면 `metaInfo().isTVScriptStrategy` 스캔. `src/core/data.js`의 `strategySourceJS()` 하나로 통일(리더 3개 + settle 서명 + 스냅샷) |
| 2 | 전략이 없는 차트에서도 PF 3G 지표를 "전략"으로 잡아 빈 리포트 반환 | `indicator()` 스크립트에는 테스터가 없는데 이름 정규식 `/PineForge\|PF 3G/i`가 지표를 먼저 잡는다 | `chart_get_state`가 `is_strategy: true`를 실어 준다. 명시적 필터가 없으면 **플래그된 전략 우선**(런·스윕 잡·뷰어 3곳) |
| 3 | −3.79 % 실행이 −0.0379 %로 표시 | TradingView의 모든 퍼센트가 **분수**인데 `winRate`만 ×100 했다 | `PCT_KEYS`(netProfitPct·winRate·maxDrawdownPct·avgTradePct) 일괄 스케일. TV↔재계산 대조에서 18개 중 13개가 `both`로 일치 |

### 7.2 실제 페이로드 형태(스텁 가정과 다른 부분)

- **지표**: `reportData().performance.{all,long,short}` 아래에 중첩 + 최상위 비율(`maxStrategyDrawDown(Percent)`, `sharpeRatio`, `sortinoRatio`, `openPL`, `buyHoldReturn`, `maxStrategyRunUp`, `maxMarginUsed`).
- **트레이드**: `ordersData()`는 **체결(fill) 목록**(`tm`=바 인덱스)이고, 마감 트레이드는 `reportData().trades` — `{e:{c,p,tm,b,tp}, x:{…}, q, tp:{v,p}, cp:{v,p}, rn:{v,p}, dd:{v,p}, cm}`, 시각은 **밀리초**, 방향은 `e.tp`(`le/lx/se/sx`).
- **미청산 트레이드**: 목록의 마지막 1건은 열려 있고 TradingView는 이를 `netProfit`에서 제외한다 → 우리도 지표·검증·window에서 제외하고 `card.openTrades`로만 센다.
- **에쿼티**: `equityData()`는 **존재하지 않는다**. 곡선은 마감 트레이드 기준(`initialCapital + cp.v`)이며 이는 Overview 탭이 그리는 것과 같다.
- **자본금**: `reportData().buyHold[0]`. 호출자가 `costs`를 주지 않으면 여기서 채운다.
- **metaInfo 범위**: `min/max/step/options` 모두 노출된다. 단 무한 입력은 **±1e12 센티널**이라 그대로 축으로 쓰면 안 된다 → 열거 100개 초과 축은 현재값 ±50 %의 5점으로 시드한다.
- **패널 상태와 무관하게 재계산된다**: 하단 바를 최소화(38 px)하거나 Pine 에디터를 활성 탭으로 둔 상태에서도 1.8–2.5 s에 settle. 백테스트 전 `ui_open_panel` 호출은 불필요.
- **settle 시간**: 20여 회에서 1.5–8.0 s(중앙값 ≈ 2 s). 기본값 15 s로 충분.

### 7.3 라이브에서만 드러난 결함 3건 (Phase 3/4 외부)

| # | 증상 | 수정 |
|---|---|---|
| 4 | `/sweep/apply`가 결정의 기준 시각을 **baseline의 마지막 트레이드**로 잡는다 | 파라미터 셋마다 트레이드 주기가 다르다 — 실측에서 적용 실행의 자체 마지막 트레이드는 01:45, baseline은 00:30이었다. baseline 시계를 쓰면 **이미 관측한 트레이드가 새 증거로 계산된다**. `summarizeRun`이 각 실행의 `window`를 보존하고, apply는 **적용된 실행 자신의** 마지막 트레이드에서 자른다 |
| 5 | `ui_open_panel`이 닫지 않고도 `performed:'closed'`를 반환(조용한 거짓말) | 이 빌드에 `bottomWidgetBar.hideWidget`이 없다. 실제 API는 `close()`(최소화)·`showWidget()`·`mode()`·`activeWidgetName()`. Pine 에디터는 하단 탭이 아니라 **떠 있는 다이얼로그**라 Monaco 가시성으로 판정하고 Close 버튼(접근성 이름 기준, Monaco에서 7단계 위)을 누른다. 모든 경로가 **요청한 상태가 됐는지 확인 후** 보고하며, 안 되면 `success:false` |
| 6 | **입력값 하나로 전략이 영구히 죽는다** | 카테고리 입력에 옵션 라벨 대신 **인덱스(`in_2: 1`)** 를 쓰면 `setInputValues()`가 받아들이고 읽기도 그 값을 돌려주지만, 그 순간부터 `reportData()`가 **null이 되고 어떤 재계산으로도 돌아오지 않는다**(스터디를 지우고 다시 넣어야 복구). 숫자 입력에 문자열, bool에 숫자도 같은 부류. 스윕은 항상 옵션 라벨을 열거하므로 안전하지만 **강제하는 장치가 없었다** → 모든 쓰기가 지나는 `setInputs()` 한 곳에서 metaInfo로 검증하고 위반 시 **쓰기 전에 거부**(부분 적용 없음). metaInfo를 못 읽으면 "눈 감고 쓰지 않는다"며 거부한다. metaInfo는 스터디 API 객체가 아니라 **모델 소스**에 있다는 점도 여기서 드러났다 |

### 7.4 종단 검증 결과

| 대상 | 결과 |
|---|---|
| 리더 3종 | metric_count 48, 트레이드 300(마감 299 + 미청산 1), 에쿼티 299점 |
| `strategy_run_backtest` | 오버라이드 없음 0.85 s / `in_1=4` settle 3.9 s, 복원 확인, 18개 중 13개 `both`, verdict `noise` |
| `POST /reports` | RunCard 128 KB 저장 → 목록 → 상세(`data` 포함) → 삭제 |
| 뷰어 Backtest 탭 | 오버라이드 추가 → 실행(settle 8.0 s) → 지표·검증·트레이드 200행·에쿼티 렌더 → 리포트 저장 후 링크 |
| 스윕(2×2 그리드) | 4런 8 s, 저널 7행, 입력 복원 + 검증, 매트릭스·선택·verdict |
| `/sweep/apply` → 결정 | pending 기록, 이후 같은 configHash 실행이 **resolved**(신규 1트레이드, +2 629.68, held) |
| `/sweep/resume` | 스윕 중 브리지 SIGKILL → 재시작 → 저널의 run 2부터 재개해 4런 완주, 복원 검증, 완료된 스윕 재개는 409 |
| 뷰어 Optimize 탭 | 20축 시드 → 2축 편집 → 실행(진행률·현재 지점 표시) → 순위표·매트릭스·오버레이·Apply → 결정 링크. 콘솔 오류 0 |
| 입력 검증 가드 | 잘못된 4종(카테고리 인덱스·숫자에 문자열·bool에 숫자·혼합) 모두 거부, 정상 3종 통과, 이후에도 테스터 정상 계산 |
| 최종 확인 실행 | 새로 얹은 전략에서 settle 2.0 s, 경고 0, 마감 183 + 미청산 1, TV↔재계산 13키 일치, 복원 확인 |
| 단위 테스트 | 136 → **143** 전부 통과 |
