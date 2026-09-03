# 기능 출처 스펙 — Phase 3 · 4 재설계에 무엇을 어디서 가져왔고, 무엇을 왜 안 가져왔나

> 작성일 2026-09-03 · 짝 문서: [재설계 노트](./phase-3-4-redesign-notes.ko.md) · 영문 스펙 [Phase 3](./phase-3-backtest.md) · [Phase 3.5](./phase-3.5-bias-checks.md) · [Phase 4](./phase-4-optimize.md)

## 0. 목적과 범위

Threads(@nwwonee)의 "10 GITHUB REPOS EVERY TRADER SHOULD KNOW" 두 게시물이 소개한 리포 10개를 README·핵심 모듈·문서 수준에서
조사해, TradingView MCP의 Backtest/Optimize 설계에 **가져올 패턴**과 **가져오지 않을 것**을 리포별로 판정했다. 코드를 벤더링한 곳은
없다 — 전부 **패턴·공식·절차**를 우리 코드베이스의 관례(Node ESM, 단일 파일 뷰어, 브리지 잡)로 다시 쓴다. 조사는 2026-09-03 웹
조회 기준이며, 별표 수 등 수치는 당시 화면 표기다. 확인하지 못한 것은 "미확인"으로 남겼다.

## 1. 라이선스 처리 원칙

| 라이선스 | 해당 리포 | 처리 |
|---|---|---|
| MIT | Vibe-Trading, FinRL | 패턴·공식·함수 시그니처를 참고해 자체 재구현. 문서와 소스 주석에 출처 표기 |
| Apache-2.0 | hummingbot / quants-lab, TradingAgents | 동일. 프롬프트 구조(judge 문구 등)는 우리 표현으로 다시 씀 |
| GPLv3 | freqtrade | **코드 복사 금지.** 손실함수·분석 절차는 공개된 수식·문서로 재구현(부록 B). 파일 경로는 출처 표기용으로만 인용 |
| LGPL-3.0 | nautilus_trader | 코드 복사 금지. 설정 객체·체결 모델의 **구조 아이디어**만 |
| AGPL-3.0 | OpenAlice, OpenBB, FinceptTerminal, OpenStock | 코드·프롬프트 파일 복사 금지. 아이디어 수준 인용만(OpenAlice 인테이크 계약). 필요 시 별도 프로세스로 호출 |

## 2. 요약 매트릭스

