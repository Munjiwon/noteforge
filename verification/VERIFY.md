# 검증 체크리스트

브라우저에서 직접 클릭해 봐야 하는 항목들. 빌드/타입체크는 통과하지만,
DOM 셀렉터·localStorage·BlockNote 내부 구조에 의존하는 기능들은 실제로
눌러봐야 동작 여부를 알 수 있어 별도 정리.

각 항목 앞 `- [ ]` 박스에 직접 체크. 안 되는 게 있으면 그 줄 끝에
`-- 안 됨: <증상>` 형식으로 한 줄 메모만 남기면 그 자리에서 고쳐드림.

---

## 1) 페이지 단축키 (워크스페이스 페이지 안에서)

- [ ] `⌘ ⇧ R` → 읽기 모드 토글 (사이드바·툴바 사라짐, 다시 누르면 복귀)
- [ ] `Esc` → 읽기 모드 종료
- [ ] `⌘ ;` → 에디터에 오늘 날짜 (YYYY-MM-DD) 삽입
- [ ] `⌘ ⇧ T` → 표 블록 삽입
- [ ] `⌘ ⇧ F` → 현재 단락만 또렷, 나머지 흐려짐 / 다시 누르면 해제
- [ ] `⌘ ⇧ J` → 사이드바 Inbox 링크로 이동
- [ ] `⌘ ⇧ I` → Inbox에 빠른 메모 작성
- [ ] `⌘ ⇧ S` → 현 페이지 수동 스냅샷
- [ ] `⌘ ⇧ .` → 본문 텍스트 선택 후 누르면 인용 (`>`) 으로 감싸짐
- [ ] `⌘ D` → 페이지 복제
- [ ] `⌘ N` → 새 페이지 생성
- [ ] `⌘ \` → 사이드바 접기/펴기
- [ ] `⌘ ⌫` → 페이지 보관함 이동
- [ ] `⌘ K / ⌘ P / /` → 검색 팔레트
- [ ] `C` 키 (에디터 외부) → 댓글 입력창에 포커스

---

## 2) 페이지 스타일 메뉴 (페이지 우상단 ⚙ / "Page style")

### 기본 액션
- [ ] 🪟 Open in new window
- [ ] 🖨 Print now → 인쇄 다이얼로그 뜸
- [ ] 🧼 Clean print → cover/댓글/태그/반응/하위 페이지 숨긴 채 인쇄 후 복귀
- [ ] 🧰 View raw JSON → 새 탭에 JSON
- [ ] ⬇ Download JSON
- [ ] 📝 Cite this page (Markdown) → `[제목](url)` 복사
- [ ] 📝 Copy body as Markdown → 본문이 헤딩/리스트/인용 markdown으로 클립보드에
- [ ] ⬇ Download as Markdown → `.md` 파일 다운로드
- [ ] 📄 Copy as plain text → 본문 plain text 클립보드
- [ ] 🧭 Copy outline (Markdown) → 헤딩만 markdown
- [ ] 🆔 Copy page ID
- [ ] 📊 Quick stats → 단어/문장/블록/H2 + 섹션별 단어 수 모달

### 토글 (이 기기에서 기억)
- [ ] 🚫 Toggle cover → 표지 일시 숨김 / 다시 누르면 복귀
- [ ] 🔢 Toggle word chip → 제목 아래 "⏱ ◯◯ min read" 칩 숨기기
- [ ] 💬 Toggle comments compact → 댓글 영역 빽빽한 표시
- [ ] 🖨 Toggle print-hide comments → 인쇄 시 댓글 숨김 영구 설정
- [ ] ➕ Expand all → 모든 토글 블록 펼침
- [ ] ➖ Collapse all → 모든 토글 블록 접힘

### Reading toggles 그리드 (4×3+)
- [ ] `# numbers` → H1/H2/H3 앞에 1./1.1./1.1.1.
- [ ] `Bionic` → 단어 앞 글자만 굵게 (간단 효과)
- [ ] `Zen mode` → 사이드바/댓글/하위섹션 모두 숨김, 본문만
- [ ] `Highlight links` → 본문 링크 파란 밑줄로 강조
- [ ] `Dyslexia` → 글자/줄 간격 늘어남
- [ ] `Justify` → 본문 양쪽 정렬
- [ ] `Larger font` → 전체 글자 약 1.1배
- [ ] `Sticky title` → 스크롤해도 제목 상단 고정
- [ ] `DB striped` → 표 짝수행 음영
- [ ] `Grid bg` → 모눈 배경
- [ ] `Dots bg` → 점 패턴 배경
- [ ] `Ruled bg` → 공책 줄 배경
- [ ] `Hide reactions` → 반응 줄 안 보임
- [ ] `Hide tags` → 태그 줄 안 보임
- [ ] `Hide sub-pages` → 하위 페이지 섹션 안 보임
- [ ] `Hide backlinks` → 백링크 섹션 안 보임
- [ ] 새로고침해도 토글 상태 유지

### 워드 목표
- [ ] 250 / 500 / 1000 / 2000 빠른 설정 칩 → 클릭 시 즉시 저장
- [ ] ✕ 칩 → 목표 해제
- [ ] 목표 도달 시 "🎉 ◯◯ words — goal reached!" 토스트

### 페이지 상태/메타
- [ ] Status: Draft / Review / Published 칩
- [ ] ✅ Mark as published
- [ ] Width: normal / wide / full
- [ ] Font: default / serif / mono
- [ ] Lock / Unlock
- [ ] 📌 Pin
- [ ] 📦 Archive / 복구
- [ ] Set as template / Unset
- [ ] Expiry / Word goal / Custom slug

