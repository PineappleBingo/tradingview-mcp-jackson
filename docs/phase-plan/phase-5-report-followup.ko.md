# Phase 5 — 리포트 후속 작업 (2026-09-08 세션 기록)

> 완성된 분석 리포트가 막다른 길이었던 문제를 없앴다. Reports 탭 상세 화면에는
> **← all reports**와 **delete** 두 버튼밖에 없었다(`scripts/viewer/gate-audit.html:1016-1017`).
> 다섯 개의 제안을 하나의 근거 있는 변경으로 바꾸는 일은 전부 손으로 해야 했다.

## 0. 요약

| 항목 | 결과 |
|---|---|
| 브랜치 | `main` 최신화(변경 없음) → Phase 3/4 검증 → `my-changes`에 병합 후 푸시 |
| Phase 3/4 완료 여부 | **완료**. 코드·테스트·라이브 검증 모두 확인. 문서 3건만 낡아 있어 수정 |
| 신규 기능 | `src/core/whatif.js` + `strategy_gate_whatif` 툴 + 뷰어 3종 추가 |
| 툴 개수 | 86 → **87** |
| 단위 테스트 | 143 → **159**, 전부 통과 |
| 뷰어 크기 | 101,251 → 104,029 B (상한 100 → 104 KB, 의도적 상향) |
| 커밋 | 4건 (`3811962` `189db79` `3585a34` `40b7dee` `355a0bf`) — 전부 `my-changes`에 푸시 완료 |

---

## 1. 브랜치 정리

`main`은 `origin/main`과 이미 동기 상태였고 받을 것이 없었다(`b3f7843`). 설계대로 **원본 그대로**
유지된다.

문제는 따로 있었다. **Phase 3/4 작업 10개 커밋이 `my-changes`에 하나도 들어가 있지 않았다.**
`my-changes`는 PR #2 병합(`953e783`)에 멈춰 있었고, `c64f82f`부터 `fbc0164`까지가 피처 브랜치에만
있었다. `--no-ff`로 충돌 없이 병합했다(`3811962`). `main`은 건드리지 않았고 PR도 열지 않았다.

## 2. Phase 3/4 검증 결과 — 완료

명세(`docs/phase-plan/phase-3-backtest.md`, `phase-4-optimize.md`)의 파일 목록을 하나씩 대조했다.

- **Phase 3**: `src/core/backtest.js`, `src/core/validate.js`, `src/tools/backtest.js`
  (`strategy_run_backtest`), `src/cli/commands/backtest.js`, 브리지 `POST /reports` ·
  `timeoutMs` · `health.postReports`, 뷰어 `#tab-backtest` — **전부 존재**.
- **Phase 4a**: `paramspace.js`, `objectives.js`, `sweep.js`, `scripts/sweep-job.js`,
  브리지 `/sweep · /sweep/status · /cancel · /resume · /apply · /objectives`(`/agent`와 공유하는
  차트 잠금, 충돌 시 409), `profiles/pf3g-vp.json`의 `optimize.shortlist`, 뷰어 `#tab-optimize`,
  `strategy_sweep_plan` — **전부 존재**.
- 단위 테스트 143건 전부 통과. 뷰어는 자기 완결 단일 파일 조건도 유지.
- 라이브 종단 검증 기록은 `phase-3-4-implementation-notes.ko.md` §7.4에 남아 있다
  (2026-09-04, SOLUSD·15 + Supertrend Strategy).

### 다만 문서 3건이 낡아 있었다 (수정함 · `189db79`)

1. `README.md`가 여전히 **82 MCP tools**라고 적혀 있었다. 실제는 86이었다. Phase 3 변경 목록은
   README와 CLAUDE.md 둘 다 고치라고 했는데 CLAUDE.md만 반영돼 있었다.
2. `docs/VIEWER_GUIDE.ko.md`의 Backtest·Optimize 탭이 **"🛠 구현됨 (라이브 검증 대기)"** 상태로
   남아 있었다. 라이브 검증은 2026-09-04에 이미 끝났다 → **"✅ 동작 (2026-09-04 라이브 검증)"**.
3. 같은 문서 변경 이력에 Phase 3/4 항목이 아예 없어 두 줄 추가.

