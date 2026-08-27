# Gate Audit — 사용 가이드 & 세션 노트

이번 세션에서 추가된 두 가지를 정리한 문서:
1. **`strategy_gate_audit` MCP 툴** — 게이트 마스크를 손으로 디코딩하지 않고, 봉별 판정(패턴·차단 게이트·지배 입력)을 바로 받는다.
2. **라이브 Gate Audit 뷰어** — `http-bridge.js`가 서빙하는 대시보드. Claude 없이 브라우저에서 실시간으로 확인.

배경 문제와 전체 마스크 비트표는 [`DEBUG_WORKFLOW_GUIDE.md`](./DEBUG_WORKFLOW_GUIDE.md)와 `.claude/skills/strategy-gate-debug/SKILL.md` 참조. 이 문서는 신규 기능 사용법과, 구현 중 발견한 주의사항(노트)에 집중한다.

---

## 1. `strategy_gate_audit` 툴

### 왜 필요했나

기존에는 `data_get_study_series`로 원본 `Audit Final Entry Pass Mask` 숫자를 받아 사람이 직접 비트 연산(어떤 비트가 0인지, 어떤 게이트인지, 어느 입력이 지배하는지)을 해야 했다. `strategy_gate_audit`는 이 디코딩을 **MCP 서버 안에서 끝내고** 바로 판정을 반환한다.

### 호출

```jsonc
// Claude Code / MCP 클라이언트에서
strategy_gate_audit({ "count": 200 })

// HTTP 브리지 경유 (curl)
curl -s localhost:3001/call \
  -H "Authorization: Bearer $MCP_BRIDGE_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"tool":"strategy_gate_audit","params":{"count":200}}'
```

파라미터 (전부 optional):

| 파라미터 | 기본값 | 설명 |
|---|---|---|
| `count` | 200 | 마지막 N봉 (최대 500) |
| `study_filter` | 프로파일의 `studyFilter` (`"PF 3G"`) | 대상 스터디 이름 부분 문자열 |
| `profile` | `"pf3g-vp"` | `profiles/` 안의 프로파일 이름, 또는 절대경로 `.json` |

### 반환 구조 (핵심 필드만)

```jsonc
{
  "success": true,
  "study": "PineForge 3rd Gen Volume Profile [Coinbase]",
  "chart": { "symbol": "COINBASE:SOLUSD", "resolution": "5" },
  "bar_count": 200,
  "profile": { "name": "pf3g-vp", "gates": [ /* 16개 게이트 정의 */ ] },
  "summary": {
    "bars": 200, "patternBars": 22, "fired": 13, "blocked": 9, "live": 0,
    "blockerHistogram": { "RoomL": 2, "RoomS": 2, "RgmS": 2, "TrdL": 1, "RgmL": 1, "TrdS": 1 },
    "firstIso": "...", "lastIso": "...", "missingColumns": []
  },
  "verdicts": [
    {
      "iso": "2026-08-26T23:45:00.000Z",
      "side": "L", "reason": 8, "reasonName": "Healthy Breakout + FVG",
      "fired": false, "live": false,
      "mask": 65021,
      "failedGates": ["RoomL", "TrdS"],
      "sideFailedGates": ["RoomL"],
      "blocker": "RoomL", "blockerCode": "ROOM",
      "metrics": { "er": 0.47, "roomPct": 0.16, "reqPct": 1.5, "regime": {"raw":10,"active":false,"evidence":1,"whipsaw":0}, "macro": 0, "volGate": 1, "targetRoomAtr": 0.33 },
      "governingInputs": ["Require cost-adjusted next POC room", "Projected Target Policy", "Required Move Percent"]
    }
    // ...
  ]
}
```

