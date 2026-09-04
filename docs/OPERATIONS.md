# LinkAlive 운영 안내서

이 문서는 단일 지역·단일 관리자 MVP를 운영할 때 필요한 배포, 점검, 백업과 복구 절차를 설명합니다. 운영 환경에서는 MySQL/MariaDB와 Redis를 관리형 서비스로 분리하고, 웹/API 앞에 HTTPS reverse proxy를 두는 구성을 권장합니다.

## 배포 전 확인

- `ADMIN_PASSWORD`, `AUTH_SECRET`, `ENCRYPTION_KEY`를 충분히 긴 무작위 값으로 설정합니다.
- `ENCRYPTION_KEY`는 Base64로 인코딩한 정확히 32바이트 키여야 합니다. 데이터 재암호화 절차 없이 기존 키를 교체하면 저장된 URL과 알림 채널을 읽을 수 없습니다.
- HTTPS 환경에서는 `COOKIE_SECURE=true`, 실제 관리 화면 주소로 `WEB_ORIGIN`과 `APP_BASE_URL`을 설정합니다. `APP_BASE_URL`에는 자격 증명, query, fragment를 넣지 않습니다.
- 웹 이미지를 빌드할 때 브라우저에서 접근 가능한 API 주소를 `NEXT_PUBLIC_API_BASE_URL` build argument로 지정합니다. 운영값을 생략하면 브라우저가 잘못된 `localhost:4000`을 호출합니다.
- reverse proxy를 직접 구성한 경우에만 신뢰 범위를 확인한 뒤 `TRUST_PROXY=true`를 사용합니다. API를 직접 노출할 때는 `false`를 유지합니다.
- MySQL/MariaDB 자동 백업과 Redis AOF를 구성합니다.
- `pnpm audit`, `pnpm typecheck`, `pnpm test`, `pnpm build`가 모두 통과한 이미지나 커밋만 배포합니다.

로컬 인프라를 포함하는 Compose에서 외부 서비스를 임시로 사용할 때는 `CONTAINER_DATABASE_URL`, `CONTAINER_REDIS_URL`을 별도로 지정합니다. 실제 운영에서는 로컬 데이터 서비스를 포함하지 않는 `infra/compose.prod.yaml`을 사용하고 `.env`의 `DATABASE_URL`, `REDIS_URL`, `NEXT_PUBLIC_API_BASE_URL`을 실제 주소로 설정합니다. 공개 운영 주소에서 `NODE_ENV=production`이면 HTTPS와 secure cookie가 아니거나 예제용 비밀번호·서명 키가 남아 있을 때 API가 시작을 거부합니다.

## 배포 순서

1. MySQL/MariaDB와 Redis가 준비되었는지 확인합니다.
2. `pnpm db:deploy`로 준비된 migration을 적용합니다.
3. API를 시작하고 `/health/live`, `/health/ready`를 확인합니다.
4. scheduler와 worker를 시작합니다.
5. web을 시작하고 로그인, 시험 URL 검사, 시험 알림을 각각 한 번 수행합니다.

전체 Docker 구성에서는 다음 명령이 migration을 먼저 적용하고 각 프로세스를 시작합니다.

```powershell
docker compose -f infra/compose.yaml -f infra/compose.app.yaml up --build -d
```

관리형 MySQL/MariaDB와 Redis를 사용하는 운영 구성은 다음과 같이 시작합니다.

```powershell
docker compose --env-file .env -f infra/compose.prod.yaml up --build -d
```

배포 중에는 scheduler를 한 개 이상 유지할 수 있습니다. DB의 `FOR UPDATE SKIP LOCKED`와 고유 제약이 중복 예약을 막습니다. worker는 수평 확장할 수 있으며 동일 작업은 DB 결과 고유 제약과 lease로 멱등 처리됩니다.

### URL 검사 자원 보호 상한

키워드 검사는 압축 응답도 지원하지만, 압축 폭탄과 무출력 압축 스트림이 worker 자원을 계속 점유하지 못하도록 다음 고정 상한을 적용합니다.