---

## 3) 사이드바

- [ ] 워크스페이스 이름 헤더 클릭 → 워크스페이스 전환 메뉴
- [ ] 📥 Inbox 링크 + 안 읽은 알림 배지
- [ ] ☀️ Today 링크 + 오늘 만든 페이지 카운트 배지
- [ ] ✅ Tasks / 📅 Calendar / 📁 Files / 📄 All pages / 📦 Archive / 📈 Activity
- [ ] "Filter pages…" 입력 → 페이지 트리 필터
- [ ] `#태그명` 입력 → 그 태그가 붙은 페이지로 트리 필터
- [ ] Recently visited (this device) → 최근 본 페이지 5개
- [ ] 🏷 All tags 패널 → 전체 워크스페이스 태그 + 카운트, 클릭하면 필터
- [ ] Pinned 섹션 / Favorites 섹션
- [ ] Recent expand + 검색 입력
- [ ] 페이지 트리 hover → 미리보기 팝오버 (280ms)
- [ ] 페이지 드래그하여 재배치 / 하위로 중첩
- [ ] Trash → Restore all / Empty
- [ ] ↥ Compact / ↧ Cozy 토글
- [ ] ‹ / › (사이드바 접기)

---

## 4) 데이터베이스 (Database 페이지)

- [ ] T / K / G / C / M / L 키 → 뷰 전환 (Table / Kanban / Gallery / Calendar / Timeline / List)
- [ ] Filter / Sort / Group / Columns 패널
- [ ] ⥯ Density → 표 행 좁아짐
- [ ] 행 hover → ⤒ Move to top / ⤓ Move to bottom / ⎘ Duplicate / ✕ Delete
- [ ] 행 ↗ Open / 👁 Peek
- [ ] 칸반 드래그 / Calendar 날짜 드래그
- [ ] 컬럼 너비 드래그
- [ ] CSV import / export

---

## 5) AI 슬래시 (에디터에서 `/ai` 입력)

API 키 (`apps/web/.env.local`의 `OPENAI_API_KEY`)가 있어야 실제 응답.
키가 없으면 placeholder 텍스트가 나옴 — 이것도 정상.

### 텍스트 변형
- [ ] /summarize · /one-liner · /improve · /proofread · /continue
- [ ] /translate (목표 언어 prompt)
- [ ] /tone (스타일 prompt)
- [ ] /longer · /shorter
- [ ] /edit (사용자 지시문 prompt)

### 구조화
- [ ] /outline · /keywords · /glossary · /action-items
- [ ] /quote · /ideas · /checklist · /poll
- [ ] /agenda · /eli5 · /pros-cons · /risks · /timeline · /faq
- [ ] /counter · /hashtags · /headlines · /slug · /tweet-thread · /citations
- [ ] /study-notes · /flashcards · /quiz · /persona · /swot
- [ ] /release-notes · /objections · /decision-log · /user-stories · /test-cases
- [ ] /rhyme · /lyrics · /regex · /sql · /commit-msg
- [ ] /standup · /retro · /jargon · /mind-map
- [ ] /elevator-pitch · /job-desc · /follow-up
- [ ] /sub-headings · /anti-pattern · /dictionary · /expand-acronyms
- [ ] /star-method · /key-takeaways · /email-reply · /cover-letter · /pre-publish
- [ ] /tagline · /metaphor · /press-release · /interview-questions
- [ ] /linkedin-post · /blog-outline · /testimonials · /contrarian · /dialog
- [ ] /seo-keywords · /news-headline · /recommendation-letter
- [ ] /scenario · /risk-matrix · /api-spec · /raci · /value-prop
- [ ] /cta · /landing-hero · /onboarding-email
- [ ] /insight-3 · /dictation-clean · /clean-formatting · /inverse-pyramid
- [ ] /contrast-vs · /buyer-persona · /feature-benefit · /learn-vocab

### Ask AI 패널 (우하단 🤖)
- [ ] 페이지 범위 / 워크스페이스 범위 토글
- [ ] 워크스페이스 범위에서 sources 표시

---

## 6) 외부 / 통합

- [ ] `/api/v1/calendar.ics` ICS 피드 (bearer token)
- [ ] `/api/v1/feed.rss` RSS 피드
- [ ] `/api/v1/clip` 웹 클리퍼 (북마크 + 본문 paragraph 페이지 생성)

---

## 7) 알려진 한계

- **Bionic reading**: CSS `::first-letter` 만 사용해서 "첫 글자만" 굵음.
  진짜 bionic은 단어별 앞 절반을 굵게 해야 하지만 JS로 모든 텍스트를
  래핑해야 해서 비용 큼. 의도된 트레이드오프.
- **Markdown export**: BlockNote DOM을 클라이언트에서 워킹해서 markdown으로
  변환. 중첩 리스트의 들여쓰기, 표의 셀별 정렬은 손실됨. 텍스트/헤딩/리스트/
  인용/코드/이미지/구분선까지는 보존.
- **`.next` 캐시 문제**: 스키마(Prisma schema) 변경 후에는 종종
  `rm -rf apps/web/.next && PATH=…/v18.17.1/bin:$PATH npm run dev:web`
  로 dev를 재시작해야 새 컬럼이 인식됨.

---

## 8) 검증 후

- 잘 되는 항목이면 그대로 두기.
- 안 되는 항목은 그 줄에 `-- 안 됨: <증상>` 메모.
- 다음 번 이 문서를 같이 보면서 안 되는 것만 골라 고치면 됨.