### 의도적 미구현 (결함 아님)

Phase 3.5 바이어스 점검(선택), 4b What-if 패널, 4c 멀티 심볼 비교, `tv sweep` CLI(명세에서 optional).

## 3. 에이전트 리포트 쓰기 권한 (`3585a34`)

뷰어 실행이 "리포트를 남겨줘"라는 요청에 분석을 끝내 놓고 권한 프롬프트에서 멈췄다. 원인은
`AGENT_TOOLS`가 읽기 전용이었던 것.

핵심은 **규칙 문법**이었다. `Write(reports/**)`는 CLI가 거부한다:

> `Write(reports/**)` is not matched by file permission checks — only `Edit(path)` rules are.
> Use `Edit(reports/**)` instead (Edit rules cover all file-editing tools).

`Edit(reports/**)` 하나만 추가했다. 양방향 실측 확인: `reports/` 쓰기는 성공, 저장소 루트 쓰기는
여전히 거부. `--dangerously-skip-permissions`는 쓰지 않았다.

참고로 **그 실행은 유실되지 않았다.** 브리지가 `reports/mtt059jk-hblt.json`으로 이미 저장해 뒀고
Reports 탭에서 볼 수 있었다. 막힌 것은 별도 `.md` 사본뿐이었다.

## 4. 신규 기능 — 반증 가능한 검증과 그 결과물

### 4.1 왜 필요했나

리포트의 §4 제안 표에는 "검증" 열이 있지만 그건 검증 **계획**이지 검증이 아니다. 그리고 평소의
검증 수단을 쓸 수 없다 — **PF 3G VP는 `indicator()`라서 Strategy Tester 자체가 없다.**
`strategy_run_backtest`도, Phase 3/4의 스윕 기구 전체도 읽을 대상이 없다.

하지만 `decodeGateAudit()`이 이미 200봉 전체에 대해 봉별 `metrics`를 들고 있다:

```js
metrics: { er, roomPct, reqPct, targetRoomAtr, regime:{raw,active,evidence,whipsaw},
           macro, volGate, dshapeState, dshapeRotation, supertrend }
```

임계값 형태의 제안은 이것만으로 차트 접근 없이, 재계산 없이 판정할 수 있다.

### 4.2 `src/core/whatif.js` (순수 모듈) + `strategy_gate_whatif` 툴

**규칙 두 종류.** 두 방향은 대칭이 아니기 때문에 트리를 공유하지 않는다.

| 종류 | 의미 | 방향 |
|---|---|---|
| `{kind:'require', pred}` | 진입이 만족해야 할 **추가 조건** | FIRED → BLOCKED |
| `{kind:'relax', gates:[…]}` | 해당 게이트를 통과로 간주 | BLOCKED → FIRED |

`relax`는 그 봉에서 **실패한 모든 게이트가 목록에 있을 때만** 차단을 푼다. 무관한 게이트가 하나라도
더 실패했으면 그대로 막힌 상태다 — 대충 넘어가면 틀리는 지점이 정확히 여기다.

**술어는 JSON이지 코드가 아니다.** `metric`은 고정된 접근자 표의 키다. 그래서 `__proto__`,
`constructor`, 단순 오타가 전부 **같은 거부 경로**를 탄다. 정제(sanitize)도, 동적 인덱싱도,
`eval`도 없다.

```js
{ metric: 'roomPct', op: 'gte', value: { metric: 'reqPct', mul: 0.7 } }
{ all: [ … ] }   { any: [ … ] }   { not: … }
```

**아무것도 throw하지 않는다.** 잘못된 규칙은 `{valid:false, reason}`을 돌려준다. 호출자가 언어
모델이고, 던져진 예외는 "문제 없음"으로 오독되기가 명시적 거부보다 쉽기 때문이다.

**3값 논리.** 필요한 metric이 `na`인 봉은 `unknown`이며 통과도 flip도 아니다. 대부분의 봉에서 읽을
수 없는 규칙은 읽힌 봉이 어떻게 나왔든 `insufficient`로 돌아온다.

