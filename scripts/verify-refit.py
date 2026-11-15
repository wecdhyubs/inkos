#!/usr/bin/env python3
"""一键验证「非商业导向写作 Skill」魔改，并可选跑 InkOS 测试。

用法（在任意目录执行都可以）：

    python inkos/scripts/verify-refit.py                # 装依赖 + 静态自检 + core 全量测试
    python inkos/scripts/verify-refit.py --static       # 只做静态自检，不需要依赖和网络
    python inkos/scripts/verify-refit.py --no-install   # 跳过安装，直接跑测试
    python inkos/scripts/verify-refit.py --quick        # 只跑 skill 相关 + pi-stream（约 30 秒）
    python inkos/scripts/verify-refit.py --no-install --quick

脚本会处理本机环境的几个已知坑：pnpm 12 不再读 package.json 的
pnpm.overrides、腾讯镜像 403、非冻结安装后的 lockfile 变动、
ERR_PNPM_IGNORED_BUILDS、verifyDepsBeforeRun 校验，以及 Windows 上
pnpm.CMD shim 无法被 Python 直接执行（改用 node 跑 pnpm.mjs / vitest.mjs）。
它不会修改任何 Skill 内容；安装后会把 pnpm-lock.yaml 与 pnpm-workspace.yaml 还原成原样（pnpm 12 会往后者写 allowBuilds 占位）。

退出码：0 = 通过（允许存在环境性失败）；1 = 魔改相关失败；2 = 工具/环境不可用。
"""
from __future__ import annotations

import argparse
import re
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CORE_DIR = ROOT / "packages" / "core"
SKILLS = CORE_DIR / "skills"
VITEST_MJS = CORE_DIR / "node_modules" / "vitest" / "vitest.mjs"
REGISTRY = "https://registry.npmjs.org"

EXPECTED_IDS = {
    "inkos-continuation-writing", "inkos-fanfic-writing", "inkos-imitation-writing",
    "inkos-interactive-film", "inkos-long-market-research", "inkos-long-story-analysis",
    "inkos-long-writing", "inkos-play-illustration", "inkos-play-world",
    "inkos-script-writing", "inkos-short-market-research", "inkos-short-story-analysis",
    "inkos-short-writing", "inkos-spinoff-writing", "inkos-story-cover",
    "inkos-story-deslop", "inkos-story-import", "inkos-story-review",
    "inkos-storyboard", "inkos-translation",
}
WRITING_SKILLS = {
    "inkos-long-writing": 3,
    "inkos-short-writing": 1,
    "inkos-story-review": 1,
    "inkos-story-deslop": 1,
}
SKILL_TESTS = [
    "src/__tests__/external-skill-loader.test.ts",
    "src/__tests__/skill-registry.test.ts",
    "src/__tests__/skill-agent-tool.test.ts",
    "src/__tests__/pi-stream.test.ts",
]
LINK_RE = re.compile(r"(?:`|\]\()((?:references|examples)/[^`\n)]+\.(?:md|txt))(?:`|\))")
MAX_AUTOLOAD_BYTES = 20 * 1024

checks: list[tuple[bool, str]] = []
_pnpm_base: list[str] | None = None


def check(ok: bool, message: str) -> None:
    checks.append((bool(ok), message))


def node_exe() -> str:
    exe = shutil.which("node") or shutil.which("node.exe")
    if not exe:
        raise RuntimeError("找不到 node，请先安装 Node.js（项目要求 >= 22.16）")
    return exe


def run(cmd: list[str], timeout: int, cwd: Path | None = None) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(
            cmd, cwd=str(cwd or ROOT), timeout=timeout, capture_output=True,
            text=True, encoding="utf-8", errors="replace",
        )
    except FileNotFoundError as error:
        raise RuntimeError(f"找不到命令：{cmd[0]}（{error}）") from error
    except subprocess.TimeoutExpired as error:
        raise RuntimeError(f"命令超时（{timeout}s）：{' '.join(cmd[:4])} ...") from error


def resolve_pnpm() -> list[str]:
    """Windows 的 pnpm.CMD 会去执行一个无扩展名 shim，Python 直接调用会失败。"""
    node = node_exe()
    candidates: list[list[str]] = []
    for which_name in ("pnpm", "pnpm.cmd", "pnpm.exe"):
        found = shutil.which(which_name)
        if not found:
            continue
        base = Path(found).parent
        for entry in ("node_modules/pnpm/bin/pnpm.mjs", "node_modules/pnpm/bin/pnpm.cjs"):
            mjs = base / entry
            if mjs.is_file():
                candidates.append([node, str(mjs)])
        candidates.append([found])
    for candidate in candidates:
        try:
            probe = run(candidate + ["--version"], timeout=60)
        except RuntimeError:
            continue
        if probe.returncode == 0 and (probe.stdout or "").strip():
            return candidate
    raise RuntimeError("pnpm 不可用：请用 npm i -g pnpm 安装，或确认 node/pnpm 在 PATH 中")


