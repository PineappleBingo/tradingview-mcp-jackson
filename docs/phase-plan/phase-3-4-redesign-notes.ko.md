# Phase 3 · 4 재설계 노트 — 무엇이, 어떻게, 왜 바뀌었고 어떻게 동작하는가

> 작성일 2026-09-03 · 대상 브랜치 `my-changes` · 영문 스펙: [phase-3-backtest.md](./phase-3-backtest.md) ·
> [phase-3.5-bias-checks.md](./phase-3.5-bias-checks.md) · [phase-4-optimize.md](./phase-4-optimize.md) ·
> 출처 스펙: [functional-spec-sources.ko.md](./functional-spec-sources.ko.md)

## 0. 요약

- 2026-08-31에 승인된 Phase 3(Backtest)·Phase 4(Optimize) 계획은 디자인 캔버스(아티팩트 "Gate Audit Viewer",
  `Backtest.dc.html`·`Optimize.dc.html` 아트보드)를 옮겨 적은 **흐름 설계**였다. 코드와 대조해 보니 그대로는
  실행되지 않는 가정이 7개 있었다(§1).
- Threads(@nwwonee)에서 소개된 트레이딩 리포 10개를 조사했다. **백테스트 엔진은 가져올 것이 없다** — 전부 자체
  데이터 피드와 체결 모델을 전제하는데 우리 엔진은 이미 차트 위에 있다(TradingView Strategy Tester). 대신 그 엔진들
  **둘레**에 있는 것들 — 재현 가능한 실행 기록, 안정된 지표 스키마, 검증 레이어, 목적함수 레지스트리, 파라미터 타입,
  재개 가능한 탐색 잡, 판정(judge) — 이 우리에게 없던 것이고, 그것을 가져왔다.
- 원칙은 그대로다: **라이브 Strategy Tester가 유일한 엔진, 시뮬레이터는 쓰지 않는다.** 아트보드의 화면 구성도 그대로다.
  바뀐 것은 그 화면 뒤의 실행 모델·데이터 계약·신뢰 장치다.
- 이번 작업은 **문서와 아티팩트만** 바꿨다. 엔진 코드는 후속 구현 세션이 이 스펙대로 작성한다.

## 1. 기존 계획을 코드와 대조해 발견한 문제

| # | 원안의 가정 | 코드의 실제 | 결과 |
|---|---|---|---|
| 1 | "Save as report → `POST /reports`" | `POST /reports` 라우트가 없다. `scripts/http-bridge.js:437-457`은 `GET`/`DELETE`만 처리하고, 리포트는 에이전트 실행의 종료 핸들러(`:298-309`)만 쓴다 | Phase 3에서 라우트 신설 |
| 2 | "`indicator_set_inputs` → wait/poll" | `setInputs()`는 `study.setInputValues()` 직후 즉시 반환한다(`src/core/indicators.js:32`). 테스터 재계산을 기다리는 코드는 리포 어디에도 없고, `waitForChartReady()`(`src/wait.js:6`)는 심볼 스피너·봉 수만 본다 | `waitForTesterSettle()` 신설 |
| 3 | "Run = 기존 `call()` 헬퍼 위의 시퀀스" | `POST /call` 한 건은 30 s 고정 타임아웃(`send()`, `http-bridge.js:98-111`). 브라우저측 시퀀스는 CLI·스킬·에이전트가 재사용할 수 없고 단위 테스트도 불가 | 서버측 도구 `strategy_run_backtest` |
| 4 | "`data_get_trades {max_trades:200}`" | `MAX_TRADES = 200`(`src/core/data.js:7`)이고 `getTrades()`는 `ordersData()`의 **앞에서부터** 자른다(`:197`) — 트레이드 600개면 가장 오래된 200개가 온다 | 단일 evaluate 스냅샷, 5000개 캡, 최신 유지 |
| 5 | Key-metrics 표의 고정 행 | `getStrategyResults()`(`data.js:144`)는 `reportData()`가 가진 키를 그대로 돌려준다 — 스키마·정규화·폴백 없음 | `normalizeMetrics()` + `metricSources` |
| 6 | Edu 문구 "a direction, not a result" | 문구 뒤에 장치가 없다. IS/OOS·walk-forward·Monte-Carlo·트레이드 수 가드가 리포에 0건 | `validate.js` + verdict |
| 7 | (암묵) 뷰어 확장 여유 | 뷰어 68,484 B / 상한 70 KB(`tests/http_bridge.test.js:205`) — 여유 3.1 KB. 테스트 주석이 "다음 상향은 Phase 3 몫"이라고 예약해 둠 | 84 KB(P3) · 100 KB(P4) 의도적 상향 |

