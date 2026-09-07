import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AccountRole,
  hashAccountPassword,
  Prisma,
  prisma,
  type Account,
} from '@linkalive/database';
import type {
  AccountBulkCreateInput,
  AccountCreateInput,
  AccountPatch,
} from './account.schemas.js';

function toAccountView(account: Account) {
  return {
    id: account.id,
    username: account.username,
    role: account.role,
    enabled: account.enabled,
    lastLoginAt: account.lastLoginAt,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
  };
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

async function hashWithConcurrency(
  candidates: Array<{ index: number; account: AccountCreateInput }>,
): Promise<Array<{ index: number; account: AccountCreateInput; passwordHash: string }>> {
  const results = new Array<{
    index: number;
    account: AccountCreateInput;
    passwordHash: string;
  }>(candidates.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < candidates.length) {
      const outputIndex = nextIndex++;
      const candidate = candidates[outputIndex]!;
      results[outputIndex] = {
        ...candidate,
        passwordHash: await hashAccountPassword(candidate.account.password),
      };
    }
  }

  await Promise.all(Array.from({ length: Math.min(4, candidates.length) }, () => worker()));
  return results;
}

@Injectable()
export class AccountsService {
  async list() {
    const accounts = await prisma.account.findMany({
      orderBy: [{ username: 'asc' }, { id: 'asc' }],
    });
    return { items: accounts.map(toAccountView) };
  }

  async create(input: AccountCreateInput, actorId: string) {
    const passwordHash = await hashAccountPassword(input.password);
    try {
      const account = await prisma.$transaction(async (tx) => {
        const created = await tx.account.create({
          data: {
            username: input.username,
            passwordHash,
            role: input.role,
            enabled: input.enabled,
          },
        });
        await tx.auditLog.create({
          data: {
            actorId,
            action: 'ACCOUNT_CREATED',
            targetType: 'Account',
            targetId: created.id,
            metadataSafe: { username: created.username, role: created.role },
          },
        });
        return created;
      });
      return toAccountView(account);
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictException('이미 사용 중인 아이디입니다.');
      throw error;
    }
  }

  async bulkCreate(input: AccountBulkCreateInput, actorId: string) {
    const existing = await prisma.account.findMany({
      where: { username: { in: input.accounts.map((account) => account.username) } },
      select: { username: true },
    });
    const unavailable = new Set(existing.map((account) => account.username.toLocaleLowerCase()));
    const seen = new Set<string>();
    const candidates: Array<{ index: number; account: AccountCreateInput }> = [];
    const errors: Array<{ row: number; username: string; message: string }> = [];

    input.accounts.forEach((account, index) => {
      const normalized = account.username.toLocaleLowerCase();
      if (unavailable.has(normalized)) {
        errors.push({
          row: index + 2,
          username: account.username,
          message: '이미 등록된 아이디입니다.',
        });
      } else if (seen.has(normalized)) {
        errors.push({
          row: index + 2,
          username: account.username,
          message: '파일 안에 중복된 아이디입니다.',
        });
      } else {
        seen.add(normalized);
        candidates.push({ index, account });
      }
    });

    if (candidates.length === 0) {
      return {
        created: 0,
        skipped: input.accounts.length,
        errors,
      };
    }

    const hashed = await hashWithConcurrency(candidates);
    const result = await prisma.$transaction(async (tx) => {
      const created = await tx.account.createMany({
        data: hashed.map(({ account, passwordHash }) => ({
          username: account.username,
          passwordHash,
          role: account.role,
          enabled: account.enabled,
        })),
        skipDuplicates: true,
      });
      await tx.auditLog.create({
        data: {
          actorId,
          action: 'ACCOUNTS_BULK_CREATED',
          targetType: 'Account',
          targetId: 'bulk',
          metadataSafe: { requested: input.accounts.length, created: created.count },
        },
      });
      return created;
    });

    return {
      created: result.count,
      skipped: input.accounts.length - result.count,
      errors,
    };
  }

  async update(id: string, patch: AccountPatch, actorId: string) {
    const passwordHash = patch.password ? await hashAccountPassword(patch.password) : undefined;
    try {
      const account = await prisma.$transaction(async (tx) => {
        const current = await tx.account.findUnique({ where: { id } });
        if (!current) throw new NotFoundException('계정을 찾을 수 없습니다.');

        const nextRole = patch.role ?? current.role;
        const nextEnabled = patch.enabled ?? current.enabled;
        if (current.id === actorId && (nextRole !== AccountRole.ADMIN || !nextEnabled)) {
          throw new BadRequestException(
            '현재 로그인한 관리자 계정의 권한이나 상태는 변경할 수 없습니다.',
          );
        }
        if (
          current.role === AccountRole.ADMIN &&
          current.enabled &&
          (nextRole !== AccountRole.ADMIN || !nextEnabled)
        ) {
          const activeAdmins = await tx.account.count({
            where: { role: AccountRole.ADMIN, enabled: true },
          });
          if (activeAdmins <= 1) {
            throw new BadRequestException('활성 관리자 계정은 최소 한 개가 필요합니다.');
          }
        }

        const updated = await tx.account.update({
          where: { id },
          data: {
            ...(patch.username !== undefined ? { username: patch.username } : {}),
            ...(passwordHash !== undefined ? { passwordHash } : {}),
            ...(patch.role !== undefined ? { role: patch.role } : {}),
            ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
          },
        });
        await tx.auditLog.create({
          data: {
            actorId,
            action: 'ACCOUNT_UPDATED',
            targetType: 'Account',
            targetId: id,
            metadataSafe: {
              username: updated.username,
              role: updated.role,
              enabled: updated.enabled,
            },
          },
        });
        return updated;
      });
      return toAccountView(account);
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictException('이미 사용 중인 아이디입니다.');
      throw error;
    }
  }

  async remove(id: string, actorId: string): Promise<void> {
    if (id === actorId) throw new BadRequestException('현재 로그인한 계정은 삭제할 수 없습니다.');

    await prisma.$transaction(async (tx) => {
      const current = await tx.account.findUnique({ where: { id } });
      if (!current) throw new NotFoundException('계정을 찾을 수 없습니다.');
      if (current.role === AccountRole.ADMIN && current.enabled) {
        const activeAdmins = await tx.account.count({
          where: { role: AccountRole.ADMIN, enabled: true },
        });
        if (activeAdmins <= 1) {
          throw new BadRequestException('활성 관리자 계정은 최소 한 개가 필요합니다.');
        }
      }
      await tx.auditLog.create({
        data: {
          actorId,
          action: 'ACCOUNT_DELETED',
          targetType: 'Account',
          targetId: id,
          metadataSafe: { username: current.username, role: current.role },
        },
      });
      await tx.account.delete({ where: { id } });
    });
  }
}