- 응답 헤더: 32KiB
- gzip, deflate, Brotli 압축 입력(네트워크 전송량): 256KiB. 유효한 `Content-Length`가 이 값을 넘으면 본문을 읽기 전에 중단하며, 길이를 알 수 없는 스트림도 압축 해제 전에 누적 전송량을 검사합니다.
- 압축 해제 후 키워드 검사 범위: 64KiB
- Brotli: 비표준 large-window 모드를 거부하고 ring buffer를 필요에 따라 확장합니다.
- 전체 검사 시간: 최대 30초. 위 크기 상한과 별도로 항상 적용됩니다.

상한 초과는 대상의 `RESPONSE_LIMIT_EXCEEDED` 실패로 기록됩니다. 운영자가 환경 변수로 이 값을 늘릴 수 없게 하여 worker replica마다 동일한 보호 정책을 유지합니다.

## 상태 점검

- `GET /health/live`: API 프로세스가 요청을 받을 수 있는지 확인합니다.
- `GET /health/ready`: MySQL/MariaDB와 Redis 연결을 함께 확인합니다.
- scheduler `:4101/health`: 최근 예약 처리 tick과 Redis 연결이 정상인지 확인합니다.
- worker `:4102/health`: 최근 outbox poll, MySQL/MariaDB·Redis 연결과 예약 검사 pipeline이 정상인지 확인합니다. 응답의 `checkPipeline`은 작업이 없으면 `idle`, 처리 중이면 `active`, 최근 처리가 있으면 `healthy`입니다. processor가 연속 실패하면 `failing`, DB 원장에 오래된 `ENQUEUED`/`RUNNING` 작업이 남으면 `stalled`가 되며 HTTP 503을 반환합니다.
- 대시보드의 `STALE`: `next_check_at`이 허용 지연을 넘긴 모니터 수입니다. 대상 사이트 장애가 아니라 LinkAlive 내부의 scheduler/worker 이상 신호입니다.

`WORKER_CHECK_FAILURE_THRESHOLD`는 `failing`으로 전환할 연속 processor 실패 횟수(기본 3), `WORKER_CHECK_PIPELINE_STALE_AFTER_MS`는 미완료 예약 검사를 `stalled`로 판단할 최소 경과 시간입니다. 후자를 직접 실행할 때 생략하면 `SCHEDULED_CHECK_LEASE_MS`의 두 배와 2분 중 큰 값이 사용되며, Compose 기본값은 기본 lease의 두 배인 10분입니다. 정상적인 느린 검사나 lease 회수를 장애로 오인하지 않도록 lease의 두 배 이상을 권장합니다.

### 목적지별 분산 검사 제한

수동·시험·정기 검사는 모두 Redis에서 호스트명과 DNS 검증을 통과한 각 공인 IP별 lease를
원자적으로 확보한 뒤 네트워크 요청을 시작합니다. 리다이렉트도 hop마다 다시 DNS 검증과
제한을 적용합니다. 기본값과 허용 범위는 다음과 같습니다.

| 환경 변수                            | 기본값 | 허용 범위        | 의미                                      |
| ------------------------------------ | ------ | ---------------- | ----------------------------------------- |
| `DESTINATION_CHECK_MAX_CONCURRENCY`  | 4      | 1–1,000          | 호스트명/IP별 동시 네트워크 요청          |
| `DESTINATION_CHECK_MAX_PER_MINUTE`   | 60     | 1–100,000        | 호스트명/IP별 60초 고정 창 요청 수        |
| `DESTINATION_CHECK_LEASE_MS`         | 45,000 | 31,000–600,000ms | 비정상 종료 시 동시 슬롯 자동 회수 시간   |
| `DESTINATION_LIMIT_REDIS_TIMEOUT_MS` | 1,000  | 100–10,000ms     | 제한 확인·해제 Redis 명령의 최대 대기시간 |

lease는 HTTP 검사의 강제 상한 30초보다 길어야 하므로 31초 미만을 허용하지 않습니다. 제한에
도달하거나 Redis 명령이 실패한 경우 네트워크 요청은 시작하지 않고 `PLATFORM_ERROR`로
기록합니다. 이미 시작한 요청의 lease 해제에 실패해도 결과를 대상 장애로 확정하지 않으며,
lease 만료가 슬롯을 회수합니다. 따라서 이 오류는 `DOWN` 임계치에 포함되지 않습니다.
API와 모든 worker replica에 네 설정을 동일하게 배포하고, 한도를 바꿀 때에는 Redis의 기존
60초 rate key가 만료되는 동안 보수적으로 동작할 수 있음을 고려하세요.