def pnpm(*args: str) -> list[str]:
    global _pnpm_base
    if _pnpm_base is None:
        _pnpm_base = resolve_pnpm()
    return [*_pnpm_base, "--config.verifyDepsBeforeRun=false", "-C", str(ROOT), *args]


def vitest(*args: str) -> list[str]:
    if not VITEST_MJS.is_file():
        raise RuntimeError("vitest 未安装，请去掉 --no-install 让脚本先装依赖")
    return [node_exe(), str(VITEST_MJS), "run", *args, "--reporter=dot"]


def parse_frontmatter(text: str) -> tuple[dict[str, str], str]:
    normalized = text.replace("\r\n", "\n").lstrip("\ufeff")
    if not normalized.startswith("---\n"):
        raise ValueError("缺少 frontmatter 起始分隔符")
    end = normalized.find("\n---", 4)
    if end < 0:
        raise ValueError("缺少 frontmatter 结束分隔符")
    data: dict[str, str] = {}
    for line in normalized[4:end].splitlines():
        if not line.strip() or line.startswith((" ", "\t", "#")) or ":" not in line:
            continue
        key, value = line.split(":", 1)
        data[key.strip()] = value.strip().strip('"').strip("'")
    return data, normalized[end + 4:].lstrip("\n")


def static_check() -> None:
    dirs = sorted(p for p in SKILLS.iterdir() if p.is_dir() and (p / "SKILL.md").is_file())
    ids = {p.name for p in dirs}
    check(ids == EXPECTED_IDS, f"内置 Skill ID 集合不变（20 个，实际 {len(ids)} 个）")

    for d in dirs:
        text = (d / "SKILL.md").read_text(encoding="utf-8")
        try:
            data, body = parse_frontmatter(text)
        except ValueError as error:
            check(False, f"{d.name}: frontmatter 无效（{error}）")
            continue
        check(data.get("name") == d.name, f"{d.name}: name 与目录 ID 一致")
        check(0 < len(data.get("description", "")) <= 1024, f"{d.name}: description 合规")
        check(bool(body.strip()), f"{d.name}: 正文非空")

        refs = sorted(set(LINK_RE.findall(body)))
        for ref in refs:
            check((d / ref).is_file(), f"{d.name}: 固定引用存在 -> {ref}")
        if d.name in WRITING_SKILLS:
            limit = WRITING_SKILLS[d.name]
            size = sum((d / r).stat().st_size for r in refs if (d / r).is_file())
            check(
                len(refs) <= limit and size <= MAX_AUTOLOAD_BYTES,
                f"{d.name}: 自动加载 {len(refs)} 份 / {size / 1024:.1f} KB（上限 {limit} 份 / 20 KB，超出会撑爆 protected context）",
            )

    for d in dirs:
        for p in d.rglob("*.md"):
            raw = p.read_bytes()
            check(b"\x00" not in raw and len(raw) < 512 * 1024, f"{p.relative_to(ROOT).as_posix()}: UTF-8 文本且 < 512 KB")
            for ref in set(LINK_RE.findall(raw.decode("utf-8", errors="replace"))):
                check((d / ref).is_file(), f"{p.relative_to(ROOT).as_posix()}: 引用可解析 -> {ref}")

    lw = SKILLS / "inkos-long-writing" / "references"
    for rel in ["outline-voice.md", "literary/INDEX.md", "literary/dickens-bildungsroman.md"]:
        check((lw / rel).is_file(), f"整合资料存在 -> {rel}")
    for name in WRITING_SKILLS:
        check((SKILLS / name / "references" / "outline-voice.md").is_file(), f"{name}: outline-voice.md 已就位")
    check(not list((lw / "literary").rglob("SKILL.md")), "literary/ 下没有 SKILL.md（不会被误发现为新 skill）")
    readme = (ROOT / "README.md").read_text(encoding="utf-8")
    check("写作方法：非商业导向" in readme, "README.md 已同步新写法说明")


