# 온보딩 AI — ECS/도커 배포 적합성 평가

> 작성: 2026-06-29 / 대상: `onboarding-ai`(이 레포)를 AWS ECS Fargate에 올릴 때의 문제점 정리.
> 비교 기준은 이미 ECS에 떠 있는 별도 앱 `data-palette-builder`(DPB, Python/FastAPI).
> ※ DPB와 섞이지 않게 이 레포 안에만 보관하는 작업 메모.

## 0. 앱 정체 (DPB와의 구조 차이)

| 항목 | DPB (현재 ECS) | 온보딩 AI (이 레포) |
|---|---|---|
| 런타임 | Python / FastAPI | Node.js / Express + TS(tsx) |
| 프로세스 | 1개 (uvicorn :8002) | 2개: API `:8787` + Vite 프론트 `:5173` |
| DB | RDS PostgreSQL | SQLite 로컬 파일 (`server/data/app.db`) |
| 파일 저장 | (클라이언트 파싱) | 로컬 디스크 `server/data/storage/` (multer 업로드) |
| 무거운 의존성 | — | DuckDB(`@duckdb/node-api`), exceljs |
| 컨테이너 | Dockerfile 있음 | **Dockerfile 없음 / PM2 로컬(Windows) 상주만** |
| AI | claude-opus-4-8 | claude-opus-4-8 (동일 모델·동일 account 키) |
| 외부연동 | — | Google Drive OAuth |

런타임이 Python vs Node라 **DPB 이미지에 끼워넣기는 불가** → 무조건 별도 컨테이너 전제.

## 1. 🔴 블로커 (안 풀면 안 돌아감)

### 1-A. 상태(데이터)가 전부 컨테이너 로컬 디스크 → Fargate에서 증발
`server/data/`(=`DATA_DIR`)에 상태 3종이 전부:
- `app.db`(+WAL) — SQLite: projects/artifacts/analysis_runs/findings/deliverables/usage 전부
- `storage/` — 업로드 원본 고객파일 + 파싱 JSON (`storage.ts putObject` → 로컬 `writeFileSync`)
- `google-oauth.json` — Google refresh token (`google/tokenStore.ts`, `DATA_DIR` 하위)

Fargate 태스크 파일시스템은 **ephemeral** → 재배포·재시작·헬스체크 재기동·크래시마다 전부 소멸.
- **해결안 A(코드 최소): EFS 마운트** — `data/`를 EFS에. 단 ⚠ better-sqlite3 + WAL을 NFS(EFS) 위에서 돌리는 건 파일락 지뢰. 단일 태스크 한정.
- **해결안 B(정공법): SQLite→RDS Postgres, storage→S3, token→env/SSM.** 코드 큼, 안정적.

### 1-B. 회사 프록시가 multipart 업로드를 막음 (DPB가 이미 데인 함정)
업로드가 `multer` multipart/form-data (`upload.single('file')`, `POST /api/projects/:id/artifacts`).
DPB가 동일 패턴(multipart + "upload" 경로)으로 회사 DLP 프록시에 403 → 결국 **클라이언트 사이드 파싱**으로 전환한 이력.
→ 온보딩도 **사무실 네트워크에선 업로드 막힐 가능성 매우 높음.** ECS화와 별개로 풀어야 함.

### 1-C. 네이티브 모듈 — Windows node_modules 재사용 불가
`better-sqlite3`, `@duckdb/node-api`는 네이티브(N-API) 애드온 → 도커 빌드 시 **리눅스 컨테이너 안에서 `npm ci`로 새로 빌드** 필수.
duckdb 프리빌드는 **glibc** 기준 → **alpine/musl 안 됨**, `node:22-bookworm-slim` 류 사용. (Dockerfile 아직 없음 → 멀티스테이지 신규 작성)

### 1-D. 2-프로세스(dev) 구조를 프로덕션용으로 합쳐야
현재 Express API(8787) + Vite **dev 서버**(5173). Vite dev는 프로덕션용 아님. Express는 정적 서빙 안 함(`express.static` 없음).
→ `vite build` 후 Express가 `/`=정적, `/api`=API로 **같은 오리진 1프로세스/1포트** 서빙으로 합치는 게 정석. Vite의 `proxy /api→localhost:8787`(dev 전용)도 불필요해짐.

## 2. 🟡 주의 (돌긴 하나 손봐야)

- **2-E. 백그라운드 파이프라인 휘발성**: `startStage`가 HTTP 응답 먼저 주고 `fn().catch()`로 인프로세스 백그라운드 실행(`runDecode/Generate/Match`), 클라이언트 폴링. 태스크가 실행 중 교체되면(배포·스케일인) 그 run 유실 → DB에 `running` 영구 박힘. 내구 잡 큐 없음.
- **2-F. 수평 확장 불가 → 1태스크 고정**: `relationsCache`(Map) + Q&A 북 캐시가 인프로세스 메모리 + SQLite 로컬 → `desired_count>1` 불가.
- **2-G. 504/타임아웃**: `ai/client.ts`가 `new Anthropic()` 기본값(timeout/maxRetries 미지정), `max_tokens: 64000`. 무거운 AI는 백그라운드라 ALB idle 회피되나, **Q&A(`qaAsk`, max_tokens 16000)는 동기 요청/응답**이라 ALB idle(300s) 안에 들어와야 함. SDK timeout/maxRetries 명시 권장.
- **2-H. Google OAuth 리다이렉트 + CORS**: `oauthRedirectUri()`가 `${req.protocol}://${req.get('host')}/...` 기본값 → ALB 뒤에선 `req.protocol`이 http로 잡혀 HTTPS 불일치. `trust proxy` 처리 또는 `GOOGLE_OAUTH_REDIRECT` 환경변수 명시 + 콜백 URL을 Google Cloud Console에 사전 등록. `app.use(cors())` 전체 허용도 조여야.
- **2-I. 시크릿**: `ANTHROPIC_API_KEY` + `GOOGLE_OAUTH_CLIENT_ID/SECRET`이 `server/.env` 평문 → ECS task def 환경변수로 주입(해당 IAM 계정은 SSM/Secrets Manager 막혀 평문 env 불가피).

