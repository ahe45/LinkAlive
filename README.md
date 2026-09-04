# LinkAlive

LinkAlive는 등록한 HTTP/HTTPS URL을 정해진 주기로 검사하고, 연속 실패로 장애를 판정해 Telegram으로 장애와 복구를 알리는 자체 호스팅 모니터링 시스템입니다.

## 주요 기능

- 여러 URL 등록, 수정, 일시 중지, 재개, soft delete
- 1·5·10·30·60분 주기 검사와 즉시/시험 검사
- DNS, 연결, TLS, 응답 지연, 상태 코드, 키워드 오류 구분
- `PENDING → UP → SUSPECT → DOWN → RECOVERING` 상태 머신
- MySQL/MariaDB 작업 원장과 Redis/BullMQ 기반의 재생 가능한 작업 처리
- incident별 Telegram 장애/복구 알림과 발송 이력
- 관리자 로그인, 대시보드, 검사 및 장애 이력
- DNS 재확인·연결 고정과 응답 자원 고갈 방어

상세한 제품 및 운영 정책은 [PROJECT_PLAN.md](./PROJECT_PLAN.md)를 참고하세요.
배포, 백업, 복구, 장애 대응 절차는 [docs/OPERATIONS.md](./docs/OPERATIONS.md)에 정리되어 있습니다.

## 구성

```text
apps/api        NestJS + Fastify 관리 API
apps/web        Next.js 관리자 화면
apps/scheduler  due monitor를 DB 작업 원장과 Redis 큐로 전달
apps/worker     URL 검사와 알림 발송 워커
packages/domain         상태 머신과 스케줄 정책
packages/database       Prisma MySQL/MariaDB 스키마와 migration
packages/monitoring     안전한 HTTP checker
packages/notifications  Telegram adapter
infra/compose.yaml      로컬 MariaDB, Redis
infra/compose.app.yaml  로컬 인프라와 함께 실행하는 애플리케이션 컨테이너
infra/compose.prod.yaml 외부 관리형 MySQL/MariaDB·Redis용 운영 스택
```

## 로컬 실행

### 준비물

- Windows 10/11과 Windows Package Manager(`winget`)
- 실행 중인 MySQL/MariaDB

Windows의 `start_server.bat`는 Node.js 22 이상과 pnpm 11을 확인해 없거나 오래된 경우
`winget`과 npm으로 설치합니다. Redis가 없거나 실행 중이 아니면 Windows용 Redis를 설치·실행하며,
기본적으로 `6379` 포트에서 확인합니다. MySQL/MariaDB는 직접 설치·실행해야 하며 `3306` 포트에서
확인합니다. 기존 `.env`는 보존하며, 파일이 없을 때만 `admin / 1234` 계정과 무작위 로컬 비밀키를
포함한 설정을 생성합니다.

### 1. 환경 변수와 DB 준비

이미 실행 중인 로컬 MySQL/MariaDB를 재사용한다면 관리자 연결 정보가 들어 있는 다른
프로젝트의 `.env`를 지정해 초기화할 수 있습니다. 다음 명령은 관리자 비밀번호를 출력하거나
LinkAlive에 저장하지 않고 `linkalive` DB와 로컬 전용 `linkalive_app` 계정을 만든 뒤,
무작위 애플리케이션 비밀값을 포함한 Git 제외 `.env`를 생성합니다.

```powershell
pnpm db:bootstrap:local -- --source-env ..\examcheck\.env
```

새로운 Docker 기반 MariaDB를 사용할 경우에는 다음과 같이 직접 환경 파일을 준비합니다.

PowerShell 기준:

```powershell
Copy-Item .env.example .env
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

출력된 값을 `.env`의 `ENCRYPTION_KEY`에 넣고, 아래 값도 반드시 변경하세요.

- `ADMIN_PASSWORD`
- `AUTH_SECRET`: 32자 이상의 무작위 문자열
- 운영 환경의 `WEB_ORIGIN`, `COOKIE_SECURE`

Telegram은 채널을 추가할 때 bot token을 입력하거나 `.env`의 `TELEGRAM_BOT_TOKEN`을 사용할 수 있습니다.

### 2. 의존성과 나머지 인프라 준비

```powershell
pnpm install

# 기존 로컬 MySQL/MariaDB를 재사용할 때: DB 컨테이너 없이 Redis만 실행
docker compose -f infra/compose.yaml up -d redis