| # | 리포 (라이선스) | 한 줄 | 가져온 것 → 우리 파일 | 안 가져온 것 |
|---|---|---|---|---|
| 1 | HKUDS/Vibe-Trading (MIT) | LLM 트레이딩 에이전트 + 자체 멀티마켓 백테스터 | `validation.py`(MC 순열·bootstrap CI·WFA) → `src/core/validate.js`; `metrics.py` 지표 집합 → `normalizeMetrics`; `run_card.py`(JSON+MD, config_hash, warnings) → `RunCard` | 12개 venue 엔진, `optimizers/`(포트폴리오 가중치 — 파라미터 탐색 아님), `runner.py` |
| 2 | TraderAlice/OpenAlice (AGPL) | 코딩 에이전트용 로컬 트레이딩 워크스페이스 | `delegate-autoquant` 인테이크 계약(결정·유니버스·기간·벤치마크·비용·제약 선입력; "부정 결과/명확화 필요"도 유효) → RunConfig 필수 필드·verdict 문구 | 코드 전부(백테스터 없음 — 외부 "AutoQuant"에 위임), AGPL |
| 3 | AI4Finance/FinRL (MIT) | 강화학습 트레이딩 프레임워크 | `tune_sb3.py`의 plateau early-stop 콜백 아이디어 → `earlyStop.patience` | Gym 환경·14개 데이터 프로세서·pyfolio 티어시트·RL 자체 |
| 4 | hummingbot (+quants-lab) (Apache-2.0) | 크립토 봇 프레임워크 + 퀀트 리서치 랩 | `optimizer.py`의 `generate_config(trial)` 분리 seam → ParamSpace→RunConfig; 영속 study·`set_user_attr` 출처 → jsonl 저널·재개 | Optuna 의존, 검증 없는 in-sample 최대화, 커넥터/executor, 단일 `trade_cost`, triple-barrier 시뮬레이터 |
| 5 | Open-Dev-Society/OpenStock (AGPL) | 주식 트래킹 웹앱 | 없음 | 전부(백테스트·최적화 없음; TradingView 임베드 위젯만) |
| 6 | nautechsystems/nautilus_trader (LGPL) | 이벤트 드리븐 트레이딩 엔진 | 선언적 `BacktestRunConfig` → `RunConfig`+`configHash`("스윕 = 설정 목록"); `FillModel(prob_slippage)` 취약성 점검 아이디어(deferred) | 매칭 엔진·나노초 틱 인프라·데이터 카탈로그 |
| 7 | TauricResearch/TradingAgents (Apache-2.0) | LangGraph 멀티에이전트 매매 판단 | bull/bear + judge(보류 탈출구) → verdict 규칙·`sweep debate` preset; 카운터 기반 종료; `memory.py` pending→resolved 결정 로그 + 2–4문장 교훈 → `decision` 리포트 | LangGraph, 3자 리스크 토론, 매매 신호 자체 |
| 8 | freqtrade (GPLv3) | 크립토 봇 + 백테스트 + hyperopt | 손실함수 레지스트리 → `objectives.js` 8종; 트레이드 수 패널티; 파라미터 타입·SKDecimal ≤3자리; `--early-stop`; IS→held-out 절차; lookahead/recursive 분석 → Phase 3.5 축소판 | Optuna+joblib 병렬 hyperopt, exit 우선순위 사다리, 수수료 모델, lookahead 원본 |
| 9 | OpenBB (AGPL) | 금융 데이터 통합 플랫폼 | 없음(`quantitative/performance` 비율 정의 참고만) | 전부(백테스트·최적화 없음) |
| 10 | Fincept-Corporation/FinceptTerminal (AGPL) | C++/Qt 리서치 터미널 | 없음 | 전부(백테스트 모듈 존재 미확인, 스택 불일치, 강한 카피레프트 + 유료 에디션) |

## 3. 저장소별 판정

### 3.1 HKUDS/Vibe-Trading — MIT · 가장 많이 가져온 리포
**가져온 것**

| 출처 모듈 | 우리 구현 | 무엇을 하는지 |
|---|---|---|
| `agent/backtest/validation.py` `monte_carlo_test(trades, initial_capital, n_simulations=1000, seed=42)` | `validate.js` `monteCarloPermutation(trades, {n:1000, seed:42})` | 같은 트레이드의 **순서**를 섞어 Sharpe·max DD·PF의 p-value 산출. 관측 결과가 "무작위 순서보다 나을 게 없다"는 귀무가설 검정 |
| `validation.py` `bootstrap_sharpe_ci(equity_curve, n_bootstrap=1000, confidence=0.95)` | `bootstrapSharpeCI(returns, {n, conf, seed})` | 복원추출로 Sharpe 신뢰구간 |
| `validation.py` `walk_forward_analysis(equity_curve, trades, n_windows=5)` | `walkForwardWindows(trades, {nWindows:5})` | 연속 5창의 순이익·PF, 양수 창 비율 |
| `agent/backtest/metrics.py` `calc_metrics()` 20지표 | `normalizeMetrics()`의 `computed` 측 | max consecutive losses·PF·Calmar·Sortino 등 트레이드 리스트 기반 지표 |
| `agent/backtest/run_card.py` `write_run_card()` (JSON+MD, `schema_version`, `config_hash`, `strategy_hash`, `warnings`) | `RunCard`(`schemaVersion`, `configHash`, `warnings[]`, `body_md`) | 기계용·사람용 이중 형식, 재현성 해시, 경고 목록 |
| 시장 규칙 훅(`apply_slippage`/`calc_commission`) | `costs` 필드 + TV 보고값 대조 경고 | 우리는 체결을 안 하므로 "대조"만 차용 |

