'use client';

import type { CellValue } from 'exceljs';
import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { useAuthUser } from '@/components/AppShell';
import { Icon } from '@/components/Icon';
import { EmptyState, ErrorPanel, InlineNotice, SectionSkeleton } from '@/components/StateViews';
import { useToast } from '@/components/ToastProvider';
import { validateAccountPassword, validateAccountUsername } from '@/lib/account-validation';
import { accountsApi, getErrorMessage } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import type { Account, AccountBulkResult, AccountInput, AccountPatch } from '@/lib/types';

type FormMode = { type: 'create' } | { type: 'edit'; account: Account } | null;
type ImportError = AccountBulkResult['errors'][number];

export default function AccountsPage() {
  const currentUser = useAuthUser();
  const { showToast } = useToast();
  const fileInput = useRef<HTMLInputElement>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [formMode, setFormMode] = useState<FormMode>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<AccountBulkResult | null>(null);

  const load = useCallback(async (quiet = false) => {
    quiet ? setRefreshing(true) : setLoading(true);
    setError(null);
    try {
      setAccounts((await accountsApi.list()).items);
    } catch (loadError) {
      setError(getErrorMessage(loadError));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function removeAccount(account: Account) {
    if (!window.confirm(`“${account.username}” 계정을 삭제할까요?`)) return;
    setPendingId(account.id);
    try {
      await accountsApi.remove(account.id);
      setAccounts((current) => current.filter((item) => item.id !== account.id));
      showToast('계정을 삭제했습니다.', 'success');
    } catch (removeError) {
      showToast(getErrorMessage(removeError), 'error');
    } finally {
      setPendingId(null);
    }
  }

  async function downloadTemplate() {
    const { Workbook } = await import('exceljs');
    const workbook = new Workbook();
    const worksheet = workbook.addWorksheet('계정 등록');
    worksheet.columns = [
      { header: '아이디', key: 'username', width: 28 },
      { header: '비밀번호', key: 'password', width: 24 },
      { header: '권한', key: 'role', width: 15 },
      { header: '활성', key: 'enabled', width: 12 },
    ];
    worksheet.addRow({ username: 'user01', password: 'ChangeMe123!', role: 'USER', enabled: 'Y' });
    worksheet.views = [{ state: 'frozen', ySplit: 1 }];
    worksheet.autoFilter = 'A1:D1';
    worksheet.getRow(1).eachCell((cell) => {
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF16A87A' } };
    });
    const buffer = await workbook.xlsx.writeBuffer();
    const blob = new Blob([buffer as unknown as BlobPart], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'linkalive-account-template.xlsx';
    anchor.click();
    URL.revokeObjectURL(url);
  }

  async function importExcel(file: File) {
    setImporting(true);
    setImportResult(null);
    try {
      const { Workbook } = await import('exceljs');
      const workbook = new Workbook();
      await workbook.xlsx.load((await file.arrayBuffer()) as never);
      const worksheet = workbook.worksheets[0];
      if (!worksheet) throw new Error('엑셀 파일에 시트가 없습니다.');

      const headers = new Map<string, number>();
      worksheet.getRow(1).eachCell((cell, column) => {
        headers.set(cellText(cell.value).replace(/\s+/g, '').toLocaleLowerCase(), column);
      });
      const usernameColumn = findHeader(headers, ['아이디', 'username', '계정']);
      const passwordColumn = findHeader(headers, ['비밀번호', 'password']);
      const roleColumn = findHeader(headers, ['권한', 'role']);
      const enabledColumn = findHeader(headers, ['활성', 'enabled', '사용여부']);
      if (!usernameColumn || !passwordColumn) {
        throw new Error('첫 행에 아이디와 비밀번호 열이 필요합니다. 제공된 양식을 사용해 주세요.');
      }

      const validRows: Array<{ row: number; account: AccountInput }> = [];
      const localErrors: ImportError[] = [];
      worksheet.eachRow((row, rowNumber) => {
        if (rowNumber === 1) return;
        const username = cellText(row.getCell(usernameColumn).value).trim();
        const password = cellText(row.getCell(passwordColumn).value);
        const roleText = roleColumn ? cellText(row.getCell(roleColumn).value).trim() : '';
        const enabledText = enabledColumn ? cellText(row.getCell(enabledColumn).value).trim() : '';
        if (!username && !password && !roleText && !enabledText) return;

        const role = parseRole(roleText);
        const enabled = parseEnabled(enabledText);
        const message =
          validateAccountUsername(username) ??
          validateAccountPassword(password) ??
          (role === null
            ? '권한은 ADMIN 또는 USER여야 합니다.'
            : enabled === null
              ? '활성 값은 Y 또는 N이어야 합니다.'
              : null);
        if (message) {
          localErrors.push({ row: rowNumber, username, message });
        } else {
          validRows.push({
            row: rowNumber,
            account: { username, password, role: role!, enabled: enabled! },
          });
        }
      });

      if (validRows.length + localErrors.length > 500) {
        throw new Error('한 번에 최대 500개 계정까지 등록할 수 있습니다.');
      }
      if (validRows.length === 0) {
        setImportResult({ created: 0, skipped: localErrors.length, errors: localErrors });
        return;
      }

      const result = await accountsApi.bulkCreate(validRows.map(({ account }) => account));
      const serverErrors = result.errors.map((item) => ({
        ...item,
        row: validRows[item.row - 2]?.row ?? item.row,
      }));
      const combined = {
        created: result.created,
        skipped: result.skipped + localErrors.length,
        errors: [...localErrors, ...serverErrors].sort((left, right) => left.row - right.row),
      };
      setImportResult(combined);
      await load(true);
      showToast(`${combined.created}개 계정을 등록했습니다.`, 'success');
    } catch (importError) {
      showToast(getErrorMessage(importError), 'error');
    } finally {
      setImporting(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  return (
    <div className="page-container accounts-page">
      <header className="page-header">
        <div>
          <span className="page-eyebrow">Access control</span>
          <h1>계정 관리</h1>
          <p>관리자와 일반 사용자 계정을 생성하고 접근 권한을 관리합니다.</p>
        </div>
        <div className="page-header-actions account-header-actions">
          <button
            type="button"
            className="button button-secondary"
            onClick={() => void downloadTemplate()}
          >
            <Icon name="download" size={16} /> 엑셀 양식
          </button>
          <button
            type="button"
            className="button button-secondary"
            onClick={() => fileInput.current?.click()}
            disabled={importing}
          >
            {importing ? (
              <span className="spinner spinner-button" />
            ) : (
              <Icon name="upload" size={16} />
            )}
            엑셀 업로드
          </button>
          <input
            ref={fileInput}
            className="visually-hidden"
            type="file"
            accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void importExcel(file);
            }}
          />
          <button
            type="button"
            className="button button-primary"
            onClick={() => setFormMode({ type: 'create' })}
          >
            <Icon name="plus" size={17} /> 계정 추가
          </button>
        </div>
      </header>

      {formMode ? (
        <AccountForm
          mode={formMode}
          onClose={() => setFormMode(null)}
          onSaved={(account) => {
            setAccounts((current) => {
              const exists = current.some((item) => item.id === account.id);
              return exists
                ? current.map((item) => (item.id === account.id ? account : item))
                : [...current, account].sort((a, b) => a.username.localeCompare(b.username));
            });
            setFormMode(null);
            showToast(
              formMode.type === 'create' ? '계정을 추가했습니다.' : '계정을 수정했습니다.',
              'success',
            );
          }}
        />
      ) : null}

      {importResult ? (
        <section className="content-card import-result-card" aria-live="polite">
          <div className="card-header">
            <div>
              <h2>엑셀 등록 결과</h2>
              <p>
                {importResult.created}개 등록 · {importResult.skipped}개 제외
              </p>
            </div>
            <button
              type="button"
              className="icon-button"
              aria-label="결과 닫기"
              onClick={() => setImportResult(null)}
            >
              <Icon name="close" size={18} />
            </button>
          </div>
          {importResult.errors.length ? (
            <div className="import-errors">
              {importResult.errors.slice(0, 20).map((item, index) => (
                <p key={`${item.row}-${item.username}-${index}`}>
                  <strong>
                    {item.row}행 {item.username || '(아이디 없음)'}
                  </strong>
                  <span>{item.message}</span>
                </p>
              ))}
              {importResult.errors.length > 20 ? (
                <small>외 {importResult.errors.length - 20}건</small>
              ) : null}
            </div>
          ) : (
            <div className="import-success">
              <Icon name="check" size={18} /> 모든 계정을 등록했습니다.
            </div>
          )}
        </section>
      ) : null}

      {error && !loading ? (
        <ErrorPanel message={error} onRetry={() => void load()} />
      ) : (
        <section className="content-card account-list-card">
          <div className="card-header">
            <div>
              <h2>등록된 계정</h2>
              <p>{loading ? '계정을 불러오는 중입니다' : `총 ${accounts.length}개 계정`}</p>
            </div>
            <button
              type="button"
              className="button button-secondary button-small"
              onClick={() => void load(true)}
              disabled={refreshing}
            >
              {refreshing ? (
                <span className="spinner spinner-button" />
              ) : (
                <Icon name="refresh" size={15} />
              )}{' '}
              새로고침
            </button>
          </div>
          {loading ? (
            <div className="card-body">
              <SectionSkeleton rows={4} />
            </div>
          ) : accounts.length === 0 ? (
            <EmptyState
              icon="user"
              title="등록된 계정이 없습니다"
              description="첫 관리자 계정을 추가해 주세요."
            />
          ) : (
            <div className="account-table-wrap">
              <div className="account-table-header">
                <span>계정</span>
                <span>권한</span>
                <span>상태</span>
                <span>최근 로그인</span>
                <span>생성일</span>
                <span>관리</span>
              </div>
              {accounts.map((account) => (
                <article className="account-row" key={account.id}>
                  <div className="account-identity">
                    <span className="user-avatar">
                      {account.username.slice(0, 1).toUpperCase()}
                    </span>
                    <div>
                      <strong>{account.username}</strong>
                      {account.id === currentUser.id ? <small>현재 계정</small> : null}
                    </div>
                  </div>
                  <span className={`role-badge role-${account.role.toLowerCase()}`}>
                    {account.role === 'ADMIN' ? '관리자' : '일반 사용자'}
                  </span>
                  <span className={`account-status ${account.enabled ? 'enabled' : 'disabled'}`}>
                    {account.enabled ? '활성' : '비활성'}
                  </span>
                  <span>
                    {account.lastLoginAt ? formatDateTime(account.lastLoginAt) : '로그인 기록 없음'}
                  </span>
                  <span>{formatDateTime(account.createdAt)}</span>
                  <div className="account-actions">
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={`${account.username} 수정`}
                      onClick={() => setFormMode({ type: 'edit', account })}
                      disabled={pendingId === account.id}
                    >
                      <Icon name="edit" size={17} />
                    </button>
                    <button
                      type="button"
                      className="icon-button icon-button-danger"
                      aria-label={`${account.username} 삭제`}
                      onClick={() => void removeAccount(account)}
                      disabled={pendingId === account.id || account.id === currentUser.id}
                    >
                      <Icon name="trash" size={17} />
                    </button>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>
      )}

      <InlineNotice>
        비밀번호는 복호화할 수 없는 scrypt 해시로 저장됩니다. 엑셀 파일은 등록 처리 후 서버에
        보관되지 않습니다.
      </InlineNotice>
    </div>
  );
}

function AccountForm({
  mode,
  onClose,
  onSaved,
}: {
  mode: Exclude<FormMode, null>;
  onClose: () => void;
  onSaved: (account: Account) => void;
}) {
  const editing = mode.type === 'edit' ? mode.account : null;
  const [username, setUsername] = useState(editing?.username ?? '');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<'ADMIN' | 'USER'>(editing?.role ?? 'USER');
  const [enabled, setEnabled] = useState(editing?.enabled ?? true);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const usernameError = validateAccountUsername(username);
    if (usernameError) {
      setError(usernameError);
      return;
    }
    const passwordError = !editing || password ? validateAccountPassword(password) : null;
    if (passwordError) {
      setError(passwordError);
      return;
    }
    setSubmitting(true);
    try {
      if (editing) {
        const patch: AccountPatch = { username: username.trim(), role, enabled };
        if (password) patch.password = password;
        onSaved(await accountsApi.update(editing.id, patch));
      } else {
        onSaved(await accountsApi.create({ username: username.trim(), password, role, enabled }));
      }
    } catch (saveError) {
      setError(getErrorMessage(saveError));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="content-card account-form-card">
      <div className="card-header">
        <div>
          <h2>{editing ? '계정 수정' : '새 계정'}</h2>
          <p>
            {editing
              ? '권한, 상태 또는 비밀번호를 변경합니다.'
              : '콘솔에 접속할 계정을 추가합니다.'}
          </p>
        </div>
        <button type="button" className="icon-button" aria-label="계정 입력 닫기" onClick={onClose}>
          <Icon name="close" size={18} />
        </button>
      </div>
      <form className="account-form" onSubmit={submit} noValidate>
        {error ? (
          <div className="form-error" role="alert">
            <Icon name="alert" size={16} /> {error}
          </div>
        ) : null}
        <div className="account-form-grid">
          <label className="field">
            <span className="field-label">
              아이디 <em>필수</em>
            </span>
            <input
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              maxLength={160}
              autoComplete="off"
            />
          </label>
          <label className="field">
            <span className="field-label">
              비밀번호 {editing ? <small>변경 시에만 입력</small> : <em>필수</em>}
            </span>
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              maxLength={128}
              autoComplete="new-password"
            />
          </label>
          <label className="field">
            <span className="field-label">권한</span>
            <select
              value={role}
              onChange={(event) => setRole(event.target.value as 'ADMIN' | 'USER')}
            >
              <option value="USER">일반 사용자</option>
              <option value="ADMIN">관리자</option>
            </select>
          </label>
          <label className="field">
            <span className="field-label">상태</span>
            <select
              value={enabled ? 'enabled' : 'disabled'}
              onChange={(event) => setEnabled(event.target.value === 'enabled')}
            >
              <option value="enabled">활성</option>
              <option value="disabled">비활성</option>
            </select>
          </label>
        </div>
        <div className="channel-form-actions">
          <button type="button" className="button button-ghost" onClick={onClose}>
            취소
          </button>
          <button type="submit" className="button button-primary" disabled={submitting}>
            {submitting ? (
              <>
                <span className="spinner spinner-button" /> 저장 중
              </>
            ) : (
              <>
                <Icon name="check" size={16} /> 저장
              </>
            )}
          </button>
        </div>
      </form>
    </section>
  );
}

function cellText(value: CellValue): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') {
    if ('text' in value) return String(value.text);
    if ('result' in value && value.result !== undefined) return String(value.result);
    if ('richText' in value) return value.richText.map((part) => part.text).join('');
  }
  return String(value);
}

function findHeader(headers: Map<string, number>, names: string[]): number | undefined {
  return names.map((name) => headers.get(name.toLocaleLowerCase())).find(Boolean);
}

function parseRole(value: string): 'ADMIN' | 'USER' | null {
  const normalized = value.toLocaleUpperCase();
  if (!normalized || ['USER', '사용자', '일반사용자'].includes(normalized)) return 'USER';
  if (['ADMIN', '관리자'].includes(normalized)) return 'ADMIN';
  return null;
}

function parseEnabled(value: string): boolean | null {
  const normalized = value.toLocaleUpperCase();
  if (!normalized || ['Y', 'YES', 'TRUE', '1', '활성'].includes(normalized)) return true;
  if (['N', 'NO', 'FALSE', '0', '비활성'].includes(normalized)) return false;
  return null;
}