# 또는 DB까지 새 컨테이너로 실행할 때는 위 명령 대신 다음 명령 사용
# pnpm infra:up

pnpm db:generate
pnpm db:deploy
```

### 3. 애플리케이션 실행

Windows에서는 루트의 `start_server.bat`를 더블클릭하거나 다음과 같이 실행하면 필수 프로그램,
환경설정, Redis 설치·실행, 로컬 DB 연결 상태, 의존성, DB migration을 차례로 확인한 후 전체 서버가 시작됩니다.

```powershell
.\start_server.bat
```

직접 실행하려면 다음 명령을 사용합니다.

```powershell
pnpm dev
```

- 관리자 화면: <http://localhost:3001>
- API readiness: <http://localhost:4000/health/ready>
- Scheduler health: <http://localhost:4101/health>
- Worker health: <http://localhost:4102/health>

로그인은 `.env`의 `ADMIN_USERNAME`, `ADMIN_PASSWORD`를 사용합니다.

## 주요 명령

```text
pnpm dev              전체 개발 프로세스 실행
pnpm build            전체 production build
pnpm test             전체 테스트
pnpm typecheck        전체 TypeScript 검사
pnpm format:check     포맷 검사
pnpm audit            고위험 의존성 취약점 검사
pnpm db:generate      Prisma client 생성
pnpm db:bootstrap:local 기존 로컬 MySQL/MariaDB에 DB·전용 계정 생성
pnpm db:migrate       개발 DB에 migration 적용
pnpm db:deploy        운영 DB에 준비된 migration 적용
pnpm db:retention     만료된 이력을 FK-safe 소규모 batch로 명시적 정리
pnpm infra:up         MariaDB/Redis 실행
pnpm infra:down       로컬 인프라 종료
```

CI는 실제 MariaDB·Redis에서 예약 실패→`DOWN`→`RECOVERY` 흐름과 목적지 분산 제한을
검증합니다. Telegram 발송 경로는 격리된 adapter 및 통합 테스트로 검증합니다.

로컬 인프라를 포함한 전체 컨테이너 구성은 migration을 자동 적용한 뒤 서비스를 시작합니다.

```powershell
docker compose --env-file .env -f infra/compose.yaml -f infra/compose.app.yaml up --build -d
```

외부 관리형 MySQL/MariaDB와 Redis를 사용하는 운영 환경에서는 `.env`의 `DATABASE_URL`,
`REDIS_URL`, `NEXT_PUBLIC_API_BASE_URL`을 실제 주소로 설정한 다음 애플리케이션 전용
구성을 실행합니다. 이 구성에는 MySQL/MariaDB와 Redis 컨테이너가 포함되지 않습니다.

```powershell
docker compose --env-file .env -f infra/compose.prod.yaml up --build -d
```

`NEXT_PUBLIC_API_BASE_URL`은 사용자의 브라우저에서 접근 가능한 HTTPS API 주소여야 하며,
이미지를 빌드하기 전에 설정해야 합니다. API는 컨테이너 내부에서 항상 4000번 포트를
사용하고, scheduler와 worker는 각각 4101, 4102번 포트로 상태를 제공합니다.

| 프로세스  | 상태 확인                       | 의미                                      |
| --------- | ------------------------------- | ----------------------------------------- |
| API       | `/health/live`, `/health/ready` | 프로세스 및 MySQL/MariaDB·Redis 준비 상태 |
| scheduler | `:4101/health`                  | 최근 예약 작업 처리와 Redis 연결 상태     |
| worker    | `:4102/health`                  | 검사 pipeline/outbox와 DB·Redis 상태      |

Compose에서는 scheduler와 worker 포트를 호스트에 공개하지 않고 컨테이너 내부
healthcheck로 사용합니다. `docker compose ... ps`에서 각 서비스 상태를 확인할 수 있습니다.

## 데이터 보존 작업

보존 작업은 서버와 함께 자동으로 시작되지 않습니다. `.env`에서 정책을 확인하고 백업을
검증한 뒤 다음 명령으로 명시적으로 실행합니다.

```powershell
pnpm db:retention
```

기본값은 모든 출처(`SCHEDULED`, `MANUAL`, `TEST`)의 상세 검사 결과와 종료된 예약 검사
원장 30일, 종료된 incident·알림 outbox·delivery·감사 로그 365일입니다. 한 번에 500행씩
각 단계 최대 100 batch만 처리하며 결과는 한 줄 JSON으로 출력됩니다. 상세 설정과
배포 플랫폼 cron 예시는 [운영 안내서](./docs/OPERATIONS.md#데이터-보존)를 참고하세요.

## API 요약

모든 관리 API는 로그인 후 발급되는 HTTP-only 쿠키가 필요합니다.

```text
POST   /api/v1/auth/login
POST   /api/v1/auth/logout
GET    /api/v1/auth/me