읽는 법:
- `side`: 이 봉에서 패턴이 잡힌 방향 (`"L"` / `"S"` / 양쪽 다 잡히면 `"LS"` — 이때 `secondary` 필드에 반대쪽 판정이 따로 들어간다)
- `fired`: 실제 진입 트리거 발동 여부
- `live`: 마지막 봉인데 `confirmed` 비트만 아직 안 채워진 경우 (미확정 봉 — "차단"이 아니라 "대기 중")
- `blocker` / `blockerCode`: 진입을 막은 **1순위** 게이트와 그 카테고리 (RGM > MAC > TRD > PRX > ROOM > DSHP 우선순위. `confirmed`는 다른 게이트가 전부 통과했을 때만 차단자로 지목됨)
- `governingInputs`: 그 게이트를 조정하려면 만질 입력값 이름

### 프로파일 커스터마이징

`profiles/pf3g-vp.json`에 컬럼 이름·게이트 비트·차단자→입력 매핑이 전부 들어있다. 다른 전략에 맞추려면 이 구조를 그대로 복사해 새 프로파일을 만들고 `profile` 파라미터로 지정하면 된다 (코드 수정 불필요).

---

## 2. 라이브 Gate Audit 뷰어

### 실행

```bash
# 리포 루트에서
MCP_BRIDGE_TOKEN=mysecret node scripts/http-bridge.js
```

브라우저에서 열기:

```
http://127.0.0.1:3001/viewer
```

쿼리 옵션: `?refresh=10` (초 단위, 최소 2초, 기본 10) · `?count=200` (최대 500) · `?study=PF%203G` · `?profile=pf3g-vp`

### 화면 구성 (위에서 아래로)

1. **헤더** — 스터디명, `심볼 · 타임프레임`, 마지막 봉 시각, `fired / blocked / live` 카운트, 상태 점(초록=정상 폴링, 빨강=에러), 새로고침 주기, `↻`(즉시 새로고침) / `token`(토큰 재입력) 버튼
2. **판정 스트립** — 봉 하나당 세로 막대 (위쪽 절반 = 롱, 아래쪽 절반 = 숏). 초록=진입, 빨강=차단, 노랑 점선=미확정 라이브 봉, 회색=패턴 없음
3. **게이트 히트맵** — 16개 게이트(행) × 봉(열). 칸이 채워지면 그 게이트가 그 봉에서 실패, 밝을수록 "1순위 차단자"
4. **차단자 히스토그램** — 어떤 게이트가 가장 많이 막았는지. 클릭하면 아래 표가 그 게이트로 필터링됨
5. **패턴 봉 표** — 시간/방향/패턴/판정/차단자/ER/room%/req%/... 열 헤더 클릭으로 정렬
6. **상세 드로어** — 봉(스트립/히트맵/표 아무 데나) 클릭 시 우측에 전체 판정(마스크, 실패 게이트 전체, 지표, 지배 입력) + 원본 JSON 표시. `Esc`로 닫기

### 토큰

최초 접속 시 상단에 토큰 입력 바가 뜬다. 브리지가 `MCP_BRIDGE_TOKEN` 없이 떠 있으면 빈칸으로 "connect"만 누르면 된다. 입력한 토큰은 브라우저 `localStorage`에 저장되어 다음 접속부터 자동 로그인된다. 토큰이 틀리면(401) 자동으로 입력 바가 다시 뜬다.

### 동작 디테일

- 탭이 백그라운드로 가면 폴링을 멈추고, 다시 보이면 즉시 갱신한다
- 브리지가 5xx/타임아웃을 반환해도 마지막으로 성공한 화면을 유지하고 상단에 배너만 띄운다
- TradingView/CDP가 끊기면 브리지가 503을 반환 → 배너에 "TradingView unreachable" 표시
- `/viewer` 자체는 토큰이 필요 없는 정적 페이지다 (비밀 정보 없음). 실제 데이터 호출(`/call`)만 토큰이 필요.

---

## 3. 세션 노트 (구현 중 발견한 것들)

### `exportData()`는 TradingView Desktop 3.1.0에서 죽어 있다