부수 발견: `docs/phase-plan/README.md`의 "currently 48 KB"는 낡은 값(실제 70 KB), Phase 2.1(Alerts 탭) 행 누락,
`VIEWER_GUIDE.ko.md`의 "탭 4개"는 5개. 이번 커밋에서 함께 고쳤다.

## 2. Phase 3 — Backtest 변경

### 3.1 RunConfig / RunCard — 실행을 "설정 객체 + 결과 카드"로 기록
- **무엇이**: 자유 형식 "symbol·tf·override 몇 개"였던 실행을 `RunConfig`(입력·비용·split 날짜·`configHash`)와
  `RunCard`(정규화 지표·원시 TV 값·트레이드·equity·검증·마크다운 본문)로 고정했다.
- **어떻게**: `configHash = sha1(canonical JSON of {study.name, symbol, timeframe, sorted inputs, costs})`.
  `entityId`는 세션마다 바뀌므로 해시에서 제외. 카드는 JSON + `body_md` 이중 형식.
- **왜**: 같은 설정을 다시 돌렸는지, 두 리포트가 비교 가능한지는 해시로만 답할 수 있다(NautilusTrader의 선언적
  `BacktestRunConfig`, Vibe-Trading의 `run_card.py`가 같은 이유로 존재). `body_md`는 기존 Reports 상세 뷰가 그대로
  렌더하게 하려는 것이다.
- **어떻게 동작**: `strategy_run_backtest {config}` → RunCard 반환 → 뷰어가 `POST /reports {type:'backtest', data:card}`.

### 3.2 서버측 도구 `strategy_run_backtest` — 뷰어 시퀀스를 코어로 내림
- **무엇이**: `call()`을 네 번 이어 붙이던 브라우저 루프 대신 `src/core/backtest.js`의 `runBacktest(config, deps)` 하나.
- **어떻게**: `getIndicator`(원본 스냅샷) → `setInputs` → `waitForTesterSettle` → `readStrategySnapshot`(evaluate 1회로
  `reportData`·주문 ≤5000·equity ≤2000 포인트를 같은 순간에 읽음) → `normalizeMetrics` → `validate` → `finally` 복원(옵션).
  `deps` 주입은 `runGateAudit(params, deps)`(`src/core/gateAudit.js:180`)와 동일한 방식이라 녹화된 CDP 페이로드로 단위 테스트한다.
- **왜**: 30 s `/call` 타임아웃 안에서 한 왕복으로 끝내고, CLI(`tv backtest run`)·`strategy-report` 스킬·`performance-analyst`
  에이전트가 같은 구현을 쓰게 하기 위해서다. 세 판독이 한 evaluate에서 나와야 "주문은 새 값, 리포트는 옛 값"이 섞이지 않는다.
- **어떻게 동작**: 뷰어는 `call('strategy_run_backtest', {config}, {timeoutMs:60000})` 한 번; 브리지 `POST /call`이 `timeoutMs`(1–120 s)를 받는다.

### 3.3 settle 감지 — "얼마나 기다릴지"를 신호로 답함
- **무엇이**: 고정 sleep(`smartCompile`의 2500 ms, `manageIndicator`의 1500 ms 같은 방식) 대신 **서명 변화 → 안정** 감지.
- **어떻게**: `testerSignature() = {tradeCount, lastExitTime, netProfit, totalTrades}`를 250 ms마다 읽어, 적용 전 값에서
  **바뀐 뒤** 3회 연속(750 ms) 동일하면 settled. 기본 15 s, 최대 60 s에 타임아웃 → `settled:false`로 계속 진행(예외 아님).
  override가 현재 값과 같으면 테스터가 재계산하지 않으므로 `'no_change'` 경고와 함께 대기를 건너뛴다.