**표현할 수 없는 것** (툴 설명에 명시 — 호출자가 근사치로 때우지 말고 "검증 불가"라고 말하도록):
봉 간 상태(연속·쿨다운·"N봉 이내"), 프로파일 audit 컬럼에 없는 값(구조 레벨까지의 거리, 봉 내
경로, 다른 ATR 길이), 새 Pine 연산이 필요한 것, 결과(P&L·MFE·MAE).

### 4.3 뷰어 3종 추가

1. **`open report` 칩** — 열려 있는 리포트와 *그것을 만든 프롬프트*를 후속 실행에 실어 보낸다.
   `report.prompt`가 조합된 문자열 전체라서 **원래 컨텍스트가 공짜로 따라온다** — 차트 스크린샷
   경로까지. 후속 실행은 `Read`로 같은 PNG를 직접 연다. 재캡처도, base64도 필요 없다.
2. **`verify + Pine prompt` 프리셋** — 제안을 하나씩 분해 → `strategy_gate_whatif`로 측정 →
   VERIFIED / UNVERIFIABLE 등급 → 별도 Pine 세션에 붙여넣을 블록 하나를 출력.
   템플릿의 핵심 지시는 **거부**다: *대리 규칙을 지어내서 진짜 제안을 시험한 것처럼 제시하지 말 것.*
3. **코드 블록 복사 버튼** — 40줄을 드래그하게 만들면 막다른 길이 다시 생긴다.

## 5. 라이브 실측 결과

COINBASE:SOLUSD · 15, 200봉(`2026-09-06T18:15Z` → `2026-09-08T20:00Z`), 23개 패턴봉, 7개 진입.

| 검사 | 결과 |
|---|---|
| 리포트 제안 #2 `roomPct ≥ reqPct × 0.7` | 진입 **7 → 1**, 16:30 롱 **FIRED → BLOCKED** (roomPct 0.7575 vs 요구 1.05) |
| 절대 실패 못 하는 규칙(`er ≥ -1`) | flip 0건, `no-effect` |
| 항상 실패하는 규칙(`er ≥ 99`) | 7건 전부 flip |
| `relax RoomS` | 11건 차단 해제 — Audit 탭 blocker 히스토그램의 `RoomS: 11`과 **정확히 일치** |
| 주입 시도 `__proto__` | `unknown metric "__proto__"`로 거부 |

### 종단 실행 (opus, 136초, $0.97)

