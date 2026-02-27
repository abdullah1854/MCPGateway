#!/usr/bin/env python3
"""
PR Summary Generator - Creates comprehensive pull request summaries.
"""

import json
import subprocess
import sys
from typing import Optional


def get_git_diff_stats(base_branch: str = "main") -> dict:
    """Get git diff statistics."""
    try:
        # Get file changes
        result = subprocess.run(
            ["git", "diff", "--stat", f"{base_branch}...HEAD"],
            capture_output=True, text=True, check=True
        )
        stat_output = result.stdout

        # Get changed files
        result = subprocess.run(
            ["git", "diff", "--name-status", f"{base_branch}...HEAD"],
            capture_output=True, text=True, check=True
        )

        files = {"added": [], "modified": [], "deleted": []}
        for line in result.stdout.strip().split("\n"):
            if line:
                parts = line.split("\t")
                if len(parts) >= 2:
                    status, file = parts[0], parts[-1]
                    if status == "A":
                        files["added"].append(file)
                    elif status == "D":
                        files["deleted"].append(file)
                    else:
                        files["modified"].append(file)

        return {
            "stats": stat_output,
            "files": files,
            "total_files": len(files["added"]) + len(files["modified"]) + len(files["deleted"])
        }
    except subprocess.CalledProcessError:
        return {"stats": "", "files": {}, "total_files": 0}


def get_commits_since(base_branch: str = "main") -> list[dict]:
    """Get commits since branching from base."""
    try:
        result = subprocess.run(
            ["git", "log", f"{base_branch}..HEAD", "--format=%H|%s|%an|%ai", "--no-merges"],
            capture_output=True, text=True, check=True
        )

        commits = []
        for line in result.stdout.strip().split("\n"):
            if line:
                parts = line.split("|")
                if len(parts) >= 4:
                    commits.append({
                        "hash": parts[0][:7],
                        "message": parts[1],
                        "author": parts[2],
                        "date": parts[3]
                    })
        return commits
    except subprocess.CalledProcessError:
        return []


def categorize_changes(commits: list[dict], files: dict) -> dict:
    """Categorize changes by type."""
    categories = {
        "features": [],
        "fixes": [],
        "refactoring": [],
        "tests": [],
        "docs": [],
        "other": []
    }

    for commit in commits:
        msg = commit["message"].lower()
        if msg.startswith("feat"):
            categories["features"].append(commit["message"])
        elif msg.startswith("fix"):
            categories["fixes"].append(commit["message"])
        elif msg.startswith("refactor"):
            categories["refactoring"].append(commit["message"])
        elif msg.startswith("test"):
            categories["tests"].append(commit["message"])
        elif msg.startswith("docs"):
            categories["docs"].append(commit["message"])
        else:
            categories["other"].append(commit["message"])

    return {k: v for k, v in categories.items() if v}


def generate_pr_summary(
    title: str,
    description: str,
    changes: list[str],
    test_plan: list[str],
    breaking_changes: Optional[list[str]] = None,
    related_issues: Optional[list[str]] = None
) -> str:
    """Generate formatted PR summary."""

    summary = f"""## Summary
{description}

## Changes
"""
    for change in changes:
        summary += f"- {change}\n"

    if breaking_changes:
        summary += "\n## ⚠️ Breaking Changes\n"
        for bc in breaking_changes:
            summary += f"- {bc}\n"

    summary += "\n## Test Plan\n"
    for test in test_plan:
        summary += f"- [ ] {test}\n"

    if related_issues:
        summary += "\n## Related Issues\n"
        for issue in related_issues:
            summary += f"- {issue}\n"

    summary += "\n---\n🤖 Generated with [Claude Code](https://claude.com/claude-code)"

    return summary