- **왜**: 원안 Open question 2가 정확히 이 문제였다("poll until stable rather than a fixed sleep"). 테스터는 주문 → 리포트
  순으로 단계 갱신되므로 안정 폴 1회로는 부족하다.
- **어떻게 동작**: `src/wait.js`에 `waitForTesterSettle({before, pollMs, stablePolls, timeoutMs})` 추가, `waitForChartReady`와 같은 폴링 형태.

### 3.4 지표 정규화 — TV 보고값과 트레이드 재계산을 나란히
- **무엇이**: `metrics` 17개 키를 고정하고, 각 키의 출처를 `metricSources`(`tv`/`computed`/`both`)로 기록.
- **어떻게**: TV `reportData()` 키 맵(라이브에서 확정, 열린 질문 1) + 트레이드 리스트에서 재계산(net profit·PF·win rate·
  max DD·avg trade·expectancy ratio·trade-based Sharpe/Sortino/Calmar·max consecutive losses·long/short). 상대 1 % 또는
  절대 0.5 초과 불일치는 `'metrics_mismatch:<key>'` 경고, 값은 TV 것을 유지(테스터가 기록의 엔진, 재계산은 감사).
  drawdown은 TV가 미실현 손익을 봉 단위로 포함하므로 5 % 허용.
- **왜**: 아트보드의 Key-metrics 표는 안정된 키를 전제한다. 재계산은 TV 내부 필드명이 바뀌어도 표가 비지 않게 하고,
  불일치를 드러내 "숫자를 믿어도 되는가"에 답한다(Vibe-Trading `calc_metrics`의 지표 집합, 시장 규칙 훅의 "대조" 아이디어).
- **어떻게 동작**: `normalizeMetrics(tvRaw, trades, costs)` 순수 함수.

### 3.5 검증 레이어 — 문구를 계산으로
- **무엇이**: `src/core/validate.js`(TradingView 없이 단위 테스트되는 순수 함수): `splitByDate`, `monteCarloPermutation`,
  `bootstrapSharpeCI`, `walkForwardWindows`, `tradeCountPenalty`, `verdict`.
- **어떻게**: 모든 TV 실행은 로드된 히스토리 전체를 덮으므로 IS/OOS는 **트레이드 타임스탬프로 사후 분할**한다 — Deep
  Backtesting UI 자동화가 없어도 OOS를 얻는다. Monte-Carlo는 같은 트레이드의 순서를 1000회(seed 42) 섞어 Sharpe·max DD·PF의
  p-value를 낸다. walk-forward는 트레이드를 5개 창으로 나눠 양수 창 비율을 본다. 판정: `n<30` 또는 unsettled → `insufficient`;
  `pSharpe<0.05 ∧ OOS PF>1 ∧ n≥30` → `edge`; 그 외 `noise`.
- **왜**: 원안의 "8 runs · one window · one symbol — a direction, not a result"는 옳은 말이지만 장치가 없었다. 리포 10개 중
  검증을 갖춘 곳(Vibe-Trading `validation.py`)과 목적함수의 트레이드 수 패널티(freqtrade `MultiMetric`)를 합쳤고, 판정에
  "증거 부족이면 보류"라는 탈출구(TradingAgents의 research-manager)를 넣었다.
- **어떻게 동작**: RunCard의 `validation` 필드; 뷰어는 verdict 한 줄 + 이유를 텍스트로 표시(색만으로 전달하지 않음).

### 3.6 `POST /reports` 신설 — 원안이 있다고 가정한 라우트
- **무엇이**: `{type, title, summary?, body_md, data?}`를 받아 `reports/<id>.json`을 쓰는 라우트. `type` 허용목록
  `backtest | sweep | decision`, 본문 5 MB 캡, id는 기존 `newId()`/`SAFE_ID`.
- **왜**: Reports 탭·목록 API(`GET /reports`)는 이미 임의 `type`을 표시하므로(뷰어 `:944`) 쓰기 경로만 없었다.
- **어떻게 동작**: 뷰어 Save 버튼 → `POST /reports` → `#reports/<id>`로 이동. `/health.postReports`로 기능 감지.