**왜**: 검증 함수가 전부 `(equity, trades)`만 받는다 — Strategy Tester가 이미 주는 두 객체. 데이터 피드 결합이 0이라 이식 비용이 가장 낮고 효과가 가장 크다.
**가져오지 않은 것**: `engines/` 12개(자체 데이터 로더; TV가 엔진), `optimizers/`(포트폴리오 가중치 최적화 — 이름과 달리 파라미터 탐색이 아님), `runner.py`(단일 실행). LLM 전략 생성 루프는 파일 본문을 확인하지 못해 주장하지 않음.

### 3.2 hummingbot / quants-lab — Apache-2.0 · 가장 좋은 옵티마이저 구조
**가져온 것**: `quants-lab/core/backtesting/optimizer.py`의 `BaseStrategyConfigGenerator.generate_config(trial)` — 탐색 알고리즘과 전략 설정을 분리하는 seam → 우리 `ParamSpace` 한 점 → `RunConfig.inputs` 매핑; `optuna.create_study(storage=sqlite, load_if_exists=True)` + `trial.set_user_attr(config, executors)` → `reports/sweeps/<id>.jsonl` 저널(실행마다 입력·configHash·지표 기록, 브리지 재시작 후 `POST /sweep/resume`).
**왜**: 느리고 중단되기 쉬운 탐색은 재개 가능해야 한다. 우리 스윕은 분 단위 UI 자동화라 이 성질이 필수.
**가져오지 않은 것**: Optuna 자체(§4.3 사유), **검증 없는 in-sample Sharpe 최대화**(그대로 복사하면 과적합 기계), 140개 거래소 커넥터·executor, 단일 `trade_cost`(TV 자체 수수료·슬리피지 설정이 더 풍부), `position_executor_simulator.py`의 triple-barrier 봉 내 체결(TV가 체결 담당).

### 3.3 freqtrade — GPLv3 · 공식과 절차만
**가져온 것(재구현)**

| 출처 | 우리 구현 |
|---|---|
| `freqtrade/optimize/hyperopt_loss/*` 12종(smaller-is-better 인터페이스 `hyperopt_loss_function(...) -> float`) | `objectives.js` 8종: `only_profit`, `profit_factor`, `sharpe`, `sortino`, `calmar`, `max_drawdown_ratio`, `profit_drawdown`(`DRAWDOWN_MULT 0.075`), `multi_metric`(기본). 부록 B |
| `MultiMetricHyperOptLoss`의 `trade_count_penalty`(TARGET 50) | `tradeCountPenalty(n, {target:30})` |
| `IntParameter/DecimalParameter/CategoricalParameter/BooleanParameter`, `SKDecimal(lo,hi,decimals)` 우선 | `ParamSpace` 타입 4종, 소수 ≤3자리, `values[]` 선열거 |
| `--early-stop N` | `earlyStop.patience 10` |
| `--timerange`로 IS 최적화 후 held-out 구간 재백테스트 권고 | `splitDate` 사후 분할 + top-3 OOS 검사 |
| `MaxDrawDownPerPairHyperOptLoss`(최악 페어 점수) | 4c 멀티심볼 채점 시 "최악 심볼" 주석 |
| `optimize/analysis/lookahead.py`(트레이드별 진입/청산 시점에서 히스토리를 잘라 재계산, `false_entry/exit_signals`) | Phase 3.5 `strategy_repaint_check`(Bar Replay로 잘라 트레이드 리스트 diff) |
| `optimize/analysis/recursive.py`(`startup_candle_count` [199,399,499,999,1999] 변화에 따른 마지막 봉 지표 드리프트) | Phase 3.5 `strategy_history_check`(히스토리 추가 로드 후 같은 구간 비교) |

**왜**: 우리 트레이딩 도메인에서 가장 성숙한 hyperopt 관례이고, 사용자가 이미 포크(`freqtrade-v0`)해 익숙하다. 손실함수는 수학이라 재구현이 정확히 가능하다.
**가져오지 않은 것**: Optuna+joblib 병렬 hyperopt 기계(TV 재실행 1건이 수 초~수십 초, 예산 64건에 맞지 않음), exit 우선순위 사다리(exit-signal→stoploss→ROI→trailing)와 이중 수수료 모델(크립토 현물 관례; TV의 봉 내 체결 가정과 조용히 충돌), lookahead 원본(Pine 내부 시리즈 diff 불가), FreqUI/plotly.