GET    /api/v1/monitors
POST   /api/v1/monitors
POST   /api/v1/monitors/test
GET    /api/v1/monitors/:id
PATCH  /api/v1/monitors/:id
DELETE /api/v1/monitors/:id
POST   /api/v1/monitors/:id/pause
POST   /api/v1/monitors/:id/resume
POST   /api/v1/monitors/:id/check-now
GET    /api/v1/monitors/:id/checks
GET    /api/v1/monitors/:id/incidents

GET    /api/v1/incidents
GET    /api/v1/incidents/:id

GET    /api/v1/notification-channels
POST   /api/v1/notification-channels
PATCH  /api/v1/notification-channels/:id
DELETE /api/v1/notification-channels/:id
POST   /api/v1/notification-channels/:id/test

GET    /api/v1/dashboard/summary
GET    /health/live
GET    /health/ready
```

모니터 목록은 cursor pagination과 함께 `state`(`UP`, `SUSPECT`, `DOWN`, `RECOVERING`,
`PENDING`, `PAUSED`, `STALE`) 및 `query` 필터를 지원합니다. 필터는 각 페이지를 가져오기
전에 DB에서 적용되므로 모니터 수가 50개를 넘어도 장애 항목이 뒤쪽 페이지에 숨지 않습니다.

## 보안 기본값

- `http:`/`https:` URL은 localhost, 사설망, 사용자 지정 포트와 URL 기본 인증을 포함해 검사할 수 있습니다.
- 내부 서비스와 metadata 주소에도 접근할 수 있으므로 신뢰할 수 있는 관리자만 URL을 등록해야 합니다.
- 매 요청과 모든 redirect에서 DNS 결과를 다시 검사하고 검증한 IP로 연결합니다.
- API와 모든 worker replica가 Redis의 동일한 호스트명·검증 IP별 분당/동시 검사 제한을 공유합니다.
- HTTP와 HTTPS 사이의 redirect도 매 요청마다 새로 DNS를 확인한 뒤 처리합니다.
- 실제 요청 URL과 알림 채널 설정은 AES-256-GCM으로 암호화합니다.
- URL query, token, cookie, 응답 본문은 로그와 알림 payload에 넣지 않습니다.
- 응답 헤더 32KB, 압축 응답 전송량 256KB, 압축 해제 후 키워드 검사 본문 64KB, redirect 5회, 전체 요청 30초를 강제 상한으로 둡니다.

목적지 제한 기본값은 호스트명과 DNS로 검증된 각 IP마다 동시 4건, 분당 60건입니다.
요청이 끝나면 Redis lease를 해제하고 프로세스가 중단되면 45초 후 자동 만료됩니다. Redis가
응답하지 않거나 제한에 도달한 검사는 `PLATFORM_ERROR`로 남아 대상의 장애 상태를 변경하지
않습니다. `DESTINATION_CHECK_MAX_CONCURRENCY`, `DESTINATION_CHECK_MAX_PER_MINUTE`,
`DESTINATION_CHECK_LEASE_MS`, `DESTINATION_LIMIT_REDIS_TIMEOUT_MS`로 조정할 수 있으며 모든
API/worker replica에 같은 값을 배포해야 합니다.

내부망 URL은 중앙 worker가 직접 검사하므로 worker의 네트워크 접근 권한을 최소화하세요.

## 운영 배포 전 확인

- `.env`를 이미지나 Git에 포함하지 않습니다.
- `COOKIE_SECURE=true`와 HTTPS reverse proxy를 사용합니다.
- MySQL/MariaDB 자동 백업 및 복구 시험을 구성합니다.
- Redis persistence와 메모리/eviction 정책을 구성합니다.
- API, scheduler, worker를 각각 독립 프로세스로 운영합니다. 하나의 worker 프로세스가 URL 검사 큐와 알림 발송 큐를 함께 처리합니다.
- API readiness, scheduler/worker health, 예약 검사 생성 시각과 outbox 적체를 외부 모니터에서 함께 감시합니다.
- 운영 지표의 권장 임계치와 점검 쿼리는 운영 문서를 따릅니다.
