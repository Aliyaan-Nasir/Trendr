#!/usr/bin/env python3
"""Plants each bug from mutations.json in a scratch copy of the contracts and checks that the
named invariant suite fails. The working tree is never modified.

Usage: python3 test/mutations/run.py [mutation-id ...]   (run from contracts/)
Env:   MUTATION_INVARIANT_RUNS (default 64) and MUTATION_INVARIANT_DEPTH (default 128).
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import time

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SPEC = os.path.join(ROOT, "test", "mutations", "mutations.json")


def scratch_copy() -> str:
    tmp = tempfile.mkdtemp(prefix="trendr-mutation-")
    for name in ("src", "test", "script", "foundry.toml"):
        path = os.path.join(ROOT, name)
        if os.path.isdir(path):
            shutil.copytree(path, os.path.join(tmp, name))
        else:
            shutil.copy2(path, os.path.join(tmp, name))
    # Reuse build artifacts so only the mutated file and its dependents recompile.
    for name in ("out", "cache"):
        path = os.path.join(ROOT, name)
        if os.path.isdir(path):
            shutil.copytree(path, os.path.join(tmp, name))
    os.symlink(os.path.join(ROOT, "lib"), os.path.join(tmp, "lib"))
    return tmp


def plant(tmp: str, mutation: dict) -> None:
    path = os.path.join(tmp, mutation["file"])
    with open(path) as f:
        source = f.read()
    count = source.count(mutation["find"])
    if count != 1:
        raise SystemExit(f"{mutation['id']}: expected the target text once in {mutation['file']}, found {count}")
    with open(path, "w") as f:
        f.write(source.replace(mutation["find"], mutation["replace"]))


def run(mutation: dict) -> tuple[bool, float, str]:
    tmp = scratch_copy()
    try:
        plant(tmp, mutation)
        env = dict(os.environ)
        env["FOUNDRY_INVARIANT_RUNS"] = os.environ.get("MUTATION_INVARIANT_RUNS", "64")
        env["FOUNDRY_INVARIANT_DEPTH"] = os.environ.get("MUTATION_INVARIANT_DEPTH", "128")
        started = time.time()
        result = subprocess.run(
            ["forge", "test", "--root", tmp, "--match-contract", mutation["suite"]],
            capture_output=True,
            text=True,
            env=env,
        )
        output = result.stdout + result.stderr
        if "Compiler run failed" in output:
            raise SystemExit(f"{mutation['id']}: the mutated source does not compile\n{output}")
        failing = [line.strip() for line in output.splitlines() if line.strip().startswith("[FAIL")]
        return result.returncode != 0, time.time() - started, failing[0] if failing else ""
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def main() -> int:
    with open(SPEC) as f:
        mutations = json.load(f)
    wanted = set(sys.argv[1:])
    if wanted:
        mutations = [m for m in mutations if m["id"] in wanted]
    survivors = []
    for m in mutations:
        caught, seconds, detail = run(m)
        status = "caught" if caught else "SURVIVED"
        print(f"{status:9} {m['id']:32} {m['suite']:20} {seconds:6.1f}s  {detail}", flush=True)
        if not caught:
            survivors.append(m["id"])
    print(f"\n{len(mutations) - len(survivors)}/{len(mutations)} planted bugs caught")
    if survivors:
        print("Survivors: " + ", ".join(survivors))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
