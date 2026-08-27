# Strategy Gate Debug — 사용 가이드 (Usage Guide)

PineForge 볼륨 전략("PF 3G VP")을 스크린샷 없이 데이터로 디버깅하는 방법.
"이 봉에서 왜 진입했나 / 왜 막혔나"를 게이트 비트 단위로 답한다.

The `/strategy-gate-debug` skill (in `.claude/skills/`) is the executable playbook;
this document is the setup + usage manual, in Korean with English commands.

---

## 1. 구성 요소

| 구성 요소 | 위치 | 역할 |
|---|---|---|
| 전략의 Audit 플롯 | 전략 내장 (Data Window) | 봉별 게이트 비트마스크·ER·레짐 상태 |
| PF-TLM 텔레메트리 테이블 | 전략 입력 `Diagnostics → Debug Telemetry Table (MCP)` | 타임스탬프 포함 봉별 로그 (기본 OFF) |
| `data_get_study_series` | 이 리포 MCP 툴 | Audit 플롯의 **봉별 히스토리** 추출 (핵심) |
| `data_get_pine_tables/labels` | 이 리포 MCP 툴 | 텔레메트리 행·X라벨(`X8·MAC` 형식) 읽기 |
| `/strategy-gate-debug` 스킬 | `.claude/skills/strategy-gate-debug/` | 위 전부를 묶은 디버깅 플레이북 |
| `scripts/http-bridge.js` | 이 리포 | MCP를 HTTP로 노출 — 웹 세션/외부 앱용 |

마스크 비트표·차단자 코드 상세는 전략 리포의 `docs/mcp-debug-workflow.md` 참조.

---

## 2. 로컬 사용법 (데스크톱 Claude Code)

TradingView Desktop이 설치된 PC에서:

### 2.1 최초 1회 설정

```bash
# 1) TradingView Desktop을 CDP 디버그 모드로 실행
#    (플랫폼별 스크립트 — 이미 실행 중이면 완전히 종료 후 재실행)
./scripts/launch_tv_debug_mac.sh        # macOS
scripts\launch_tv_debug_win.bat         # Windows
./scripts/launch_tv_debug_linux.sh      # Linux

# 2) 연결 확인
curl -s http://localhost:9222/json/version   # JSON이 나오면 OK

# 3) Claude Code에 MCP 서버 등록 (프로젝트 루트에서)
claude mcp add tradingview -- node /절대경로/tradingview-mcp-jackson/src/server.js
```

또는 프로젝트에 `.mcp.json`으로 등록:

```json
{
  "mcpServers": {
    "tradingview": {
      "command": "node",
      "args": ["/절대경로/tradingview-mcp-jackson/src/server.js"]
    }
  }
}
```

### 2.2 디버깅 세션

1. TradingView 차트에 PF 3G VP 전략(또는 인디케이터)을 올린다
2. 전략 설정 → `Diagnostics → Debug Telemetry Table (MCP)` ON
3. Claude Code에서:

```
/strategy-gate-debug
어제 06:00봉에서 롱이 X8로 막혔는데 이유를 찾아줘
```

Claude가 `strategy_gate_audit`로 봉별 판정(차단 게이트·지배 입력까지 디코딩됨)을 받고 — 필요하면 `data_get_study_series`로 원본 마스크를 확인 —
PF-TLM 행으로 시각·ER·볼륨비를 교차 확인한 뒤, 차단 게이트와 지배 입력을 보고한다.

예시 판정 출력:

```
[2026-08-24T06:00 UTC] mask=49149 → failing bit: 4096 (Macro long)
metrics: ER=0.41 vol/baseline=0.87 evidence=1/3 shapes=b/D target=97.66@1.2
cause: 매크로 "b" bias 활성 + 2-of-3 확인 미충족 (볼륨 항목 실패)
governing input: "Confirmed Profile Macro Bias" (Soft Filter), "Macro Bias Recovery Closes" (2)
suggestion: 회복 구간이 반복 차단되면 Median Baseline 전환 또는 Recovery Closes 1로 완화 검토
```

### 2.3 라이브 게이트 뷰어 (브라우저)

Claude 없이 차트를 보면서 게이트 상태를 실시간으로 확인하려면 HTTP 브리지의 뷰어를 연다:

```bash
MCP_BRIDGE_TOKEN=mysecret node scripts/http-bridge.js
# 브라우저에서  http://127.0.0.1:3001/viewer
#   옵션: ?refresh=10 (초, 최소 2) &count=200 (봉 수, 최대 500) &study=PF%203G &profile=pf3g-vp
```

- 최초 접속 시 브리지 토큰을 한 번 묻고 `localStorage`에 저장한다 (토큰 없이 띄운 브리지면 빈칸으로 확인).
- 구성: 봉별 판정 스트립(위 = 롱, 아래 = 숏 / 초록 진입 · 빨강 차단 · 노랑 미확정 라이브 봉) → 16행 게이트 히트맵(채워진 칸 = 해당 게이트 실패, 밝은 칸 = 주 차단 게이트) → 차단 게이트 히스토그램(클릭 시 표 필터) → 패턴 봉 표(열 클릭 정렬) → 봉 클릭 시 상세 판정(마스크·실패 게이트·지표·지배 입력).
- 탭이 숨겨지면 폴링을 멈추고, 다시 보이면 즉시 갱신한다. 401이면 토큰을 다시 묻고, TradingView 연결이 끊기면 상단에 배너(브리지 503)를 띄우고 마지막 데이터를 유지한다.
- `/viewer` 자체는 토큰 없이 열리는 정적 HTML이다 (비밀 없음). 데이터 호출(`/call`)은 계속 토큰이 필요하다.