### 3.4 nautechsystems/nautilus_trader — LGPL · 패턴만
**가져온 것**: `BacktestRunConfig`(venues+data+strategy config를 하나의 불변 설정으로) + `BacktestNode(configs=[...])`("스윕 = 설정 목록") → `RunConfig`·`configHash`, 스윕 계획 = `RunConfig[]`; `FillModel(prob_fill_on_limit, prob_slippage)`는 "체결 일부가 슬리피지를 먹었다면 결과가 얼마나 취약한가"라는 사후 점검 아이디어로 Phase 3 Deferred에 기록.
**왜**: 결과가 설정에서 재현되지 않으면 리포트 비교가 무의미하다.
**가져오지 않은 것**: 엔진(이벤트 버스·매칭 엔진·나노초 틱) — TV가 엔진; `backtest/models.pyx`·`node.py` 원문은 404로 직접 확인 못 함(예제 `examples/backtest/model_configs_example.py`로 확인).

### 3.5 TauricResearch/TradingAgents — Apache-2.0 · 판정과 회고
**가져온 것**: `agents/researchers/bull_researcher.py`·`bear_researcher.py` + `agents/managers/research_manager.py`(논거를 순서와 무관하게 평가, "증거가 균형·모순·부족하면 Hold") → `verdict`의 `insufficient` 탈출구 + `sweep debate` preset(Bull/Bear 2라운드 + Judge: Adopt/Hold/Reject); `graph/conditional_logic.py`의 `count >= 2*max_debate_rounds` → 2라운드 고정; `agents/utils/memory.py` `TradingMemoryLog`(append-only, `pending`→실현 수익으로 `resolved` 백필, 2–4문장 회고, 결정적 검색) → `decision` 리포트 타입.
**왜**: 스윕의 정직한 답은 대개 "신호 없음"이다. 보류를 정당한 결과로 만드는 판정 구조가 필요했다. 결정 로그는 "최적화한 파라미터가 실제로 버텼나"를 기록하는 최소 장치다.
**가져오지 않은 것**: LangGraph 의존(가치는 ~200줄의 프롬프트·상태), 3자 리스크 토론(토큰 3배; 포지션 사이징은 Pine이 담당), 매매 신호 산출 자체(README가 결과를 보증하지 않음).

### 3.6 AI4Finance-Foundation/FinRL — MIT · 콜백 아이디어만
**가져온 것**: `finrl/agents/stablebaselines3/tune_sb3.py`의 `TuneSB3Optuna`(TPE + HyperbandPruner + Sharpe 목적 + 개선 정체 시 조기 종료 `LoggingCallback`) 중 **정체 조기 종료**만 → `earlyStop.patience`.
**왜/안 가져온 것**: 튜닝 대상이 RL 하이퍼파라미터(학습률 등)라 Pine input과 무관; Gym 환경·데이터 프로세서·`plot.py`(pyfolio, 사실상 유지보수 중단)는 제외.

### 3.7 TraderAlice/OpenAlice — AGPL · 계약 문구만
**가져온 것**: `default/skills/delegate-autoquant/SKILL.md`의 인테이크 계약 — 위임 전에 결정·유니버스·방향·기간·벤치마크·비용·제약·미지수를 명시, 방법론을 대신 정하지 않음, "부정 결과"와 "명확화 필요"를 유효 결과로 인정 → `RunConfig` 필수 필드(symbol·tf·inputs·costs·splitDate)와 verdict의 `insufficient`.
**안 가져온 것**: 코드 전부 — 리포에 백테스터가 없고(외부 AutoQuant 위임), AGPL이라 재사용은 라이선스 결정을 요구한다.