아래 항목은 외부 모니터나 운영 대시보드에서 주기적으로 확인합니다.

- 최근 `scheduled_checks.created_at`이 계속 갱신되는지
- `PENDING`, `ENQUEUED`, `RUNNING` 검사 중 lease가 오래 만료된 건수
- `notification_outbox`의 대기·재시도·최종 실패 건수와 가장 오래된 `available_at`
- 최근 검사 대비 `PLATFORM_ERROR`, `INCONCLUSIVE` 비율
- Telegram 발송 성공률 및 `UNKNOWN` delivery 건수

운영 점검용 읽기 전용 SQL 예시는 다음과 같습니다.

```sql
SELECT max(created_at) AS last_scheduled_check_at
FROM scheduled_checks;

SELECT status, count(*)
FROM scheduled_checks
WHERE status IN ('PENDING', 'ENQUEUED', 'RUNNING')
GROUP BY status;

SELECT status, count(*), min(available_at) AS oldest_available_at
FROM notification_outbox
WHERE status IN ('PENDING', 'ENQUEUED', 'PROCESSING', 'RETRY', 'FAILED')
GROUP BY status;

SELECT status, count(*)
FROM notification_deliveries
WHERE created_at >= UTC_TIMESTAMP(3) - INTERVAL 24 HOUR
GROUP BY status;
```

권장 초기 경보 조건은 다음과 같습니다.

- API readiness 또는 scheduler/worker health가 2분 이상 실패
- `STALE` 모니터가 하나 이상인 상태가 검사 주기의 두 배 이상 지속
- 검사 또는 알림의 만료 lease가 5분 이상 회수되지 않음
- outbox 최종 실패가 발생하거나 가장 오래된 발송 대기가 5분 초과
- 최근 15분 `PLATFORM_ERROR` 비율이 1% 초과

## MySQL/MariaDB 백업과 복구

로컬 Compose 환경의 논리 백업 예시입니다. 운영에서는 관리형 MySQL/MariaDB의 스냅샷과 PITR을 우선 사용합니다.

```powershell
docker compose -f infra/compose.yaml exec -T mysql sh -c 'mariadb-dump -u"$MARIADB_USER" -p"$MARIADB_PASSWORD" --single-transaction --routines --triggers "$MARIADB_DATABASE" > /tmp/linkalive.sql'
docker compose -f infra/compose.yaml cp mysql:/tmp/linkalive.sql ./linkalive.sql
```

복구는 기존 운영 DB를 덮어쓰지 말고 새 빈 DB에서 먼저 검증합니다.

```powershell
docker compose -f infra/compose.yaml cp ./linkalive.sql mysql:/tmp/linkalive.sql
docker compose -f infra/compose.yaml exec -T mysql sh -c 'mariadb -u"$MARIADB_USER" -p"$MARIADB_PASSWORD" "$MARIADB_DATABASE" < /tmp/linkalive.sql'
```

복구 후에는 다음을 확인합니다.

1. `pnpm db:deploy`가 성공하는지
2. 모니터·incident·알림 채널 건수가 예상과 일치하는지
3. 암호화 키로 기존 URL과 채널을 정상적으로 읽는지
4. scheduler가 오래된 모든 슬롯이 아니라 최신 검사 한 건만 생성하는지
5. Redis를 비운 뒤에도 DB 원장에서 미완료 검사와 outbox가 재등록되는지

## 데이터 보존

기본 정책은 상세 검사와 예약 원장 30일, 종료된 incident·알림 발송 이력·감사 로그
365일입니다. 보존 작업은 애플리케이션 내부에서 자동 실행되지 않으며 다음 명령을 호출한
경우에만 데이터를 삭제합니다. 첫 운영 실행 전에는 반드시 복구 가능한 백업을 확인하세요.

```powershell
pnpm db:retention
```

