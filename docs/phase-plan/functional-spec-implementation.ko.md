# 기능 출처 스펙(구현판) — 파일별로 무엇을 어디서 가져와 어떻게 썼고, 무엇을 안 가져왔나

> 구현일 2026-09-03 · 설계판 출처 스펙 [functional-spec-sources.ko.md](./functional-spec-sources.ko.md)의 "가져올 것"이 실제 코드에서 어디에 어떻게 앉았는지의 대장.
> 원칙: **코드 복사 0건.** 패턴·공식·절차만 Node ESM으로 재구현하고 소스 주석과 이 문서에 출처를 남긴다.

## 1. 파일 ← 출처 대장

| 우리 파일 · 함수 | 출처(라이선스) | 왜 가져왔나 | 무엇을 하나 | 처리 방식 |
|---|---|---|---|---|
| `src/core/validate.js` `monteCarloPermutation` | Vibe-Trading `agent/backtest/validation.py monte_carlo_test` (MIT) | "이 결과가 운인가"를 숫자로 답하는 유일한 층 | 같은 트레이드로 귀무분포를 만들어 Sharpe·PF(부호 뒤집기)·max DD(순서 섞기) p-value | 검정 방식을 트레이드 단위에 맞게 **변경**(설계판은 순서 섞기; §구현 노트 3-1) |
| `validate.js` `bootstrapSharpeCI` | Vibe-Trading `bootstrap_sharpe_ci` (MIT) | 점추정 Sharpe의 불확실성 표시 | 복원추출 n=1000, 95 % 구간, P(mean>0) | 시그니처·기본값 차용, 재구현 |
| `validate.js` `walkForwardWindows` | Vibe-Trading `walk_forward_analysis` (MIT) | 한 창에서만 이기는 전략 걸러내기 | 트레이드 5창 균등 분할, 양수 창 비율, stable ≥3/5 | 재구현 |
| `validate.js` `computeMetrics` | Vibe-Trading `metrics.py calc_metrics` 지표 집합 (MIT) + freqtrade `calculate_sharpe` 관례 | 안정된 스키마와 TV 키 독립성 | 순이익·PF·승률·DD·평균·기대값·트레이드 기반 Sharpe/Sortino/Calmar·연속 손실·롱/숏 | 지표 목록 차용, 공식은 자체 |
| `validate.js` `tradeCountPenalty` | freqtrade `MultiMetricHyperOptLoss` (GPLv3 — 공식만) | "요행 3건" 억제 | `n<30 → max(0.1, 1−|n−30|/30)` | 공식 재구현, 목표 50 → 30 |
| `validate.js` `verdictOf` | TradingAgents `research_manager.py` judge (Apache-2.0) + OpenAlice `delegate-autoquant` 계약 (AGPL, 아이디어만) | "증거 부족 = 보류"를 정당한 결과로 | `insufficient` 우선, `edge`는 유의성·OOS·베이스라인 세 조건 | 규칙만 |
| `src/wait.js` `waitForTesterSettle` | 자체(원안 Open question 2) — 형태는 기존 `waitForChartReady` | 고정 sleep 대체 | 서명 변경 → 3회 안정, 타임아웃은 경고 | 사용자 자산 |
| `src/core/backtest.js` `RunConfig`·`configHash` | nautilus_trader `BacktestRunConfig` (LGPL — 패턴만) | 결과를 설정에서 재현·비교 | canonical JSON sha1, `entityId` 제외 | 구조 아이디어만 |
| `backtest.js` `RunCard`·`renderRunCardMd`·`warnings[]` | Vibe-Trading `run_card.py write_run_card` (MIT) | 기계용 JSON + 사람용 MD 이중 형식, 경고 목록 | `schemaVersion`, `configHash`, `warnings`, `body_md` | 형태 차용 |
| `backtest.js` `normalizeMetrics`·`metricSources` | Vibe-Trading 시장 규칙 훅의 "대조" 아이디어 (MIT) | TV 보고값을 감사할 두 번째 출처 | 키별 `tv|computed|both|none`, 허용오차 초과 시 경고 | 자체 설계 |
| `backtest.js` `readStrategySnapshot`·`mapTrades` | 기존 `src/core/data.js`의 locate 관용구·평탄화 | 세 판독을 같은 순간에 | evaluate 1회, 뒤에서부터 5000건, 다운샘플 | 사용자 자산 확장 |
| `src/core/paramspace.js` 타입 4종·`enumerate`·소수 ≤3 | freqtrade `IntParameter/DecimalParameter/CategoricalParameter/BooleanParameter`, `SKDecimal` (GPLv3 — 개념만) | 가짜 정밀도 승자 방지 | 유한 `values[]` 선열거 | 개념 재구현 |
| `paramspace.js` `seedFromMeta` | PineForge-Lab 전략의 positional `min,max,step`(사용자 자산) | 범위를 손으로 안 적기 | metaInfo → 축 | — |
| `paramspace.js` `halvingPlan`·`earlyStop.patience` | freqtrade `--early-stop`, FinRL `tune_sb3.py LoggingCallback` 아이디어 (GPL/MIT) | 재실행이 비싼 자원 | 16 → top 4 → 이웃, 10회 무개선 정지 | 아이디어만 |
| `src/core/objectives.js` 8종 | freqtrade `hyperopt_loss/*` (GPLv3 — 수식만) | 순위·매트릭스·판정이 같은 기준 | smaller-is-better 레지스트리 | 공식 재구현(부록 B 설계판) |
| `src/core/sweep.js` `stabilityOf`·plateau 선택 | freqtrade 문서 "random state에 따라 승자 변동" 경고 | 피크 대신 plateau | 격자 이웃 평균 → `(objective+stability)/2` | 경고를 규칙으로 |
| `sweep.js` `decisionResolvedBy`·`realizedFor`, `sweep-job.js resolvePending` | TradingAgents `agents/utils/memory.py TradingMemoryLog` (Apache-2.0) | "최적화한 값이 실제로 버텼나" 기록 | `decision` 리포트 pending → resolved, `realized`, `held` | 구조 차용, 리포트 카드로 구현 |
| `scripts/sweep-job.js` 저널·`resume` | quants-lab `core/backtesting/optimizer.py`(영속 study, `load_if_exists`, `set_user_attr`) (Apache-2.0) | 느리고 중단되기 쉬운 탐색의 재개 | `reports/sweeps/<id>.jsonl` append, header/baseline/run/end, 재개 | 구조 차용, Optuna 없이 |
| `sweep-job.js` 상태기계·락·`status/cancel/resume` | 기존 `/agent` 잡(`agentRun`, `elapsedOf`, 409) — 사용자 자산 | 뷰어 폴링 코드 재사용 | 같은 상태 이름과 응답 형태 | — |
| `sweep-job.js` 루프(입력 설정 → 실행 → 복원) | quants-lab `generate_config(trial)` seam (Apache-2.0) + nautilus "스윕 = 설정 목록" | 탐색 알고리즘과 전략 설정 분리 | 점 → `RunConfig.inputs` | 아이디어만 |
| 뷰어 `sweep debate` 프리셋 | TradingAgents bull/bear + judge, `count ≥ 2×rounds` 종료 (Apache-2.0) | 스윕 결과의 반대 의견을 강제로 듣기 | Bull/Bear 2라운드 → Adopt/Hold/Reject | 프롬프트 자체 작성 |
| 뷰어 Backtest/Optimize 탭 | 디자인 캔버스 아트보드, `META_JS`·`settingsText`·`call()`·`prep()`·`drawTable` (사용자 자산) | 화면·헬퍼 재사용 | — | — |

