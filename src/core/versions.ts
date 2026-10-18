import { PioContext, runPio } from "./pio";
import { PLATFORMIO_VERSION } from "./constants";
import { ProjectModel } from "./repo";

export type CheckStatus = "ok" | "warn" | "error" | "info";

export interface LockCheck {
  id: string;
  label: string;
  detail: string;
  status: CheckStatus;
  file?: string;
  children?: LockCheck[];
}

const RANK: Record<CheckStatus, number> = { ok: 0, info: 1, warn: 2, error: 3 };

function worstStatus(checks: LockCheck[]): CheckStatus {
  let status: CheckStatus = "ok";
  for (const c of checks) {
    if (RANK[c.status] > RANK[status]) status = c.status;
  }
  return status;
}

function depIsPinned(dep: string): boolean {
  // Registry deps look like `owner/name@^1.2.3` or `name@1.2.3`.
  return /@[~^]?[0-9]/.test(dep) || /@[a-zA-Z]/.test(dep);
}

export async function collectLockChecks(
  _root: string,
  ctx: PioContext,
  projects: ProjectModel[]
): Promise<LockCheck[]> {
  const checks: LockCheck[] = [];

  const versionResult = await runPio(ctx, ["--version"], 20000);
  const actual = /version\s+([0-9][^\s,]*)/i.exec(
    `${versionResult.stdout}\n${versionResult.stderr}`
  )?.[1];

  let status: CheckStatus = "ok";
  let detail = "";
  if (!actual) {
    status = "warn";
    detail = "无法读取 pio 版本";
  } else if (actual !== PLATFORMIO_VERSION) {
    status = "warn";
    detail = `插件锁定 ${PLATFORMIO_VERSION}，实际 ${actual}`;
  } else {
    detail = `已锁定 ${PLATFORMIO_VERSION}`;
  }
  checks.push({ id: "platformio", label: "PlatformIO", status, detail });

  for (const project of projects) {
    const issues: LockCheck[] = [];
    for (const env of project.envs) {
      if (!env.board) {
        issues.push({
          id: `${project.name}:${env.name}:board`,
          label: `${env.name}: 未指定 board`,
          detail: "在 platformio.ini 中补 board",
          status: "warn",
          file: project.iniPath,
        });
      }
      if (!env.platform) {
        issues.push({
          id: `${project.name}:${env.name}:platform`,
          label: `${env.name}: 未指定 platform`,
          detail: "在 platformio.ini 中补 platform",
          status: "warn",
          file: project.iniPath,
        });
      } else if (!/@[0-9]/.test(env.platform)) {
        issues.push({
          id: `${project.name}:${env.name}:platform`,
          label: `${env.name}: platform 未锁版本`,
          detail: env.platform,
          status: "warn",
          file: project.iniPath,
        });
      }
      for (const dep of env.libDeps) {
        const remote = /^https?:/i.test(dep) || /^(file|symlink|git\+?):/i.test(dep);
        if (remote) continue;
        if (!depIsPinned(dep)) {
          issues.push({
            id: `${project.name}:${env.name}:lib:${dep}`,
            label: `${env.name}: 依赖未锁版本`,
            detail: dep,
            status: "warn",
            file: project.iniPath,
          });
        }
      }
    }

    const projectStatus = worstStatus(issues);
    checks.push({
      id: `project:${project.name}`,
      label: project.name,
      status: projectStatus,
      detail: issues.length > 0 ? `${issues.length} 项待处理` : "版本已锁定",
      file: project.iniPath,
      children: issues,
    });
  }

  return checks;
}