---

## 3. 웹 사용법 (claude.ai/code — Claude Code on the web)

웹 세션의 컨테이너는 사용자 PC의 `localhost:9222`에 접근할 수 없다.
**스킬 자체는 리포가 세션에 추가되면 자동 인식**되고, 라이브 차트 접근은 HTTP 브리지 + 터널로 해결한다.

### 3.1 로컬 PC에서 (1터미널)

```bash
# 토큰 없이 터널에 노출 금지 — 토큰은 필수로 생각할 것
MCP_BRIDGE_TOKEN=$(openssl rand -hex 16) node scripts/http-bridge.js
# 출력된 토큰을 복사해 둔다 (또는 직접 지정: MCP_BRIDGE_TOKEN=mysecret ...)
```

### 3.2 터널 노출 (2터미널)

```bash
ngrok http 3001
# 또는
cloudflared tunnel --url http://localhost:3001
```

발급된 `https://xxxx.ngrok-free.app` 형태의 URL을 복사.

### 3.3 웹 Claude Code 세션에서

```
/strategy-gate-debug
브리지: https://xxxx.ngrok-free.app  토큰: <복사한 토큰>
어제 횡보 구간에서 왜 롱이 나갔는지 확인해줘
```

스킬이 MCP 툴 부재를 감지하면 curl 경로로 동일한 루프를 수행한다:

```bash
curl -s "$TV_BRIDGE_URL/health" -H "Authorization: Bearer $TV_BRIDGE_TOKEN"
curl -s "$TV_BRIDGE_URL/call" -H "Authorization: Bearer $TV_BRIDGE_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"tool":"data_get_study_series","params":{"study_filter":"PF 3G","plot_filter":"Audit","count":200}}'
```

### 3.4 보안 수칙

- `MCP_BRIDGE_TOKEN` 없이 터널을 열지 않는다 — URL을 아는 누구든 TradingView 세션을 조종할 수 있다
- 터널 URL/토큰을 공개 채널에 남기지 않는다
- 디버깅이 끝나면 터널과 브리지를 종료한다 (`Ctrl+C`)
- 브리지는 기본 `127.0.0.1` 바인드 — LAN 노출이 필요할 때만 `MCP_BRIDGE_HOST` 변경

### 3.5 브리지 엔드포인트

| 엔드포인트 | 메서드 | 설명 |
|---|---|---|
| `/viewer` | GET | 라이브 게이트 뷰어 (정적 HTML, 토큰 불필요 — 페이지가 직접 토큰을 물어 `/call`을 호출) |
| `/health` | GET | `{ ok, connected }` — TradingView/CDP 연결 여부 (미연결 시 503) |
| `/tools` | GET | 사용 가능한 MCP 툴 이름/설명 목록 |
| `/call` | POST | `{ "tool": "...", "params": { ... } }` → 툴 결과 JSON (TradingView/CDP 미연결로 실패하면 503, 그 외 툴 오류는 500) |

---

## 4. 자주 겪는 문제

| 증상 | 원인/해결 |
|---|---|
| `/health`가 503 | TradingView Desktop이 CDP 모드가 아님 → `scripts/launch_tv_debug_*`로 재실행 |
| `data_get_study_series`가 "No study columns matched" | `study_filter` 오타(대소문자는 무시됨) 또는 전략이 차트에 없음. 플롯 제목은 `data_get_study_values`로 확인 (`plot_filter`는 `\|`로 여러 제목 지정 가능) |
| `data_get_study_series`가 "Data export is not supported" | 구버전 MCP 서버. TradingView Desktop 3.1.0은 `exportData`를 스텁 처리하므로 최신 버전은 차트 모델의 PlotList를 직접 읽음 — `git pull` 후 재시작 |
| 뷰어 상단에 "TradingView unreachable" 배너 | 브리지가 503을 반환 — TradingView Desktop이 꺼졌거나 CDP 모드가 아님. `/health`로 확인 후 재실행하면 뷰어가 자동 복구 |
| 텔레메트리 테이블이 안 읽힘 | 전략 입력에서 `Debug Telemetry Table (MCP)`가 OFF |
| 라벨에 시간이 없음 | 정상 — 라벨 툴팁의 `t=` 또는 PF-TLM 행으로 봉을 특정 |
| 401 Unauthorized | `Authorization: Bearer <토큰>` 헤더 누락/불일치 |

---

## 5. 관련 문서

- 전략 리포 `docs/mcp-debug-workflow.md` — 마스크 비트표, 차단자 코드, PF-TLM 필드 사전 (한국어)
- `.claude/skills/strategy-gate-debug/SKILL.md` — 실행 플레이북 (Claude가 따르는 문서)
- `SETUP_GUIDE.md` — MCP 서버 일반 설치 가이드
