"""
Git Commit Analyzer

Analyzes staged changes and suggests conventional commit messages.

Usage:
    python commit_analyzer.py [--scope SCOPE] [--breaking]
"""

from typing import List, Dict, Optional, Tuple
import subprocess
import re
import argparse


def get_staged_files() -> List[str]:
    """Get list of staged files."""
    result = subprocess.run(
        ["git", "diff", "--cached", "--name-only"],
        capture_output=True, text=True
    )
    return [f for f in result.stdout.strip().split("\n") if f]


def get_staged_diff() -> str:
    """Get the staged diff content."""
    result = subprocess.run(
        ["git", "diff", "--cached"],
        capture_output=True, text=True
    )
    return result.stdout


def infer_commit_type(files: List[str], diff: str) -> str:
    """
    Infer the commit type from staged changes.

    Returns one of: feat, fix, docs, refactor, test, chore, ci, perf
    """
    # Check for test files
    test_patterns = ["test", "spec", "__tests__"]
    if all(any(p in f.lower() for p in test_patterns) for f in files):
        return "test"

    # Check for documentation
    doc_extensions = [".md", ".rst", ".txt", ".adoc"]
    if all(any(f.endswith(ext) for ext in doc_extensions) for f in files):
        return "docs"

    # Check for CI/CD files
    ci_patterns = [".github/workflows", "Jenkinsfile", ".gitlab-ci", "azure-pipelines"]
    if any(any(p in f for p in ci_patterns) for f in files):
        return "ci"

    # Check for config/chore files
    chore_patterns = ["package.json", "tsconfig", ".eslint", ".prettier", "Dockerfile"]
    if all(any(p in f for p in chore_patterns) for f in files):
        return "chore"

    # Check diff content for fix indicators
    fix_patterns = ["fix", "bug", "error", "issue", "crash", "fail"]
    diff_lower = diff.lower()
    if any(p in diff_lower for p in fix_patterns):
        return "fix"

    # Default to feat for new functionality
    return "feat"


def infer_scope(files: List[str]) -> Optional[str]:
    """
    Infer scope from changed files.

    Returns common directory or module name.
    """
    if not files:
        return None

    # Extract first directory from each file
    dirs = []
    for f in files:
        parts = f.split("/")
        if len(parts) > 1:
            # Skip common root dirs
            skip_roots = ["src", "lib", "app", "packages"]
            if parts[0] in skip_roots and len(parts) > 2:
                dirs.append(parts[1])
            else:
                dirs.append(parts[0])

    if not dirs:
        return None

    # Return most common directory
    from collections import Counter
    most_common = Counter(dirs).most_common(1)
    if most_common:
        return most_common[0][0]

    return None


def generate_subject(files: List[str], diff: str, commit_type: str) -> str:
    """
    Generate a commit subject line.

    This is a simplified version - production should use LLM.
    """
    # Extract key changes from diff
    added_lines = [l[1:] for l in diff.split("\n") if l.startswith("+") and not l.startswith("+++")]
    removed_lines = [l[1:] for l in diff.split("\n") if l.startswith("-") and not l.startswith("---")]

    # Common verbs by type
    verbs = {
        "feat": "add",
        "fix": "fix",
        "docs": "update",
        "refactor": "refactor",
        "test": "add tests for",
        "chore": "update",
        "ci": "configure",
        "perf": "improve",
    }

    verb = verbs.get(commit_type, "update")

    # Describe what changed based on files
    if len(files) == 1:
        file_desc = files[0].split("/")[-1].replace("_", " ").replace(".ts", "").replace(".py", "")
        return f"{verb} {file_desc}"
    else:
        # Multiple files - describe the area
        scope = infer_scope(files)
        if scope:
            return f"{verb} {scope} functionality"
        return f"{verb} multiple files"


def format_commit_message(
    commit_type: str,
    scope: Optional[str],
    subject: str,
    breaking: bool = False,
    body: Optional[str] = None,
    footer: Optional[str] = None
) -> str:
    """Format a complete commit message."""
    # Build type/scope prefix
    breaking_mark = "!" if breaking else ""
    if scope:
        prefix = f"{commit_type}({scope}){breaking_mark}: {subject}"
    else:
        prefix = f"{commit_type}{breaking_mark}: {subject}"

    lines = [prefix]

    if body:
        lines.append("")
        lines.append(body)

    if footer or breaking:
        lines.append("")
        if breaking:
            lines.append("BREAKING CHANGE: This change may break existing implementations.")
        if footer:
            lines.append(footer)

    return "\n".join(lines)


def analyze_and_suggest(
    custom_scope: Optional[str] = None,
    breaking: bool = False
) -> str:
    """
    Analyze staged changes and suggest a commit message.

    Args:
        custom_scope: Override inferred scope
        breaking: Mark as breaking change

    Returns:
        Suggested commit message
    """
    files = get_staged_files()
    if not files:
        return "No staged files found. Stage files with `git add` first."

    diff = get_staged_diff()

    commit_type = infer_commit_type(files, diff)
    scope = custom_scope or infer_scope(files)
    subject = generate_subject(files, diff, commit_type)

    return format_commit_message(
        commit_type=commit_type,
        scope=scope,
        subject=subject,
        breaking=breaking
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Analyze staged changes for commit")
    parser.add_argument("--scope", help="Override inferred scope")
    parser.add_argument("--breaking", action="store_true", help="Mark as breaking change")

    args = parser.parse_args()

    result = analyze_and_suggest(
        custom_scope=args.scope,
        breaking=args.breaking
    )
    print(result)