### 3.7 뷰어 Backtest 탭
- **무엇이**: 아트보드 그대로(configure → run → results → save)에 settle pill, warnings, verdict 줄, IS/OOS 행 추가. 아트보드의
  "date range"는 **split date** 하나로 대체(끝은 항상 현재; OOS에 필요한 것은 분할점).
- **어떻게**: 입력 라벨↔`in_N` 조인은 이미 `settingsText()`(`gate-audit.html:511-543`)가 하는 방식을 그대로 쓴다. 새 pill 2개:
  `backtest`(js)와 `review backtest`(agent, sonnet). GLOSSARY에 p-value·walk-forward·in-sample/out-of-sample.
- **왜/어떻게 동작**: `call()`에 세 번째 인자(`timeoutMs`) 추가 외에는 기존 헬퍼(`prep`, `drawTable`, `togglePanel`) 재사용. 크기 상한 70→84 KB.

## 3. Phase 3.5 — 바이어스 점검(신설, 선택)

- **무엇이**: `strategy_repaint_check {date}`(Bar Replay로 D 시점까지 잘라 다시 계산한 트레이드와 전체 실행의 D 이전 트레이드를 diff)와
  `strategy_history_check`(히스토리를 더 로드한 뒤 같은 구간의 트레이드·지표가 변하는지).
- **왜**: freqtrade의 lookahead-analysis·recursive-analysis가 "최적화 전에 백테스트가 거짓말하는지"를 먼저 묻는다. Pine에도
  `request.security` lookahead·리페인팅·warm-up 의존이 있고, PF 3G VP는 "non-lookahead"를 표방하므로 데이터로 확인할 가치가 있다.
- **어떻게 동작**: 기존 `replay_*` 도구(`src/core/replay.js`)와 Phase 3의 스냅샷/settle 헬퍼만 사용. 스윕 경로에는 넣지 않는다(분 단위 UI 자동화).
- **왜 축소판인가**: freqtrade는 pandas 지표 프레임을 diff하지만 우리는 Pine 내부 시리즈에 접근할 수 없다 → 트레이드 리스트 수준으로 축소.

## 4. Phase 4 — Optimize 변경

### 4.1 파라미터 공간(ParamSpace) — "값 목록 1–2개"에서 타입이 있는 공간으로
- **무엇이**: `int | decimal | categorical | bool` 타입, `values[]`를 미리 열거하는 유한 공간, 출처(`metaInfo | profile | user`).
- **어떻게**: `META_JS`가 `min/max/step/options`까지 내보내도록 확장해 자동 시드. PF 3G VP는 숫자 input 86개에 positional
  범위를 선언한다(예: `erRangeThreshold` 0.05–0.60 step 0.05, `strategyStopAtr` 0.25–10 step 0.25). 프로파일
  `optimize.shortlist`(`governingInputs` 기반 16개, 선언 범위보다 좁은 "스윕 창")를 라벨→`in_N`으로 런타임 해석. 소수 ≤3자리.
- **왜**: freqtrade의 `IntParameter/DecimalParameter/CategoricalParameter/BooleanParameter`와 "`Real`보다 `SKDecimal`" 정책 —
  무한한 실수축은 가짜 정밀도 승자를 만든다. metaInfo 시드는 사람이 범위를 손으로 적을 필요를 없앤다.
- **어떻게 동작**: `src/core/paramspace.js` — `seedFromMeta`, `resolveLabels`, `expandGrid`(64 초과 시 개수와 함께 거부), `sampleRandom`, `halvingPlan`, `neighbors`.

### 4.2 목적함수 레지스트리 — "net %로 정렬"에서 선택 가능한 8종으로
- **무엇이**: `only_profit · profit_factor · sharpe · sortino · calmar · max_drawdown_ratio · profit_drawdown · multi_metric(기본)`,
  전부 smaller-is-better.