제안 5건 중 **2건만 측정하고 3건은 검증을 거부**했다. 리포트 자신의 헤드라인 주장(#1, "Room 목표를
첫 구조 레벨로 바꿨으면 이 거래는 막혔다")도 거부 대상이었다 — 그 거리가 audit 컬럼에 없기 때문.

시키지 않은 민감도 분석까지 했다: 룸 하한 ×0.7은 16:30을 막지만 ×0.5는 못 막는다(0.7575가 0.75를
**0.0075%p 차이로** 통과). ER 하한은 Room을 고치고 나면 아무것도 추가로 걸러내지 못한다.

### ⚠ 원래 분석이 놓친 발견

**숏 진입 4건이 `roomPct`가 음수인 상태로 발화했다** (−1.036, −0.493, −0.386, −0.038).
Room 게이트가 **목표가 이미 가격 뒤에 있는 거래를 통과시키고 있다**는 뜻이다. 튜닝 이슈가 아니라
소스에서 확인해야 할 **버그**로 취급할 것.

생성된 Pine 프롬프트는 루프도 닫아 둔다 — 지금 측정 불가한 값들(`Audit Room To First Level Pct`,
`Audit Bars Since Last Entry`, `Audit Close Retrace Pct`)을 새 audit 컬럼으로 plot해 달라고 요청한다.
그러면 다음 회차에는 그 제안들도 한 번의 호출로 검증된다.

## 6. Phase 4b와의 관계

`phase-4-optimize.md` §4b의 What-if 패널은 "게이트 X를 통과로 간주"만 명세했고 구현된 적이 없다.
이번에 **그 엔진이 일반화된 형태로, 헤드리스로 먼저 나왔다.** 4b는 게이트 하나를 뒤집는 것이고,
이 모듈은 `metrics` 위의 임의 술어를 평가한다. "게이트 X를 통과로" 는 `relax` 한 형태일 뿐이다.

따라서 **패널은 이제 얇은 클라이언트**다. 뷰어에는 이미 브리지 `POST /call` MCP 프록시를 때리는
`call()`이 있으므로, 평가기를 HTML에 복제하지 말고 같은 툴을 부르면 된다.

## 7. 부수 확인 — 브라우저 라우팅

`run.sh`가 예전엔 ChromeOS 브라우저로 열렸는데 지금은 새로 설치된 쪽에서 열린다는 건에 대해:

컨테이너 안에 **Google Chrome이 2026-08-24에 설치**됐고(`/opt/google/chrome/chrome`),
그 desktop 항목이 `x-scheme-handler/http;https`를 주장한다. 어떤 `mimeapps.list`에도 명시적
기본값이 없어 `mimeinfo.cache` 정렬로 결정되는데 `com.google.Chrome.desktop`이
`garcon_host_browser.desktop`보다 앞선다. 그래서:

```
xdg-mime query default x-scheme-handler/http  →  com.google.Chrome.desktop
```

즉 **`xdg-open`으로 URL을 여는 모든 도구가 컨테이너 Chrome으로 간다.** 다만 `run.sh` 자체는
범인이 아니다 — ChromeOS 분기에서 `xdg-open`을 우회해 garcon 심을 직접 부르고, 실제로 이번 실행에서
`/opt/google/chrome` 프로세스는 뜨지 않았다. `xdg-open` 쪽만 되돌리려면 한 줄이면 된다:

```bash
xdg-settings set default-web-browser garcon_host_browser.desktop
```

## 8. 이월 (의도적 미구현)

- **`POST /proposals` + `docs/proposals/`** — 커밋되는 제안 문서. 실제 출력물을 두세 개 읽어 보기
  전에는 커밋할 가치가 있는지 알 수 없다. 손을 봐야 하는 물건으로 드러나면 올바른 산출물은
  *사용자가* 복사 버튼으로 만든 파일이고, 이 기능은 영영 안 만드는 게 맞다. 그동안에도
  `reports/`의 JSON이 전부 보존한다.
- 4b 시각 패널, 4b의 ±% 선행수익 열
- `docs/PROMPT_CATALOGUE.md` (`README.md:40`의 미작성 부수 산출물) — 이번 템플릿이 그 첫 항목이다
- 라이브 재감사 A/B(`indicator_set_inputs` → 재감사 → diff → 복원): 반증 replay가 실제 Pine 연산과
  어긋나는 게 확인될 때만 가치 있다

## 9. 커밋

| 커밋 | 내용 |
|---|---|
| `3811962` | merge: Phase 3/4 열 개 커밋을 `my-changes`로 (충돌 없음) |
| `189db79` | docs: 툴 개수 정정, Backtest/Optimize 라이브 검증 완료 표기 |
| `3585a34` | feat(agent): 뷰어 실행이 `reports/` 범위 안에서 리포트 파일을 쓸 수 있게 |
| `40b7dee` | feat(whatif): 반증 replay 엔진 + `strategy_gate_whatif` 툴 |
| `355a0bf` | feat(viewer): 리포트 → 검증된 변경 요청 체인, 코드 블록 복사 버튼 |

## 10. 알아 둘 것

세션 중 브리지가 한 번 **OOM으로 강제 종료**됐다. 코드 문제가 아니라 컨테이너 메모리 압박이다
(6.3 GB 중 5.5 GB 사용, 여유 ~849 MB — VS Code 4개 ~1.0 GB, `claude` 2개 ~816 MB,
TradingView 290 MB). 재시작했고 지금은 정상이다.

스윕은 차트를 수 분간 점유하는 장기 잡이라 이 점이 중요하다. 브리지가 스윕 도중 죽어도
`reports/sweeps/`의 저널이 남아 `POST /sweep/resume`가 올바른 지점부터 재개한다(2026-09-04에
의도적 SIGKILL로 검증). 복구는 되지만, 애초에 안 죽게 하려면 에디터 창이나 두 번째 `claude`
세션을 먼저 닫는 편이 낫다.