설정값은 모두 양의 정수여야 하며 범위를 벗어나면 DB에 연결하거나 삭제하기 전에 명령이
실패합니다.

| 환경 변수                        | 기본값 | 허용 범위     | 의미                                      |
| -------------------------------- | ------ | ------------- | ----------------------------------------- |
| `RETENTION_CHECK_RESULT_DAYS`    | 30     | 1–3,650일     | 검사 결과와 종료된 예약 검사 보존 기간    |
| `RETENTION_HISTORY_DAYS`         | 365    | 1–36,500일    | incident, 알림, 감사 로그 보존 기간       |
| `RETENTION_BATCH_SIZE`           | 500    | 1–10,000행    | 트랜잭션 하나에서 단계별로 삭제할 최대 행 |
| `RETENTION_MAX_BATCHES_PER_STEP` | 100    | 1–1,000 batch | 실행 한 번의 단계별 최대 batch 수         |

명령은 MySQL/MariaDB에서 UTC 경계 시각을 한 번만 읽고 두 cutoff를 계산합니다. 모든 비교는 그
고정된 cutoff에 대한 `<`이므로 cutoff와 정확히 같은 행은 이번 실행에서 지우지 않습니다.
각 테이블의 보존 기준은 다음과 같습니다.

- `check_results`: `finished_at`. 출처를 제한하지 않으므로 `SCHEDULED`, `MANUAL`, 저장 전
  `TEST` 결과가 모두 포함됩니다.
- `scheduled_checks`: `COMPLETED`, `FAILED`, `CANCELED`만 대상으로 하며 완료·취소·마지막
  갱신 시각을 기준으로 삼습니다. 연결된 결과가 남아 있으면 삭제하지 않습니다.
- `notification_deliveries`: 자신의 완료(없으면 생성) 시각과 부모 outbox의 종료 시각이
  모두 cutoff보다 오래되고 부모가 종료 상태일 때만 삭제합니다.
- `notification_outbox`: `SENT`, `FAILED`, `CANCELED`만 대상으로 하며 종료 시각을 기준으로
  삼습니다. 연결된 delivery가 하나라도 남아 있으면 삭제하지 않습니다. incident가 없는
  시험 알림도 같은 정책으로 정리됩니다.
- `incidents`: `RESOLVED`, `CANCELED`의 실제 종료 시각을 기준으로 하며 연결된 outbox가
  남아 있으면 삭제하지 않습니다. 열린 incident는 나이와 무관하게 보존합니다.
- `audit_logs`: `created_at`을 기준으로 합니다.

FK 순서에 맞춰 검사 결과 → 예약 원장, delivery → outbox → incident, 감사 로그 순으로
각 batch를 별도 트랜잭션에서 처리합니다. 동시에 실행된 두 번째 명령은 세션 advisory
lock을 얻지 못해 `already_running`으로 건너뜁니다. 완료·건너뜀·실패 결과는 로그 수집이
가능한 한 줄 JSON으로 출력됩니다. 단계의 `limitReached`가 `true`이면 제한에 걸린 것이므로
다음 실행에서 이어서 처리하거나 부하가 낮은 시간에 batch 제한을 조정하세요.

### 암호화된 비밀정보 폐기

- 모니터를 soft-delete하면 원래 요청 URL 암호문을 즉시 불투명 tombstone으로 교체합니다.
- 알림 채널을 soft-delete하면 Telegram token/chat ID를 담은 설정 암호문을
  즉시 tombstone으로 교체합니다.
- 발송이 끝난 outbox의 채널 설정 snapshot도 재시도나 복구 생성에 더 이상 필요하지 않은
  시점에 즉시 교체합니다. 다만 열린 incident의 `SENT` 장애 알림은 향후 복구 알림을 만들기
  위해 보존합니다. 장애 알림 전달 실패 때문에 취소된 복구 알림도, 이미 공급자에 전달됐지만
  DB 기록이 늦은 장애 알림이 성공으로 확정할 수 있으므로 그 순서가 정리될 때까지 보존합니다.