- **어떻게**: freqtrade 손실함수의 **공식**을 Node로 재구현(GPLv3이라 코드 복사 없음). `multi_metric = −(profitDraw × ln(PF+1) ×
  ln(min(10, expectancyRatio)+2) × ln(1.2+winRate) × penalty)`, `penalty`는 트레이드 30개 미만에서 선형 감소(하한 0.1).
- **왜**: 트레이드 수 패널티와 로그 감쇠 PF가 "요행 3건" 승자를 직접 억제한다. 기본 목적함수를 하나로 정해야 순위·매트릭스·
  판정이 같은 기준을 쓴다.
- **어떻게 동작**: `score(name, metrics, validation)`; `list()`가 뷰어 선택기를 채운다.

### 4.3 샘플러·예산 — "루프"에서 예산 인지형 탐색으로
- **무엇이**: `grid`(≤64) · `random`(16) · `halving`(16 → top 4 → ±1-step 이웃) · plateau early-stop(patience 10).
- **왜 Optuna/TPE가 아닌가**: Node 브리지에 Python 의존을 넣지 않는다; 평가 예산이 64건이라 베이지안 샘플러의 이득이 작다;
  quants-lab의 Optuna 옵티마이저는 검증(WFA/OOS)이 없어 우리가 가장 필요한 부분이 빠져 있다. early-stop은 freqtrade `--early-stop`·FinRL 콜백 아이디어를 유지.
- **어떻게 동작**: 1건 = settle(≤15 s 기본, ≤45 s 최악) + 1000 ms 페이싱 → 상한 ≈48 min, 아트보드의 8건 ≈ 2–6 min. `expectedMs = baseline settle × 남은 수`.

### 4.4 브리지 스윕 잡 — 브라우저 루프에서 저널이 있는 잡으로
- **무엇이**: `POST /sweep`, `GET /sweep/status`, `POST /sweep/cancel`, `POST /sweep/resume {id}`, `POST /sweep/apply {id,index}`;
  `reports/sweeps/<id>.jsonl` 저널; `/agent`와 공유하는 "차트 변경 잡 1개" 락(409).
- **어떻게**: 상태 객체는 `agentRun`(`http-bridge.js:149-160`)을 미러. baseline 실행 → 계획 → 각 점마다 in-process
  `callTool('strategy_run_backtest', …, 120_000)` → 저널 append → 페이싱 → cancel·early-stop 확인. `finally`에서 원본 입력 복원 후
  baseline을 한 번 더 읽어 `restore.verified` 기록. 복원 실패 시 `error` + 뷰어 빨간 배너에 원본 입력 나열.
- **왜**: 원안의 뷰어측 루프는 30 s `/call` 제약, 새로고침 시 진행 상실, 브리지 재시작 시 재개 불가, 그리고 "CDP 딸꾹질이 차트를 조용히
  바꿔 놓은 채 끝나는" 위험을 해결하지 못한다. 저널+재개는 quants-lab의 영속 Optuna study(`load_if_exists=True`)에서 가져온 형태다.
- **어떻게 동작**: 뷰어는 로드 시 `GET /sweep/status`로 재접속(에이전트 상태 폴링과 동일).

### 4.5 선택·판정·결정 로그 — "승자 표시"에서 "승자를 깎아내리는 절차"로
- **무엇이**: IS 목적함수 순위 → top-3 OOS 검사 → 안정성(격자 이웃 평균; 피크보다 plateau 중심 선호) → Monte-Carlo p-value →
  `verdict: edge | noise | insufficient` + 이유 목록 → `Apply to chart` 시 `decision` 리포트(`pending`) → 같은 `configHash`의 후속
  백테스트가 `resolved`로 채움 + 2–4문장 교훈.
- **왜**: freqtrade 문서의 "random state를 바꾸면 승자가 달라진다"를 기계적으로 반영(이웃 평균), TradingAgents의 judge(보류 탈출구)와
  결정 로그(pending→resolved 회고)를 적용. 승자를 자동으로 차트에 반영하지 않고 사람이 `Apply`를 눌러야 한다는 점은 원안과 같다.
- **어떻게 동작**: `src/core/sweep.js` 순수 함수; 에이전트 preset `sweep debate`(bull/bear 2라운드 + judge, opus)는 선택 사항.

