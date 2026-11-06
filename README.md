# Siggu (식구)

5명(수진·다연·근주·동은·영지)이 2–3달에 한 번 모일 날짜를 정하는 모바일 웹 프로토타입.

- 각자 되는 날을 캘린더에 찍으면, 모두 모일 수 있는 날을 추천해 줘요.
- 날짜가 확정되면 시간·장소를 정하고, 모임 사진을 한 장 남길 수 있어요.
- 생일 달(앞뒤 한 달 포함)에는 캐릭터가 꼬깔모자를 써요.

## 구조

- `prototype/index.html` — 화면 전체 (HTML/CSS/JS 한 파일)
- `prototype/assets/` — 캐릭터·로고 원본 이미지
- `api/` — Vercel 서버 함수 (`state` 불러오기, `action` 저장, `photo` 사진). 데이터는 Upstash Redis에 저장
  - 필요한 환경 변수: `KV_REST_API_URL`, `KV_REST_API_TOKEN` (Vercel에서 Upstash Redis를 연결하면 자동으로 들어가요)

## 로컬에서 보기

```bash
python3 -m http.server 5173 --directory prototype
```

http://localhost:5173 을 열면 돼요.

로컬에서는 API가 없어서 예시 데이터로, 이 브라우저(localStorage)에만 저장하는 모드로 동작해요.

## 저장 방식

- 배포된 사이트: 모든 데이터를 서버(Upstash Redis)에 저장해서 식구 5명이 같은 내용을 봐요. 30초마다, 그리고 앱으로 돌아올 때 새 내용을 불러와요.
- "누구세요?"로 고른 사람만 각 폰에 기억해요.