### 3.8 OpenBB · 3.9 FinceptTerminal · 3.10 OpenStock — AGPL · 가져올 것 없음
- **OpenBB**: 데이터 통합 플랫폼. 현행 Platform에 백테스트·최적화 확장이 없음(`openbb_platform/extensions/` 목록 확인). `quantitative/performance`는 비율 정의 참고용. 벤치마크 시계열이 필요해지면 별도 프로세스/API로 호출(AGPL 네트워크 조항).
- **FinceptTerminal**: C++20/Qt6 + 임베디드 Python. 백테스트 소스 존재는 코드 검색이 로그인을 요구해 **미확인**. 스택·라이선스·유료 에디션 모두 이식에 불리. 노드 에디터의 "파이프라인을 그래프로" 아이디어만 기록.
- **OpenStock**: Next.js 주식 트래커. 백테스트·최적화·지표 없음. TradingView 연동은 임베드 위젯(`components/TradingViewWidget.tsx`)뿐, Pine 없음.

## 4. 사용자 자산에서 가져온 것

| 자산 | 사용 |
|---|---|
| 디자인 캔버스 아티팩트 "Gate Audit Viewer"(`Backtest.dc.html`, `Optimize.dc.html`, 캔버스 주석) | 화면 구성·색·문구 그대로. "Results save into the SAME report store" 주석 → 리포트 타입 확장으로 반영 |
| `scripts/http-bridge.js`의 `/agent` 잡 패턴(`agentRun` 상태기계, status/cancel/resume, 타임아웃 vs 에러 구분) | `/sweep` 잡의 골격 |
| `scripts/viewer/gate-audit.html`의 `META_JS`·`settingsText()`(라벨↔`in_N` 조인), `call()`, `prep()`, `drawTable()`, PRESETS 3종 | Backtest/Optimize 탭 전부 재사용 |
| `src/core/gateAudit.js` `runGateAudit(params, deps)` 주입 패턴 | `runBacktest(config, deps)` 테스트 방식 |
| `profiles/pf3g-vp.json` `governingInputs` | `optimize.shortlist` 16개의 출발점 |
| PineForge-Lab `third_generation_volume_profile_strategy.pine`의 positional `min,max,step`(숫자 input 86개) | ParamSpace 자동 시드 |
| PineForge-Lab `docs/full-parameter-manual-kr.md`("walk-forward 검증이 우선") · `docs/mcp-debug-workflow.md` | 검증 우선순위·용어 |

## 5. 역색인 — 우리 파일 ← 출처

| 우리 파일/함수 | 출처 |
|---|---|
| `src/core/validate.js` (`monteCarloPermutation`, `bootstrapSharpeCI`, `walkForwardWindows`) | Vibe-Trading `validation.py` |
| `src/core/validate.js` (`tradeCountPenalty`, `splitByDate`) | freqtrade `MultiMetricHyperOptLoss`, `--timerange` 절차 |
| `src/core/validate.js` (`verdict`) | TradingAgents research-manager(보류 탈출구), OpenAlice 인테이크 계약("부정 결과 유효") |
| `src/core/backtest.js` (`RunConfig`, `configHash`, `RunCard`, `normalizeMetrics`) | nautilus_trader `BacktestRunConfig`, Vibe-Trading `run_card.py`·`metrics.py` |
| `src/wait.js` `waitForTesterSettle` | 자체(원안 Open question 2의 답); 형태는 기존 `waitForChartReady` |
| `src/core/objectives.js` | freqtrade `hyperopt_loss/*`(공식 재구현) |
| `src/core/paramspace.js` | freqtrade 파라미터 타입·SKDecimal; PineForge-Lab positional 범위 |
| `scripts/sweep-job.js` + `reports/sweeps/*.jsonl` | 자체 `/agent` 잡 패턴 + quants-lab 영속 study/`set_user_attr` |
| `src/core/sweep.js` (`rank`, OOS, `stability`, `verdict`) | freqtrade("random state에 따라 승자 변동" 경고의 기계화), TradingAgents judge |
| `decision` 리포트 타입 | TradingAgents `memory.py` |
| Phase 3.5 `strategy_repaint_check` / `strategy_history_check` | freqtrade `lookahead.py` / `recursive.py`(축소판) |
| `earlyStop.patience` | freqtrade `--early-stop`, FinRL `LoggingCallback` |