## 2. 가져오지 않은 것과 이유(구현 시점 재확인)

| 출처 | 항목 | 이유 |
|---|---|---|
| Vibe-Trading | `engines/` 12개, `optimizers/`(포트폴리오 가중치), `runner.py` | TV가 엔진; 가중치 최적화는 다른 문제 |
| hummingbot/quants-lab | Optuna·TPE, executor/커넥터, triple-barrier 봉 내 체결, 단일 `trade_cost` | Python 의존 없음, 예산 64건, 검증 없는 최적화 복사 금지, TV가 체결 담당 |
| freqtrade | hyperopt 병렬 기계(joblib), exit 우선순위 사다리·수수료 모델, lookahead 원본, FreqUI/plotly | 예산·환경 불일치, TV 체결 가정과 충돌, Pine 내부 시리즈 접근 불가 |
| nautilus_trader | 매칭 엔진·틱 인프라·`FillModel` 재점수(deferred) | TV가 엔진; 취약성 재점수는 후속 |
| TradingAgents | LangGraph, 3자 리스크 토론, 매매 신호 | 프롬프트 200줄이면 충분, 토큰 3배, 신호는 Pine이 담당 |
| FinRL | RL 환경·데이터 프로세서·pyfolio | 튜닝 대상이 다름, 유지보수 중단 의존성 |
| OpenAlice | 코드 전부 | 백테스터 없음(외부 AutoQuant), AGPL |
| OpenBB · FinceptTerminal · OpenStock | 전부 | 데이터/터미널 플랫폼, AGPL, 백테스트 모듈 없음/미확인 |
| 설계판 자체 항목 | Phase 3.5 리페인트·히스토리 점검, 4b What-if, 4c 멀티심볼, `resolve decision` 프리셋, `tv sweep` CLI | 선택 항목 또는 라이브 검증 후 착수 |

## 3. 라이선스 처리 확인

- MIT(Vibe-Trading, FinRL)·Apache-2.0(quants-lab, TradingAgents): 함수 시그니처·기본값·구조를 참고해 재구현, 파일 상단 주석에 출처.
- GPLv3(freqtrade)·LGPL(nautilus): **코드 미복사**. 손실함수 8종은 문서·설계판 부록 B의 수식에서, 파라미터 타입·early-stop·`BacktestRunConfig`는 개념만.
- AGPL(OpenAlice·OpenBB·Fincept·OpenStock): 인용 없음(OpenAlice는 verdict 문구의 아이디어만).

## 4. 포크 체크리스트(변동 없음)

설계판 §6과 동일 — `freqtrade-v0`만 포크됨. 구현에서 참조한 나머지(Vibe-Trading, quants-lab, TradingAgents, nautilus_trader, FinRL)는 라이브 검증 단계에서 원문 대조가 필요할 때 포크를 권장한다.