- 보존 명령은 위 즉시 폐기를 놓친 이전 버전의 행을 별도 bounded batch로 먼저 보정하며,
  `totalRedacted`와 `secretRedactions`를 JSON 결과에 기록합니다. 이 보정에는 보존 일수 대기
  기간이 없습니다.

tombstone은 `LONGBLOB NOT NULL` 제약을 유지하는 비어 있지 않은 값이며 의도적으로 AES-GCM
envelope가 아닙니다. 상태 전이 오류로 폐기된 행이 다시 발송 경로에 들어와도 복호화가 닫힌
방식으로 실패합니다. DB에서 tombstone을 실제 설정값으로 되돌리거나 수동 복호화하지 마세요.

### 배포 플랫폼에서 매일 실행하는 예시

운영 플랫폼의 cron을 사용해 하루 한 번 호출하는 것을 권장합니다. 애플리케이션 프로세스
안에 반복 루프를 추가하지 마세요. 아래 crontab 예시는 매일 03:17(서버 시간)에 이미 떠
있는 운영 이미지로 명령을 한 번 실행합니다.

```cron
17 3 * * * cd /srv/linkalive && docker compose --env-file .env -f infra/compose.prod.yaml run --rm --no-deps api pnpm --silent --filter @linkalive/database retention >> /var/log/linkalive-retention.log 2>&1
```

Kubernetes `CronJob`을 사용하는 경우 컨테이너 command를
`["pnpm", "--silent", "--filter", "@linkalive/database", "retention"]`으로 지정하고 기존 애플리케이션과
같은 `DATABASE_URL` Secret을 주입하세요. `schedule: "17 3 * * *"`,
`concurrencyPolicy: Forbid`, 낮은 `backoffLimit`을 권장합니다. 플랫폼 시간대가 UTC인지
확인하고 실패 JSON과 `limitReached`를 경보 대상으로 연결하세요. CLI의 advisory lock은
플랫폼 설정 오류로 두 작업이 겹쳐도 실제 동시 삭제를 한 번 더 차단합니다.

## 장애 대응

### Redis 장애 또는 데이터 유실

대상 URL을 임의로 `DOWN` 처리하지 않습니다. Redis 복구 후 scheduler의 Check Dispatcher와 worker의 Outbox Dispatcher가 MySQL/MariaDB의 만료 lease와 미완료 원장을 다시 큐에 등록합니다. 큐를 수동으로 재생하기 전에 중복 worker가 남아 있지 않은지 확인합니다.

### MySQL/MariaDB 장애

API, scheduler, worker의 쓰기를 중지하고 DB를 우선 복구합니다. DB 오류로 검사하지 못한 시간은 대상 장애로 기록하지 않습니다. 복구 뒤 migration 상태와 데이터 정합성을 확인한 다음 scheduler, worker, API 순으로 재개합니다.

### Telegram 장애

모니터 건강 상태와 incident는 그대로 유지합니다. outbox와 delivery의 `last_error_safe`, `UNKNOWN`, `FAILED`를 확인하고 제공자가 정상화되었을 때 새 시험 알림으로 연결을 검증합니다. 제공자가 요청을 수신한 뒤 응답을 주지 않은 경우 동일 Message-ID로 재시도하므로 드물게 중복 전달될 수 있습니다.

### 잘못된 장애 판정

모니터를 일시 중지하거나 판정 설정을 수정합니다. 열린 incident는 각각 `PAUSED` 또는 `CONFIG_CHANGED`로 취소되고 대기 알림은 중단됩니다. 원인을 확인한 뒤 재개하면 건강 상태는 `PENDING`에서 다시 판정됩니다.

## 롤백

- 애플리케이션 롤백은 이전 이미지로 API, scheduler, worker, web을 함께 되돌립니다.
- DB migration은 기본적으로 앞으로만 적용합니다. 파괴적 schema 변경은 expand → migrate data → contract 순서로 별도 migration을 작성합니다.
- schema가 호환되지 않는 이전 버전으로 즉시 되돌려야 한다면 서비스 쓰기를 중지하고 검증된 DB 백업으로 새 인스턴스를 복구합니다.
- 롤백 후 `/health/ready`, 즉시 검사, 시험 알림, 원장 reconciliation을 다시 확인합니다.