`chartWidget.exportData(...)`가 항상 `Promise.reject("Data export is not supported")`를 반환한다. `data_get_study_series`는 이제 이 함수를 쓰지 않고, 차트 모델을 직접 읽는다:

```
window.TradingViewApi._activeChartWidgetWV.value()._chartWidget
  .model().model().dataSources()   // 스터디 배열
  → study.metaInfo()               // description, shortDescription, plots, styles
  → study.data()                   // PlotList: firstIndex()/lastIndex()/valueAt(i)
```

`firstIndex()`는 거대한 음수 센티널이라 **항상 `lastIndex()`부터 역방향으로** 읽어야 한다 (0부터 읽으면 안 됨).

### CDP 타겟 선택 버그 — 렌더러 멈춤과 겹쳐서 발견

`connection.js`의 기존 타겟 탐색 로직은 URL에 `"tradingview"`가 들어가면 뭐든 채택했는데, TradingView Desktop 앱의 **내부 `file://` 페이지 경로에도 `TradingView`가 들어간다** (`file:///opt/TradingView/resources/app.asar/...`). 렌더러가 한 번 멈췄다가(원인 미상, 재현 안 됨) 재시작된 뒤 MCP 서버가 이 내부 페이지에 붙어버려 `chart_get_state`가 `_activeChartWidgetWV` 관련 에러를 냈다. `pickChartTarget()`을 순수 함수로 분리하고 `https://*.tradingview.com/` 페이지만 후보로 삼도록 고쳤다 (`tests/connection_target.test.js`).

**증상을 다시 보면:** TradingView Desktop을 완전히 재시작 (`tv_launch` with `kill_existing: true`) 하고 차트가 다 로드될 때까지(수십 초) 기다린 후 재시도.

### CDP는 여러 클라이언트를 동시에 받는다

브리지가 띄운 MCP 서버(별도 Node 프로세스)와 이 Claude Code 세션의 MCP 서버가 **동시에** 같은 차트에 CDP로 붙어 있어도 문제없다. 즉 `http-bridge.js`를 계속 띄워두고 뷰어로 실시간 확인하면서, 동시에 Claude Code에서 다른 툴을 호출해도 서로 간섭하지 않는다.

### 브리지 라우팅 주의점

- `authorized()` 토큰 체크가 라우팅보다 먼저 실행되므로, `/viewer`(토큰 불필요)는 그 체크 **이전**에 분기해야 한다
- `req.url === '/health'` 같은 정확 매치는 `?refresh=10` 같은 쿼리스트링이 붙으면 깨진다 → `new URL(req.url, ...).pathname`으로 라우팅
- MCP 자식 프로세스를 `SIGINT`/`SIGTERM`에서 정리하지 않으면 브리지를 껐다 켤 때 고아 프로세스가 남는다 → 시그널 핸들러 추가
- 브리지가 성공 응답을 CDP-down 에러와 구분 없이 500으로 매핑하고 있었다 → TradingView/CDP 관련 에러 문자열은 503으로 매핑해 "재시도하면 될 문제"와 "설정을 봐야 할 문제"를 구분

---

## 4. 관련 파일

| 경로 | 내용 |
|---|---|
| `profiles/pf3g-vp.json` | 게이트/컬럼/차단자 프로파일 (수정 대상) |
| `src/core/gateAudit.js` | 디코더 순수 함수 (`decodeGateAudit`, `decodeMask`, `pickBlocker`, ...) |
| `src/tools/gateAudit.js` | `strategy_gate_audit` MCP 툴 등록 |
| `scripts/viewer/gate-audit.html` | 뷰어 단일 파일 (외부 리소스 없음, 다크 테마) |
| `scripts/http-bridge.js` | `/viewer`, `/call`, `/health`, `/tools` 라우팅 |
| `tests/gate_audit.test.js`, `tests/gate_audit_tool.test.js`, `tests/http_bridge.test.js`, `tests/connection_target.test.js` | 관련 테스트 (`npm run test:unit`) |