## 3. 서버 연산 무게 (DPB 대비 핵심 차이)

DPB는 파싱을 클라이언트로 떠넘겨 **서버가 가벼움**(Claude로 가는 얇은 프록시, I/O 바운드).
온보딩은 **서버에서 실제 계산**을 함:
1. **exceljs 워크북 로드** — 전 셀 순회, 메모리 다대. 복잡한 워크북은 수백 MB.
2. **관계성 분석(`relations.ts` 649줄)** — region 검출 + 수식 파싱 + 값 일치 기반 手コピー 역추정(그리드 간 값 크로스 비교). 순수 CPU.
3. **DuckDB 시뮬레이션(`simulate.ts`)** — 분석마다 `:memory:` 인스턴스 + 입력 전체 INSERT 후 생성 SQL 실행.

### 로컬→서버 이전 시 함의
지금은 이 부하가 **본인 노트북(PM2)** 에서 돎. 배포하면 **Fargate 태스크 1개 안으로 통째로 이동**:
- **메모리 격차**: 노트북 16GB+ vs Fargate 기본 1~2GB → exceljs/DuckDB 적재가 **OOM**으로 컨테이너 죽을 수 있음. 50MB 업로드짜리 복잡 워크북은 파싱 중 10~20배 팽창 → **동시 분석 피크 메모리가 사이징 기준**. 최소 **2vCPU/4GB**부터.
- **★ 단일 이벤트루프 블로킹**: `relations.ts` CPU 루프 + exceljs 파싱이 단일 이벤트루프 점유 → **한 명 분석 중 다른 사용자 전원 멈춤**. CPU 작업이라 `await`로 못 양보(DuckDB의 `await conn.run`만 양보). 진짜 다인 운영이면 `worker_threads`로 분리 필요.
- **확장 불가**: 1태스크 고정(2-F)이라 경합을 태스크 추가로 못 푼다.

## 4. RDS를 DPB와 공유할 수 있나?

**가능하고 권장**(같은 인스턴스에 `CREATE DATABASE onboarding;` 별도 DB). 단:
- 온보딩은 SQLite라 **데이터 계층 포팅 필요**. 실측: `db.prepare`/`exec`/`transaction` **89곳**, `.get/.all/.run` **132곳**, SQLite 고유 문법 **30곳**(`AUTOINCREMENT`, `datetime('now')` 등).
- 최대 비용은 문법이 아니라 **동기→비동기 전환**: better-sqlite3(동기) → pg(비동기) → 132개 호출 전부 `await` + 트랜잭션 재작성. (Node에 쓸만한 동기 PG 클라이언트 없음 → 회피 불가.)
- RDS는 **관계형 데이터만** 해결. `storage/` 파일 + google token은 여전히 **S3** 필요(RDS BLOB 비권장).
- 인프라: 별도 DB+별도 유저, `dpb-rds-sg` 인바운드에 온보딩 태스크 SG 추가, t4g.micro(1GB, max_conn≈112) 커넥션 풀 작게, blast radius 공유 주의.

## 5. 선택지 요약

| | RDS 공유 (Postgres 포팅) | EFS + SQLite 유지 |
|---|---|---|
| 코드 작업 | **큼**(132곳 sync→async + SQL 포팅) | 거의 없음 |
| 추가 인프라 | 기존 RDS 재사용 + S3 | EFS 마운트 |
| 안정성 | 높음 | ⚠ WAL-over-NFS 락 리스크 |
| 확장(desired>1) | 가능 | 불가 |
| 파일 저장 | S3 별도 필요 | EFS가 같이 해결 |

- **빠른 PoC**: EFS + SQLite (코드 거의 안 건드림, 1태스크 한정)
- **제대로 운영**: RDS 공유 + S3 (포팅 비용 내고 안정성·확장성)
- 어느 쪽이든 1-B(업로드 프록시)는 별개로 풀어야.

## 6. 가장 먼저 결정할 것
1. 영속성을 **EFS냐 RDS+S3냐** → 나머지 작업량이 여기서 갈림 (SQLite+EFS WAL 락 때문에 RDS+S3 정공법 권장)
2. **사무실 업로드 막힘(1-B)** → 안 풀리면 올려도 못 씀. DPB처럼 클라이언트 파싱 전환이 답일 수 있음
3. **서버 연산 무게(§3)** → 태스크 2vCPU/4GB+ 또는 무거운 분석 worker_threads 분리
</content>
</invoke>