## 6. 포크 체크리스트

플랜에 인용된 리포 중 사용자 계정에 포크가 있는 것/없는 것(2026-09-03 `list_repos` 기준):

| 리포 | 포크 | 비고 |
|---|---|---|
| freqtrade/freqtrade | ✅ `PineappleBingo/freqtrade-v0` | 이번 조사에서 로컬 clone으로 손실함수 원문 확인 |
| HKUDS/Vibe-Trading | ❌ | `validation.py`·`run_card.py` 참조용으로 포크 권장 |
| hummingbot/quants-lab (+ hummingbot/hummingbot) | ❌ | `core/backtesting/optimizer.py` |
| nautechsystems/nautilus_trader | ❌ | 패턴만 — 포크 선택 |
| TauricResearch/TradingAgents | ❌ | `agents/utils/memory.py`, `agents/managers/research_manager.py` |
| AI4Finance-Foundation/FinRL | ❌ | 선택 |
| TraderAlice/OpenAlice | ❌ | `default/skills/delegate-autoquant/SKILL.md` 문구 참조용 |
| OpenBB · FinceptTerminal · OpenStock | ❌ | 불필요 |

참고: 사용자 포크 `PineappleBingo/Quant`는 eisenjimmy/Quant(데스크톱 마켓 터미널)로 이번 목록과 무관하다.

## 부록 A. 검색 근거

- Threads 게시물 1: https://www.threads.com/share/FIlGEHAYw/ — @nwwonee, "10 GITHUB REPOS EVERY TRADER SHOULD KNOW", 1–5:
  HKUDS/Vibe-Trading · TraderAlice/OpenAlice · AI4Finance-Foundation/FinRL · hummingbot/hummingbot · Open-Dev-Society/OpenStock
- Threads 게시물 2: https://www.threads.com/share/Oethfmgmd/ — @nwwonee(조회 시 표기일 2026-08-10), 6–10:
  nautechsystems/nautilus_trader · TauricResearch/TradingAgents · freqtrade/freqtrade · OpenBB-finance/OpenBB · Fincept-Corporation/FinceptTerminal
- 두 게시물 모두 링크 목록만 있고 용도 설명은 없다. 각 리포의 용도·구조는 README와 소스 조회로 확인했다.

## 부록 B. 공식 모음(재구현 기준)

- **ProfitDrawDown**: `loss = −(P − relDD·P·(1 − 0.075))`, `P` = 순이익, `relDD` = 최대 낙폭(계좌 대비 비율).
- **MultiMetric**: `loss = −(profitDraw · ln(PF + 1) · ln(min(10, ER) + 2) · ln(1.2 + WR) · penalty)`, `profitDraw` = 위 식의 괄호 안,
  `PF` = 총이익/|총손실|, `ER` = expectancy ratio, `WR` = 승률, `penalty = n ≥ 30 ? 1 : max(0.1, 1 − |n − 30|/30)`.
- **MaxDrawDownRatio**: `loss = −P / maxDD_abs` (`maxDD_abs = 0`이면 `−P`).
- **Expectancy**: `E = WR·avgWin − (1 − WR)·|avgLoss|`, `ER = E/|avgLoss|`.
- **Trade-based Sharpe**: `mean(r)/std(r)·√(n/years)`, `r` = 트레이드별 수익률; Sortino는 하방 편차; Calmar = 연환산 수익률/최대 낙폭 %.
- **Monte-Carlo 순열**: `pnl` 순서를 `n=1000`회 섞어 지표 재계산, `p = #(지표 ≥ 관측)/n`.
- **Bootstrap CI**: 복원추출 `n=1000`회의 Sharpe 백분위 [2.5 %, 97.5 %].
- **Walk-forward**: 트레이드를 시간순 5창으로 균등 분할, 창별 순이익·PF, `positiveFraction = 양수 창/5`.
- **Verdict**: `insufficient` if `n < 30 ∨ ¬settled`; `edge` if `pSharpe < 0.05 ∧ PF_oos > 1 ∧ n ≥ 30`; else `noise`.
