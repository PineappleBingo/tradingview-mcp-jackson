# Claude Code 스킬 · 플러그인 셋업 가이드

> **최종 수정일: 2026-08-31**
> 스킬을 추가·제거할 때마다 이 날짜와 [12장 변경 이력](#12-변경-이력)을 함께 갱신하세요.
> 이 문서는 프로파일(`~/.claude`)이 초기화돼도 살아남도록 git 저장소 안에 둡니다.

새 머신에서 이 문서 하나만 AI에게 주면 동일한 환경이 재현됩니다.
바로 설치 → [9. 마스터 프롬프트](#9-마스터-프롬프트) | 한글이 깨져 보인다면 → [2. 한글 표시 문제](#2-한글-표시-문제-먼저-해결)

---

## 1. 한눈에 보기

### 전역 설치 (모든 프로젝트 공통)

| 이름 | 저장소 | 한 줄 설명 | 방식 | 구성 |
|---|---|---|---|---|
| superpowers | [obra/superpowers](https://github.com/obra/superpowers) | TDD·디버깅·계획 수립 개발 방법론 | 플러그인 | 스킬 14 |
| ponytail | [dietrichgebert/ponytail](https://github.com/dietrichgebert/ponytail) | YAGNI 강제 — "가장 게으른 해법" | 플러그인 | 스킬 6 |
| claude-mem | [thedotmack/claude-mem](https://github.com/thedotmack/claude-mem) | 세션 간 영속 메모리 | 플러그인 | 스킬 19, MCP 1 |
| headroom | [headroomlabs-ai/headroom](https://github.com/headroomlabs-ai/headroom) | 도구 출력 압축 (토큰 절감) | 플러그인 | 훅 전용 |
| context7 | [upstash/context7](https://github.com/upstash/context7) | 라이브러리 최신 문서 실시간 조회 | 플러그인 (공식) | MCP 1 |
| playwright | Microsoft | 브라우저 자동화 · E2E | 플러그인 (공식) | MCP 1 |
| agent-skills | [vercel-labs/agent-skills](https://github.com/vercel-labs/agent-skills) | React/Next.js·웹디자인·문서작성 | `npx skills` | 스킬 9 |
| strix | [usestrix/strix](https://github.com/usestrix/strix) | AI 모의침투 테스트 | `npx skills` | 스킬 9 |

### 프로젝트 스코프

| 이름 | 저장소 | 설명 | 구성 |
|---|---|---|---|
| ecc | [affaan-m/ecc](https://github.com/affaan-m/ecc) | 에이전트 하네스 최적화 종합 레이어 | 스킬 380, 에이전트 68 |

### 별도 도구 (스킬 아님 → [6장](#6-별도-도구-스킬-아님))

graphify · strix CLI · screenshot-to-code

---

## 2. 한글 표시 문제 (먼저 해결)

리눅스 최소 설치 환경에서 이 문서가 `□□□`로 깨져 보이는 원인은 **두 단계**입니다. 둘 다 해결해야 합니다.

### 2-1. 한글 폰트 설치

```bash
fc-list :lang=ko | wc -l          # 0이면 폰트 없음
sudo apt-get install -y fonts-noto-cjk
fc-cache -f
fc-match 'monospace:lang=ko'      # "Noto Sans Mono CJK KR"가 나와야 정상
```

터미널은 **고정폭(monospace)** 글꼴을 쓰므로 `fc-match monospace:lang=ko`가 한글 폰트로 해석되는지 반드시 확인하세요.

### 2-2. ⚠️ 앱 재시작 (가장 많이 놓치는 부분)

**VS Code·Cursor 등 Electron 앱은 프로세스 시작 시점에 시스템 폰트 목록을 한 번만 읽고 캐싱합니다.**
앱이 실행 중인 상태에서 폰트를 설치하면 `fc-cache`를 아무리 돌려도 그 앱에는 반영되지 않습니다.

```bash
# 원인 확인: 앱 시작 시각이 폰트 설치 시각보다 앞서면 재시작 필요
ps -eo lstart,cmd | grep "[/]usr/share/code/code"
stat -c '%y' ~/.cache/fontconfig
```

> **해결: VS Code를 완전히 종료 후 재실행.** 터미널 탭만 새로 여는 것으로는 안 됩니다.

### 2-3. 폰트 명시 지정 (선택, 확실하게)

`~/.config/Code/User/settings.json`:

```json
{
    "terminal.integrated.fontFamily": "'DejaVu Sans Mono', 'Noto Sans Mono CJK KR', monospace",
    "editor.fontFamily": "'DejaVu Sans Mono', 'Noto Sans Mono CJK KR', monospace"
}
```

영문은 DejaVu, 한글은 Noto CJK로 폴백됩니다.

> 📌 파일 자체는 항상 정상 UTF-8입니다. 깨짐은 **인코딩 문제가 아니라 글리프(폰트) 부재**입니다. `LANG=C.UTF-8`이어도 UTF-8이므로 문제없습니다.

---

## 3. 사전 준비물

| 항목 | 확인 | 없을 때 |
|---|---|---|
| Claude Code | `claude --version` | `curl -fsSL https://claude.ai/install.sh \| bash` |
| PATH | `which claude` | `echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc && source ~/.bashrc` |
| Node.js 18+ | `node --version` | `sudo apt-get install -y nodejs npm` |
| jq | `jq --version` | `sudo apt-get install -y jq` |
| 한글 폰트 | `fc-list :lang=ko \| wc -l` | [2장](#2-한글-표시-문제-먼저-해결) |

> ⚠️ **jq는 statusline이 요구합니다.** 없으면 statusline이 조용히 깨집니다 — 모델명이 `unknown`, 컨텍스트가 `--%`로만 표시되고, 에러는 stderr로 가서 화면에 안 보입니다. [8장](#8-사용자-레벨-설정-git-밖) 참조.

> ⚠️ **Node.js는 필수입니다.** Claude Code 본체는 자체 런타임으로 돌지만 `npx skills`·claude-mem·MCP 서버가 Node를 요구합니다. 없으면 조용히 실패합니다.

---

## 4. 전역 스킬 상세

### 4-1. obra/superpowers — `superpowers`

개발 방법론을 스킬로 강제하는 프레임워크. TDD 루프, 체계적 디버깅, 계획 작성·실행, 코드리뷰 주고받기, git worktree, 서브에이전트 분산 개발.

- https://github.com/obra/superpowers · MIT · 마켓플레이스명 **`superpowers-dev`**
- 스킬: `brainstorming`, `test-driven-development`, `systematic-debugging`, `writing-plans`, `executing-plans`, `subagent-driven-development`, `verification-before-completion`, `using-git-worktrees` 외

```bash
claude plugin marketplace add obra/superpowers
claude plugin install superpowers@superpowers-dev -s user -y
```

**사용 예:** "이 기능 TDD로 만들어줘" / "체계적으로 디버깅해줘" / "브레인스토밍 하자"

---

### 4-2. dietrichgebert/ponytail — `ponytail`

"가장 게으른 시니어처럼 생각하라". 표준 라이브러리 우선, 50줄보다 1줄, 안 쓴 코드가 최고의 코드. superpowers의 과잉 설계를 견제하는 균형추.

- https://github.com/dietrichgebert/ponytail · MIT · 마켓플레이스명 **`ponytail`**
- 스킬: `ponytail`, `ponytail-audit`, `ponytail-debt`, `ponytail-gain`, `ponytail-review`, `ponytail-help`

```bash
claude plugin marketplace add dietrichgebert/ponytail
claude plugin install ponytail@ponytail -s user -y
```

**사용 예:** "이거 과하게 만든 것 같은데 줄여줘" / "기술부채 점검해줘"

---

### 4-3. thedotmack/claude-mem — `claude-mem`

세션 중 일어난 일을 캡처·AI 압축해 다음 세션에 주입. 프로파일 초기화 대비책이기도 합니다.

- https://github.com/thedotmack/claude-mem · Apache-2.0 · 마켓플레이스명 **`thedotmack`**
- 스킬: `mem-search`, `learn-codebase`, `smart-explore`, `timeline-report`, `standup`, `knowledge-agent` 외 19개

```bash
claude plugin marketplace add thedotmack/claude-mem
claude plugin install claude-mem@thedotmack -s user -y
```

> ⚠️ Claude Code에는 이미 파일 기반 **내장 메모리**(`~/.claude/projects/<프로젝트>/memory/`)가 있습니다. claude-mem은 자체 SQLite+ChromaDB 파이프라인을 따로 돌리므로 **메모리 시스템이 둘**이 됩니다. 어느 쪽을 정본으로 쓸지 정해두세요.

**사용 예:** "지난주에 이거 어떻게 하기로 했지?" / "이 코드베이스 학습해줘"

---

### 4-4. headroomlabs-ai/headroom — `headroom`

도구 출력·로그·파일·RAG 청크를 LLM 도달 전에 압축. JSON 60~95%, 코딩 에이전트 전반 20% 토큰 절감 표방. 스킬 없이 **훅으로만** 동작합니다.

- https://github.com/headroomlabs-ai/headroom · Apache-2.0 · 마켓플레이스명 **`headroom-marketplace`**
- 훅: `SessionStart`, `PreToolUse`

```bash
claude plugin marketplace add headroomlabs-ai/headroom
claude plugin install headroom@headroom-marketplace -s user -y
```

> ⚠️ **모든 도구 출력 경로에 개입합니다.** AI가 받는 데이터가 이상하거나 잘려 보이면 **가장 먼저** 이것을 의심하세요:
> ```bash
> claude plugin disable headroom
> ```
> TradingView MCP처럼 큰 페이로드를 다루는 프로젝트에서 이득이 크지만, 위험도 같은 경로에 몰려 있습니다.

---

### 4-5. upstash/context7 — `context7`

라이브러리·프레임워크의 **버전별 최신 공식 문서**를 원격 MCP로 조회. 학습 컷오프 이후 API 변경으로 인한 환각을 막습니다.

- https://github.com/upstash/context7 · MIT
- **공식 마켓플레이스에 이미 포함** → 마켓 추가 불필요
- 익명 동작, `CONTEXT7_API_KEY` 설정 시 요청 한도 상향

```bash
claude plugin install context7@claude-plugins-official -s user -y
```

**사용 예:** "Next.js 15 App Router 최신 문서 기준으로 짜줘"

---

### 4-6. playwright (Microsoft)

브라우저 자동화 MCP. 페이지 조작, 스크린샷, 폼 입력, 클릭, E2E 테스트.

- 공식 마켓플레이스 포함 → 마켓 추가 불필요

```bash
claude plugin install playwright@claude-plugins-official -s user -y
```

> 💡 로컬 Chrome 세션을 그대로 쓰려면 Claude Code **내장** `claude-in-chrome` 스킬을 쓰세요 (설치 불필요). playwright는 헤드리스·CI용으로 병행합니다.

---

### 4-7. vercel-labs/agent-skills

Vercel 공식 스킬 모음. React/Next.js 성능 패턴, 웹 인터페이스 가이드라인(접근성), 글쓰기 가이드라인, Vercel 배포·비용 최적화.

- https://github.com/vercel-labs/agent-skills
- **플러그인이 아니라 순수 스킬** → `npx skills` CLI 사용
- 스킬 9개: `vercel-react-best-practices`, `vercel-composition-patterns`, `vercel-react-native-skills`, `vercel-react-view-transitions`, `web-design-guidelines`, `writing-guidelines`, `deploy-to-vercel`, `vercel-cli-with-tokens`, `vercel-optimize`

```bash
npx -y skills add vercel-labs/agent-skills -g -a claude-code --all
```

`-g` 전역, `-a claude-code` 대상 에이전트. 실제 파일은 `~/.agents/skills/`에 설치되고 `~/.claude/skills/`로 심링크됩니다.

**사용 예:** "내 UI 접근성 검토해줘" / "이 문서 문체 점검해줘"

---

### 4-8. usestrix/strix (스킬 부분)

AI 모의침투 테스트. 정적 분석 경고가 아니라 샌드박스에서 **실제 익스플로잇을 실증한** 취약점만 보고합니다. OWASP Top 10:2025 및 API Security Top 10 대응.

- https://github.com/usestrix/strix · Apache-2.0
- 스킬 9개: `penetration-testing-with-strix`, `web-app-penetration-testing`, `api-security-testing`, `find-security-vulnerabilities-in-code`, `fix-security-vulnerabilities-with-strix`, `owasp-top-10-testing`, `ci-security-scanning-with-strix`, `managed-pentesting-with-strix`, `application-security-testing`

```bash
npx -y skills add usestrix/strix -g -a claude-code --all
```

> ⚠️ 스킬은 **Strix CLI의 래퍼**입니다. 실제 스캔에는 CLI가 별도로 필요합니다 → [6-2장](#6-2-strix-cli)
> ⚠️ 본인 소유이거나 명시적으로 허가받은 대상에만 사용하세요.

---

## 5. 프로젝트 스코프 — affaan-m/ecc

스킬·본능(instincts)·메모리·보안·리서치 우선 개발을 묶은 하네스 최적화 종합 레이어.

- https://github.com/affaan-m/ecc · MIT · 마켓플레이스명 **`ecc`**
- 규모: **스킬 380, 에이전트 68, 훅 7, MCP 1(chrome-devtools)**

```bash
claude plugin marketplace add affaan-m/ecc
cd <프로젝트 디렉터리>          # 반드시 프로젝트 안에서
claude plugin install ecc@ecc -s project -y
```

**왜 전역이 아닌가:** 스킬 380개는 매 세션 스킬 목록을 지배하고, superpowers(TDD 우선)·ponytail(최소 코드)과 방법론이 정면 충돌합니다. 프로젝트 스코프면 `.claude/settings.json`에 기록되어 git으로 따라다니고 기본 세션은 가볍게 유지됩니다.

**설정 옵션 2개** (`/plugin configure ecc@ecc` 또는 설치 시 `--config KEY=VALUE`):

| 키 | 타입 | 기본값 | 설명 |
|---|---|---|---|
| `hooks_enabled` | boolean | `true` | 끄면 스킬·커맨드만 남고 자동화 훅 비활성화 |
| `hook_profile` | string | `standard` | `minimal` / `standard` / `strict` |

---

## 6. 별도 도구 (스킬 아님)

아래 셋은 **드롭인 스킬이 아니며** 별도 런타임이 필요합니다.

### 6-1. Graphify-Labs/graphify

코드베이스·문서·SQL 스키마·설정·PDF를 **질의 가능한 지식 그래프**로 변환. 로컬 결정론적 AST 파싱, 벡터 스토어 불필요. CLI를 설치하면 CLI가 `/graphify` 스킬을 직접 생성합니다.

- https://github.com/Graphify-Labs/graphify (기본 브랜치 `v8`) · Apache-2.0

```bash
# uv 없으면: curl -LsSf https://astral.sh/uv/install.sh | sh
uv tool install graphifyy      # 패키지명 graphifyy (y 두 개), 명령어는 graphify
graphify install               # Claude Code용 스킬 생성
```

> `command not found` → `uv tool update-shell` 후 새 터미널.
> macOS/Windows는 `pip install` 대신 `uv tool install` / `pipx install` 사용 (인터프리터 불일치로 `ModuleNotFoundError` 발생).
> 선택 기능: `uv tool install "graphifyy[pdf]"` · `[office]` · `[mcp]` · `[neo4j]`

### 6-2. strix CLI

[4-8장](#4-8-usestrixstrix-스킬-부분) 스킬이 호출하는 실제 엔진.

```bash
curl -sSL https://strix.ai/install | bash
export STRIX_LLM="openai/gpt-5"
export LLM_API_KEY="<your-key>"
strix --target ./repo
```

**전제조건:** Docker, AI 프로바이더 API 키.
로컬 설치 없이 쓰려면 관리형 플랫폼(app.strix.ai) 방식이 있고 `managed-pentesting-with-strix` 스킬이 이를 다룹니다.

### 6-3. abi/screenshot-to-code

스크린샷을 HTML/Tailwind/React/Vue 코드로 변환. **독립 웹 애플리케이션이며 스킬이 아닙니다.** Claude Code에 설치할 수 없고 따로 띄워 브라우저로 씁니다.

- https://github.com/abi/screenshot-to-code · MIT

```bash
git clone https://github.com/abi/screenshot-to-code
cd screenshot-to-code
echo "OPENAI_API_KEY=sk-..." > .env      # 또는 ANTHROPIC_API_KEY
docker compose up -d --build             # http://localhost:5173
```

**전제조건:** Docker, 자체 API 키(비용 발생).

---

## 7. 제외 항목과 사유

### benjitaylor/agentation — 설치하지 않음

"에이전트용 시각 피드백 도구". 제외 사유:

1. **정체** — 최종 커밋 2026-06-07 (약 3개월)
2. **라이선스 불명확** — GitHub이 `NOASSERTION`으로 표시
3. **전역 설치 불가** — 프로젝트별 npm devDependency(`npm i -D agentation`)라 저장소마다 반복 설치
4. **더 나은 대안 존재**

| 용도 | 대체 도구 | 설치 |
|---|---|---|
| 실제 Chrome 조작·스크린샷·콘솔 로그 | **`claude-in-chrome`** (Claude Code 내장) | **불필요** |
| 헤드리스·CI 브라우저 자동화 | `playwright` 플러그인 | [4-6장](#4-6-playwright-microsoft) |

둘 다 1st-party이며 활발히 유지보수됩니다.

---

## 8. 사용자 레벨 설정 (git 밖)

⚠️ **이 장의 파일들은 저장소가 아니라 홈 디렉터리에 있습니다. 프로파일이 초기화되면 전부 사라집니다.**
플러그인은 [9장 마스터 프롬프트](#9-마스터-프롬프트)로 복구되지만, 아래 3개는 수동으로 되살려야 합니다.

| 파일 | 내용 | 유실 시 증상 |
|---|---|---|
| `~/.claude/settings.json` | 전역 플러그인 목록, ecc `hook_profile`, statusline 등록 | 플러그인 전부 사라짐 |
| `~/.claude/statusline-command.sh` | statusline 스크립트 | statusline 없음 |
| `~/.config/Code/User/settings.json` | 한글 폰트 지정 | 한글 `□□□` |

### 8-1. statusline 스크립트

`[PONYTAIL] 모델명 | [####------] 43% | effort:high` 형태로 표시합니다.

`~/.claude/statusline-command.sh` 생성 후 `chmod +x`:

```bash
#!/usr/bin/env bash
input=$(cat)

# ponytail mode badge, prepended if the plugin is installed (version-agnostic)
pt=$(ls -d "$HOME"/.claude/plugins/cache/ponytail/ponytail/*/hooks/ponytail-statusline.sh 2>/dev/null | tail -1)
badge=""
[ -n "$pt" ] && badge=$(printf '%s' "$input" | bash "$pt" 2>/dev/null)

model=$(echo "$input" | jq -r '.model.display_name // "unknown"')
used=$(echo "$input" | jq -r '.context_window.used_percentage // empty')
effort=$(echo "$input" | jq -r '.effort.level // empty')

# 10-cell bar, filled proportional to used_percentage
bar=""
if [ -n "$used" ]; then
  filled=$(awk -v p="$used" 'BEGIN{printf "%d", (p/10)+0.5}')
  [ "$filled" -gt 10 ] && filled=10
  for i in $(seq 1 10); do
    if [ "$i" -le "$filled" ]; then bar="${bar}#"; else bar="${bar}-"; fi
  done
  ctx=$(printf "[%s] %.0f%%" "$bar" "$used")
else
  ctx="[----------] --%"
fi

out=$(printf "\033[2m%s | %s" "$model" "$ctx")
if [ -n "$effort" ]; then
  out=$(printf "%s | effort:%s" "$out" "$effort")
fi
[ -n "$badge" ] && printf "%s " "$badge"
printf "%s\033[0m" "$out"
```

`~/.claude/settings.json`에 등록:

```json
"statusLine": {
  "type": "command",
  "command": "bash \"$HOME/.claude/statusline-command.sh\""
}
```

**동작 확인** (재시작 없이 바로 테스트 가능):

```bash
echo '{"model":{"display_name":"Opus 5"},"context_window":{"used_percentage":42.7},"effort":{"level":"high"}}' \
  | bash ~/.claude/statusline-command.sh
# → [PONYTAIL] Opus 5 | [####------] 43% | effort:high
```

> 📌 **비용(cost)은 일부러 뺐습니다.** ecc의 PostToolUse 훅이 이미 세션 비용을 출력하므로 중복입니다.
> 📌 ponytail 배지 경로는 버전 와일드카드(`*`)를 씁니다. 버전을 고정하면 `claude plugin update ponytail` 후 조용히 깨집니다.
> 📌 `jq`가 없으면 **에러 없이** 모델명이 `unknown`, 컨텍스트가 `--%`로만 나옵니다. 반드시 위 확인 명령으로 검증하세요.

### 8-2. VS Code 폰트

`~/.config/Code/User/settings.json` — [2-3장](#2-3-폰트-명시-지정-선택-확실하게)과 동일한 내용입니다.

```json
{
    "terminal.integrated.fontFamily": "'DejaVu Sans Mono', 'Noto Sans Mono CJK KR', monospace",
    "editor.fontFamily": "'DejaVu Sans Mono', 'Noto Sans Mono CJK KR', monospace"
}
```

### 8-3. 백업 권장

프로파일 초기화에 대비해 3개 파일을 저장소 밖 안전한 곳에 복사해 두세요:

```bash
mkdir -p ~/claude-config-backup
cp ~/.claude/settings.json ~/.claude/statusline-command.sh ~/claude-config-backup/
cp ~/.config/Code/User/settings.json ~/claude-config-backup/vscode-settings.json
```

> ⚠️ `~/.claude/settings.json`은 저장소에 커밋하지 마세요. 머신 고유 경로가 들어 있고, 향후 토큰·자격증명이 추가될 수 있습니다.

---

## 9. 마스터 프롬프트

새 머신에서 AI에게 아래 블록을 그대로 붙여넣으세요.

````text
이 문서(docs/skills-setup.ko.md)를 참조해 Claude Code 스킬 환경을 구축해줘.
아래 순서대로 실행하고 각 단계 결과를 보고해줘.

[0단계] 사전 점검 — 없는 것만 설치
  claude --version              # 없으면: curl -fsSL https://claude.ai/install.sh | bash
  which claude                  # 없으면: PATH에 $HOME/.local/bin 추가
  node --version                # 없으면: sudo apt-get install -y nodejs npm
  fc-list :lang=ko | wc -l      # 0이면: sudo apt-get install -y fonts-noto-cjk && fc-cache -f
  export PATH="$HOME/.local/bin:$PATH"

  ※ 폰트를 새로 설치했다면 VS Code를 완전히 종료 후 재시작해야 한다.
    Electron 앱은 시작 시점에 폰트 목록을 캐싱하므로 fc-cache만으로는 반영되지 않는다.

[1단계] 마켓플레이스 등록 (claude-plugins-official은 기본 등록됨)
  claude plugin marketplace add obra/superpowers
  claude plugin marketplace add dietrichgebert/ponytail
  claude plugin marketplace add thedotmack/claude-mem
  claude plugin marketplace add headroomlabs-ai/headroom
  claude plugin marketplace add affaan-m/ecc
  claude plugin marketplace list        # 6개 확인

[2단계] 전역 플러그인 설치 (user 스코프)
  claude plugin install superpowers@superpowers-dev -s user -y
  claude plugin install ponytail@ponytail -s user -y
  claude plugin install claude-mem@thedotmack -s user -y
  claude plugin install headroom@headroom-marketplace -s user -y
  claude plugin install context7@claude-plugins-official -s user -y
  claude plugin install playwright@claude-plugins-official -s user -y

  ※ 마켓플레이스명은 저장소명과 다르다. 위 문자열 그대로 사용할 것. 추측 금지.

[3단계] 전역 스킬 설치 (플러그인 아님)
  npx -y skills add vercel-labs/agent-skills -g -a claude-code --all
  npx -y skills add usestrix/strix -g -a claude-code --all
  ※ Eve / PromptScript 관련 실패 메시지는 무시. claude-code만 성공하면 된다.

[4단계] ecc — 프로젝트 스코프 (전역 금지)
  cd <프로젝트 디렉터리>
  claude plugin install ecc@ecc -s project -y
  ※ 전역 설치 시 스킬 380개가 세션을 지배하고 superpowers/ponytail과 충돌한다.

[5단계] 검증
  claude plugin list                    # 전역 6개 + 프로젝트 ecc = enabled
  ls ~/.claude/skills/                  # 18개 디렉터리
  claude plugin details superpowers     # 구성요소·예상 토큰 비용
  python3 -c "import json,os;print(json.load(open(os.path.expanduser('~/.claude.json')))['enabledPlugins'])"

[5.5단계] 사용자 레벨 설정 복구 (문서 8장)
  플러그인 복구만으로는 statusline과 한글 폰트 설정이 돌아오지 않는다.
  문서 8장의 statusline-command.sh를 생성하고 settings.json에 등록한 뒤,
  아래로 반드시 렌더링을 확인할 것 (jq 없으면 조용히 깨진다):
    echo '{"model":{"display_name":"Opus 5"},"context_window":{"used_percentage":42.7}}' \
      | bash ~/.claude/statusline-command.sh

[6단계] 세션 재시작
  플러그인·스킬은 재시작 후 적용된다. Claude Code를 재시작하고
  스킬 목록에 superpowers·ponytail·vercel·strix 스킬이 뜨는지 확인해줘.

[문제 발생 시]
  - 도구 출력이 이상하거나 잘림   → claude plugin disable headroom
  - 마켓플레이스 추가 실패        → 네트워크·git 확인 후 claude plugin marketplace update
  - npx 없음                      → Node.js 미설치. 0단계로.
  - 한글이 □□□로 깨짐             → 폰트 부재 + 앱 재시작 필요. 인코딩 문제 아님. 문서 2장 참조.

[선택 — 별도 도구, 문서 6장]
  graphify / strix CLI / screenshot-to-code 는 각각 uv·Docker·API 키가 필요하다.
  요청하기 전에는 설치하지 말 것.
````

---

## 10. 검증 체크리스트

- [ ] `fc-list :lang=ko | wc -l` > 0 **그리고** VS Code 재시작 완료 → 이 문서가 정상 표시
- [ ] `node --version` → v18 이상
- [ ] `claude plugin marketplace list` → 6개
- [ ] `claude plugin list` → 전역 6개 enabled + ecc(project) enabled
- [ ] `ls ~/.claude/skills/` → 18개 (vercel 9 + strix 9)
- [ ] `~/.claude.json`의 `enabledPlugins`가 `null`이 아님
- [ ] 세션 재시작 후 스킬 목록에 실제 노출
- [ ] statusline 렌더링 확인 ([8-1장](#8-1-statusline-스크립트)) — `unknown`/`--%`로 나오면 `jq` 미설치
- [ ] `claude plugin details <이름>`으로 토큰 비용 확인 → 전역 스킬 과다 여부 판단

### 2026-08-31 기준 설치 확인된 버전

| 플러그인 | 버전 |
|---|---|
| superpowers@superpowers-dev | 6.3.0 |
| ponytail@ponytail | 4.9.0 |
| claude-mem@thedotmack | 13.18.0 |
| headroom@headroom-marketplace | 0.37.0 |
| ecc@ecc | 2.2.0 |
| context7 / playwright | ed404106fcd8 (공식 마켓 스냅샷) |

환경: Debian 13 (trixie, ChromeOS Crostini) · Claude Code 2.1.251 · Node v20.19.2 · npm 9.2.0

---

## 11. 유지보수

```bash
claude plugin marketplace update       # 전체 마켓플레이스 갱신
claude plugin update <이름>            # 개별 갱신 (재시작 필요)
claude plugin disable <이름>           # 임시 비활성화 (문제 격리)
claude plugin uninstall <이름>         # 제거
claude plugin details <이름>           # 구성요소·토큰 비용
```

**컨텍스트 비용 관리:** 전역 스킬이 늘수록 매 세션 컨텍스트가 커집니다. 주기적으로 `claude plugin details`로 점검하고, 잘 안 쓰는 것은 프로젝트 스코프로 내리거나 제거하세요.

---

## 12. 변경 이력

| 날짜 | 변경 내용 |
|---|---|
| 2026-08-31 | 8장 **사용자 레벨 설정 (git 밖)** 신설 — statusline 스크립트 전문, VS Code 폰트 설정, 백업 절차. 이 3개는 홈 디렉터리에 있어 프로파일 초기화 시 유실되며 마스터 프롬프트로 복구되지 않는다. `jq`를 사전 준비물에 추가 (없으면 statusline이 에러 없이 깨짐). 기존 8~11장 → 9~12장으로 번호 이동. |
| 2026-08-31 | 한글 표시 문제 2장으로 분리 — 폰트 설치만으로는 부족하고 **Electron 앱 재시작이 필수**임을 명시 (VS Code가 시작 시점에 폰트 목록을 캐싱). 터미널 폰트 명시 지정 방법 추가. 마스터 프롬프트에 동일 주의사항 반영. |
| 2026-08-31 | 최초 작성. 전역 8종(플러그인 6 + 스킬셋 2) + ecc 프로젝트 스코프 설치. agentation 제외(claude-in-chrome + playwright 대체). graphify·strix CLI·screenshot-to-code는 별도 도구로 문서화. 한글 폰트·Node.js 사전 준비물 추가. |