def generate_from_git(
    base_branch: str = "main",
    include_files: bool = True
) -> str:
    """Generate PR summary from git history."""

    diff_stats = get_git_diff_stats(base_branch)
    commits = get_commits_since(base_branch)
    categories = categorize_changes(commits, diff_stats.get("files", {}))

    # Build description
    parts = []
    if categories.get("features"):
        parts.append(f"Adds {len(categories['features'])} new feature(s)")
    if categories.get("fixes"):
        parts.append(f"Fixes {len(categories['fixes'])} bug(s)")
    if categories.get("refactoring"):
        parts.append(f"Refactors {len(categories['refactoring'])} area(s)")

    description = ". ".join(parts) if parts else "Various changes and improvements."

    # Build changes list
    changes = []
    for category, items in categories.items():
        for item in items[:5]:  # Limit per category
            changes.append(item)

    # Build test plan
    test_plan = ["Verify all tests pass", "Manual testing of changed functionality"]
    if categories.get("features"):
        test_plan.append("Test new feature end-to-end")
    if categories.get("fixes"):
        test_plan.append("Verify bug fix resolves the issue")

    summary = generate_pr_summary(
        title="PR Summary",
        description=description,
        changes=changes[:10],  # Limit total changes
        test_plan=test_plan
    )

    if include_files and diff_stats.get("files"):
        files = diff_stats["files"]
        summary += "\n\n## Files Changed\n"
        if files.get("added"):
            summary += f"\n**Added** ({len(files['added'])})\n"
            for f in files["added"][:10]:
                summary += f"- `{f}`\n"
        if files.get("modified"):
            summary += f"\n**Modified** ({len(files['modified'])})\n"
            for f in files["modified"][:10]:
                summary += f"- `{f}`\n"
        if files.get("deleted"):
            summary += f"\n**Deleted** ({len(files['deleted'])})\n"
            for f in files["deleted"][:10]:
                summary += f"- `{f}`\n"

    return summary


def generate_pr_template() -> str:
    """Generate a PR template file."""
    return """## Summary
<!-- Brief description of what this PR does -->

## Changes
<!-- List the key changes made -->
-

## Type of Change
<!-- Check the relevant option -->
- [ ] 🐛 Bug fix (non-breaking change which fixes an issue)
- [ ] ✨ New feature (non-breaking change which adds functionality)
- [ ] 💥 Breaking change (fix or feature that would cause existing functionality to not work as expected)
- [ ] 📝 Documentation update
- [ ] 🔧 Refactoring (no functional changes)

## Test Plan
<!-- Describe how this was tested -->
- [ ] Unit tests added/updated
- [ ] Integration tests pass
- [ ] Manual testing completed

## Related Issues
<!-- Link any related issues -->
Closes #

## Screenshots
<!-- If applicable, add screenshots -->

---
🤖 Generated with [Claude Code](https://claude.com/claude-code)
"""


if __name__ == "__main__":
    if len(sys.argv) > 1:
        cmd = sys.argv[1]

        if cmd == "--git":
            base = sys.argv[2] if len(sys.argv) > 2 else "main"
            print(generate_from_git(base))

        elif cmd == "--template":
            print(generate_pr_template())

        elif cmd == "--example":
            print(generate_pr_summary(
                title="Add user authentication",
                description="Implements JWT-based authentication for the API with login and registration endpoints.",
                changes=[
                    "Add User model with password hashing",
                    "Implement POST /auth/register endpoint",
                    "Implement POST /auth/login endpoint",
                    "Add JWT token generation and validation",
                    "Create auth middleware for protected routes"
                ],
                test_plan=[
                    "Registration creates new user",
                    "Login returns valid JWT",
                    "Protected routes reject invalid tokens",
                    "Password is hashed correctly"
                ],
                related_issues=["#123", "#124"]
            ))

        elif cmd == "--commits":
            base = sys.argv[2] if len(sys.argv) > 2 else "main"
            commits = get_commits_since(base)
            for c in commits:
                print(f"{c['hash']} - {c['message']}")

    else:
        print("PR Summary Generator")
        print("Usage:")
        print("  --git [base]    Generate from git history")
        print("  --template      Generate PR template")
        print("  --example       Show example summary")
        print("  --commits [base] Show commits since base")