### 4.6 4b What-if · 4c 멀티심볼 — 유지
원안 그대로. 4c에 "여러 심볼에 한 파라미터 세트를 채점할 때는 평균이 아니라 **최악 심볼**로"라는 주석만 추가(freqtrade `MaxDrawDownPerPair`).

### 4.7 뷰어 Optimize 탭
아트보드 요소 전부 + 목적함수 선택·split date·샘플러·verdict 배지·p-value·안정성 열. 매트릭스는 파라미터가 정확히 2개일 때만, 그 외는
순위 목록. 상한 84→100 KB.

## 5. Before → After

| 원문(2026-08-31) | 재설계(2026-09-03) |
|---|---|
| "Run = a sequence over the existing `call()` helper `chart_set_symbol` → `chart_set_timeframe` → optional `indicator_set_inputs` → wait/poll → `data_get_strategy_results` + `data_get_trades {max_trades:200}` + `data_get_equity`" | 서버측 `strategy_run_backtest {config}` 한 호출(`runBacktest`: 스냅샷 → 적용 → settle → 단일 evaluate 판독 → 정규화 → 검증 → 복원) |
| "overrides apply via `indicator_set_inputs {entity_id, inputs}`" | 동일 setter를 코어에서 호출하되 `updated_inputs`로 적용 여부를 검증(`'inputs_not_applied:<id>'`) |
| "**date range ships display-only.** True range control needs TradingView "deep backtesting" UI automation" | Deep Backtesting은 여전히 deferred. 대신 **split date**로 IS/OOS를 트레이드 타임스탬프에서 사후 계산 |
| "key-metrics table: net profit, total trades, win rate, profit factor, max drawdown, avg trade, long/short split" | 같은 7행 + expectancy ratio·Sharpe·Sortino·Calmar·max consecutive losses, 키별 출처(`metricSources`)와 불일치 경고 |
| "**Save as report** → `POST /reports` with `type:'backtest'` (store and Reports tab already handle arbitrary types)" | `POST /reports` 라우트를 **신설**(허용목록·5 MB 캡·SAFE_ID); Reports 탭은 무변경 |
| Open question 2: "How long after `indicator_set_inputs` until the Strategy Tester repopulates — poll … until stable rather than a fixed sleep." | 답: `waitForTesterSettle` — 서명 변화 후 250 ms × 3회 안정, 15 s 타임아웃, `settled:false`로 계속 |
| Open question 3: "Restore original inputs after a run? … decide whether that's Phase 3 or only needed for Phase 4 sweeps." | 답: 단일 실행은 `restore:false` 기본(차트에서 결과를 보려는 목적), 스윕은 항상 `finally` 복원 + `restore.verified` |
| "80/80 unit tests stay green (new size ceiling if needed, raised deliberately)" | 상한을 숫자로 고정: 70→84 KB(P3), 84→100 KB(P4); 새 순수 함수 테스트 3파일 |
| (없음) | Phase 3.5 바이어스 점검(리페인트·히스토리 민감도) 신설, 선택 |
| "Configure 1–2 inputs with value lists (artboard example: Trend Gate Mode {Soft, Hard} × ER threshold 0.20→0.35 step 0.05 = 8 runs, "est ~6 min")" | 타입이 있는 `ParamSpace`(metaInfo 시드 + 프로파일 shortlist 16개 + 사용자 오버라이드, 소수 ≤3자리); 같은 예시는 grid 8건으로 그대로 표현됨 |
| "Loop Phase 3's run serially with pacing (the `delay_ms` pattern from `src/core/batch.js`); progress row + cancel; **read original inputs first and restore on finish/cancel**" | 브리지 잡(`/sweep*`)으로 이동: 직렬·1000 ms 페이싱·cancel·**저널·재개**·`finally` 복원·`restore.verified`·`/agent`와 공유 락 |
| "Results: all-runs table (net %, PF, max DD, trades, Δ vs baseline) · **sweep matrix** · equity-vs-baseline overlay" | 동일 + IS obj·OOS PF·stability 열, verdict 배지·이유·p-value; 매트릭스는 2-파라미터일 때만 |
| "`Apply to chart` (sets the winning inputs) · `Save as report` (`type:'sweep'`)" | `Apply` = `POST /sweep/apply` → `decision` 리포트(`pending` → 후속 백테스트가 `resolved`); 스윕 리포트는 잡이 완료 시 자동 저장 |
| "Edu note ships the artboard's own caveat: *"8 runs · one window · one symbol — a direction, not a result"*" | 문구 유지 + 계산된 verdict/이유가 그 옆에 표시 |
| "Sweeps are minutes-long UI automation against a live chart — the fragile end of the plan. Serialized, paced, cancellable, inputs restored; no auto-retry." | 유지 + 저널/재개/타임아웃(60 min)/복원 검증 추가; settle 타임아웃 1회 외 재시도 없음 |
| "Sweep results invite overfitting; the UI copy deliberately undersells the winner." | 문구가 아니라 절차가 깎아내린다: OOS·안정성·p-value·트레이드 수 패널티·`insufficient` 탈출구 |