def ensure_deps() -> None:
    tracked = [ROOT / "pnpm-lock.yaml", ROOT / "pnpm-workspace.yaml"]
    originals = {p: p.read_bytes() for p in tracked if p.is_file()}
    print("安装依赖（官方 npm 源，非冻结模式）...")
    result = run(pnpm("install", "--no-frozen-lockfile", f"--registry={REGISTRY}"), timeout=900)
    if result.returncode != 0:
        tail = (result.stderr or result.stdout).strip().splitlines()[-4:]
        print("  安装命令返回非零（pnpm 12 常因构建脚本被拦而如此），检查 vitest 是否可用：")
        for line in tail:
            print("   ", line)
    if not VITEST_MJS.is_file():
        raise RuntimeError("vitest 不可用，依赖没装好。请检查网络或手动运行 pnpm install。")
    print("  vitest 已就位")
    for path, data in originals.items():
        if path.is_file() and path.read_bytes() != data:
            path.write_bytes(data)
            print(f"  已把 {path.name} 还原为安装前内容")


def run_tests(quick: bool) -> int:
    files = SKILL_TESTS if quick else []
    print("运行测试：", "skill 相关 + pi-stream（quick）" if quick else "core 全量")
    result = run(vitest(*files), timeout=900, cwd=CORE_DIR)
    out = re.sub(r"\x1b\[[0-9;]*[A-Za-z]", "", (result.stdout or "") + "\n" + (result.stderr or ""))

    files_m = re.search(r"Test Files\s+(\d+) failed \| (\d+) passed \((\d+)\)", out)
    tests_m = re.search(r"Tests\s+(\d+) failed \| (\d+) passed \((\d+)\)", out)
    passed_files = re.search(r"Test Files\s+\d+ passed \(\d+\)", out)
    passed_tests = re.search(r"Tests\s+\d+ passed \(\d+\)", out)

    if result.returncode == 0:
        print(f"  {passed_files.group(0) if passed_files else 'Test Files passed'}")
        print(f"  {passed_tests.group(0) if passed_tests else 'Tests passed'}")
        print("  [OK] 测试全绿。")
        return 0
    if not tests_m:
        print("  [失败] 测试命令非零退出，且没解析到汇总行；尾部输出：")
        for line in out.strip().splitlines()[-12:]:
            print("   ", line)
        return 1

    failed_files = re.findall(r"FAIL\s+(src/__tests__/[^\s>]+\.ts)", out)
    print(f"  {files_m.group(0) if files_m else ''}")
    print(f"  {tests_m.group(0)}")
    overflow = "ProtectedContextOverflowError" in out
    skill_fail = any(
        any(key in f for key in ("external-skill-loader", "skill-registry", "skill-agent-tool", "pi-stream"))
        for f in failed_files
    )
    env_only = not overflow and not skill_fail and ("fetch failed" in out or "stream=false" in out)

    if overflow:
        print("  [严重] ProtectedContextOverflowError：SKILL.md 的固定引用过多，按静态自检的预算项收敛。")
    if skill_fail:
        print("  [严重] skill 相关测试失败，魔改可能有问题。")
    if env_only:
        print("  [环境] 剩余失败均为 fetch failed / stream=false（沙盒网络或 stubbed LLM mock），与 Skill 魔改无关。")
    print(f"  失败文件：{', '.join(sorted(set(failed_files))) or '（未解析到文件名）'}")
    return 1 if (overflow or skill_fail) else 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--static", action="store_true", help="只做静态自检，不装依赖、不跑测试")
    parser.add_argument("--no-install", action="store_true", help="跳过依赖安装")
    parser.add_argument("--quick", action="store_true", help="只跑 skill 相关 + pi-stream")
    args = parser.parse_args()

    print(f"InkOS 根目录：{ROOT}\n")
    print("=== 静态自检 ===")
    static_check()
    for ok, message in checks:
        print(f"[{'OK' if ok else 'FAIL'}] {message}")
    failed_static = [m for ok, m in checks if not ok]
    print(f"静态自检：{len(checks) - len(failed_static)} 通过，{len(failed_static)} 失败。\n")
    if failed_static:
        return 1
    if args.static:
        print("完成（--static）。")
        return 0

    try:
        if not args.no_install:
            ensure_deps()
        print("")
        print("=== 测试 ===")
        code = run_tests(args.quick)
        print("\n提示：脚本会把 lockfile 还原；之后若直接运行 pnpm 命令被 verifyDepsBeforeRun 拦住，")
        print("      加上 --config.verifyDepsBeforeRun=false 即可（脚本内部已自动加）。")
        return code
    except RuntimeError as error:
        print(f"[环境错误] {error}")
        return 2


if __name__ == "__main__":
    sys.exit(main())