## 6. 고정 숫자(모든 문서 공통)

| 항목 | 값 |
|---|---|
| settle 폴링 / 안정 폴 / 타임아웃 | 250 ms / 3회 / 기본 15 s, 최대 60 s |
| `/call timeoutMs` | 기본 30 s, 1–120 s |
| 원시 주문 캡 / equity 포인트 | 5000 / ≤2000 |
| Monte-Carlo · bootstrap | n=1000, seed=42, conf 0.95 |
| walk-forward | 5 창, ≥3/5 양수면 stable |
| TARGET_TRADES | 30 (`penalty = n<30 ? max(0.1, 1−|n−30|/30) : 1`) |
| verdict | edge: `pSharpe<0.05 ∧ OOS PF>1 ∧ n≥30` · insufficient: `n<30` 또는 unsettled(스윕은 settled 실행 <8건도) · 그 외 noise |
| 소수 자리 | ≤3 |
| grid 캡 / random 기본 / 총 예산 | 64 / 16 / 64 |
| halving | 16 → top 4 → ±1-step 이웃 |
| early-stop patience | 10 |
| 스윕 페이싱 / 잡 타임아웃 | 1000 ms / 60 min |
| 기본 목적함수 | `multi_metric` (대안 `profit_drawdown`, mult 0.075) |
| 뷰어 상한 | 70 → 84 KB (P3) → 100 KB (P4) |

## 7. 바뀌지 않은 것

- 원칙: 라이브 Strategy Tester가 유일한 엔진. 시뮬레이터·자체 데이터 피드·체결 모델 없음.
- 아트보드의 화면 구성과 색(`#1a1a19`, `#7aa2f7`, 계열색 `#3987e5 #d95926 #199e70`, baseline 회색 점선, 단일 y축).
- 표준 제약: `my-changes`만, PR·main 머지 금지; 뷰어 단일 파일·외부 의존 없음; `POST /call`이 유일한 네트워크 경로.
- 4b What-if 패널, 4c 멀티심볼 비교의 설계.
- 리포트 저장소 하나(`reports/`), 형식 하나(기존 envelope + `data`).
- 승자를 자동 적용하지 않는다 — `Apply to chart`는 사람이 누른다.

## 8. 라이브에서 확인해야 할 것 · 리스크

- 확인 항목(스펙의 Open questions로 이관): `reportData()` 키 이름, `ordersData()` 필드·시간 단위, metaInfo의 `min/max/step/options`
  노출 여부, 테스터 패널이 닫힌 상태의 재계산 여부, `equityData` 형태, 수수료·초기자본 판독 경로, 실제 트레이드 수, settle 시간 분포,
  문자열 input의 setter 값 형식(라벨 vs 인덱스), 복원 후 baseline 재현성.
- 리스크: settle 감지는 휴리스틱(동일 서명 재계산은 타임아웃으로 표기됨); TV 내부 API 변동은 `backtest.js` 한 모듈에 국한;
  적은 트레이드에서 통계는 약하다(판정이 `insufficient`로 말함); 실행은 차트를 바꾼다(단일 실행은 헤더에 적용값 표시, 스윕은 복원 검증).
